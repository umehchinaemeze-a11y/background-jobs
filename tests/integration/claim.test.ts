import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { claimJobBatch } from "@/worker/claim";
import { countJobs, enqueue, jobById, uniqueKey } from "../helpers";

describe("atomic job claiming", () => {
  it("concurrent workers never receive the same job", async () => {
    await Promise.all(
      Array.from({ length: 30 }, () => enqueue()),
    );
    expect(await countJobs()).toBe(30);

    const [a, b, c] = await Promise.all([
      claimJobBatch(10, "worker-a"),
      claimJobBatch(10, "worker-b"),
      claimJobBatch(10, "worker-c"),
    ]);
    const all = [...a, ...b, ...c];

    // No duplicates across workers.
    expect(new Set(all.map((j) => j.id)).size).toBe(all.length);
    // Every one of the 30 runnable jobs was claimed exactly once.
    expect(all.length).toBe(30);

    // Every claimed row is marked processing with a startedAt timestamp.
    const claimedIds = new Set(all.map((j) => j.id));
    for (const id of claimedIds) {
      const row = await jobById(id);
      expect(row!.status).toBe("processing");
      expect(row!.startedAt).not.toBeNull();
      expect(row!.claimedBy).toBeTruthy();
    }
  });

  it("claims only one of the jobs when two workers race for a single job", async () => {
    const { jobId } = await enqueue();
    const [a, b, c, d] = await Promise.all([
      claimJobBatch(1, "race-1"),
      claimJobBatch(1, "race-2"),
      claimJobBatch(1, "race-3"),
      claimJobBatch(1, "race-4"),
    ]);
    const claimed = [...a, ...b, ...c, ...d];
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(jobId);
    expect(new Set(claimed.map((j) => j.id)).size).toBe(1);
  });

  it("does not claim jobs that are not due yet", async () => {
    await prisma.job.create({
      data: {
        userId: "alice",
        type: "order-confirmation",
        payload: { orderNumber: "ORD-FUTURE", recipientEmail: "x@example.com" },
        idempotencyKey: uniqueKey("future"),
        runAt: new Date(Date.now() + 60_000),
        maxAttempts: 5,
      },
    });
    const batch = await claimJobBatch(10, "worker-future");
    expect(batch.length).toBe(0);
    expect(await countJobs()).toBe(1);
  });

  it("does not claim an already processing job", async () => {
    const { jobId } = await enqueue();
    const first = await claimJobBatch(1, "claim-1");
    expect(first.length).toBe(1);

    const again = await claimJobBatch(1, "claim-2");
    expect(again.length).toBe(0);
    const row = await jobById(jobId);
    expect(row!.status).toBe("processing");
    expect(row!.claimedBy).toBe("claim-1");
  });

  it("claims failed jobs that are due for retry", async () => {
    const { jobId } = await enqueue();
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "failed", attempts: 1, runAt: new Date(Date.now() - 1_000) },
    });
    const batch = await claimJobBatch(10, "worker-retry");
    expect(batch.some((j) => j.id === jobId)).toBe(true);
    const row = await jobById(jobId);
    expect(row!.status).toBe("processing");
    expect(row!.attempts).toBe(1); // prior failures preserved
  });

  it("is a single atomic statement (status + startedAt set together)", async () => {
    const { jobId } = await enqueue();
    await claimJobBatch(1, "atomic-check");
    const row = await jobById(jobId);
    expect(row!.status).toBe("processing");
    expect(row!.startedAt).not.toBeNull();
  });
});