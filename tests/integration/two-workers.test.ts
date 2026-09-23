import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { config } from "@/lib/config";
import { WorkerPool } from "@/worker/pool";
import {
  captureLogs,
  countDeliveries,
  enqueue,
  jobById,
  USERS,
  waitFor,
} from "../helpers";

describe("multiple workers (two-process guarantee)", () => {
  it("two worker pools cooperate and never both process the same job", async () => {
    const COUNT = 20;
    for (let i = 0; i < COUNT; i++) {
      await enqueue(USERS.alice);
    }

    const workerId1 = "suites-w1";
    const workerId2 = "suites-w2";
    const { lines, restore } = captureLogs();
    const w1 = new WorkerPool(config(), workerId1, { concurrency: 2, pollIntervalMs: 100 });
    const w2 = new WorkerPool(config(), workerId2, { concurrency: 2, pollIntervalMs: 100 });
    const p1 = w1.start();
    const p2 = w2.start();

    await waitFor(
      async () => (await countDeliveries()) >= COUNT,
      30_000,
      200,
    );
    w1.requestStop();
    w2.requestStop();
    await p1;
    await p2;
    restore();

    // Both workers did real work.
    expect(w1.stats().claimed).toBeGreaterThan(0);
    expect(w2.stats().claimed).toBeGreaterThan(0);

    // Every job ended succeeded exactly once and produced exactly one output.
    const all = await prismaJobIds();
    expect(all.length).toBe(COUNT);
    for (const id of all) {
      const row = await jobById(id);
      expect(row!.status).toBe("succeeded");
    }
    const outputs = await prismaOutputJobIds();
    expect(outputs.length).toBe(COUNT);
    expect(new Set(outputs).size).toBe(COUNT); // one logical output per job

    // No job was ever claimed by both workers at the same time.
    const claims = lines.filter((l) => l.event === "job.claimed");
    const perJobClaimers = new Map<string, Set<string>>();
    for (const c of claims) {
      const jobId = c.jobId as string;
      const wid = c.workerId as string;
      if (!perJobClaimers.has(jobId)) perJobClaimers.set(jobId, new Set());
      perJobClaimers.get(jobId)!.add(wid);
    }
    for (const [, claimers] of perJobClaimers) {
      expect(claimers.size).toBe(1);
    }

    // A single job claimed row ends with a single claimer recorded.
    const row = await jobById(all[0]);
    expect(["suites-w1", "suites-w2"]).toContain(row!.claimedBy ?? "");
  });
});

async function prismaJobIds(): Promise<string[]> {
  const rows = await prisma.job.findMany({ select: { id: true } });
  return rows.map((r) => r.id);
}

async function prismaOutputJobIds(): Promise<string[]> {
  const rows = await prisma.jobOutput.findMany({ select: { jobId: true } });
  return rows.map((r) => r.jobId);
}