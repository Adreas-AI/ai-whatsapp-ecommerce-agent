/** Builds Meta-shaped webhook payloads. Used by the demo simulator, scripts and tests. */
export function buildTextMessagePayload(input: {
  from: string;
  name?: string | null;
  text: string;
  messageId: string;
  phoneNumberId: string;
  timestampSec: number;
}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'DEMO_WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550009999', phone_number_id: input.phoneNumberId },
              contacts: [{ profile: { name: input.name ?? 'Customer' }, wa_id: input.from }],
              messages: [
                { from: input.from, id: input.messageId, timestamp: String(input.timestampSec), type: 'text', text: { body: input.text } },
              ],
            },
          },
        ],
      },
    ],
  };
}
