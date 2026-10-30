import { z } from "zod";

/** Signed canonical envelope; the event identity is authenticated with the payload. */
export const webhookEventSchema = z.object({
  id: z.string().uuid(),
  type: z.literal("order.created"),
  occurredAt: z.string().datetime(),
  data: z.object({ orderId: z.string().trim().min(1).max(128) }).strict(),
}).strict();

/** This extension durably accepts an order notification; it does not place an order. */
export type WebhookEvent = z.infer<typeof webhookEventSchema>;
