/**
 * Generates n8n/whatsapp-ecommerce-agent.workflow.json.
 *
 * The workflow is generated (not hand-edited) so the OpenAI instructions and
 * JSON schema stay identical to src/agent/classifier.ts. A test fails if the
 * committed JSON drifts from this generator.
 *
 *   npm run build:workflow
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CLASSIFICATION_JSON_SCHEMA, CLASSIFIER_INSTRUCTIONS } from '../src/agent/classifier.js';
import { N8N_ENVELOPE_SCHEMA } from '../src/agent/gateway.js';

export const WORKFLOW_PATH = new URL('../n8n/whatsapp-ecommerce-agent.workflow.json', import.meta.url);

export const CREDENTIALS = {
  gateway: { id: 'synvocaGatewayHdr', name: 'Synvoca Gateway → n8n (X-Gateway-Token)' },
  tools: { id: 'synvocaToolsApiHd', name: 'Synvoca Tools API (Authorization: Bearer)' },
  openai: { id: 'synvocaOpenAiKey1', name: 'OpenAI account' },
} as const;

type Node = Record<string, unknown> & { name: string };
const nodes: Node[] = [];
const connections: Record<string, { main: { node: string; type: 'main'; index: number }[][] }> = {};

function add(node: Node): string {
  nodes.push(node);
  return node.name;
}

function connect(from: string, to: string, outputIndex = 0) {
  const entry = (connections[from] ??= { main: [] });
  while (entry.main.length <= outputIndex) entry.main.push([]);
  entry.main[outputIndex]!.push({ node: to, type: 'main', index: 0 });
}

let idSeq = 0;
const id = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;

const ENVELOPE = 'Validate Envelope';
const base = `$('${ENVELOPE}').first().json`;

/** HTTP Request to an allowlisted gateway tool. Customer identity travels only in X-Turn-Token. */
function toolNode(
  name: string,
  tool: string,
  bodyExpr: string,
  pos: [number, number],
  opts: { maxTries?: number; onError?: 'continueErrorOutput' | 'continueRegularOutput' | 'stopWorkflow'; notes: string },
): Node {
  return {
    id: id(),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: pos,
    parameters: {
      method: 'POST',
      url: `={{ ${base}.tools_base_url }}/tools/${tool}`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'X-Turn-Token', value: `={{ ${base}.turn_token }}` }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: bodyExpr,
      options: { timeout: 15000 },
    },
    credentials: { httpHeaderAuth: CREDENTIALS.tools },
    retryOnFail: (opts.maxTries ?? 1) > 1,
    ...((opts.maxTries ?? 1) > 1 ? { maxTries: opts.maxTries, waitBetweenTries: 1500 } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
    notes: opts.notes,
    notesInFlow: false,
  };
}

