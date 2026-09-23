"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types – subset of JobView returned by the status endpoint.
// ---------------------------------------------------------------------------
type JobView = {
  id: string;
  type: string;
  status: "pending" | "processing" | "succeeded" | "failed" | "dead";
  attempts: number;
  maxAttempts: number;
  runAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  idempotencyKey: string;
  createdAt: string;
  context: { orderNumber: string; recipientEmail: string };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TOKEN_KEY = "bg-job-token";
const POLL_MS = 1_500;
const TERMINAL = new Set(["succeeded", "dead"]);

function readToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

function saveToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}

function isoOrBlank(s: string | null): string {
  return s ? new Date(s).toLocaleTimeString() : "—";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function HomePage() {
  // Token state
  const [token, setToken] = useState(readToken);
  const onTokenChange = (v: string) => {
    setToken(v);
    saveToken(v);
  };

  // Enqueue form state
  const [orderNumber, setOrderNumber] = useState(() => `ORD-${Date.now().toString(36)}`);
  const [recipientEmail, setRecipientEmail] = useState("alice@example.com");
  const [recipientName, setRecipientName] = useState("Alice");
  const [idempotencyKey, setIdempotencyKey] = useState(() => `order/${Date.now().toString(36)}`);
  const [forceFailure, setForceFailure] = useState(false);
  const [testDelayMs, setTestDelayMs] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [enqueueError, setEnqueueError] = useState("");

  // Status tracking
  const [job, setJob] = useState<JobView | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPoll = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  const poll = useCallback(
    (jobId: string) => {
      clearPoll();
      const run = async () => {
        try {
          const res = await fetch(`/api/jobs/${jobId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) return; // keep polling on transient errors
          const body = await res.json();
          const j: JobView | undefined = body.data;
          if (!j) return;
          setJob(j);
          if (TERMINAL.has(j.status)) clearPoll();
        } catch {
          /* network glitch – keep trying */
        }
      };
      run();
      pollRef.current = setInterval(run, POLL_MS);
    },
    [token],
  );

  useEffect(() => {
    return () => clearPoll();
  }, []);

  const enqueue = async () => {
    if (!token) {
      setEnqueueError("Enter an API token first");
      return;
    }
    setEnqueueError("");
    setSubmitting(true);
    setJob(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: "order-confirmation",
          idempotencyKey,
          payload: {
            orderNumber,
            recipientEmail,
            recipientName: recipientName || undefined,
            currency: "USD",
            items: [
              {
                name: "Widget",
                quantity: 1,
                unitPriceCents: 1999,
              },
            ],
            forceFailure,
            testDelayMs,
          },
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setEnqueueError(body.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const j: JobView = {
        id: body.data.jobId,
        type: "order-confirmation",
        status: body.data.status,
        attempts: 0,
        maxAttempts: 5,
        runAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        lastError: null,
        idempotencyKey: body.data.idempotencyKey,
        createdAt: new Date().toISOString(),
        context: { orderNumber, recipientEmail },
      };
      setJob(j);
      poll(body.data.jobId);
    } catch (e) {
      setEnqueueError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main>
      <h1>Background Job System</h1>
      <p className="sub">
        Persistent PostgreSQL-backed queue · atomic claiming · finite retries ·
        exponential backoff + jitter · idempotent delivery · stuck recovery ·
        dead-letter view
      </p>

      {/* ---- API Token --------------------------------------------------- */}
      <div className="panel">
        <h2 style={{ margin: "0 0 4px", fontSize: 16 }}>API Token</h2>
        <label>Bearer token (from AUTH_USERS)</label>
        <input
          type="text"
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="tok_alice_dev"
        />
      </div>

      {/* ---- Enqueue form ------------------------------------------------ */}
      <div className="panel">
        <h2 style={{ margin: "0 0 4px", fontSize: 16 }}>Enqueue order-confirmation email</h2>
        <div className="row">
          <div>
            <label>Order number</label>
            <input type="text" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} />
          </div>
          <div>
            <label>Recipient email</label>
            <input type="email" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} />
          </div>
        </div>
        <div className="row">
          <div>
            <label>Recipient name</label>
            <input type="text" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
          </div>
          <div>
            <label>Idempotency key</label>
            <input type="text" value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} />
          </div>
        </div>
        <div className="checkbox">
          <input type="checkbox" checked={forceFailure} onChange={(e) => setForceFailure(e.target.checked)} />
          <span>Force failure (test vendor only)</span>
        </div>
        <div className="row" style={{ maxWidth: 280 }}>
          <div>
            <label>Delay (ms)</label>
            <input
              type="number"
              min={0}
              value={testDelayMs}
              onChange={(e) => setTestDelayMs(Math.max(0, Number(e.target.value)))}
            />
          </div>
        </div>
        <button onClick={enqueue} disabled={submitting || !token}>
          {submitting ? "Enqueueing…" : "Send order confirmation"}
        </button>
        {enqueueError && <p className="error" style={{ marginTop: 8 }}>{enqueueError}</p>}
      </div>

      {/* ---- Job status -------------------------------------------------- */}
      {job && (
        <div className="panel">
          <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Job status</h2>
          <div className="kv">
            <div><b>Job ID:</b> <span className="mono">{job.id}</span></div>
            <div><b>Type:</b> {job.type}</div>
            <div><b>Status:</b>{" "}<span className={`badge ${job.status}`}>{job.status}</span></div>
            <div><b>Attempts:</b> {job.attempts} / {job.maxAttempts}</div>
            <div><b>Idempotency key:</b> <span className="mono">{job.idempotencyKey}</span></div>
            <div><b>Order:</b> {job.context.orderNumber}</div>
            <div><b>Recipient:</b> {job.context.recipientEmail}</div>
            <div><b>Created:</b> {isoOrBlank(job.createdAt)}</div>
            <div><b>Scheduled runAt:</b> {isoOrBlank(job.runAt)}</div>
            <div><b>StartedAt:</b> {isoOrBlank(job.startedAt)}</div>
            <div><b>FinishedAt:</b> {isoOrBlank(job.finishedAt)}</div>
            {job.lastError && (
              <div style={{ marginTop: 4 }}>
                <b className="error">LastError:</b>{" "}
                <span className="error" style={{ whiteSpace: "pre-wrap" }}>{job.lastError}</span>
              </div>
            )}
          </div>
          {job.status === "pending" && job.runAt && (
            <p className="state-note">
              Waiting for the worker to pick up this job.
              {new Date(job.runAt) > new Date() &&
                ` Next attempt scheduled at ${new Date(job.runAt).toLocaleTimeString()}.`}
            </p>
          )}
          {job.status === "processing" && (
            <p className="state-note">The worker is executing the email send now.</p>
          )}
          {job.status === "failed" && (
            <p className="state-note">
              The last attempt failed; another attempt will be made at{" "}
              {job.runAt ? new Date(job.runAt).toLocaleTimeString() : "an unknown time"}.
            </p>
          )}
          {job.status === "dead" && (
            <p className="state-note" style={{ color: "var(--err)" }}>
              All attempts exhausted. This job requires manual intervention from
              the <a href="/dead-letter">dead-letter view</a>.
            </p>
          )}
          {job.status === "succeeded" && (
            <p className="state-note" style={{ color: "var(--ok)" }}>
              Email sent successfully.
            </p>
          )}
        </div>
      )}

      <p style={{ marginTop: 32 }}>
        <a href="/dead-letter">Open dead-letter view</a>
      </p>
    </main>
  );
}