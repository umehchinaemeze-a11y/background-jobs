import { describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import { WorkerPool } from "@/worker/pool";
import { captureLogs, enqueue, sleep, waitFor, countJobs } from "../helpers";

describe("concurrency cap", () => {
  it("processes 50 jobs without ever exceeding the configured concurrency", async () => {
    const N = 3;
    for (let i = 0; i < 50; i++) {
      await enqueue();
    }
    expect(await countJobs()).toBe(50);

    const { lines, restore } = captureLogs();
    const pool = new WorkerPool(config(), "conc-capped", {
      concurrency: N,
      pollIntervalMs: 100,
    });
    const run = pool.start();

    await waitFor(
      () => pool.stats().completed + pool.stats().failed >= 50,
      30_000,
      200,
    );
    pool.requestStop();
    await run;
    restore();

    // Every job finished successfully and the measured concurrency never
    // exceeded the cap.
    expect(pool.stats().completed).toBe(50);
    expect(pool.stats().failed).toBe(0);
    expect(pool.stats().maxActive).toBeLessThanOrEqual(N);
    expect(pool.stats().maxActive).toBeGreaterThan(1); // concurrency was actually used

    const claims = lines.filter((l) => l.event === "job.claimed");
    expect(claims.length).toBe(50);
    const activeFromLogs = claims.map((l) => l.active as number);
    expect(Math.max(...activeFromLogs)).toBeLessThanOrEqual(N);

    const success = lines.filter((l) => l.event === "job.succeeded");
    expect(success.length).toBe(50);
  });

  it("does not claim more jobs than free slots on any single tick", async () => {
    for (let i = 0; i < 20; i++) {
      await enqueue();
    }
    const { lines, restore } = captureLogs();
    const pool = new WorkerPool(config(), "slot-check", {
      concurrency: 2,
      pollIntervalMs: 200,
    });
    const run = pool.start();
    await waitFor(() => pool.stats().completed >= 20, 20_000, 200);
    pool.requestStop();
    await run;
    restore();

    expect(pool.stats().completed).toBe(20);
    const claims = lines.filter((l) => l.event === "job.claimed");
    for (const c of claims) {
      // measured active never exceeds the configured cap at claim time
      expect(c.active as number).toBeLessThanOrEqual(c.concurrent as number);
    }
    await sleep(50);
  });
});