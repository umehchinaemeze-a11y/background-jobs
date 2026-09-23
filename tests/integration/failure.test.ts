import { describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { WorkerPool } from "@/worker/pool";
import {
  captureLogs,
  countJobs,
  enqueue,
  jobById,
  samplePayload,
  sleep,
  uniqueKey,
  USERS,
  waitFor,
} from "../helpers";

describe("failure lifecycle", () => {
  it("100% failures retry with growing backoff + jitter, then land in dead with exhaustion", async () => {
    const maxAttempts = config().JOB_MAX_ATTEMPTS; // 5 in tests
    const jobA = await enqueue(
      USERS.alice,
      samplePayload({ forceFailure: true }),
      uniqueKey("fail-a"),
    );
    const jobB = await enqueue(
      USERS.alice,
      samplePayload({ forceFailure: true }),
      uniqueKey("fail-b"),
    );

    const { lines, restore } = captureLogs();
    const pool = new WorkerPool(config(), "fail-drill", {
      concurrency: 1,
      pollIntervalMs: 120,
    });
    const run = pool.start();

    // Sample the DB row over time to prove the state machine progressed.
    const snapshots: { status: string; attempts: number; runAt: number }[] = [];
    await waitFor(
      async () => {
        const a = await jobById(jobA.jobId);
        if (a) {
          snapshots.push({ status: a.status, attempts: a.attempts, runAt: a.runAt.getTime() });
        }
        return a?.status === "dead";
      },
      40_000,
      200,
    );
    pool.requestStop();
    await run;
    restore();

    // Terminal state: exactly exhausted, failed forever.
    const finalA = await jobById(jobA.jobId);
    expect(finalA!.status).toBe("dead");
    expect(finalA!.attempts).toBe(maxAttempts);
    expect(finalA!.lastError).toContain("FORCED_TEST_FAILURE");
    expect(finalA!.finishedAt).not.toBeNull();
    expect(finalA!.startedAt).toBeNull();

    // The state machine only ever moves forward: pending -> failed -> ... -> dead.
    const seen = snapshots.map((s) => s.status);
    expect(seen[0]).toBe("pending");
    expect(seen).toContain("failed");
    expect(seen[seen.length - 1]).toBe("dead");

    // Status is never 'succeeded' and backoff schedules strictly grow: the
    // retry runAts move into the future as attempts accumulate.
    expect(seen.every((s) => s !== "succeeded")).toBe(true);
    const failedRunAts = snapshots
      .filter((s) => s.status === "failed")
      .map((s) => s.runAt);
    for (let i = 1; i < failedRunAts.length; i++) {
      // allowed to stay equal within a single 200ms poll window
      if (failedRunAts[i] < failedRunAts[i - 1]) {
        throw new Error("runAt moved backwards");
      }
    }

    // Failure log events: one per failed attempt on A, with growing delays.
    const failEvents = lines
      .filter((l) => l.event === "job.failed" || l.event === "job.dead")
      .filter((l) => l.jobId === jobA.jobId)
      .sort((x, y) => (x.attemptsAfter as number) - (y.attemptsAfter as number));
    expect(failEvents.length).toBe(maxAttempts);
    const delays = failEvents.map((f) => f.delayMs as number);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }

    // Jitter proof: two identical failing jobs produce different retry delays
    // for the same attempt, and both stay within [exp, exp + jitterMs].
    const bEvents = lines
      .filter((l) => (l.event === "job.failed" || l.event === "job.dead"))
      .filter((l) => l.jobId === jobB.jobId)
      .sort((x, y) => (x.attemptsAfter as number) - (y.attemptsAfter as number));
    const base = config().JOB_RETRY_BASE_DELAY_MS;
    const jitter = config().JOB_RETRY_JITTER_MS;
    for (let i = 0; i < maxAttempts; i++) {
      const exp = Math.min(base * 2 ** i, config().JOB_RETRY_MAX_DELAY_MS);
      const dA = delays[i];
      const dB = bEvents[i].delayMs as number;
      expect(dA).toBeGreaterThanOrEqual(exp);
      expect(dA).toBeLessThan(exp + jitter);
      expect(dB).toBeGreaterThanOrEqual(exp);
      expect(dB).toBeLessThan(exp + jitter);
    }
    expect(delays[0]).not.toBe(bEvents[0].delayMs); // jitter differs across draws

    // Both jobs exhausted and are visible in the dead bucket.
    expect(await countJobs(["dead"])).toBe(2);
    await sleep(50);
  });

  it("a failed job remains claim-eligible on its retry window (failed is retry-waiting, not terminal)", async () => {
    const { jobId } = await enqueue(USERS.alice, samplePayload(), uniqueKey());
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "failed", attempts: 1, runAt: new Date(Date.now() - 1) },
    });

    const { restore } = captureLogs();
    const pool = new WorkerPool(config(), "failed-retryable", {
      concurrency: 1,
      pollIntervalMs: 100,
    });
    const run = pool.start();
    await waitFor(async () => (await jobById(jobId))?.status === "succeeded", 15_000, 150);
    pool.requestStop();
    await run;
    restore();

    expect(pool.stats().failed).toBe(0);
    const row = await jobById(jobId);
    expect(row!.status).toBe("succeeded");
    expect(row!.attempts).toBe(1); // prior failure kept
    await sleep(50);
  });
});