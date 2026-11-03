/**
 * Sends a Meta-shaped, correctly signed webhook to a running gateway, exactly
 * like Meta would. Uses META_APP_SECRET from the environment (demo secret by default).
 *
 *   npm run simulate -- --from 15550100001 --text "Where is my order #1002?"
 *   npm run simulate -- --fixture tests/fixtures/meta/text-message.json
 *   npm run simulate -- --text "hi" --bad-signature      # expect HTTP 401
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEMO_SECRETS } from '../src/config.js';
import { buildTextMessagePayload } from '../src/whatsapp/payloads.js';
import { signPayload } from '../src/whatsapp/verify.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.GATEWAY_URL ?? 'http://127.0.0.1:3000/webhook' },
    from: { type: 'string', default: '15550100001' },
    name: { type: 'string', default: 'Alex Rivera (fictional)' },
    text: { type: 'string', default: 'Where is my order #1002?' },
    fixture: { type: 'string' },
    'bad-signature': { type: 'boolean', default: false },
  },
});

const secret = process.env.META_APP_SECRET || DEMO_SECRETS.appSecret;
const body = values.fixture
  ? readFileSync(values.fixture)
  : Buffer.from(
      JSON.stringify(
        buildTextMessagePayload({
          from: values.from!,
          name: values.name,
          text: values.text!,
          messageId: `wamid.SIM.${randomUUID()}`,
          phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'DEMO_PHONE_NUMBER_ID',
          timestampSec: Math.floor(Date.now() / 1000),
        }),
      ),
    );

const signature = values['bad-signature'] ? signPayload(body, 'wrong-secret') : signPayload(body, secret);
const res = await fetch(values.url!, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body });
console.log(`HTTP ${res.status} ${await res.text()}`);
console.log('Open the dashboard (DEMO_MODE) to see the turn: http://localhost:3000/');
