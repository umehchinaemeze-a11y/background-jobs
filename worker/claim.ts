import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

export interface ClaimedJob {
  id: string;
  type: string;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
}

/**
 * ATOMIC JOB CLAIM
 * ================
 *
 * Claim and mark `processing` in ONE statement so two workers can never claim
 * the same job:
 *
 *   WITH candidate AS (
 *     SELECT id
 *     FROM "Job"
 *     WHERE status IN ('pending','failed')      -- only runnable states
 *       AND "runAt" <= now()                     -- only jobs due now
 *     ORDER BY "runAt" ASC
 *     LIMIT $limit
 *     FOR UPDATE SKIP LOCKED                     -- lock rows; skip locked ones
 *   )
 *   UPDATE "Job" j
 *   SET status = 'processing', "startedAt" = now(), "claimedBy" = $workerId
 *   FROM candidate
 *   WHERE j.id = candidate.id
 *     AND j.status IN ('pending','failed')       -- re-check while holding lock
 *     AND j."runAt" <= now()
 *   RETURNING j.*;                               -- only rows we actually won
 *
 * Why this is safe:
 * - `FOR UPDATE SKIP LOCKED` takes a row lock on the selected job. Any other
 *   worker selecting the same job blocks until this lock releases OR — with
 *   `SKIP LOCKED` — skips it entirely and claims a different row. Two workers
 *   therefore never both receive the same job from the query.
 * - The lock is taken and the state transition (pending -> processing) happen
 *   inside the same single SQL statement, so there is no window in which the
 *   SELECT result and the UPDATE can disagree.
 * - The `WHERE` clause is repeated inside the UPDATE while we already hold the
 *   lock, so a row that stopped being eligible (recovered, retried, or
 *   cancelled by another path) cannot be claimed.
 *
 * A naive "SELECT pending job, then UPDATE it" approach is a race: worker A
 * reads the job, worker B reads the same job, both transition it to
 * processing, and both execute the email work. This function never does that.
 */
export async function claimJobBatch(
  limit: number,
  workerId: string,
): Promise<ClaimedJob[]> {
  const rows = await prisma.$queryRaw<ClaimedJob[]>(Prisma.sql`
    WITH candidate AS (
      SELECT id
      FROM "Job"
      WHERE "status" IN ('pending','failed')
        AND "runAt" <= now()
      ORDER BY "runAt" ASC
      LIMIT ${Math.max(0, limit)}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Job" j
    SET "status" = 'processing'
      , "startedAt" = now()
      , "claimedBy" = ${workerId}
    FROM candidate
    WHERE j.id = candidate.id
      AND j."status" IN ('pending','failed')
      AND j."runAt" <= now()
    RETURNING j.id, j.type, j.payload, j."attempts", j."maxAttempts", j."runAt"
  `);
  return rows;
}