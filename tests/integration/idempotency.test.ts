import { describe, expect, it } from "vitest";
import { conflict } from "@/lib/errors";
import { countJobs, enqueue, uniqueKey, USERS } from "../helpers";

describe("database-level idempotency", () => {
  it("submitting the same logical job twice resolves to one Job row", async () => {
    const key = uniqueKey("dup");
    const first = await enqueue(USERS.alice, undefined, key);
    expect(first.duplicate).toBe(false);

    // Same payload and same key, submitted again.
    const second = await enqueue(USERS.alice, undefined, key);
    expect(second.duplicate).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    expect(second.idempotencyKey).toBe(key);

    expect(await countJobs()).toBe(1);
  });

  it("two concurrent submissions with the same key still create exactly one row", async () => {
    const key = uniqueKey("race");
    const results = await Promise.all([
      enqueue(USERS.alice, undefined, key),
      enqueue(USERS.alice, undefined, key),
      enqueue(USERS.alice, undefined, key),
      enqueue(USERS.alice, undefined, key),
    ]);

    const jobIds = new Set(results.map((r) => r.jobId));
    expect(jobIds.size).toBe(1);
    expect(await countJobs()).toBe(1);
    expect(results.some((r) => r.duplicate)).toBe(true);
    expect(results.some((r) => !r.duplicate)).toBe(true);
  });

  it("a duplicate submission resolves the existing job even after it is processed", async () => {
    const key = uniqueKey("later");
    const first = await enqueue(USERS.alice, undefined, key);
    // Simulate processing already finished.
    const { prisma } = await import("@/lib/prisma");
    await prisma.job.update({
      where: { id: first.jobId },
      data: { status: "succeeded", attempts: 0 },
    });
    const again = await enqueue(USERS.alice, undefined, key);
    expect(again.jobId).toBe(first.jobId);
    expect(again.status).toBe("succeeded");
    expect(await countJobs()).toBe(1);
  });

  it("rejects reuse of another user's idempotency key", async () => {
    const key = uniqueKey("owned");
    await enqueue(USERS.alice, undefined, key);
    await expect(enqueue(USERS.bob, undefined, key)).rejects.toEqual(
      conflict("idempotency key is already in use by another user"),
    );
    expect(await countJobs()).toBe(1);
  });
});