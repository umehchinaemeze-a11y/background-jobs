import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { recoverStuckJobs } from "@/worker/recovery";
import {
  claimFromDb,
  enqueue,
  jobById,
  samplePayload,
  uniqueKey,
  USERS,
} from "../helpers";

export async function backdateAsStuck(jobId: string, hoursAgo = 3): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { startedAt: new Date(Date.now() - hoursAgo * 3_600_000) },
  });
}

describe("stuck job recovery", () => {
  it("sweeps a crashed worker's processing job back to a retriable failed state", async () => {
    const { jobId } = await enqueue();
    const { ok } = await claimFromDb(jobId, "crashed-worker");
    expect(ok).toBe(true);
    await backdateAsStuck(jobId);

    const recovered = await recoverStuckJobs("sweeper");
    expect(recovered.map((r) => r.jobId)).toContain(jobId);

    const row = await jobById(jobId);
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(1);
    expect(row!.startedAt).toBeNull();
    expect(row!.finishedAt).toBeNull();
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now() - 1); // rescheduled
    // A fresh worker can pick it up again immediately on the next retry window:
    const batch = await claimFromDb(jobId, "next-worker");
    expect(batch.ok);
  });

  it("sweep is atomic: locked jobs are skipped, not double-recovered", async () => {
    for (let i = 0; i < 5; i++) {
      const { jobId } = await enqueue(USERS.alice, samplePayload(), uniqueKey());
      await claimFromDb(jobId, "crashed-worker");
      await backdateAsStuck(jobId);
    }
    const [a, b, c] = await Promise.all([
      recoverStuckJobs("sweeper-1"),
      recoverStuckJobs("sweeper-2"),
      recoverStuckJobs("sweeper-3"),
    ]);
    const seen = [...a, ...b, ...c];
    const ids = seen.map((r) => r.jobId);
    expect(new Set(ids).size).toBe(ids.length); // each job recovered exactly once
    const rows = await prisma.job.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => r.status === "failed")).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  });

  it("exhausts attempts on recovery when the job already used its budget", async () => {
    const key = uniqueKey("exhausted");
    const { jobId } = await enqueue(USERS.alice, samplePayload({ forceFailure: true }), key);
    // Simulate a job that was restarted several times before crashing.
    await prisma.job.update({
      where: { id: jobId },
      data: { attempts: 4, status: "processing", startedAt: new Date(Date.now() - 3_600_000) },
    });
    const recovered = await recoverStuckJobs("sweeper");
    const thisJob = recovered.find((r) => r.jobId === jobId);
    expect(thisJob).toBeDefined();
    expect(thisJob!.attemptsAfter).toBe(5); // 4 + 1 recovery attempt

    const row = await jobById(jobId);
    expect(row!.status).toBe("dead");
    expect(row!.attempts).toBe(5);
    expect(row!.finishedAt).not.toBeNull();
  });

  it("leaves fresh, still-running jobs alone", async () => {
    const { jobId } = await enqueue();
    await claimFromDb(jobId, "busy-worker"); // startedAt = now
    const recovered = await recoverStuckJobs("sweeper");
    expect(recovered.some((r) => r.jobId === jobId)).toBe(false);
    const row = await jobById(jobId);
    expect(row!.status).toBe("processing");
  });
});