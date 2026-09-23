import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadConfig, resetConfigForTests } from "../../lib/config";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { enqueueJob } from "../../lib/jobs";
import { resetEmailSenderForTests } from "../../worker/email";
import { orderConfirmationPayloadSchema, type OrderConfirmationPayload } from "../../lib/payload";

// ── env ────────────────────────────────────────────────────────────────────

function ensureEnv(): void {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(resolve(".env"));
    } catch { /* ignore */ }
  }
}
ensureEnv();
loadConfig();

export { prisma, loadConfig };

// Persistently pin THIS process to the no-op test adapter. Used by every
// break-it scenario except 07 so that in-process pools (01/02/03/05) can never
// send real emails just because the developer's .env happens to have a resend
// key set. Spawned child workers already get test via BASE_WORKER_ENV.
export function forceTestVendor(): void {
  process.env.EMAIL_PROVIDER_VENDOR = "test";
  process.env.TEST_FORCE_EMAIL_FAILURE = "0";
  process.env.TEST_EMAIL_DELAY_MS = "0";
  resetConfigForTests();
  resetEmailSenderForTests();
  loadConfig();
}

// ── helpers ────────────────────────────────────────────────────────────────

let _keyId = 0;
export function slug(prefix = "e"): string {
  _keyId += 1;
  return `${prefix}${Date.now().toString(36)}${process.pid}${_keyId}${Math.random().toString(36).slice(2, 7)}`;
}

export function samplePayload(overrides: Partial<OrderConfirmationPayload> = {}): OrderConfirmationPayload {
  return orderConfirmationPayloadSchema.parse({
    orderNumber: `ORD-${slug("ord")}`,
    recipientEmail: `cust-${slug("to")}@example.com`,
    recipientName: "Alice",
    currency: "USD",
    items: [{ name: "Widget", quantity: 1, unitPriceCents: 1999 }],
    forceFailure: false,
    testDelayMs: 0,
    ...overrides,
  });
}

export const USERS = { alice: "alice", bob: "bob" } as const;
export function authHeader(user: string = USERS.alice): Record<string, string> {
  return { Authorization: `Bearer ${tokens()[user]}` };
}
export function tokens(): Record<string, string> {
  return JSON.parse(process.env.AUTH_USERS ?? "{}") as Record<string, string>;
}

export async function enqueue(userId: string = USERS.alice, payload: OrderConfirmationPayload = samplePayload(), idempotencyKey?: string) {
  return enqueueJob(userId, { type: "order-confirmation", idempotencyKey: idempotencyKey ?? slug("key"), payload });
}

