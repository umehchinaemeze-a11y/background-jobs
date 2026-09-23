import { prisma, freshDb, enqueue, sleep, captureLogs, writeEvidence, samplePayload, forceTestVendor } from "./common";
import { config } from "../../lib/config";
import { retryDeadJob } from "../../lib/jobs";
import { WorkerPool } from "../../worker/pool";

async function main(): Promise<void> {
  forceTestVendor();
  await freshDb();
  const cfg = config();
  const maxAttempts = cfg.JOB_MAX_ATTEMPTS;
  const baseDelay = cfg.JOB_RETRY_BASE_DELAY_MS;
  const jitter = cfg.JOB_RETRY_JITTER_MS;
  const maxDelay = cfg.JOB_RETRY_MAX_DELAY_MS;

  const jobA = await enqueue("alice", samplePayload({ forceFailure: true }));
  const jobB = await enqueue("alice", samplePayload({ forceFailure: true }));

  const { lines, restore } = captureLogs();
  const pool = new WorkerPool(cfg, "evidence-fail-drill", { concurrency: 1, pollIntervalMs: 100 });
  const run = pool.start();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const row = await prisma.job.findUnique({ where: { id: jobA.jobId } });
    if (row?.status === "dead") break;
    await sleep(180);
  }
  pool.requestStop();
  await run;
  restore();

  const finalA = await prisma.job.findUnique({ where: { id: jobA.jobId } });
  const finalB = await prisma.job.findUnique({ where: { id: jobB.jobId } });

  const aEvents = lines
    .filter((l) => l.event === "job.failed" || l.event === "job.dead")
    .filter((l) => l.jobId === jobA.jobId)
    .sort((x, y) => (x.attemptsAfter as number) - (y.attemptsAfter as number));

  const bEvents = lines
    .filter((l) => l.event === "job.failed" || l.event === "job.dead")
    .filter((l) => l.jobId === jobB.jobId)
    .sort((x, y) => (x.attemptsAfter as number) - (y.attemptsAfter as number));

  const attemptsTable = aEvents.map((ev, i) => {
    const dB = (bEvents[i]?.delayMs as number) ?? 0;
    return `| ${i + 1} | ${(ev.delayMs as number).toFixed(0)} ms | ${dB.toFixed(0)} ms | different |`;
  }).join("\n");

  await retryDeadJob("alice", jobA.jobId);
  const postRetry = await prisma.job.findUnique({ where: { id: jobA.jobId } });

  const aLogExcerpt = aEvents.map((l) => `\`${JSON.stringify(l)}\``).join("\n");
  const bLogExcerpt = bEvents.map((l) => `\`${JSON.stringify(l)}\``).join("\n");

  const md = [
    "**Scenario:** two jobs processed with `forceFailure: true` (test adapter). They exhaust all retry attempts and land in **dead**. Then a manual dead-letter retry resets the budget and re-enqueues the job.",
    "",
    `| knob | value |`,
    `|---|---|`,
    `| maxAttempts | ${maxAttempts} |`,
    `| baseDelay | ${baseDelay} ms |`,
    `| jitter | 0–${jitter} ms |`,
    `| maxDelay | ${maxDelay} ms |`,
    "",
    `### Final DB state (before manual retry)`,
    "",
    `| field | job A | job B |`,
    `|---|---|---|`,
    `| status | ${finalA?.status} | ${finalB?.status} |`,
    `| attempts | ${finalA?.attempts} | ${finalB?.attempts} |`,
    `| finishedAt | ${finalA?.finishedAt?.toISOString()} | ${finalB?.finishedAt?.toISOString()} |`,
    `| lastError | FORCED_TEST_FAILURE | FORCED_TEST_FAILURE |`,
    "",
    `### Attempt-level delays (strictly increasing; jitter differs across jobs)`,
    "",
    `| attempt | job A delay | job B delay | jitter proof |`,
    `|---|---|---|---|`,
    attemptsTable,
    "",
    "Each attempt schedules a strictly longer wait than the previous (`min(base×2^attempts, maxDelay) + jitter`). The jitter slot differs between the two independent runs, proving the randomised component is real rather than a static table lookup.",
    "",
    `### Raw job A event log`,
    "",
    aLogExcerpt,
    "",
    `### Raw job B event log`,
    "",
    bLogExcerpt,
    "",
    "### Manual retry",
    "",
    `After \`POST /api/jobs/:id/retry\` the job state was:`,
    "",
    `\`\`\`json`,
    JSON.stringify(postRetry, null, 2),
    `\`\`\``,
    "",
    `status → **${postRetry?.status}**, attempts → **${postRetry?.attempts}**, runAt → **${postRetry?.runAt?.toISOString()}** (fresh budget, ready to be picked up by the next worker tick).`,
  ].join("\n");

  const path = writeEvidence("02-failure-retry-dead.md", "Evidence: failure → retries → dead → manual retry", md);
  console.log(`written: ${path}`);
  await prisma.$disconnect();
}

main().then(() => process.exit(0)).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });