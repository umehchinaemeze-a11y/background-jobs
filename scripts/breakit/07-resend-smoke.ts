import { config, resetConfigForTests } from "../../lib/config";
import { prisma, freshDb, enqueue, sleep, slug, writeEvidence, samplePayload } from "./common";
import { getEmailSender, resetEmailSenderForTests, EmailProviderError } from "../../worker/email";
import { renderOrderEmailHtml } from "../../lib/payload";
import { WorkerPool } from "../../worker/pool";

/**
 * LIVE PROVIDER SMOKE TEST (matrix item #12)
 *
 * This is the only scenario that REQUIRES a real API key, so by default it is a
 * no-op that documents itself as SKIPPED. Enable it by setting, in `.env`:
 *
 *   EMAIL_PROVIDER_VENDOR=resend
 *   EMAIL_PROVIDER_API_KEY=re_................................................
 *   EMAIL_PROVIDER_FROM=Acme <orders@your-domain.com>   (a verified sender)
 *   RESEND_SMOKE_TO=you@example.com                     (your own inbox)
 *
 * When enabled it makes REAL outbound email sends and verifies:
 *   A. a real send succeeds and returns a real message id  (not a `test:` id)
 *   B. Resend's 24h Idempotency-Key dedupe: identical replay returns the SAME id
 *   C. Resend's 409: same key with a DIFFERENT payload is rejected
 *   D. the full worker pipeline (claim → send → JobOutput → succeeded) with vendor=resend
 *
 * The API key is never written into evidence/ stdout.
 */

const SKIP_REASONS: string[] = [];

function ready(): boolean {
  if (process.env.EMAIL_PROVIDER_VENDOR !== "resend") {
    SKIP_REASONS.push("EMAIL_PROVIDER_VENDOR is not set to `resend` in .env");
  }
  if (!process.env.EMAIL_PROVIDER_API_KEY) {
    SKIP_REASONS.push("EMAIL_PROVIDER_API_KEY is not set");
  }
  if (!process.env.RESEND_SMOKE_TO) {
    SKIP_REASONS.push("RESEND_SMOKE_TO (the recipient inbox for the live smoke email) is not set");
  }
  return SKIP_REASONS.length === 0;
}

