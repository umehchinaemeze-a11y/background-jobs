import { z } from "zod";

// All job payloads are validated at the edge (enqueue) AND again inside the
// worker before any work is performed. A payload that fails validation is an
// application bug, not a retryable transport error — but the worker still
// records it as a failed attempt so the job surfaces in the dead-letter view.

export const JOB_TYPES = ["order-confirmation"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const IDEMPOTENCY_KEY_MAX = 200;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:/+-]+$/;

// Soft size cap: 32 KB of JSON per payload is generous for an order email and
// bounds memory/DB abuse from a single request.
export const MAX_PAYLOAD_BYTES = 32_000;

export const orderItemSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(1_000),
  unitPriceCents: z.number().int().nonnegative().max(1_000_000_000),
});

export const orderConfirmationPayloadSchema = z.object({
  orderNumber: z.string().min(1).max(80),
  recipientEmail: z.string().email().max(254),
  recipientName: z.string().min(1).max(200).optional(),
  currency: z.string().length(3).default("USD"),
  items: z.array(orderItemSchema).min(1).max(50),

  // TEST-ONLY controls. These are honored exclusively by the `test` email
  // provider adapter and are ignored by the real Resend adapter, so they can
  // never force a production email to fail.
  forceFailure: z.boolean().optional().default(false),
  testDelayMs: z.number().int().min(0).max(300_000).optional().default(0),
});

export type OrderConfirmationPayload = z.infer<
  typeof orderConfirmationPayloadSchema
>;

export const enqueueBodySchema = z.object({
  type: z.enum(JOB_TYPES).default("order-confirmation"),
  idempotencyKey: z
    .string()
    .min(1)
    .max(IDEMPOTENCY_KEY_MAX)
    .regex(
      IDEMPOTENCY_KEY_PATTERN,
      "idempotencyKey may only contain A-Z a-z 0-9 . _ : / + -",
    ),
  payload: orderConfirmationPayloadSchema,
});

export type EnqueueInput = z.infer<typeof enqueueBodySchema>;

export function payloadBytes(input: EnqueueInput): number {
  return Buffer.byteLength(JSON.stringify(input.payload), "utf8");
}

export function orderTotalCents(payload: OrderConfirmationPayload): number {
  return payload.items.reduce(
    (sum, item) => sum + item.unitPriceCents * item.quantity,
    0,
  );
}

export function renderOrderEmailHtml(payload: OrderConfirmationPayload): string {
  const rows = payload.items
    .map(
      (it) =>
        `<tr><td>${escapeHtml(it.name)}</td><td>${it.quantity}</td>` +
        `<td>${centsToMoney(it.unitPriceCents, payload.currency)}</td></tr>`,
    )
    .join("");
  const total = orderTotalCents(payload);
  return `<div style="font-family:sans-serif;max-width:520px;margin:auto">
<h2>Order confirmation</h2>
<p>Thanks${payload.recipientName ? `, ${payload.recipientName}` : ""}! Your order <strong>${escapeHtml(payload.orderNumber)}</strong> is confirmed.</p>
<table cellpadding="6" style="border-collapse:collapse;width:100%">
<thead><tr><th align="left">Item</th><th align="left">Qty</th><th align="left">Price</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p style="margin-top:16px"><strong>Total: ${centsToMoney(total, payload.currency)}</strong></p>
</div>`;
}

function centsToMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Safe, non-sensitive summary of a job's payload. Exposed by the status and
 * dead-letter endpoints. The full payload is never returned to the client.
 */
export function safeContext(payload: unknown): {
  orderNumber: string;
  recipientEmail: string;
} {
  const parsed = orderConfirmationPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { orderNumber: "(invalid payload)", recipientEmail: "(invalid)" };
  }
  return {
    orderNumber: parsed.data.orderNumber,
    recipientEmail: parsed.data.recipientEmail,
  };
}