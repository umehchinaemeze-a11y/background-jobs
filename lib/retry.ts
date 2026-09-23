// Exponential backoff with jitter.
//
// A retry delay is derived from the number of failed attempts already
// recorded for the job:
//
//   delay = min(baseDelay * 2^(attempts - 1), maxDelay) + jitter
//
// where jitter is drawn uniformly from [0, jitterMs).
//
// Without jitter, many jobs that fail at the same time would retry at the
// same time and recreate the same load spike against the downstream provider
// — the classic thundering-herd problem. Adding per-job randomness spreads
// retries so the retry wave is smoothed out.
//
// The formula is bounded (maxDelay) so a job that keeps failing cannot
// schedule a nonsensical future runAt (Postgres timestamps, humans, logs).

import { config } from "./config";

export interface RetryPolicy {
  baseDelayMs: number;
  jitterMs: number;
  maxDelayMs: number;
}

export function retryPolicyFromConfig(): RetryPolicy {
  const cfg = config();
  return {
    baseDelayMs: cfg.JOB_RETRY_BASE_DELAY_MS,
    jitterMs: cfg.JOB_RETRY_JITTER_MS,
    maxDelayMs: cfg.JOB_RETRY_MAX_DELAY_MS,
  };
}

/**
 * Compute the millisecond delay before the attempt whose index is
 * `attemptsAfter` (i.e. 1 for the first retry, 2 for the second, ...).
 *
 * `random` is injectable so tests can make jitter deterministic.
 */
export function retryDelayMs(
  attemptsAfter: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    policy.baseDelayMs * 2 ** (attemptsAfter - 1),
    policy.maxDelayMs,
  );
  const jitter = Math.floor(random() * policy.jitterMs);
  return exponential + jitter;
}