async function main(): Promise<number> {
  config();

  if (!ready()) {
    const md = [
      "**Scenario:** live Resend delivery (acceptance matrix item #12).",
      "",
      "**NOT RUN — skipped because the environment is not configured for live sends.**",
      "",
      "To enable, add to `.env`:",
      "",
      "```",
      "EMAIL_PROVIDER_VENDOR=resend",
      "EMAIL_PROVIDER_API_KEY=re_<your key>",
      "EMAIL_PROVIDER_FROM=Acme <orders@your-domain.com>   # a verified sender",
      "RESEND_SMOKE_TO=<your own inbox>",
      "```",
      "",
      "Then re-run: `npm run breakit`.",
      "",
      ...SKIP_REASONS.map((r) => `- ${r}`),
    ].join("\n");
    const path = writeEvidence("07-resend-live.md", "Evidence: live Resend delivery (SKIPPED)", md);
    console.log(`written: ${path}`);
    console.log(`07-resend-smoke: SKIPPED (${SKIP_REASONS.length} reason(s)). Enable via .env as described in the evidence file.`);
    return 0;
  }

  // Force this process to use the resend adapter (config + sender singletons).
  process.env.EMAIL_PROVIDER_VENDOR = "resend";
  resetConfigForTests();
  const cfg = config();
  resetEmailSenderForTests();
  const sender = getEmailSender();

  await freshDb();
  console.log("=== 07 resend smoke (LIVE EMAILS WILL BE SENT) ===");

  const to = process.env.RESEND_SMOKE_TO as string;
  const payload = samplePayload({ recipientName: "Resend Smoke", recipientEmail: to });
  const subject = `Order ${payload.orderNumber} confirmed`;
  const html = renderOrderEmailHtml(payload);
  const keyA = `smoke-${slug("k")}`;
  const keyB = `smoke-${slug("k")}`;

  // A · real send -----------------------------------------------------------
  const tA = Date.now();
  const sentA = await sender.send({ from: cfg.EMAIL_PROVIDER_FROM, to, subject, html, idempotencyKey: keyA });
  const aMs = Date.now() - tA;

  // B · identical replay within the 24h idempotency window -------------------
  const tB = Date.now();
  const sentB = await sender.send({ from: cfg.EMAIL_PROVIDER_FROM, to, subject, html, idempotencyKey: keyA });
  const bMs = Date.now() - tB;
  const deduped = sentB.providerMessageId === sentA.providerMessageId;

  // C · same key, different payload → Resend must reject with 409 ------------
  let cObserved = "";
  let cPass = false;
  try {
    const other = { from: cfg.EMAIL_PROVIDER_FROM, to, subject: `${subject} (CORRUPTED REPLAY)`, html: "<p>different body</p>", idempotencyKey: keyA };
    const sentC = await sender.send(other);
    cObserved = `accepted (new id ${sentC.providerMessageId}) — Resend did NOT enforce key uniqueness across a different payload`;
  } catch (e) {
    cObserved =
      e instanceof EmailProviderError
        ? `rejected with HTTP ${e.statusCode} (${e.providerCode ?? "provider error"})`
        : `threw non-provider error: ${e instanceof Error ? e.message : String(e)}`;
    cPass = e instanceof EmailProviderError && e.statusCode === 409;
  }

  // D · full worker pipeline with the real adapter ----------------------------
  const job = await enqueue("alice", payload, keyB);
  const pool = new WorkerPool(cfg, "resend-smoke", { concurrency: 1, pollIntervalMs: 150 });
  const run = pool.start();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const row = await prisma.job.findUnique({ where: { id: job.jobId }, select: { status: true } });
    if (row?.status === "succeeded") break;
    await sleep(200);
  }
  pool.requestStop();
  await run;

  const finished = await prisma.job.findUnique({ where: { id: job.jobId }, select: { status: true } });
  const output = await prisma.jobOutput.findUnique({ where: { jobId: job.jobId } });
  const pipelineDelivered = finished?.status === "succeeded" && output !== null;

  const passA = sentA.providerMessageId.length > 0 && !sentA.providerMessageId.startsWith("test:");
  const passB = deduped;
  const passAll = passA && passB && cPass && pipelineDelivered;

  const md = [
    "**Scenario:** live Resend delivery (acceptance matrix item #12) — REAL emails were sent to:",
    "",
    `**to:** \`${to}\``,
    `**from:** \`${cfg.EMAIL_PROVIDER_FROM}\``,
    `**recipient name:** ${payload.recipientName}`,
    "",
    "### A · Direct adapter send",
    "",
    `- providerMessageId: \`${sentA.providerMessageId}\` (real resend id, not a \`test:\` id) → **${passA ? "PASS" : "FAIL"}**`,
    `- round-trip: ${aMs}ms`,
    "",
    "### B · Resend 24h Idempotency-Key dedupe (identical replay)",
    "",
    `- replayed with the same \`Idempotency-Key\` (\`${keyA}\`) and identical body`,
    `- returned message id: \`${sentB.providerMessageId}\` in ${bMs}ms`,
    `- same id as the original: **${deduped ? "yes (deduplicated, no second send)" : "NO — duplicate-send window"}** → **${passB ? "PASS" : "FAIL"}**`,
    "",
    "### C · Same key + different payload",
    "",
    `- ${cObserved} → **${cPass ? "PASS (expected 409)" : "OBSERVE"}**`,
    "",
    "### D · Full worker pipeline with the real adapter",
    "",
    `- dedicated key: \`${keyB}\` (see your inbox: \`${to}\` — a second, pipeline-sent email)`,
    `- final job status: \`${finished?.status}\`, JobOutput row: **${output ? `yes (${output.providerMessageId})` : "no"}** → **${pipelineDelivered ? "PASS" : "FAIL"}**`,
    "",
    "### Overall",
    "",
    `**${passAll ? "PASS 🎉 — live Resend delivery verified (matrix item #12)." : "FAIL — see A/B/C/D above."}**`,
    "",
    "> The API key is intentionally never written to this file.",
  ].join("\n");

  const path = writeEvidence("07-resend-live.md", "Evidence: live Resend delivery", md);
  console.log(`written: ${path}`);
  await prisma.$disconnect();
  return passAll ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });