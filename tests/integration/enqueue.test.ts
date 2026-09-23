import { describe, expect, it } from "vitest";
import { POST as enqueueHandler } from "@/app/api/jobs/route";
import { config } from "@/lib/config";
import { countJobs, authHeader, jobById, makeEnqueueInput } from "../helpers";

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/jobs", () => {
  it("returns 202 Accepted, persists a pending job, and does no email work", async () => {
    const input = await makeEnqueueInput();
    const res = await enqueueHandler(makeRequest(input, authHeader()));
    expect(res.status).toBe(202);
    const { data } = await res.json();
    expect(data.jobId).toBeTypeOf("string");
    expect(data.status).toBe("pending");
    expect(data.idempotencyKey).toBe(input.idempotencyKey);
    expect(data.duplicate).toBe(false);

    const row = await jobById(data.jobId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(0);
    expect(row!.maxAttempts).toBe(config().JOB_MAX_ATTEMPTS);
    expect(row!.userId).toBe("alice");
    expect(row!.type).toBe("order-confirmation");
    expect(row!.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(row!.lastError).toBeNull();
    expect(row!.startedAt).toBeNull();
    expect(row!.finishedAt).toBeNull();
  });

  it("returns 401 without a bearer token", async () => {
    const res = await enqueueHandler(makeRequest(await makeEnqueueInput()));
    expect(res.status).toBe(401);
  });

  it("returns 401 with an unknown token", async () => {
    const res = await enqueueHandler(
      makeRequest(await makeEnqueueInput(), { Authorization: "Bearer nope" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for malformed JSON", async () => {
    const req = new Request("http://localhost/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: "{not json",
    });
    const res = await enqueueHandler(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid idempotency key", async () => {
    const input = await makeEnqueueInput();
    const res = await enqueueHandler(
      makeRequest({ ...input, idempotencyKey: "bad key with spaces" }, authHeader()),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unsupported job type", async () => {
    const input = await makeEnqueueInput();
    const res = await enqueueHandler(
      makeRequest({ ...input, type: "not-a-real-type" }, authHeader()),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid payload", async () => {
    const input = await makeEnqueueInput();
    const res = await enqueueHandler(
      makeRequest(
        {
          ...input,
          payload: { ...input.payload, recipientEmail: "not-an-email" },
        },
        authHeader(),
      ),
    );
    expect(res.status).toBe(400);
  });

  it("does not create a Job row when validation fails", async () => {
    const input = await makeEnqueueInput();
    await enqueueHandler(
      makeRequest({ ...input, idempotencyKey: "has spaces" }, authHeader()),
    );
    expect(await countJobs()).toBe(0);
  });
});