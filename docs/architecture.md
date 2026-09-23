# Architecture — order-confirmation background jobs

## One-page diagram

```
 CLIENT ──────────────────────────────────────────────┐
 (storefront / order service)                          │
                                                       │
  POST /api/jobs  (Bearer token)             GET /api/jobs/:id
  {type, idempotencyKey, payload}            GET /api/jobs?status=dead
  ────────────────────────────────────►      POST /api/jobs/:id/retry
        │              ▲                             │
        │ 202 {jobId,  │ 404 for foreign ids         │
        │     duplicate} (no existence leak)         │
        v              └────────────────────────────┼─┘
┌───────────────────────  HTTP LAYER (Next.js app server)  ───────────────┐
│  lib/jobs.ts  createJob()                                               │
│   · validate payload (zod)                                              │
│   · UNIQUE(idempotencyKey, userId) → duplicate or insert                │
│   · status=pending (because async — 202, never an SMTP call here)       │
└──────────────────────────────────┬────────────────────────────────────┘
                                   │ INSERT (same DB / same transaction)
                                   v
        ┌───────────────────────────────────────────────────────────┐
        │                 PostgreSQL  "Job" queue                    │
        │                                                            │
        │  id | userId | type | payload | idempotencyKey(unique)     │
        │  status | attempts | maxAttempts | runAt | startedAt       │
        │  finishedAt | claimedBy | lastError                        │
        │                                                            │
        │   indexes: status+runAt, status+startedAt, userId+…        │
        └───────────────────────────────────────────────────────────┘
                                   ▲
              ┌────────────────────┼───────────────────────┐
              │                    │                       │
        worker A               worker B            (N workers run
        └────────┬─┘           └────────┬─┘         concurrently; each
                 │                      │          uses the same loop)
                 │   +  ┌──────────────────────────────────────┐
                 │      │  WorkerPool loop (per tick)          │
                 │      │                                      │
                 │      │  1. sweep: reclaim processing rows   │
                 │      │     older than JOB_STUCK_TIMEOUT_MS  │
                 │      │     → treat as a failed attempt      │
                 │      │  2. slots = CONCURRENCY − active     │
                 │      │     claim ≤ slots: atomic            │
                 │      │     SELECT … FOR UPDATE SKIP LOCKED  │
                 │      │     WHERE status IN (pending,failed) │
                 │      │       AND runAt <= now               │
                 │      │                │ 3. execute each      │
                 │      │                │    with 1s watchdog  │
                 │      └────────────────┼──────────────────────┘
                 │                       │
                 │                        v
                 │              ┌─────────────────────────┐
                 │              │  executeClaimedJob       │
                 │              │   · INSERT JobOutput      │
                 │              │     (unique provider key  │
                 │              │      = job.id)            │
                 │              │     → duplicate? no-op     │
                 │              │   · call provider:         │
                 │              │     POST emails.send       │
                 │              │     Idempotency-Key: job.id│
                 │              │   · success → succeeded    │
                 │              │   · failure → failed/backoff│
                 │              │      (or dead at max)      │
                 │              └────────────┬──────────────┘
                 │                           ▼
                 │              ┌─────────────────────────┐
                 │              │  Email provider         │
                 │              │   · resend — live API   │
                 │              │   · test — test sink;   │
                 │              │     forced-failure +    │
                 │              │     delay injection     │
                 │              └─────────────────────────┘
                 ▼
        JobOutput rows  (durable, unique providerMessageId)
```

## What each piece does and why

### HTTP layer (`lib/jobs.ts`, `app/api/jobs/**`)
`createJob` is the only write entry point. Idempotency is enforced by the DB:
`UNIQUE("userId", "idempotencyKey")`. Because submission is **async** (202), the email provider
is never touched in the request path — the request just stores structured data, so it cannot
"forget to send."

### The queue is the `Job` table
A row *is* the job. Unlike an in-memory/in-process queue, this survives server restarts and
worker crashes, and it participates in the same transaction as the order write if the caller
commits in one transaction. When two request copies arrive (double-click, retry, replay), the
unique key collapses them into one row.

