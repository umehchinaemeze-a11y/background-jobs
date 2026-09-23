import { Prisma } from "@prisma/client";
import { JobStatus } from "@prisma/client";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { retryDelayMs, retryPolicyFromConfig } from "../lib/retry";

export interface RecoveryResult {
  jobId: string;
  attemptsAfter: number;
  status: JobStatus;
  runAt: Date;
  workerId: string;
}

/**
 * STUCK-JOB RECOVERY (crash sweep)
 *
 * A worker can die while a job is `processing`. That row would otherwise stay
 * `processing` forever, so a sweep runs periodically and reclaims any job that
 * has been `processing` for longer than JOB_STUCK_TIMEOUT_MS.
 *
 * Each job is treated exactly like a failed attempt: attempts is incremented,
 * and the job either retries (status `failed`, runAt = now + backoff(+jitter))
 * or — once attempts reach maxAttempts — becomes `dead`.
 *
 * Concurrency: candidates are selected with FOR UPDATE SKIP LOCKED inside a
 * transaction and re-verified in the UPDATE's WHERE, so two sweeping workers
 * (or a sweeper racing a live worker's failure recorder) can never both
 * "recover" the same job.
 */
export async function recoverStuckJobs(
  workerId: string,
  now: Date = new Date(),
): Promise<RecoveryResult[]> {
  const cfg = config();
  const policy = retryPolicyFromConfig();
  const startedBefore = new Date(now.getTime() - cfg.JOB_STUCK_TIMEOUT_MS);
  const message = `recovered: job was 'processing' with startedAt < ${startedBefore.toISOString()} (worker did not finish within JOB_STUCK_TIMEOUT_MS=${cfg.JOB_STUCK_TIMEOUT_MS})`;

  const results: RecoveryResult[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<
        { id: string; attempts: number; maxAttempts: number; runAt: Date }[]
      >(
        Prisma.sql`
        SELECT id, "attempts", "maxAttempts", "runAt"
        FROM "Job"
        WHERE "status" = 'processing'
          AND "startedAt" < ${startedBefore}
        ORDER BY "startedAt" ASC
        LIMIT 100
        FOR UPDATE SKIP LOCKED
      `,
      );

      for (const c of candidates) {
        const attemptsAfter = c.attempts + 1;
        const isDead = attemptsAfter >= c.maxAttempts;
        const delayMs = retryDelayMs(attemptsAfter, policy);
        const runAt = isDead ? c.runAt : new Date(now.getTime() + delayMs);
        const { count } = await tx.job.updateMany({
          where: { id: c.id, status: "processing", startedAt: { lt: startedBefore } },
          data: {
            status: isDead ? "dead" : "failed",
            attempts: { increment: 1 },
            lastError: message,
            runAt,
            finishedAt: isDead ? now : null,
            startedAt: null,
            claimedBy: null,
          },
        });
        if (count === 1) {
          results.push({ jobId: c.id, attemptsAfter, status: isDead ? "dead" : "failed", runAt, workerId });
        }
      }
    });
  } catch (e) {
    logger.error("recovery.sweep-error", {
      workerId,
      error: e instanceof Error ? e.message : String(e),
    });
    return results;
  }

  for (const r of results) {
    logger.log("job.recovered", {
      jobId: r.jobId,
      workerId: r.workerId,
      status: r.status,
      attemptsAfter: r.attemptsAfter,
      runAt: r.runAt.toISOString(),
    });
  }
  return results;
}