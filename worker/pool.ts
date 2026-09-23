import type { AppConfig } from "../lib/config";
import { logger } from "../lib/logger";
import type { ClaimedJob } from "./claim";
import { claimJobBatch } from "./claim";
import { executeClaimedJob } from "./executor";
import { recoverStuckJobs } from "./recovery";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PoolStats {
  active: number;
  maxActive: number;
  completed: number;
  failed: number;
  recovered: number;
  claimed: number;
}

/**
 * Bounded-concurrency worker pool.
 *
 * The pool never has more than `JOB_WORKER_CONCURRENCY` jobs executing
 * their email work at the same time. It only asks the database for a batch
 * of new jobs when it has free slots:
 *
 *   slots = JOB_WORKER_CONCURRENCY - active
 *   claim at most `slots`
 *   dispatch each claimed job (active increments immediately)
 *
 * Because a new claim happens only after slots are recomputed, `active`
 * cannot exceed the configured bound. Every start logs `active/concurrency`
 * so the concurrency behavior is directly observable.
 *
 * The loop also runs the stuck-job sweep on every tick and sleeps for
 * JOB_POLL_INTERVAL_MS between ticks when idle — no busy-spinning.
 */
export class WorkerPool {
  private active = 0;
  private maxActive = 0;
  private completed = 0;
  private failed = 0;
  private recovered = 0;
  private claimed = 0;
  private running = false;
  private inflight = new Set<Promise<void>>();

  readonly workerId: string;
  readonly concurrency: number;
  private readonly pollIntervalMs: number;

  constructor(
    cfg: AppConfig,
    identifier?: string,
    overrides?: { concurrency?: number; pollIntervalMs?: number },
  ) {
    this.concurrency = overrides?.concurrency ?? cfg.JOB_WORKER_CONCURRENCY;
    this.pollIntervalMs =
      overrides?.pollIntervalMs ?? cfg.JOB_POLL_INTERVAL_MS;
    this.workerId =
      identifier ?? `worker-${process.pid}-${Date.now().toString(36)}`;
    logger.setWorkerId(this.workerId);
  }

  stats(): PoolStats {
    return {
      active: this.active,
      maxActive: this.maxActive,
      completed: this.completed,
      failed: this.failed,
      recovered: this.recovered,
      claimed: this.claimed,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.log("worker.start", {
      workerId: this.workerId,
      concurrency: this.concurrency,
      pollIntervalMs: this.pollIntervalMs,
    });

    while (this.running) {
      await this.tick();
      if (this.running) await sleep(this.pollIntervalMs);
    }

    // Wait for in-flight jobs to finish (graceful drain).
    await Promise.allSettled([...this.inflight]);
    logger.log("worker.stop", {
      workerId: this.workerId,
      stats: this.stats(),
    });
  }

  requestStop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async tick(): Promise<void> {
    // 1) Stuck-job sweep happens on every tick but only touches rows that are
    //    stale and still `processing`, so it is cheap for a healthy queue.
    try {
      const recovered = await recoverStuckJobs(this.workerId);
      this.recovered += recovered.length;
    } catch (e) {
      logger.error("worker.recovery-error", {
        workerId: this.workerId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const slots = this.concurrency - this.active;
    if (slots <= 0) return;

    let batch: ClaimedJob[] = [];
    try {
      batch = await claimJobBatch(slots, this.workerId);
    } catch (e) {
      logger.error("worker.claim-error", {
        workerId: this.workerId,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    for (const job of batch) {
      this.launch(job);
    }
  }

  private launch(job: ClaimedJob): void {
    this.active += 1;
    this.claimed += 1;
    if (this.active > this.maxActive) this.maxActive = this.active;
    logger.log("job.claimed", {
      jobId: job.id,
      workerId: this.workerId,
      active: this.active,
      concurrent: this.concurrency,
    });

    const p = executeClaimedJob(this.workerId, job)
      .then((res) => {
        if (res.outcome === "succeeded" || res.outcome === "already-delivered") {
          this.completed += 1;
        } else {
          this.failed += 1;
        }
      })
      .catch((e) => {
        this.failed += 1;
        logger.error("job.executor-error", {
          jobId: job.id,
          workerId: this.workerId,
          error: e instanceof Error ? e.message : String(e),
        });
      })
      .finally(() => {
        this.active -= 1;
        this.inflight.delete(p);
      });
    this.inflight.add(p);
  }
}