### Claiming (`worker/claim.ts`)
Workers pull work with **`SELECT … FOR UPDATE SKIP LOCKED ORDER BY runAt`** inside a
transaction, then `UPDATE … WHERE status='processing'` guarded by the claim fields. Because the
rows are locked at the DB level, two workers can never claim the same row — no Redis, no
distributed lock, no message-consumer weirdness. `SKIP LOCKED` means a busy row is simply
skipped, so pollers never block each other.

### Bounded concurrency (`worker/pool.ts`)
Each tick computes `slots = CONCURRENCY − active` and claims at most `slots`, holding `active`
until each execution finishes. The most executions any instant can have is therefore exactly
`JOB_WORKER_CONCURRENCY`, regardless of how many workers/processes run. (Verified: 100 jobs,
N=3, peak active = 3.)

### Backoff + jitter (`lib/retry.ts`)
`delay = min(baseDelay × 2^attempt, maxDelay) + random(0..jitter)`. Jitter breaks the
thundering-herd pattern where every failed job wakes at exactly the same moment and re-fails in
lockstep. (Verified: delays grow 1851→3326→6000→12075→24152ms and differ across jobs.)

### Idempotent output (`worker/executor.ts`, `JobOutput`)
Sends are **at-least-once, outputs at-most-once**. Before calling the provider, the executor
inserts a `JobOutput` row keyed by a unique `providerMessageId` (the job id). If a job is ever
re-executed (crash recovery, retry after an ambiguous failure), the insert is a no-op and we
skip the send — plus the provider call itself carries `Idempotency-Key: jobId`, so even the
request/response loss window is collapsed by the provider's own dedupe (Resend: 24h, key+different-payload → 409).

### Crash recovery (`worker/recovery.ts`, swept by `worker/pool.ts`)
If a worker dies mid-job, the row stays `processing`. The periodic sweep reclaims anything
`processing` for longer than `JOB_STUCK_TIMEOUT_MS`, increments `attempts` (best guess — we
can't tell partial success from no send), and schedules a backoff retry — exactly the semantics
of a failed attempt. (Verified: killing a worker mid-flight, 3 stuck rows recovered, 8/8 emails
delivered once.)

### Dead-letter + manual retry (`app/api/jobs/[id]/retry`)
At `attempts ≥ maxAttempts` the row becomes `dead`. It's still inspectable via the admin view
and can be reset (`pending`, `attempts=0`, `runAt=now`) to give it a fresh budget.

### Auth and ownership (`lib/auth.ts`)
Routes require a bearer token from `AUTH_USERS`. Jobs are strictly owned: a foreign id returns
404 (not 403), so no content of another tenant's jobs (emails, amounts, names) leaks. `JobView`
deliberately omits `userId`.

## Failure modes this design avoids

| Risk | Mitigation |
|---|---|
| Email lost because "we'll send it later" | Job is a committed DB row before the 202 is returned |
| Duplicate email on double-submit | Unique idempotency key at insert **(dedupe in the worker)*** |
| Duplicate email when two workers grab one job | `FOR UPDATE SKIP LOCKED` exclusive claim |
| Duplicate email after a crash/retry | `JobOutput` unique key + provider `Idempotency-Key` **(dedupe in the worker)*** |
| Thundering herd after an outage | Full jitter on every retry window |
| Job stuck forever after a crash | Stuck sweep reclaims `processing` rows |
| Death-lettered jobs lost forever | Dead-letter view + manual retry endpoint |
| Slow `orders` endpoint | Async 202; SMTP call happens in the worker, never the request |

> \* Two *separate* dedupe layers: one at submission (idempotency key), one at delivery (output
> guard + provider header). Together they make "exactly-once" as close as the provider allows.

## Deployment notes

- Scale workers by adding more processes on the same DB; each process caps itself at
  `JOB_WORKER_CONCURRENCY`. The sweep and claims are concurrency-safe across processes.
- Keep `JOB_STUCK_TIMEOUT_MS` comfortably above your worst-case job duration; running it at or
  below typical job time causes the sweep to (safely, idempotently) re-claim still-running jobs.
- For the live Resend path, the adapter is implemented but **not yet verified against the real
  API** during this build (no key available). Smoke-test one real delivery before go-live.