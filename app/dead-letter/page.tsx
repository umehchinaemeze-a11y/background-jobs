"use client";

import { useEffect, useState } from "react";

type DeadJob = {
  id: string;
  type: string;
  status: "dead";
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

const TOKEN_KEY = "bg-job-token";

function readToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

function isoOrBlank(s: string | null): string {
  return s ? new Date(s).toLocaleString() : "—";
}

export default function DeadLetterPage() {
  const [token, setToken] = useState(readToken);
  const [jobs, setJobs] = useState<DeadJob[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async (auth: string) => {
    setError("");
    try {
      const res = await fetch(`/api/jobs?status=dead`, {
        headers: { Authorization: `Bearer ${auth}` },
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setJobs(body.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    }
  };

  useEffect(() => {
    if (token) void load(token);
  }, [token]);

  const retry = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/jobs/${id}/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? `HTTP ${res.status}`);
      }
      await load(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>Dead-Letter View</h1>
      <p className="sub">
        Jobs that exhausted all attempts and require manual intervention.
      </p>

      <div className="panel">
        <label>API Token</label>
        <input
          type="text"
          value={token}
          onChange={(e) => {
            const v = e.target.value;
            setToken(v);
            localStorage.setItem(TOKEN_KEY, v);
          }}
          placeholder="tok_alice_dev"
        />
        <button className="secondary" onClick={() => token && void load(token)}>
          Refresh
        </button>
        {error && <p className="error" style={{ marginTop: 8 }}>{error}</p>}
      </div>

      {jobs !== null && (
        <div className="panel">
          {jobs.length === 0 ? (
            <p className="state-note">No dead jobs right now.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Type</th>
                  <th>Attempts</th>
                  <th>Order</th>
                  <th>Last error</th>
                  <th>Finished at</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="mono">{j.id}</td>
                    <td>{j.type}</td>
                    <td>
                      {j.attempts}/{j.maxAttempts}
                    </td>
                    <td>
                      {j.context.orderNumber}
                      <br />
                      <span style={{ color: "var(--muted)" }}>{j.context.recipientEmail}</span>
                    </td>
                    <td className="error">{j.lastError?.slice(0, 140) ?? "—"}</td>
                    <td>{isoOrBlank(j.finishedAt)}</td>
                    <td>
                      <button className="secondary" disabled={busy} onClick={() => retry(j.id)}>
                        Retry
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </main>
  );
}