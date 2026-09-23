import { JobStatus } from "@prisma/client";
import { config } from "../lib/config";
import { isPrismaUniqueViolation } from "../lib/jobs";
import { logger } from "../lib/logger";
import {
  orderConfirmationPayloadSchema,
  renderOrderEmailHtml,
  type OrderConfirmationPayload,
} from "../lib/payload";
import { prisma } from "../lib/prisma";
import { retryDelayMs, retryPolicyFromConfig } from "../lib/retry";
import type { ClaimedJob } from "./claim";
import { getEmailSender } from "./email";

export interface JobRunResult {
  jobId: string;
  outcome: "succeeded" | "already-delivered" | "failed";
}

function summarizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 1_000);
}

function runWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`work exceeded JOB_WORK_TIMEOUT_MS (${ms}ms)`)),
      ms,
    );
  });
  try {
    return Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs one claimed job to completion: validates the persisted payload, checks
 * the durable output record, sends the email (with the provider idempotency
 * key = job id), records the delivery and marks the job succeeded.
 */
export async function executeClaimedJob(
  workerId: string,
  job: ClaimedJob,
): Promise<JobRunResult> {
  try {
    return await runWork(workerId, job);
  } catch (e) {
    // Any exception (invalid payload, provider error, timeout, DB hiccup)
    // becomes a recorded failed attempt with retry/dead scheduling.
    await recordFailure(job.id, e);
    return { jobId: job.id, outcome: "failed" };
  }
}

async function runWork(
  workerId: string,
  job: ClaimedJob,
): Promise<JobRunResult> {
  const cfg = config();
  const parsed = orderConfirmationPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid job payload: ${detail}`);
  }
  const payload: OrderConfirmationPayload = parsed.data;

  logger.log("job.run-start", { jobId: job.id, workerId, type: job.type });

  // IDEMPOTENT OUTPUT GUARD ------------------------------------------------
  // If this job already produced a delivery (previous run crashed AFTER the
  // provider accepted the email but BEFORE recording success), do NOT send
  // again. The JobOutput row is uniquely keyed by jobId in the database.
  const existing = await prisma.jobOutput.findUnique({
    where: { jobId: job.id },
  });
  if (existing) {
    logger.log("job.already-delivered", {
      jobId: job.id,
      workerId,
      providerMessageId: existing.providerMessageId,
    });
    await markSucceeded(job.id);
    return { jobId: job.id, outcome: "already-delivered" };
  }

  const sender = getEmailSender();
  const sent = await runWithTimeout(
    () =>
      sender.send({
        from: cfg.EMAIL_PROVIDER_FROM,
        to: payload.recipientEmail,
        subject: `Order ${payload.orderNumber} confirmed`,
        html: renderOrderEmailHtml(payload),
        // Provider-side idempotency key: Resend dedupes identical requests
        // for 24h, so a retry after a crash returns the original message id
        // instead of re-sending.
        idempotencyKey: job.id,
        forceFailure: payload.forceFailure,
        testDelayMs: payload.testDelayMs,
      }),
    cfg.JOB_WORK_TIMEOUT_MS,
  );

  await recordDelivery(job.id, payload, sent.providerMessageId);
  await markSucceeded(job.id);
  logger.log("job.succeeded", {
    jobId: job.id,
    workerId,
    providerMessageId: sent.providerMessageId,
    vendor: sender.vendor,
  });
  return { jobId: job.id, outcome: "succeeded" };
}

async function recordDelivery(
  jobId: string,
  payload: OrderConfirmationPayload,
  providerMessageId: string,
): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.jobOutput.create({
        data: {
          jobId,
          providerMessageId,
          recipient: payload.recipientEmail,
        },
      }),
      prisma.job.updateMany({
        where: { id: jobId, status: "processing" },
        data: {
          status: "succeeded",
          finishedAt: new Date(),
        },
      }),
    ]);
  } catch (e) {
    if (isPrismaUniqueViolation(e)) {
      // A concurrent execution recorded the output first; treat as success.
      await prisma.job.updateMany({
        where: { id: jobId, status: "processing" },
        data: { status: "succeeded", finishedAt: new Date() },
      });
      return;
    }
    throw e;
  }
}

async function markSucceeded(jobId: string): Promise<void> {
  await prisma.job.updateMany({
    where: { id: jobId, status: "processing" },
    data: { status: "succeeded", finishedAt: new Date() },
  });
}

export interface FailureRecord {
  recorded: boolean;
  attemptsAfter?: number;
  maxAttempts?: number;
  status?: JobStatus;
  runAt?: Date;
  delayMs?: number;
}

/**
 * Records one failed attempt. Increments `attempts`; if attempts now reach
 * maxAttempts the job is DEAD (finishedAt set), otherwise it returns to the
 * retry-eligible `failed` state with runAt = now + backoff(+jitter).
 *
 * The guarded WHERE (`status = processing`) makes double-recording
 * impossible even if locally-timed-out work and the stuck-recovery sweep
 * race over the same job.
 */
export async function recordFailure(
  jobId: string,
  err: unknown,
  extra = "",
): Promise<FailureRecord> {
  const policy = retryPolicyFromConfig();
  const message = summarizeError(err);

  const result = await prisma.$transaction(
    async (tx): Promise<FailureRecord> => {
      const row = await tx.job.findUnique({
        where: { id: jobId },
        select: { attempts: true, maxAttempts: true, status: true, runAt: true },
      });
      if (!row || row.status !== "processing") {
        return { recorded: false };
      }
      const attemptsAfter = row.attempts + 1;
      const isDead = attemptsAfter >= row.maxAttempts;
      const delayMs = retryDelayMs(attemptsAfter, policy);
      const now = new Date();
      const runAt = isDead ? row.runAt : new Date(now.getTime() + delayMs);
      const lastError = `${
        extra ? `${extra}: ` : ""
      }${message}`;

      const { count } = await tx.job.updateMany({
        where: { id: jobId, status: "processing" },
        data: {
          status: isDead ? "dead" : "failed",
          attempts: { increment: 1 },
          lastError,
          runAt,
          finishedAt: isDead ? now : null,
          startedAt: null,
          claimedBy: null,
        },
      });
      if (count !== 1) return { recorded: false };
      return {
        recorded: true,
        attemptsAfter,
        maxAttempts: row.maxAttempts,
        status: isDead ? "dead" : "failed",
        runAt,
        delayMs,
      };
    },
  );

  if (result.recorded) {
    logger.log(result.status === "dead" ? "job.dead" : "job.failed", {
      jobId,
      attemptsAfter: result.attemptsAfter,
      maxAttempts: result.maxAttempts,
      status: result.status,
      runAt: result.runAt?.toISOString(),
      delayMs: result.delayMs,
      error: message,
    });
  }
  return result;
}