export async function freshDb(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Job" CASCADE');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── log capture (in-process) ───────────────────────────────────────────────

export interface LogLine {
  ts: string;
  level: string;
  event: string;
  [key: string]: unknown;
}

export function captureLogs(): { lines: LogLine[]; restore: () => void } {
  const prev = logger.getSink();
  const lines: LogLine[] = [];
  logger.setSink({ line: (o) => lines.push(o as LogLine) });
  return { lines, restore: () => logger.setSink(prev) };
}

// ── in-process pool runner ─────────────────────────────────────────────────

// ── child worker spawning ──────────────────────────────────────────────────

const TSX_CLI = resolve("node_modules/tsx/dist/cli.mjs");
const NEXT_BIN = resolve("node_modules/next/dist/bin/next");

const BASE_WORKER_ENV = () => ({
  DATABASE_URL: process.env.DATABASE_URL!,
  EMAIL_PROVIDER_VENDOR: "test",
  TEST_FORCE_EMAIL_FAILURE: "0",
  TEST_EMAIL_DELAY_MS: "0",
  EMAIL_PROVIDER_FROM: "Acme Store <orders@example.com>",
  AUTH_USERS: process.env.AUTH_USERS ?? '{"alice":"tok_alice_dev","bob":"tok_bob_dev"}',
  JOB_MAX_ATTEMPTS: "5",
  JOB_RETRY_MAX_DELAY_MS: "5000",
  JOB_WORK_TIMEOUT_MS: "30000",
  JOB_STUCK_TIMEOUT_MS: "2000",
});

export interface SpawnedProcess {
  proc: ReturnType<typeof import("node:child_process").spawn>;
  pid: number;
  stdout: string[];
  stderr: string[];
  cmdline: string;
  waitForReady(regexOrMs: string | number, timeoutMs?: number): Promise<boolean>;
  stop(): Promise<void>;
}

export function spawnWorker(envOverrides: Record<string, string> = {}): SpawnedProcess {
  const env = { ...process.env, ...BASE_WORKER_ENV(), ...envOverrides };
  const proc = spawn(process.execPath, [TSX_CLI, "worker/index.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
  proc.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  const readyLines = stdout;
  return {
    proc,
    pid: proc.pid!,
    stdout,
    stderr,
    cmdline: `tsx worker/index.ts [env: ${Object.keys(envOverrides).join(",")}]`,
    async waitForReady(pattern, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const full = readyLines.join("");
        if (typeof pattern === "number") { await sleep(pattern); return true; }
        if (full.includes(pattern)) return true;
        await sleep(150);
      }
      return false;
    },
    async stop() {
      if (proc.killed || proc.exitCode !== null) return;
      try { proc.kill("SIGTERM"); } catch {}
      await Promise.race([new Promise<void>((r) => proc.on("exit", () => r())), sleep(5000)]);
      if (!proc.killed && proc.exitCode === null) {
        try { execFileSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "pipe" }); } catch {}
      }
    },
  };
}

export function spawnNextDev(port = 3444, extraEnv: Record<string, string> = {}): SpawnedProcess {
  const env = { ...process.env, ...BASE_WORKER_ENV(), PORT: String(port), ...extraEnv };
  const proc = spawn(process.execPath, [NEXT_BIN, "dev", "-p", String(port)], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
  proc.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  return {
    proc,
    pid: proc.pid!,
    stdout,
    stderr,
    cmdline: `next dev -p ${port}`,
    async waitForReady(pattern, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const full = (stdout.join("") + stderr.join("")).toLowerCase();
        if (typeof pattern === "number") { await sleep(pattern); return true; }
        if (full.includes(pattern.toLowerCase())) return true;
        await sleep(300);
      }
      return false;
    },
    async stop() {
      if (proc.killed || proc.exitCode !== null) return;
      try { proc.kill("SIGTERM"); } catch {}
      await Promise.race([new Promise<void>((r) => proc.on("exit", () => r())), sleep(5000)]);
      if (!proc.killed && proc.exitCode === null) {
        try { execFileSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "pipe" }); } catch {}
      }
    },
  };
}

// ── evidence writer ────────────────────────────────────────────────────────

mkdirSync(resolve("evidence"), { recursive: true });

export function writeEvidence(filename: string, title: string, md: string): string {
  const header = `# ${title}\n\n> Generated by \`scripts/breakit/${filename.replace(/\.md$/i, ".ts")}\` on ${new Date().toISOString()}\n\n`;
  const filePath = resolve("evidence", filename);
  writeFileSync(filePath, header + md, "utf8");
  return filePath;
}

export function excerptLines(lines: string[], maxLen = 3_000): string {
  const joined = lines.join("\n");
  if (joined.length <= maxLen) return joined;
  const head = joined.slice(0, Math.ceil(maxLen / 2));
  const tail = joined.slice(-Math.ceil(maxLen / 2));
  return `${head}\n\n... (${lines.length} lines total, excerpt) ...\n\n${tail}`;
}

export function excerptJson(obj: unknown, maxLen = 2_000): string {
  const s = JSON.stringify(obj, null, 2);
  return s.length > maxLen ? s.slice(0, maxLen - 20) + "\n... (truncated)" : s;
}

export async function httpJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
