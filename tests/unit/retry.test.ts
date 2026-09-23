import { describe, expect, it } from "vitest";
import {
  retryDelayMs,
  type RetryPolicy,
} from "../../lib/retry";

const policy: RetryPolicy = { baseDelayMs: 500, jitterMs: 200, maxDelayMs: 10_000 };

const noJitter = () => 0;
const fullJitter = () => 0.999;

describe("retryDelayMs (exponential backoff + jitter)", () => {
  it("grows exponentially with the attempt index (without jitter)", () => {
    expect(retryDelayMs(1, policy, noJitter)).toBe(500);
    expect(retryDelayMs(2, policy, noJitter)).toBe(1_000);
    expect(retryDelayMs(3, policy, noJitter)).toBe(2_000);
    expect(retryDelayMs(4, policy, noJitter)).toBe(4_000);
  });

  it("adds bounded jitter on top of the exponential component", () => {
    const base1 = retryDelayMs(1, policy, noJitter);
    const j1 = retryDelayMs(1, policy, fullJitter);
    const j2 = retryDelayMs(1, policy, fullJitter);
    expect(j1).toBe(base1 + Math.floor(0.999 * policy.jitterMs));
    // randomness: two full-jitter draws are equal, but a 0-jitter draw differs
    expect(j2).toBe(j1);
    expect(retryDelayMs(1, policy, noJitter)).not.toBe(j1);
  });

  it("always schedules a delay within [exponential, exponential + jitterMs)", () => {
    for (let a = 1; a <= 10; a++) {
      const exp = Math.min(policy.baseDelayMs * 2 ** (a - 1), policy.maxDelayMs);
      for (let i = 0; i < 50; i++) {
        const d = retryDelayMs(a, policy);
        expect(d).toBeGreaterThanOrEqual(exp);
        expect(d).toBeLessThan(exp + policy.jitterMs + 1);
      }
    }
  });

  it("is monotonic: later attempts wait strictly longer than earlier ones", () => {
    // With baseDelay >= jitterMs, exp growth dominates jitter, so delays are
    // strictly increasing in expectation and across arbitrary draws.
    for (let i = 0; i < 200; i++) {
      const d1 = retryDelayMs(1, policy);
      const d2 = retryDelayMs(2, policy);
      const d3 = retryDelayMs(3, policy);
      expect(d2).toBeGreaterThan(d1);
      expect(d3).toBeGreaterThan(d2);
    }
  });

  it("caps the delay at maxDelayMs instead of growing unboundedly", () => {
    const capped = { baseDelayMs: 100, jitterMs: 10, maxDelayMs: 1_000 };
    const far = retryDelayMs(20, capped, noJitter);
    expect(far).toBe(1_000);
    expect(retryDelayMs(20, capped, fullJitter)).toBeLessThan(1_010);
  });

  it("uses a safe bounded exponent (no overflow) for large attempt counts", () => {
    const d = retryDelayMs(10_000, policy, noJitter);
    expect(d).toBe(policy.maxDelayMs);
    expect(Number.isSafeInteger(d)).toBe(true);
  });
});