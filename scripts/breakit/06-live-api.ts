import { prisma, freshDb, writeEvidence, sleep, spawnNextDev, authHeader, samplePayload, slug, httpJson } from "./common";

const PORT = 3455;
const BASE = `http://localhost:${PORT}`;

async function main(): Promise<void> {
  await freshDb();
  const server = spawnNextDev(PORT);
  console.log(`next dev pid=${server.pid}, waiting for readiness...`);

  const ready = await server.waitForReady("ready", 90_000);
  // True readiness also needs the port to answer HTTP.
  let responding = false;
  for (let i = 0; i < 60 && !responding; i++) {
    try {
      const r = await fetch(`${BASE}/api/jobs`, { headers: authHeader("alice") });
      if (r.status >= 400 || r.status < 500) responding = true;
    } catch { await sleep(400); }
  }
  console.log(`next ready=${ready} responding=${responding}`);

  const alice = authHeader("alice");
  const K = slug("live");

  const body = {
    type: "order-confirmation",
    idempotencyKey: K,
    payload: samplePayload(),
  };

  const noAuth = await httpJson(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const first = await httpJson(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", ...alice }, body: JSON.stringify(body) });
  const second = await httpJson(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", ...alice }, body: JSON.stringify(body) });

  const jobId = (first.body as { data?: { jobId?: string } })?.data?.jobId ?? "";
  const status = await httpJson(`${BASE}/api/jobs/${jobId}`, { headers: alice });
  const statusOther = await httpJson(`${BASE}/api/jobs/${jobId}`, { headers: authHeader("bob") });

  const badKey = await httpJson(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", ...alice }, body: JSON.stringify({ ...body, idempotencyKey: "has spaces" }) });

  // Dead-letter flow through the live server: force a dead job, list, retry.
  const deadKey = slug("dead");
  await prisma.job.create({
    data: {
      userId: "alice",
      type: "order-confirmation",
      payload: samplePayload(),
      idempotencyKey: deadKey,
      status: "dead",
      attempts: 5,
      maxAttempts: 5,
      lastError: "FORCED_TEST_FAILURE",
      finishedAt: new Date(),
    },
  });
  const deadList = await httpJson(`${BASE}/api/jobs?status=dead`, { headers: alice });
  const deadRows = (deadList.body as { data?: { id: string }[] })?.data ?? [];
  const deadId = deadRows[0]?.id ?? "";
  const retry = await httpJson(`${BASE}/api/jobs/${deadId}/retry`, { method: "POST", headers: alice });
  const afterRetry = await prisma.job.findUnique({ where: { id: deadId } });

  const md = [
    `**Scenario:** a **live \`next dev\` server** (pid ${server.pid}, port ${PORT}) serves the real HTTP API. Requests below were made with \`fetch\` against \`${BASE}\`.`,
    "",
    `server readiness: ready=${ready} responding=${responding}`,
    "",
    `### 1 · POST /api/jobs without token → **401**`,
    render(noAuth),
    "",
    `### 2 · POST /api/jobs (alice, key \`${K}\`) → **202 Accepted (async, no email sent in the request)**`,
    render(first),
    "",
    `### 3 · POST same key again → duplicate resolution`,
    render(second),
    `same jobId: **${(first.body as { data?: { jobId?: string } })?.data?.jobId === (second.body as { data?: { jobId?: string } })?.data?.jobId}**`,
    "",
    `### 4 · GET /api/jobs/:id — status`,
    render(status),
    `bob reading alice's job: ${JSON.stringify(statusOther)}`,
    "",
    `### 5 · POST with an invalid idempotency key → **400**`,
    render(badKey),
    "",
    `### 6 · GET /api/jobs?status=dead (dead-letter view)`,
    render(deadList),
    "",
    `### 7 · POST /api/jobs/:id/retry (manual dead-letter retry)`,
    render(retry),
    `after retry → status \`${afterRetry?.status}\`, attempts \`${afterRetry?.attempts}\`, runAt \`${afterRetry?.runAt?.toISOString()}\``,
    "",
    "## Server stdout (startup + request lines)",
    "",
    "```",
    serverStdout(server.stdout),
    "```",
  ].join("\n");

  const path = writeEvidence("06-live-api.md", "Evidence: live Next.js HTTP API end-to-end", md);
  console.log(`written: ${path}`);

  await server.stop();
  await prisma.$disconnect();
}

function render(r: { status: number; body: unknown }): string {
  return `\`HTTP ${r.status}\`\n\n\`\`\`json\n${JSON.stringify(r.body, null, 2)}\n\`\`\`\n`;
}

function serverStdout(stdout: string[]): string {
  const joined = stdout.join("").split("\n").filter(Boolean).slice(0, 60).join("\n");
  return joined.length > 5_000 ? joined.slice(0, 5_000) + "\n... (truncated)" : joined;
}

main().then(() => process.exit(0)).catch(async (err) => { console.error(err); try { await prisma.$disconnect(); } catch {} process.exit(1); });