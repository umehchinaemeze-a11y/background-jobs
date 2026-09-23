// Worker process entry point. This process is entirely separate from the
// Next.js HTTP server: it only touches the database and the email provider,
// never the request path.
import "./env";

import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { WorkerPool } from "./pool";

function main(): void {
  const cfg = config();
  let pool: WorkerPool | null = null;

  const shutdown = (signal: string): void => {
    logger.log("worker.shutdown-signal", { signal });
    if (cfg.JOB_WORKER_GRACE_MS === 0) {
      // Abrupt termination for failure-recovery drills: jobs left `processing`
      // are reclaimed by the stuck-job sweep of the next worker.
      process.exit(0);
    }
    if (pool) pool.requestStop();
    setTimeout(() => {
      logger.log("worker.shutdown-force", { signal });
      process.exit(0);
    }, cfg.JOB_WORKER_GRACE_MS).unref();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGHUP", () => shutdown("SIGHUP"));

  pool = new WorkerPool(cfg, cfg.WORKER_ID || undefined);
  pool
    .start()
    .then(() => {
      logger.log("worker.exiting", { workerId: pool?.workerId });
      process.exit(0);
    })
    .catch((e) => {
      logger.error("worker.fatal", {
        error: e instanceof Error ? e.message : String(e),
      });
      process.exit(1);
    });
}

main();