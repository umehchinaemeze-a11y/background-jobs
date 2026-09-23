import { describe, expect, it } from "vitest";
import { POST as enqueueHandler } from "@/app/api/jobs/route";
import { GET as listHandler } from "@/app/api/jobs/route";
import { GET as statusHandler } from "@/app/api/jobs/[id]/route";
import { POST as retryHandler } from "@/app/api/jobs/[id]/retry/route";
import { prisma } from "@/lib/prisma";
import {
  authHeader,
  makeEnqueueInput,
  makeJsonPayloadForInsert,
  samplePayload,
  uniqueKey,
  USERS,
} from "../helpers";

function bodyOf(req: Request, body: unknown) {
  return new Request("http://localhost/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
  });
}

async function createJobFor(
  user: string,
  overrides: { status?: string; attempts?: number; maxAttempts?: number; key?: string } = {},
): Promise<string> {
  const input = await makeEnqueueInput();
  const res = await enqueueHandler(bodyOf(new Request("http://x"), input));
  const { data } = await res.json();
  await prisma.job.update({
    where: { id: data.jobId },
    data: {
      status: (overrides.status ?? "pending") as never,
      attempts: overrides.attempts ?? 0,
      maxAttempts: overrides.maxAttempts ?? 5,
      lastError: overrides.status === "dead" ? "exhausted" : null,
      finishedAt: overrides.status === "dead" ? new Date() : null,
      userId: user,
      idempotencyKey: overrides.key ?? input.idempotencyKey,
    },
  });
  return data.jobId;
}

async function createDeadJob(user: string): Promise<string> {
  const key = uniqueKey("dead");
  const job = await prisma.job.create({
    data: {
      userId: user,
      type: "order-confirmation",
      payload: makeJsonPayloadForInsert(samplePayload()),
      idempotencyKey: key,
      status: "dead",
      attempts: 5,
      maxAttempts: 5,
      lastError: "FORCED_TEST_FAILURE",
      finishedAt: new Date(),
    },
  });
  return job.id;
}

function requestWithToken(tokenUser: string) {
  return { headers: authHeader(tokenUser) };
}

describe("GET /api/jobs/:id (status)", () => {
  it("returns the caller's own job with full status", async () => {
    const id = await createJobFor(USERS.alice);
    const res = await statusHandler(
      new Request("http://x", requestWithToken(USERS.alice)),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.id).toBe(id);
    expect(data.status).toBe("pending");
    expect(data.attempts).toBe(0);
    expect(data.idempotencyKey).toBeTypeOf("string");
    // Ownership is enforced server-side; the owner is never echoed back.
    expect("userId" in data).toBe(false);
  });

  it("returns 404 for a job that does not exist", async () => {
    const res = await statusHandler(
      new Request("http://x", requestWithToken(USERS.alice)),
      { params: Promise.resolve({ id: "c00000000000000000000000" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for another user's job (no existence leak)", async () => {
    const id = await createJobFor(USERS.bob);
    const res = await statusHandler(
      new Request("http://x", requestWithToken(USERS.alice)),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 when not authenticated", async () => {
    const id = await createJobFor(USERS.alice);
    const res = await statusHandler(new Request("http://x"), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/jobs?status=dead (dead-letter view)", () => {
  it("lists only the caller's dead jobs", async () => {
    const mine = await createDeadJob(USERS.alice);
    await createDeadJob(USERS.bob);
    const res = await listHandler(
      new Request("http://localhost/api/jobs?status=dead", requestWithToken(USERS.alice)),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((j: { id: string }) => j.id === mine)).toBe(true);
    expect(data.every((j: { status: string }) => j.status === "dead")).toBe(true);
    expect(data.some((j: { id: string }) => j.id === mine)).toBe(true);
    // List view does not echo the owner.
    expect(data.every((j: Record<string, unknown>) => !("userId" in j))).toBe(true);
  });

  it("rejects an invalid status filter", async () => {
    const res = await listHandler(
      new Request("http://localhost/api/jobs?status=nope", requestWithToken(USERS.alice)),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/jobs/:id/retry (dead-letter manual retry)", () => {
  it("resets a dead job to pending with a fresh attempt budget", async () => {
    const id = await createDeadJob(USERS.alice);
    const res = await retryHandler(
      new Request("http://x", { method: "POST", ...requestWithToken(USERS.alice) }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.id).toBe(id);
    expect(data.status).toBe("pending");
    expect(data.attempts).toBe(0);
    expect(data.lastError).toBeNull();
    expect(data.finishedAt).toBeNull();
    const row = await prisma.job.findUnique({ where: { id } });
    expect(row!.status).toBe("pending");
    expect(row!.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("returns 404 when retrying someone else's dead job", async () => {
    const id = await createDeadJob(USERS.bob);
    const res = await retryHandler(
      new Request("http://x", { method: "POST", ...requestWithToken(USERS.alice) }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(404);
    const row = await prisma.job.findUnique({ where: { id } });
    expect(row!.status).toBe("dead"); // untouched
  });

  it("returns 409 when the job is not dead (not retryable)", async () => {
    const id = await createJobFor(USERS.alice, { status: "succeeded" });
    const res = await retryHandler(
      new Request("http://x", { method: "POST", ...requestWithToken(USERS.alice) }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(409);
  });

  it("returns 409 for the wrong idempotency shape on an already-pending job", async () => {
    const id = await createJobFor(USERS.alice, { status: "pending" });
    const res = await retryHandler(
      new Request("http://x", { method: "POST", ...requestWithToken(USERS.alice) }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(409);
  });
});