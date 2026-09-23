# Order Confirmation Background Jobs

A production-grade, PostgreSQL-backed **persistent background job system** for transactional
order-confirmation emails. The HTTP API returns `202 Accepted` immediately and enqueues a durable
job; a separate worker process drains the queue with bounded concurrency, exponential backoff +
jitter, at-least-once execution with idempotent output, stuck-job crash recovery, and a
dead-letter view with manual retry.

Built with Next.js 15 (App Router, route handlers), TypeScript, Prisma 6 + PostgreSQL, zod, vitest.

## Why this design (the essentials)

| Requirement | How it is met |
|---|---|
| Fast, async request handling | `POST /api/jobs` validates → `INSERT` → returns **202** in <100ms; no network call in the request path |
| Durable response, no "we'll send later" | The job is a **row in Postgres** (transactional with your app DB if you commit in the same tx) |
| Exactly-once submission | Unique `idempotencyKey` per job → second submission returns the same `jobId` (`duplicate: true`) |
| Bounded concurrency | Worker pool claims **at most `N` rows** per tick (`FOR UPDATE SKIP LOCKED`, `N = JOB_WORKER_CONCURRENCY`) |
| Retries with backoff + jitter | `delay = min(base · 2^attempt, maxDelay) + random(0..jitter)` (see `lib/retry.ts`) |
| At-most-once *sends* | `JobOutput` insert protected by a unique provider idempotency key; the email provider is called with an `Idempotency-Key` header |
| Crash safety | A worker that dies mid-job leaves `processing` rows; the **stuck sweep** re-enqueues them after `JOB_STUCK_TIMEOUT_MS` |
| Human operations | `GET /api/jobs?status=dead` dead-letter view + `POST /api/jobs/:id/retry` to reset a dead job |
| No data-massaging secrets | Emails are built only from the validated, stored payload |

## Quick start

```bash
# 1. Database (Postgres on :15435)
docker compose up -d

# 2. Dependencies + schema
npm install
npm run db:setup          # creates jobs / jobs_test DBs and applies migrations

# 3. Dev API (renders a minimal UI + API routes)
npm run dev               # http://localhost:3000

# 4. Worker (separate process — never in the Next.js server)
npm run worker            # poll loop, bounded concurrency, stuck sweep
```

> The dev environment ships with `EMAIL_PROVIDER_VENDOR=test` (see `.env`) so nothing is
> actually emailed until you add a Resend key. See [Configuration](#configuration).

## API

All routes require a bearer token (see `AUTH_USERS`).

| Method | Route | Purpose | Response |
|---|---|---|---|
| `POST` | `/api/jobs` | Enqueue an order-confirmation email | `202` `{ jobId, status, idempotencyKey, duplicate }` — `409` if another user owns the key, `400` on invalid input, `401` without a token |
| `GET` | `/api/jobs/:id` | Job status (owned only; others get 404 — no existence leak) | `200` job view |
| `GET` | `/api/jobs?status=dead` | Dead-letter list (owned only) | `200` array |
| `POST` | `/api/jobs/:id/retry` | Reset a dead job: status→`pending`, attempts→`0`, runAt→now | `200` job view |

Request body (`POST /api/jobs`):

```json
{
  "type": "order-confirmation",
  "idempotencyKey": "order-AB12345-final-send",
  "payload": {
    "orderNumber": "AB12345",
    "recipientEmail": "buyer@example.com",
    "recipientName": "Alex",
    "currency": "USD",
    "items": [{ "name": "Widget", "quantity": 1, "unitPriceCents": 1999 }]
  }
}
```

## Job lifecycle & status semantics

```
                ┌────────── enqueue ──────────────────────┐
     retry      v                                         │
  (dead→pending)        ┌────────── claim ────────────┐   │
 dead ────────────────► pending ─────────────────────► processing
   ▲                    │  │  failed (backoff window;  │   │  two outcomes
   │ attempts exhausted │  │  still claim-eligible)    │   │
   └────────────────────┘  └──────────────────────────┼───┼────────┐
                                                    success │        │
                                                      └──────┘     └─► succeeded
```

- `pending`   — eligible and due (`runAt <= now`)
- `processing`— atomically claimed, being executed
- `failed`    — a retry attempt failed; scheduled for a future `runAt` (backoff + jitter); still claim-eligible
- `dead`      — `attempts >= maxAttempts`; terminal, requires a manual retry
- `succeeded` — done; the delivery is recorded in `JobOutput`
- `attempts` counts failures (recovered/stuck rows count as a failed attempt too)

## Configuration (all knobs via env, see `.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `JOB_MAX_ATTEMPTS` | `5` | Failure attempts before a job goes dead |
| `JOB_WORKER_CONCURRENCY` | `4` | Max executions in one worker process |
| `JOB_RETRY_BASE_DELAY_MS` | `1500` | Backoff base (2× per attempt, capped) |
| `JOB_RETRY_JITTER_MS` | `400` | Random added delay (thundering-herd guard) |
| `JOB_RETRY_MAX_DELAY_MS` | `300000` | Backoff ceiling |
| `JOB_STUCK_TIMEOUT_MS` | `60000` | `processing` older than this ⇒ recovered by the sweep |
| `JOB_POLL_INTERVAL_MS` | `1000` | Worker poll cadence |
| `JOB_WORK_TIMEOUT_MS` | `30000` | Per-execution watchdog |
| `JOB_WORKER_GRACE_MS` | `5000` | Graceful-shutdown grace period |
| `EMAIL_PROVIDER_VENDOR` | `resend` | `resend` (live) or `test` (no-op sink) |
| `EMAIL_PROVIDER_API_KEY` | — | Resend key (`resend` only) |
| `AUTH_USERS` | `{}` | `{ userId: token }` JSON for API auth |

## Testing

```bash
npm test        # 47 tests / 10 files — unit + integration on a real Postgres (jobs_test DB)
npm run breakit # "break-it" evidence suite → evidence/*.md (see below)
```

The integration tests use a real Postgres (`jobs_test`): they exercise enqueue, idempotency
(sequential + concurrent), atomic claiming, concurrency caps, failure/retry/dead transitions,
stuck-recovery, status ownership, and two-worker zero-overlap — all against the real route
handlers and worker modules. A `test` email adapter simulates send latency and forced failures.

## Evidence (break-it suite)

Runnable proof that the system survives real-world abuse. Each run writes a timestamped markdown
file under `evidence/` with raw logs:

| # | Scenario | Finds |
|---|---|---|
| 1 | 100 jobs, concurrency N=3 | `active` never exceeds 3 |
| 2 | forced failures → retries → dead | strictly increasing backoff, real jitter, manual retry resets budget |
| 3 | worker **killed mid-flight** | stuck sweep recovers 3 `processing` rows; a fresh worker finishes 8/8, zero emails lost or sent twice |
| 4 | idempotency via real route handlers | duplicates dedupe (sequential + concurrent), cross-user 409, status 404 integrity |
| 5 | **two worker processes** on one queue | 40 jobs, 20/20 split, **zero** jobs claimed by both |
| 6 | live `next dev` server over HTTP | 401/202/duplicate/400/status/dead-list/retry end-to-end |
| 7 | **live Resend** (\*needs a real API key) | real send + 24h idempotency dedupe + 409 on key reuse + full pipeline with `vendor=resend` — recorded as a self-documenting SKIP until configured |

## Not verified / known gaps

- **LIVE Resend delivery is not verified** — no API key was available during development.
  The `resend` adapter is implemented (`worker/email.ts`, `Idempotency-Key` + 24h dedupe, 409
  handling) but has not been executed against the real API. When you have a key, set
  `EMAIL_PROVIDER_VENDOR=resend`, `EMAIL_PROVIDER_API_KEY`, `EMAIL_PROVIDER_FROM` (verified
  sender) and `RESEND_SMOKE_TO` (your inbox) in `.env`, then run `npm run breakit` — scenario 07
  performs a real send + idempotency proof and flips this item to PASS. Everything else is
  exercised by tests + evidence.

## Layout

```
app/            Next.js route handlers + minimal UI
lib/            config, retry/backoff, payload schema, auth, logger, prisma
worker/         claim (FOR UPDATE SKIP LOCKED), executor, recovery sweep, pool, email adapters, entry
prisma/         schema + migrations
tests/          vitest suite (unit + integration, real Postgres)
scripts/        db-setup + break-it evidence harness → evidence/*
```#   b a c k g r o u n d - j o b s  
 