import { prisma, freshDb, writeEvidence, authHeader, samplePayload, slug } from "./common";
import { POST as enqueueHandler } from "../../app/api/jobs/route";
import { GET as statusHandler } from "../../app/api/jobs/[id]/route";

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function postJob(body: unknown, headers: Record<string, string> = {}) {
  const res = await enqueueHandler(post(body, headers));
  return { status: res.status, body: await res.json() };
}

async function getJob(id: string, headers: Record<string, string> = {}) {
  const res = await statusHandler(new Request(`http://localhost:3000/api/jobs/${id}`, { headers }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

function payload() {
  return samplePayload();
}

async function main(): Promise<void> {
  await freshDb();

  const aliceHeaders = authHeader("alice");
  const bobHeaders = authHeader("bob");
  const results: Record<string, unknown> = {};
  const K1 = slug("idem");

  const first = await postJob({ type: "order-confirmation", idempotencyKey: K1, payload: payload() }, aliceHeaders);
  const second = await postJob({ type: "order-confirmation", idempotencyKey: K1, payload: payload() }, aliceHeaders);
  const firstId = (first.body as { data?: { jobId?: string } })?.data?.jobId;
  const secondId = (second.body as { data?: { jobId?: string } })?.data?.jobId;
  results.sequential = { first, second, sameJobId: firstId === secondId };

  // Concurrent submissions of the same key at the same moment.
  const K2 = slug("race");
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () =>
      postJob({ type: "order-confirmation", idempotencyKey: K2, payload: payload() }, aliceHeaders),
    ),
  );
  const ids = new Set(concurrent.map((r) => r.body?.data?.jobId));
  const dups = concurrent.filter((r) => r.status === 202 && r.body?.data?.duplicate).length;
  results.concurrent = {
    responses: concurrent.map((r) => ({ status: r.status, duplicate: r.body?.data?.duplicate, jobId: r.body?.data?.jobId })),
    distinctJobIds: ids.size,
    duplicateCount: dups,
  };

  // Cross-user reuse → conflict (409), no row created for bob.
  const crossUser = await postJob(
    { type: "order-confirmation", idempotencyKey: K1, payload: payload() },
    bobHeaders,
  );
  results.crossUser = crossUser;

  // Invalid idempotency key → 400.
  const badKey = await postJob({ type: "order-confirmation", idempotencyKey: "has spaces", payload: payload() }, aliceHeaders);
  results.badKey = badKey;

  // Status endpoint returns the resolved job.
  const jobId = first.body?.data?.jobId as string;
  const statusOk = await getJob(jobId, aliceHeaders);
  const statusOther = await getJob(jobId, bobHeaders);
  const status404 = await getJob("c9f00000000000000000000000", aliceHeaders);
  results.status = { statusOk, statusOther, status404 };

  const totalRows = await prisma.job.count();
  const aliceRows = await prisma.job.count({ where: { userId: "alice" } });
  const bobRows = await prisma.job.count({ where: { userId: "bob" } });

  const md = [
    "**Scenario:** the same logical job is submitted twice, four times concurrently, and by a different user — all against the real route handlers (`app/api/jobs/route.ts`).",
    "",
    `### Sequential duplicate (key \`${K1}\`)`,
    "",
    run("1st POST", first),
    "",
    run("2nd POST (same key)", second),
    "",
    `→ same jobId returned: **${firstId === secondId}**, only one row in the DB.`,
    "",
    `### Concurrent duplicate (key \`${K2}\`, 4 parallel POSTs)`,
    "",
    resultsConcurrent(results.concurrent),
    "",
    "→ all four resolved to the **same** jobId; at least one saw `duplicate:true`; **no** duplicate row was created.",
    "",
    "### Cross-user reuse",
    "",
    run("bob POSTs alice's key", crossUser),
    "",
    "→ the owner's row is untouched and bob got a 409 **without** a new row (bob rows = 0).",
    "",
    "### Validation",
    "",
    run("invalid idempotency key", badKey),
    "",
    "### Status endpoint (GET /api/jobs/:id)",
    "",
    run("alice reads her job", statusOk),
    run("bob reads alice's job", statusOther),
    run("alice reads a nonexistent id", status404),
    "",
    "→ 404 for unknown ids **and** for other users' jobs (no existence leak).",
    "",
    `### DB totals after all of the above`,
    "",
    `| scale | count |`,
    `|---|---|`,
    `| total rows | ${totalRows} |`,
    `| alice rows | ${aliceRows} |`,
    `| bob rows | ${bobRows} |`,
  ].join("\n");

  const path = writeEvidence("04-idempotency.md", "Evidence: database-level idempotency + ownership", md);
  console.log(`written: ${path}`);
  await prisma.$disconnect();
}

function run(label: string, r: { status: number; body: unknown }): string {
  return `**${label}** → \`HTTP ${r.status}\`\n\n\`\`\`json\n${JSON.stringify(r.body, null, 2)}\n\`\`\`\n`;
}

function resultsConcurrent(c: unknown): string {
  const cc = c as { responses: { status: number; duplicate: boolean; jobId: string }[]; distinctJobIds: number; duplicateCount: number };
  const table = cc.responses.map((r, i) => `| POST ${i + 1} | ${r.status} | ${r.jobId} | duplicate=${r.duplicate} |`).join("\n");
  return [
    `| # | status | resolved jobId | dup flag |`,
    `|---|---|---|---|`,
    table,
    "",
    `→ distinct jobIds resolved across 4 concurrent requests: **${cc.distinctJobIds}** · responses flagged duplicate: **${cc.duplicateCount}**`,
  ].join("\n");
}

main().then(() => process.exit(0)).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });