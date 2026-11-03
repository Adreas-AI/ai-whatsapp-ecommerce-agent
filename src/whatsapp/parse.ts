import { z } from 'zod';

/**
 * Normalises the WhatsApp Cloud API webhook payload ("messages" field) into a
 * flat list of inbound messages. Unknown fields are ignored; malformed entries
 * are skipped rather than failing the whole batch.
 */

export interface InboundMessage {
  messageId: string;
  waId: string;
  phoneNumberId: string;
  profileName: string | null;
  timestampMs: number;
  type: string;
  /** Text content for text / button / interactive replies, otherwise null. */
  text: string | null;
}

export interface StatusEvent {
  messageId: string;
  status: string;
  recipientId: string;
  timestampMs: number;
}

const message = z
  .object({
    from: z.string().regex(/^\d{6,15}$/),
    id: z.string().min(1).max(256),
    timestamp: z.string().regex(/^\d+$/),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    button: z.object({ text: z.string() }).optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ title: z.string() }).optional(),
        list_reply: z.object({ title: z.string() }).optional(),
      })
      .optional(),
  })
  .passthrough();

const status = z
  .object({ id: z.string(), status: z.string(), recipient_id: z.string(), timestamp: z.string() })
  .passthrough();

const value = z
  .object({
    messaging_product: z.literal('whatsapp').optional(),
    metadata: z.object({ phone_number_id: z.string() }).passthrough(),
    contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).partial().optional() }).passthrough()).optional(),
    messages: z.array(z.unknown()).optional(),
    statuses: z.array(z.unknown()).optional(),
  })
  .passthrough();

const payloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z
      .object({
        changes: z.array(z.object({ field: z.string(), value: z.unknown() }).passthrough()).default([]),
      })
      .passthrough(),
  ),
});

export const MAX_TEXT_LENGTH = 4096;

export function parseWebhookPayload(body: unknown): { messages: InboundMessage[]; statuses: StatusEvent[]; skipped: number } {
  const messages: InboundMessage[] = [];
  const statuses: StatusEvent[] = [];
  let skipped = 0;

  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success || parsed.data.object !== 'whatsapp_business_account') return { messages, statuses, skipped: 1 };

  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') {
        skipped++;
        continue;
      }
      const v = value.safeParse(change.value);
      if (!v.success) {
        skipped++;
        continue;
      }
      const names = new Map((v.data.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));

      for (const rawMessage of v.data.messages ?? []) {
        const m = message.safeParse(rawMessage);
        if (!m.success) {
          skipped++;
          continue;
        }
        const msg = m.data;
        const text =
          msg.text?.body ?? msg.button?.text ?? msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? null;
        messages.push({
          messageId: msg.id,
          waId: msg.from,
          phoneNumberId: v.data.metadata.phone_number_id,
          profileName: (names.get(msg.from) ?? null)?.slice(0, 80) ?? null,
          timestampMs: Number(msg.timestamp) * 1000,
          type: msg.type,
          text: text === null ? null : text.slice(0, MAX_TEXT_LENGTH),
        });
      }
      for (const rawStatus of v.data.statuses ?? []) {
        const s = status.safeParse(rawStatus);
        if (!s.success) {
          skipped++;
          continue;
        }
        statuses.push({
          messageId: s.data.id,
          status: s.data.status,
          recipientId: s.data.recipient_id,
          timestampMs: Number(s.data.timestamp) * 1000,
        });
      }
    }
  }
  return { messages, statuses, skipped };
}
