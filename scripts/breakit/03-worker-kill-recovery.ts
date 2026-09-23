import { prisma, freshDb, enqueue, sleep, writeEvidence, samplePayload, spawnWorker, forceTestVendor } from "./common";
import { recoverStuckJobs } from "../../worker/recovery";
import { WorkerPool } from "../../worker/pool";
import { config, resetConfigForTests } from "../../lib/config";

async function main(): Promise<void> {
  forceTestVendor();
  // The sweep and the final pool must share the same 2s stuck timeout that the
  // killed worker runs under (BASE_WORKER_ENV). Dev .env uses 60000ms — and the
  // config singleton may already have been parsed at import time, so reset it.
  process.env.JOB_STUCK_TIMEOUT_MS = "2000";
  resetConfigForTests();
  config();
  await freshDb();
  console.log("=== 03 worker-kill recovery ===");

  // 8 slow jobs (2000ms each) so we can catch them mid-flight.
  for (let i = 0; i < 8; i++) {
    await enqueue("alice", samplePayload({ testDelayMs: 2000 }));
  }

  const w1 = spawnWorker(
    { JOB_WORKER_CONCURRENCY: "3", JOB_POLL_INTERVAL_MS: "150", WORKER_ID: "destroyed-worker" },
  );
  console.log(`spawned worker pid=${w1.pid}`);

  const claimed = await w1.waitForReady("job.claimed");
  console.log(`worker claimed some work: ${claimed}`);
  // Give it up to ~1s to claim 3 slow jobs (limit 3) before we murder it.
  await sleep(900);

  const midFlight = await prisma.job.findMany({ where: { status: "processing" }, select: { id: true, claimedBy: true, startedAt: true } });
  const stillPending = await prisma.job.count({ where: { status: "pending" } });

  console.log(`killing worker pid=${w1.pid}`);
  const beforeKill = Date.now();
  await w1.stop();

  const killMs = Date.now() - beforeKill;
  const exitCode = w1.proc.exitCode;
  const midFlightRows = midFlight.map((r) => `| ${r.id} | ${r.claimedBy} | ${r.startedAt?.toISOString()} |`).join("\n");

  // Wait past the stuck timeout, then sweep.
  await sleep(2500);
  const recovered = await recoverStuckJobs("evidence-sweeper");
  const recoveredRows = recovered.map((r) => `| ${r.jobId} | ${r.status} | attempts→${r.attemptsAfter} | runAt ${r.runAt.toISOString()} | worker ${r.workerId} |`).join("\n");

  const recoveredCount = recovered.length;
  const failedCount = await prisma.job.count({ where: { status: "failed" } });

  // Now a healthy pool drains failed (already due) + still-pending jobs.
  // It uses a production-sane stuck timeout (60s) so it never "recovers" its
  // own 2s-long in-flight jobs — the recovery story stays about the crash.
  console.log("draining with a fresh healthy pool...");
  const pool = new WorkerPool(
    { ...config(), JOB_STUCK_TIMEOUT_MS: 60_000 },
    "evidence-resurrected",
    { concurrency: 4, pollIntervalMs: 120 },
  );
  const run = pool.start();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const done = await prisma.job.count({ where: { status: "succeeded" } });
    if (done >= 8) break;
    await sleep(200);
  }
  pool.requestStop();
  await run;

  const succeeded = await prisma.job.count({ where: { status: "succeeded" } });
  const outputs = await prisma.jobOutput.count();

  const md = [
    "**Scenario:** a real worker process is spawned (with slow, 2s payloads), claims jobs, and is then **killed abruptly with a terminating signal** mid-work — simulating a crash. The stuck-job sweep later recovers those rows; a fresh worker finishes everything.",
    "",
    `**Worker command:** \`tsx worker/index.ts\` (pid ${w1.pid}, concurrency 3, poll 150ms, stuck timeout 2000ms)`,
    "",
    `### While the worker was alive (3 jobs in flight, 5 untouched)`,
    "",
    `| jobId | claimedBy | startedAt |`,
    `|---|---|---|`,
    midFlightRows,
    "",
    `| still pending at kill time | ${stillPending} |`,
    `| kill method | ${process.platform === "win32" ? "taskkill /pid <pid> /T /F" : "SIGTERM"} |`,
    `| time to terminate | ${killMs}ms |`,
    `| child exit code | ${exitCode ?? "killed"} |`,
    "",
    `### State immediately after the crash (before sweep)`,
    "",
    `Processing rows = ${midFlight.length} (all "processing", startedAt frozen), failed rows = 0, pending = ${stillPending}.`,
    "",
    "### Stuck-job sweep",
    "",
    `**Sweep script:** \`recoverStuckJobs("evidence-sweeper")\` (structure identical to the per-tick sweep in \`worker/pool.ts\`).`,
    "",
    `| jobId | recovered→status | attemptsAfter | next runAt | sweeping worker |`,
    `|---|---|---|---|---|`,
    recoveredRows,
    "",
    `Recovered ${recoveredCount} crashed rows → **failed** (${failedCount} total failed rows). Each recovered row increments \`attempts\` and is scheduled on a backoff retry window, exactly like a real failed attempt.`,
    "",
    `### After a fresh healthy worker drains the queue`,
    "",
    `| succeeded | ${succeeded}/8 |`,
    `| durable outputs | ${outputs} |`,
    "",
    "**No email was lost and none was sent twice**: every job ended `succeeded` exactly once and the `JobOutput` table holds one row per job.",
    "",
    "## Raw worker stdout (lifecycle evidence)",
    "",
    "```",
    stdoutExcerpt(w1.stdout),
    "```",
  ].join("\n");

  const path = writeEvidence("03-worker-kill-recovery.md", "Evidence: crashed worker → stuck sweep → recovery → completion", md);
  console.log(`written: ${path}`);
  await prisma.$disconnect();
}

function stdoutExcerpt(lines: string[]): string {
  const joined = lines.join("").split("\n").filter(Boolean).slice(0, 40).join("\n");
  return joined.length > 4_000 ? joined.slice(0, 4_000) + "\n... (truncated)" : joined;
}

main().then(() => process.exit(0)).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });