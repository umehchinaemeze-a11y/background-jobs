import { JobStatus, Prisma } from "@prisma/client";
import { enqueueJob } from "../lib/jobs";
import {
  orderConfirmationPayloadSchema,
  type OrderConfirmationPayload,
  type EnqueueInput,
} from "../lib/payload";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";

export const USERS = { alice: "alice", bob: "bob" } as const;

export function tokens(): Record<string, string> {
  return JSON.parse(process.env.AUTH_USERS ?? "{}") as Record<string, string>;
}

export function authHeader(user: string = USERS.alice): Record<string, string> {
  const t = tokens()[user];
  if (!t) throw new Error(`No token configured for user ${user}`);
  return { Authorization: `Bearer ${t}` };
}

let keyCounter = 0;
export function uniqueKey(prefix = "test"): string {
  keyCounter += 1;
  return `${prefix}/${Date.now().toString(36)}-${process.pid}-${keyCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A slug-safe unique token (no '/', no '$') for emails/order numbers. */
export function slug(prefix = "t"): string {
  keyCounter += 1;
  return `${prefix}${Date.now().toString(36)}${process.pid}${keyCounter}${Math.random().toString(36).slice(2, 8)}`;
}

export function samplePayload(
  overrides: Partial<OrderConfirmationPayload> = {},
): OrderConfirmationPayload {
  return orderConfirmationPayloadSchema.parse({
    orderNumber: `ORD-${slug("ord")}`,
    recipientEmail: `customer-${slug("to")}@example.com`,
    recipientName: "Alice",
    currency: "USD",
    items: [{ name: "Widget", quantity: 1, unitPriceCents: 1999 }],
    forceFailure: false,
    testDelayMs: 0,
    ...overrides,
  });
}

export async function enqueue(
  userId: string = USERS.alice,
  payload: OrderConfirmationPayload = samplePayload(),
  idempotencyKey: string = uniqueKey(),
) {
  return enqueueJob(userId, {
    type: "order-confirmation",
    idempotencyKey,
    payload,
  });
}

export async function makeEnqueueInput(
  overrides: Partial<EnqueueInput> = {},
): Promise<EnqueueInput> {
  return {
    type: "order-confirmation",
    idempotencyKey: uniqueKey(),
    payload: samplePayload(),
    ...overrides,
  };
}

export async function allJobs() {
  return prisma.job.findMany({ orderBy: { createdAt: "asc" } });
}

export async function jobById(id: string) {
  return prisma.job.findUnique({ where: { id } });
}

export async function countJobs(status?: JobStatus | JobStatus[]): Promise<number> {
  return prisma.job.count({
    where: status !== undefined ? { status: Array.isArray(status) ? { in: status } : status } : {},
  });
}

export async function countDeliveries(): Promise<number> {
  return prisma.jobOutput.count();
}

export async function claimFromDb(
  jobId: string,
  workerId = "test-claim",
): Promise<{ ok: boolean }> {
  const res = await prisma.$executeRaw(
    Prisma.sql`UPDATE "Job" SET "status"='processing', "startedAt"=now(), "claimedBy"=${workerId} WHERE id=${jobId} AND "status" IN ('pending','failed') AND "runAt" <= now()`,
  );
  return { ok: res === 1 };
}

export function makeJsonPayloadForInsert(payload: OrderConfirmationPayload): Prisma.InputJsonValue {
  // OrderConfirmationPayload is a plain object compatible with InputJsonValue.
  return payload as unknown as Prisma.InputJsonValue;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LogLine {
  ts: string;
  level: string;
  event: string;
  [key: string]: unknown;
}

export function captureLogs(): { lines: LogLine[]; restore: () => void } {
  const previous = logger.getSink();
  const lines: LogLine[] = [];
  logger.setSink({ line: (o: unknown) => lines.push(o as LogLine) });
  return {
    lines,
    restore: () => logger.setSink(previous),
  };
}

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
  pollMs = 150,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(pollMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}