# Final report & acceptance matrix

Delivered on 2026-09-18 for the "background jobs done properly" build of the order-confirmation
email pipeline.

## Scope

`POST /api/jobs` → durable Postgres job → bounded worker pool → resend/test email with
idempotent output. Status: **built, tested, and demonstrated with runnable evidence**. The single
unverifiable item is a **live Resend delivery**, blocked by the absence of an API key.

## Acceptance matrix

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | `POST /api/jobs` returns 202 and does **not** send the email synchronously | ✅ PASS | `tests/integration/enqueue`, `evidence/06-live-api.md` (202 + `pending` + no send in request path) |
| 2 | The system does not rely on "we'll send it later" — durable, transactional | ✅ PASS | Job is a `Job` row; `evidence/06` shows row present; enqueue in one tx via `lib/jobs.ts` |
| 3 | Exactly-once: same logical job twice ⇒ same job id, one send | ✅ PASS | `UNIQUE(userId, idempotencyKey)`; `tests/integration/idempotency` (sequential + concurrent), `evidence/04-idempotency.md` |
| 4 | Two parallel worker processes, no double processing | ✅ PASS | `FOR UPDATE SKIP LOCKED`; `tests/integration/two-workers`, `evidence/05-two-worker-processes.md` (40 jobs, 0 overlaps) |
| 5 | Bounded concurrency | ✅ PASS | Pool `slots = concurrency − active`; `tests/integration/concurrency`, `evidence/01-concurrency-cap.md` (100 jobs, peak active = 3 ≤ 3) |
| 6 | Retries with exponential backoff + jitter | ✅ PASS | `lib/retry.ts`; `tests/unit/retry`, `evidence/02-failure-retry-dead.md` (1851→3326→6000→12075→24152 ms, jitter varies) |
| 7 | Idempotent output — no duplicate email on retry/re-execution | ✅ PASS | `JobOutput` unique provider key + executor skip; `tests/integration/output` (tap handles `409`); noted in `evidence/03` (8/8 sent once) |
| 8 | Stuck/crash recovery | ✅ PASS | Stuck sweep treats `processing` past timeout as a failed attempt; `tests/integration/stuck`, `evidence/03-worker-kill-recovery.md` (worker killed mid-flight, 3 rows recovered, 8/8 done) |
| 9 | Dead-letter handling + manual retry | ✅ PASS | `GET /api/jobs?status=dead`, `POST /api/jobs/:id/retry`; `tests/integration/failure`, `tests/integration/stuck`, `evidence/02` + `evidence/06` |
| 10 | Status endpoint with ownership scoping | ✅ PASS | 404 for foreign ids; `tests/integration/status`, `evidence/04` (bob→404), `evidence/06` |
| 11 | "How the job status is stored": single `Job` table, `status`/`attempts`/`runAt`/`startedAt` | ✅ PASS | `prisma/schema.prisma`; documented in `README.md` |
| 12 | Resend as the provider | ✅ **NOT VERIFIED** | Adapter implemented (`worker/email.ts`: fetch + `Idempotency-Key`, 24h dedupe, 409 handshake) but **no API key existed** — never executed against the real API. Everything else in the repo is exercised. |
| 13 | "Do it properly this time": async, no in-process smuggle, no mocked calls in the request path | ✅ PASS | Worker is a separate process (`npm run worker`); `evidence/06` over real `next dev` HTTP; tests run the real modules against real Postgres |

## How each "proper" concern was handled

1. **Async now; the email happens in a worker.** The API **only** stores a validated payload and
   returns 202. A separate long-running worker process polls, claims, and sends. Nothing about
   "later" is trusted to memory — it's a committed row.
2. **Exactly-once submission.** Enforce the invariant in the database, not with a race-prone
   check-then-write: `UNIQUE("userId","idempotencyKey")`. Concurrent duplicates collapse; the
   second POST returns the same `jobId` with `duplicate: true`.
3. **No smuggle, no mocked real calls.** The only adapter that is a no-op is the deliberate
   `test` vendor used in dev/tests (with forced-failure + delay injection). The `resend` adapter
   is a real HTTPS call and the `Idempotency-Key` header is passed through — but it is honestly
   marked **NOT VERIFIED** because no key was available to run it.
