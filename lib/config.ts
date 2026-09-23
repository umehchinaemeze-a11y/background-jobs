import { z } from "zod";

// Central configuration. Every operational knob is defined here — never
// scattered as magic numbers in handlers or the worker.

const emailVendorSchema = z.enum(["resend", "test"]);

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1),
  JOB_WORKER_CONCURRENCY: z.coerce.number().int().min(1),
  JOB_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0),
  JOB_RETRY_JITTER_MS: z.coerce.number().int().min(0),
  JOB_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1),
  JOB_STUCK_TIMEOUT_MS: z.coerce.number().int().min(1),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(1),
  JOB_WORK_TIMEOUT_MS: z.coerce.number().int().min(1),
  JOB_WORKER_GRACE_MS: z.coerce.number().int().min(0),

  EMAIL_PROVIDER_VENDOR: emailVendorSchema.default("resend"),
  EMAIL_PROVIDER_API_KEY: z.string().optional(),
  EMAIL_PROVIDER_FROM: z.string().min(3),

  // Test-only failure switch. Honored ONLY when EMAIL_PROVIDER_VENDOR=test.
  TEST_FORCE_EMAIL_FAILURE: z.coerce.number().int().default(0),
  TEST_EMAIL_DELAY_MS: z.coerce.number().int().min(0).default(0),

  AUTH_USERS: z.string().min(1, "AUTH_USERS is required").default("{}"),
  WORKER_ID: z.string().default(""),
});

export type AppConfig = z.infer<typeof envSchema>;

function parseAuthUsers(raw: string): Record<string, string> {
  const obj = JSON.parse(raw) as unknown;
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error("AUTH_USERS must be a JSON object of userId -> token");
  }
  const out: Record<string, string> = {};
  for (const [userId, token] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(`AUTH_USERS entry for '${userId}' must be a non-empty string`);
    }
    out[userId] = token;
  }
  return out;
}

let cached: AppConfig | null = null;

export function config(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Configuration error: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  cached = parsed.data;
  return cached;
}

export function authUsers(cfg = config()): Record<string, string> {
  return parseAuthUsers(cfg.AUTH_USERS);
}

export function resetConfigForTests(): void {
  cached = null;
}