function codeNode(name: string, jsCode: string, pos: [number, number], notes: string): Node {
  return { id: id(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, parameters: { jsCode }, notes };
}

function switchNode(name: string, outputs: number, expr: string, pos: [number, number], notes: string): Node {
  return {
    id: id(),
    name,
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    position: pos,
    parameters: { mode: 'expression', numberOutputs: outputs, output: expr },
    notes,
  };
}

export function buildWorkflow() {
  nodes.length = 0;
  for (const k of Object.keys(connections)) delete connections[k];
  idSeq = 0;
  const X = (col: number) => col * 280;

  const webhook = add({
    id: id(),
    name: 'Inbound Turn (from Gateway)',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [X(0), 300],
    webhookId: '7d1c6a0e-2f4b-4c8e-9a51-5e7f3b9d2c10',
    parameters: {
      httpMethod: 'POST',
      path: 'synvoca-whatsapp-turn',
      authentication: 'headerAuth',
      responseMode: 'onReceived',
      options: {},
    },
    credentials: { httpHeaderAuth: CREDENTIALS.gateway },
    notes:
      'Receives the redacted turn envelope from the Synvoca gateway (which already verified X-Hub-Signature-256 and de-duplicated the message). Header auth: X-Gateway-Token. Responds 200 immediately.',
  });

  const envelope = add(
    codeNode(
      ENVELOPE,
      `// EDIT: where n8n can reach the gateway's tool API. Overridable with env SYNVOCA_TOOLS_BASE_URL
// when N8N_BLOCK_ENV_ACCESS_IN_NODE=false.
const DEFAULT_TOOLS_BASE_URL = 'http://gateway:3000';
let toolsBaseUrl = DEFAULT_TOOLS_BASE_URL;
try { if ($env.SYNVOCA_TOOLS_BASE_URL) toolsBaseUrl = $env.SYNVOCA_TOOLS_BASE_URL; } catch (e) { /* env access blocked */ }

const body = $input.first().json.body || {};
if (body.schema !== '${N8N_ENVELOPE_SCHEMA}' || typeof body.turn_token !== 'string' || typeof body.message_id !== 'string') {
  throw new Error('Rejected envelope: unexpected schema');
}
return [{ json: {
  message_id: body.message_id,
  turn_token: body.turn_token,
  message_type: String(body.message_type || 'unknown'),
  text_redacted: typeof body.text_redacted === 'string' ? body.text_redacted.slice(0, 4096) : null,
  awaiting: body.awaiting || null,
  demo_mode: body.demo_mode === true,
  tools_base_url: String(toolsBaseUrl).replace(/\\/+$/, ''),
} }];`,
      [X(1), 300],
      'Normalises the envelope. Contains no raw text, email or full phone number: the gateway redacts before forwarding.',
    ),
  );

  const context = add(
    toolNode('Get Conversation Context', 'context', '{}', [X(2), 300], {
      maxTries: 3,
      notes: 'Conversation state: handoff flag, what the bot is waiting for, 24h window, demo mode. Fails the execution if the gateway is unreachable (set an Error Workflow to alert).',
    }),
  );

  const chooseClassifier = add(
    switchNode(
      'Handoff / Classifier Switch',
      4,
      `={{ $json.handoff_active ? 0 : ($json.text_redacted === null ? 1 : ($json.demo_mode ? 2 : 3)) }}`,
      [X(3), 300],
      'Output 0: human handoff active → skip AI. 1: non-text message → skip AI. 2: DEMO_MODE → mock rule classifier. 3: live → upsert contact, then OpenAI.',
    ),
  );

  const upsert = add(
    toolNode('HubSpot: Upsert Contact', 'crm/upsert-contact', '{}', [X(4), 520], {
      maxTries: 2,
      onError: 'continueRegularOutput',
      notes: 'Search by WhatsApp number (+E.164), create or fill empty fields only. Server-side lock + cache prevent duplicates. A CRM outage does not block the answer.',
    }),
  );

  const upsertDemo = add(
    toolNode('HubSpot: Upsert Contact (DEMO mock)', 'crm/upsert-contact', '{}', [X(4), 300], {
      maxTries: 2,
      onError: 'continueRegularOutput',
      notes: 'Same tool; in DEMO_MODE the gateway uses the mock HubSpot client.',
    }),
  );

  const mockClassifier = add(
    toolNode('Mock Classifier (DEMO rules)', 'classify/rules', '={{ JSON.stringify({ source: "mock" }) }}', [X(5), 300], {
      maxTries: 2,
      onError: 'continueErrorOutput',
      notes: 'DEMO_MODE only: deterministic keyword classifier on the gateway. Clearly labelled as mock in traces.',
    }),
  );

  const buildOpenAi = add(
    codeNode(
      'Build OpenAI Request',
      `// EDIT: model. Must support Structured Outputs on the Responses API.
const MODEL = 'gpt-5-mini';
const INSTRUCTIONS = ${JSON.stringify(CLASSIFIER_INSTRUCTIONS)};
const SCHEMA = ${JSON.stringify(CLASSIFICATION_JSON_SCHEMA)};

const env = $('${ENVELOPE}').first().json;
const context = env.awaiting === 'order_number'
  ? 'Context: the assistant just asked the customer for their order number.\\n'
  : env.awaiting === 'email' ? 'Context: the assistant just asked for the email address used on the order.\\n' : '';
const text = String(env.text_redacted || '').replace(/<\\/?customer_message>/gi, '');
return [{ json: { openai_request: {
  model: MODEL,
  instructions: INSTRUCTIONS,
  input: [{ role: 'user', content: context + '<customer_message>\\n' + text + '\\n</customer_message>' }],
  text: { format: { type: 'json_schema', name: 'intent_classification', strict: true, schema: SCHEMA } },
  store: false,
  max_output_tokens: 2000,
} } }];`,
      [X(5), 520],
      'Builds a Responses API request from REDACTED text only. Instructions treat the message as untrusted data. store:false.',
    ),
  );

  const openai = add({
    id: id(),
    name: 'OpenAI: Classify Intent',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [X(6), 520],
    parameters: {
      method: 'POST',
      url: 'https://api.openai.com/v1/responses',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'openAiApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.openai_request) }}',
      options: { timeout: 20000 },
    },
    credentials: { openAiApi: CREDENTIALS.openai },
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 2000,
    onError: 'continueErrorOutput',
    notes: 'Classification only: no tools, no customer data, never writes the reply. On failure → rule fallback.',
  });

  const fallback = add(
    toolNode('Rule Fallback Classifier', 'classify/rules', '={{ JSON.stringify({ source: "fallback" }) }}', [X(7), 700], {
      maxTries: 2,
      onError: 'continueErrorOutput',
      notes: 'Used when OpenAI fails or times out.',
    }),
  );

  const normalize = add(
    codeNode(
      'Normalize Classification',
      `// Accepts either a gateway rules response ({ classification, source }) or an OpenAI Responses API body.
const j = $input.first().json;
let classification = null;
let source = 'fallback';
if (j && j.classification) {
  classification = j.classification;
  source = j.source === 'mock' ? 'mock' : 'fallback';
} else if (j && Array.isArray(j.output)) {
  source = 'openai';
  for (const item of j.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part.type === 'output_text') {
        try { classification = JSON.parse(part.text); } catch (e) { classification = null; }
      }
    }
  }
}
// No validation here on purpose: the gateway guard validates and decides.
return [{ json: { classification, classification_source: source } }];`,
      [X(8), 300],
      'Extracts the JSON classification. The server guard (next node) validates it against the schema.',
    ),
  );

  const route = add(
    toolNode(
      'Route (Server Guard)',
      'route',
      `={{ JSON.stringify({ classification: $json.classification ?? null, source: $json.classification_source ?? 'mock' }) }}`,
      [X(9), 300],
      {
        maxTries: 2,
        onError: 'continueErrorOutput',
        notes:
          'Gateway validates the classification, discards invented order numbers, applies confidence/handoff rules and returns ONE allowlisted route. Static replies come back as reply_text.',
      },
    ),
  );

  const routeSwitch = add(
    switchNode(
      'Route Switch',
      5,
      `={{ ({ product_search: 0, order_lookup: 1, escalate: 2, reply: 3, none: 4 })[$json.route] ?? 4 }}`,
      [X(10), 300],
      '0 product_search · 1 order_lookup · 2 escalate · 3 reply · 4 none',
    ),
  );

  const products = add(
    toolNode('WooCommerce: Search Products', 'products/search', '={{ JSON.stringify({ query: $json.product_query }) }}', [X(11), 0], {
      maxTries: 2,
      onError: 'continueErrorOutput',
      notes: 'Read-only catalogue search. Reply text is built from WooCommerce data; nothing is generated.',
    }),
  );

  const order = add(
    toolNode('WooCommerce: Verify Ownership & Get Order', 'orders/lookup', '={{ JSON.stringify({ order_number: $json.order_number }) }}', [X(11), 180], {
      maxTries: 2,
      onError: 'continueErrorOutput',
      notes:
        'Ownership check on the gateway (billing phone = WhatsApp number, or billing email). Uniform refusal; rate-limited. Only the outcome + customer-safe reply are returned to n8n.',
    }),
  );

  const escalate = add(
    toolNode(
      'HubSpot: Create Ticket & Handoff',
      'handoff/escalate',
      `={{ JSON.stringify({ reason: $json.escalation_reason || 'customer_request', priority: $json.escalation_priority || 'MEDIUM' }) }}`,
      [X(11), 360],
      {
        maxTries: 2,
        onError: 'continueErrorOutput',
        notes: 'Creates a HubSpot TICKET (never a deal) associated with the contact and mutes the bot for this customer.',
      },
    ),
  );

  const safeFallback = add(
    toolNode('Safe Fallback: Escalate Tool Error', 'handoff/escalate', '={{ JSON.stringify({ reason: "tool_error", priority: "MEDIUM" }) }}', [X(12), 640], {
      maxTries: 1,
      onError: 'continueErrorOutput',
      notes: 'Single attempt (no loop). Any tool error ends here: one ticket + honest message.',
    }),
  );

  const staticError = add(
    codeNode(
      'Static Technical-Issue Reply',
      `return [{ json: { reply_text: "Sorry, I'm having a technical problem right now and couldn't complete that. Our team has been notified." } }];`,
      [X(13), 820],
      'Last resort if even the escalation tool failed.',
    ),
  );

  const hasReply = add(
    switchNode('Has Reply?', 2, `={{ ($json.reply_text && String($json.reply_text).length > 0) ? 0 : 1 }}`, [X(14), 300], '0 → send · 1 → nothing to send'),
  );

  const send = add(
    toolNode('WhatsApp: Send Reply', 'whatsapp/reply', '={{ JSON.stringify({ text: $json.reply_text }) }}', [X(15), 200], {
      maxTries: 3,
      onError: 'continueErrorOutput',
      notes:
        'Gateway enforces the 24h window, handoff mute and one-reply-per-message idempotency, so retries cannot double-send. Recipient comes from the turn token.',
    }),
  );

  const complete = add(
    toolNode('Complete Turn (Log)', 'turn/complete', '={{ JSON.stringify({ status: "done" }) }}', [X(16), 300], {
      maxTries: 2,
      onError: 'continueRegularOutput',
      notes: 'Marks the turn done in the gateway trace log (dashboard).',
    }),
  );

  const completeError = add(
    toolNode('Complete Turn (Error Log)', 'turn/complete', '={{ JSON.stringify({ status: "error", note: "reply could not be delivered" }) }}', [X(16), 520], {
      maxTries: 1,
      onError: 'continueRegularOutput',
      notes: 'Records a failed delivery. No further retries.',
    }),
  );

  add({
    id: id(),
    name: 'Read Me',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [X(0) - 40, -260],
    parameters: {
      width: 760,
      height: 360,
      content:
        '## Synvoca · AI WhatsApp E-commerce Support Agent\n\nMeta → **Gateway** (signature check, dedupe, redaction) → this workflow → **Gateway tool API** (WooCommerce / HubSpot / WhatsApp).\n\n* The AI only **classifies**. Replies are built from tool data, never generated.\n* Customer identity comes from the gateway-signed **X-Turn-Token**, not from the AI.\n* Retries are bounded (max 3). Errors go to one escalation, never a loop.\n\nSetup: create the 3 credentials, set `DEFAULT_TOOLS_BASE_URL` in **Validate Envelope**, set the model in **Build OpenAI Request**, then publish.',
    },
  });

  connect(webhook, envelope);
  connect(envelope, context);
  connect(context, chooseClassifier);
  connect(chooseClassifier, route, 0); // handoff active → guard returns "none"
  connect(chooseClassifier, route, 1); // non-text → guard returns unsupported_type reply
  connect(chooseClassifier, upsertDemo, 2);
  connect(chooseClassifier, upsert, 3);
  connect(upsertDemo, mockClassifier);
  connect(mockClassifier, normalize, 0);
  connect(mockClassifier, safeFallback, 1);
  connect(upsert, buildOpenAi);
  connect(buildOpenAi, openai);
  connect(openai, normalize, 0);
  connect(openai, fallback, 1);
  connect(fallback, normalize, 0);
  connect(fallback, safeFallback, 1);
  connect(normalize, route);
  connect(route, routeSwitch, 0);
  connect(route, safeFallback, 1);
  connect(routeSwitch, products, 0);
  connect(routeSwitch, order, 1);
  connect(routeSwitch, escalate, 2);
  connect(routeSwitch, hasReply, 3);
  connect(routeSwitch, complete, 4);
  for (const tool of [products, order, escalate]) {
    connect(tool, hasReply, 0);
    connect(tool, safeFallback, 1);
  }
  connect(safeFallback, hasReply, 0);
  connect(safeFallback, staticError, 1);
  connect(staticError, hasReply);
  connect(hasReply, send, 0);
  connect(hasReply, complete, 1);
  connect(send, complete, 0);
  connect(send, completeError, 1);

  return {
    id: 'synvocaWaAgent01',
    name: 'Synvoca · AI WhatsApp E-commerce Support Agent',
    nodes,
    connections,
    active: false,
    settings: {
      executionOrder: 'v1',
      // Privacy: successful executions are not stored (they contain reply text). Errors are kept for debugging.
      saveDataSuccessExecution: 'none',
      saveDataErrorExecution: 'all',
      saveManualExecutions: true,
      executionTimeout: 120,
    },
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    tags: [],
  };
}

export function renderWorkflowJson(): string {
  return `${JSON.stringify(buildWorkflow(), null, 2)}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  writeFileSync(WORKFLOW_PATH, renderWorkflowJson());
  console.log(`wrote ${WORKFLOW_PATH.pathname}`);
}
