import { config } from "../lib/config";
import { logger } from "../lib/logger";

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  /** Provider-side idempotency key (Resend supports Idempotency-Key header). */
  idempotencyKey: string;
  /** TEST-ONLY: honored only by the test vendor. */
  forceFailure?: boolean;
  /** TEST-ONLY: honored only by the test vendor. */
  testDelayMs?: number;
}

export interface SendEmailResult {
  providerMessageId: string;
}

export interface EmailSender {
  readonly vendor: string;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export class EmailProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = "EmailProviderError";
  }
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Real provider adapter: Resend REST API (POST /emails).
 *
 * - Authenticates with EMAIL_PROVIDER_API_KEY.
 * - Sends `Idempotency-Key: <jobId>` on every request. Resend deduplicates
 *   identical (key, payload) requests for 24h and returns the original message
 *   id instead of re-sending, which directly protects the worker
 *   crash-after-send window described in the docs.
 * - Evaluates as an HTTP call; non-2xx responses throw.
 *
 * The idempotency window is capped by Resend at 24 hours. If a retry happens
 * more than 24h after the original send the key has expired, so a low but
 * non-zero duplicate-send window remains — mitigated by the durable JobOutput
 * check that runs before every provider call.
 */
class ResendSender implements EmailSender {
  readonly vendor = "resend";

  constructor(private readonly apiKey: string, private readonly from: string) {
    if (!apiKey) {
      throw new Error(
        "EMAIL_PROVIDER_API_KEY is required when EMAIL_PROVIDER_VENDOR=resend",
      );
    }
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      message?: string;
      statusCode?: number;
    };

    if (!res.ok) {
      throw new EmailProviderError(
        `resend send failed (${res.status}${body.name ? ` ${body.name}` : ""}): ${
          body.message ?? body.statusCode ?? "unknown error"
        }`,
        res.status,
        body.name,
      );
    }
    const id = body.id;
    if (!id) {
      throw new EmailProviderError("resend send returned no message id", res.status);
    }
    return { providerMessageId: id };
  }
}

/**
 * Deterministic test adapter. It never contacts a real provider, which lets
 * the whole pipeline (claim -> work -> output -> retry -> dead) run against a
 * Postgres database in tests without external accounts.
 *
 * It honors TEST_FORCE_EMAIL_FAILURE / TEST_EMAIL_DELAY_MS and the payload's
 * forceFailure/testDelayMs controls so failure and crash scenarios can be
 * reproduced deterministically. These switches are scoped to this class only.
 */
class TestSender implements EmailSender {
  readonly vendor = "test";

  constructor(
    private readonly cfg: {
      forceFailure: boolean;
      delayMs: number;
      from: string;
    },
  ) {}

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const force = this.cfg.forceFailure || input.forceFailure === true;
    const delay = Math.max(this.cfg.delayMs, input.testDelayMs ?? 0);
    logger.log("email.test-send", {
      to: input.to,
      subject: input.subject,
      idempotencyKey: input.idempotencyKey,
      delayMs: delay,
      forceFailure: force,
      vendor: this.vendor,
    });
    if (delay > 0) await sleep(delay);
    if (force) {
      throw new EmailProviderError(
        "FORCED_TEST_FAILURE: test adapter configured to fail every send",
        503,
        "forced_test_failure",
      );
    }
    // Stable message id so idempotent replays can be observed.
    return { providerMessageId: `test:${input.idempotencyKey}` };
  }
}

let sender: EmailSender | null = null;

export function getEmailSender(): EmailSender {
  if (sender) return sender;
  const cfg = config();
  if (cfg.EMAIL_PROVIDER_VENDOR === "test") {
    sender = new TestSender({
      forceFailure: cfg.TEST_FORCE_EMAIL_FAILURE === 1,
      delayMs: cfg.TEST_EMAIL_DELAY_MS,
      from: cfg.EMAIL_PROVIDER_FROM,
    });
  } else {
    sender = new ResendSender(cfg.EMAIL_PROVIDER_API_KEY ?? "", cfg.EMAIL_PROVIDER_FROM);
  }
  return sender;
}

export function resetEmailSenderForTests(): void {
  sender = null;
  logger.log("email.sender-reset");
}