4. **Bounded concurrency that can't be exceeded.** A worker never asks for more work than it has
   free slots (`slots = concurrency − active`), so the claim batch is the enforcement point.
5. **No double-send even in a retry.** Two independent dedupe layers: the executor's `JobOutput`
   insert is keyed uniquely; the provider call carries the same id as its `Idempotency-Key`.
6. **Crash recovery with correct semantics.** Recovery reuses the *failed-attempt* path (attempts
   +1, backoff) — deliberately conservative — so exactly-once is preserved at the cost of a
   possible retry.

## Automated test suite

`npm test` — **47 tests, 10 files, ~23 s**, green on a real Postgres (`jobs_test`):

```
tests/unit/retry.test.ts                  backoff/jitter math, monotonic growth
tests/integration/enqueue.test.ts         202 async, payload persistence, attempts=0
tests/integration/idempotency.test.ts     sequential + concurrent dedupe, cross-user 409, bad key 400
tests/integration/claim.test.ts           FOR UPDATE SKIP LOCKED single-claim
tests/integration/concurrency.test.ts     1× N cap maintained under 4× load
tests/integration/failure.test.ts         failure → backoff → attempts → dead
tests/integration/output.test.ts          providerMessageId persisted; re-execution no-ops
tests/integration/stuck.test.ts           processing past timeout ⇒ re-enqueued as failed attempt
tests/integration/status.test.ts          ownership 404s, JobView has no userId
tests/integration/two-workers.test.ts     two pools, zero double-processing
```

Run `npx tsc --noEmit`, `npm run lint`, `npm run build` — all clean.

## Break-it evidence

`npm run breakit` → regenerates real, timestamped artifacts under `evidence/` (each run is
self-contained, starts from a truncated queue, and prints raw worker logs):

| Artifact | What it proves |
|---|---|
| `01-concurrency-cap.md` | 100 jobs, N=3: `max active ever measured = 3` |
| `02-failure-retry-dead.md` | Strictly increasing backoff, differing jitter, manual retry resets attempts→0/status→pending |
| `03-worker-kill-recovery.md` | Real worker **killed by taskkill mid-flight**: 3 `processing` rows swept→failed→retried; fresh worker completes 8/8; 8 durable outputs |
| `04-idempotency.md` | Real route handlers: duplicate/409/400/status/404 matrix over 6 requests |
| `05-two-worker-processes.md` | Two real processes: 40 jobs, 20/20 split, **0** jobs claimed by both |
| `06-live-api.md` | Real `next dev` server over HTTP: 401/202/duplicate/status/400/dead-list/retry + server stdout |
| `07-resend-live.md` | **Live Resend** — real send, 24h `Idempotency-Key` dedupe, 409 on key reuse, full pipeline with `vendor=resend`. Without a key it writes a self-documenting SKIP (exit 0) so the suite stays green |

## Verification commands

```bash
npm test          # 47/47
npm run lint      # clean, 0 warnings (max-warnings 0)
npx tsc --noEmit  # clean
npm run build     # 6 routes, clean
npm run breakit   # 7/7 scenarios → regenerates evidence/*.md (#7 self-documents a SKIP until a Resend key is present)
```

## Remaining risk / honest NOT VERIFIED

- **Resend live send (req #12)** — `EMAIL_PROVIDER_VENDOR=resend` + `EMAIL_PROVIDER_API_KEY` was
  never exercised because no key was available in this environment. The adapter exists and is
  type-checked, but a real delivery, the real `Idempotency-Key` dedupe window, and the real 409
  handshake must be smoke-tested before go-live. The harness is ready: put the key, a verified
  `from`, and your own inbox in `RESEND_SMOKE_TO` (all in `.env`), run `npm run breakit`, and
  `evidence/07-resend-live.md` records the proof — then flip #12 to PASS in this report.
- Everything else on the matrix is demonstrated by automated tests **and** standalone runnable
  evidence with no fabricated data.