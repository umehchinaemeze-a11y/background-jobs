import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { claimJobBatch, type ClaimedJob } from "@/worker/claim";
import { executeClaimedJob } from "@/worker/executor";
import {
  captureLogs,
  countDeliveries,
  enqueue,
  jobById,
  sleep,
} from "../helpers";

describe("idempotent job output", () => {
  it("runs the work exactly once and records one logical output", async () => {
    const { jobId } = await enqueue();
    const { lines, restore } = captureLogs();

    const claimed = await claimJobBatch(1, "executor");
    expect(claimed.length).toBe(1);
    const r1 = await executeClaimedJob("executor", claimed[0]);
    expect(r1.outcome).toBe("succeeded");

    const sends = () => lines.filter((l) => l.event === "email.test-send").length;
    expect(sends()).toBe(1);
    expect(await countDeliveries()).toBe(1);

    const row = await jobById(jobId);
    expect(row!.status).toBe("succeeded");
    expect(row!.finishedAt).not.toBeNull();
    // startedAt/claimedBy are retained for audit (recovery only inspects
    // status='processing'), so a succeeded job keeps its processing timestamps.
    expect(row!.startedAt).not.toBeNull();
    expect(row!.claimedBy).toBe("executor");

    const output = await prisma.jobOutput.findUnique({ where: { jobId } });
    expect(output).not.toBeNull();
    expect(output!.recipient).toBeTruthy();
    expect(output!.providerMessageId).toBe(`test:${jobId}`);
    expect(output!.sentAt).not.toBeNull();
    restore();
  });

  it("re-executing an already-delivered job does not call the provider again", async () => {
    const { jobId } = await enqueue();
    const { lines, restore } = captureLogs();

    const c1 = await claimJobBatch(1, "first");
    await executeClaimedJob("first", c1[0]);
    expect(lines.filter((l) => l.event === "email.test-send").length).toBe(1);

    // Replay the crash window: the delivery row exists but the job is back in
    // a claimable state (the "sent, then worker died before committing
    // success" scenario from the spec).
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "pending",
        attempts: 1,
        runAt: new Date(Date.now() - 1),
        startedAt: null,
        finishedAt: null,
      },
    });

    const c2 = await claimJobBatch(1, "second");
    expect(c2.length).toBe(1);
    const r2 = await executeClaimedJob("second", c2[0]);
    expect(r2.outcome).toBe("already-delivered");

    // Provider was still called exactly once; one logical output remains.
    expect(lines.filter((l) => l.event === "email.test-send").length).toBe(1);
    expect(await countDeliveries()).toBe(1);

    const after = await jobById(jobId);
    expect(after!.status).toBe("succeeded");
    expect(after!.attempts).toBe(1);
    restore();
  });

  it("re-execution against an existing delivery record without a claim still resolves to success (no re-send)", async () => {
    const { jobId } = await enqueue();
    const { lines, restore } = captureLogs();
    const c = await claimJobBatch(1, "first");
    await executeClaimedJob("first", c[0]);

    const row = await jobById(jobId);
    const stale: ClaimedJob = {
      id: row!.id,
      type: row!.type as "order-confirmation",
      payload: row!.payload,
      attempts: 1,
      maxAttempts: row!.maxAttempts,
      runAt: row!.runAt,
    };
    const r2 = await executeClaimedJob("second", stale);
    expect(r2.outcome).toBe("already-delivered");
    expect(lines.filter((l) => l.event === "email.test-send").length).toBe(1);
    expect(await countDeliveries()).toBe(1);
    restore();
  });

  it("records a failure (not a throw) when payload validation fails during execution", async () => {
    const { jobId } = await enqueue();
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "processing",
        attempts: 0,
        payload: { orderNumber: "x" }, // no recipientEmail
      },
    });
    const claimed: ClaimedJob = {
      id: jobId,
      type: "order-confirmation",
      payload: { orderNumber: "x" },
      attempts: 0,
      maxAttempts: 5,
      runAt: new Date(),
    };
    const r = await executeClaimedJob("bad-payload", claimed);
    expect(r.outcome).toBe("failed");
    const row = await jobById(jobId);
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toContain("Invalid job payload");
    await sleep(50);
  });
});