import { Prisma } from "@prisma/client";
import { JobStatus } from "@prisma/client";
import { config } from "./config";
import { conflict, notFound, ApiError } from "./errors";
import {
  MAX_PAYLOAD_BYTES,
  payloadBytes,
  safeContext,
  type EnqueueInput,
} from "./payload";
import { prisma } from "./prisma";

export interface EnqueueResult {
  jobId: string;
  status: JobStatus;
  idempotencyKey: string;
  duplicate: boolean;
}

export function isPrismaUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

/**
 * Persist a job row and return immediately. No email work happens here.
 *
 * Idempotency is enforced by the database: `idempotencyKey` has a unique
 * constraint, so a duplicate submission fails the create and we resolve the
 * already-existing job. There is no check-then-create race window.
 */
export async function enqueueJob(
  userId: string,
  input: EnqueueInput,
): Promise<EnqueueResult> {
  if (payloadBytes(input) > MAX_PAYLOAD_BYTES) {
    throw new ApiError(413, `Payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }

  const cfg = config();
  try {
    const job = await prisma.job.create({
      data: {
        userId,
        type: input.type,
        payload: input.payload as unknown as Prisma.InputJsonValue,
        maxAttempts: cfg.JOB_MAX_ATTEMPTS,
        idempotencyKey: input.idempotencyKey,
        runAt: new Date(),
      },
      select: { id: true, status: true, idempotencyKey: true },
    });
    return {
      jobId: job.id,
      status: job.status,
      idempotencyKey: job.idempotencyKey,
      duplicate: false,
    };
  } catch (e) {
    if (!isPrismaUniqueViolation(e)) throw e;

    // A second request with the same key raced us (or arrived after). Resolve
    // the existing row deterministically instead of creating a duplicate.
    const existing = await prisma.job.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, status: true, idempotencyKey: true, userId: true },
    });
    if (!existing) throw e;
    if (existing.userId !== userId) {
      throw conflict("idempotency key is already in use by another user");
    }
    return {
      jobId: existing.id,
      status: existing.status,
      idempotencyKey: existing.idempotencyKey,
      duplicate: true,
    };
  }
}

export interface JobView {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastError: string | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
  context: { orderNumber: string; recipientEmail: string };
}

function toView(job: {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastError: string | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
  payload: Prisma.JsonValue;
}): JobView {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    runAt: job.runAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastError: job.lastError,
    idempotencyKey: job.idempotencyKey,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    context: safeContext(job.payload),
  };
}

export async function getJobStatus(
  userId: string,
  jobId: string,
): Promise<JobView> {
  const job = await prisma.job.findFirst({
    where: { id: jobId, userId },
  });
  if (!job) throw notFound("Job not found");
  return toView(job);
}

export async function listJobs(
  userId: string,
  status?: JobStatus,
  limit = 50,
): Promise<JobView[]> {
  const jobs = await prisma.job.findMany({
    where: { userId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 200),
  });
  return jobs.map(toView);
}

/**
 * Manual dead-letter retry — OPTION A policy: the job restarts with a full,
 * fresh attempt cycle (attempts reset to 0, runAt = now). Simplest and easiest
 * to defend: after human intervention the job is treated like a brand-new one.
 */
export async function retryDeadJob(
  userId: string,
  jobId: string,
): Promise<JobView> {
  const job = await prisma.job.findFirst({
    where: { id: jobId, userId },
  });
  if (!job) throw notFound("Job not found");
  if (job.status !== "dead") {
    throw new ApiError(409, "Only dead jobs can be manually retried");
  }
  const now = new Date();
  const updated = await prisma.job.update({
    where: { id: job.id },
    data: {
      status: "pending",
      attempts: 0,
      lastError: null,
      startedAt: null,
      finishedAt: null,
      claimedBy: null,
      runAt: now,
    },
  });
  return toView(updated);
}