import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderWorkflowJson } from '../scripts/build-n8n-workflow.js';
import { buildResponsesRequest, CLASSIFICATION_JSON_SCHEMA } from '../src/agent/classifier.js';
import { TOOL_NAMES } from '../src/http/tools.js';

const raw = readFileSync(new URL('../n8n/whatsapp-ecommerce-agent.workflow.json', import.meta.url), 'utf8');
const wf = JSON.parse(raw) as {
  nodes: { name: string; type: string; parameters: Record<string, unknown>; credentials?: Record<string, unknown>; maxTries?: number; retryOnFail?: boolean; onError?: string }[];
  connections: Record<string, { main: { node: string }[][] }>;
  settings: Record<string, unknown>;
};
const byName = new Map(wf.nodes.map((n) => [n.name, n]));

/** Runs an n8n Code node's JS with minimal stand-ins for $input, $() and $env. */
function runCode(nodeName: string, input: unknown, refs: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const code = byName.get(nodeName)!.parameters.jsCode as string;
  const $input = { first: () => ({ json: input }), all: () => [{ json: input }] };
  const $ = (name: string) => ({ first: () => ({ json: refs[name] }) });
  const fn = new Function('$input', '$', '$env', code) as (...args: unknown[]) => { json: Record<string, unknown> }[];
  return fn($input, $, env);
}

describe('n8n workflow JSON', () => {
  it('is up to date with the generator (prompt and schema shared with the backend)', () => {
    expect(raw).toBe(renderWorkflowJson());
  });

  it('has unique node names and every connection points at an existing node', () => {
    expect(byName.size).toBe(wf.nodes.length);
    for (const [from, conn] of Object.entries(wf.connections)) {
      expect(byName.has(from), from).toBe(true);
      for (const output of conn.main) for (const target of output) expect(byName.has(target.node), target.node).toBe(true);
    }
  });

  it('every non-trigger node is reachable from the webhook', () => {
    const seen = new Set<string>();
    const queue = ['Inbound Turn (from Gateway)'];
    while (queue.length) {
      const n = queue.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const out of wf.connections[n]?.main ?? []) for (const t of out) queue.push(t.node);
    }
    const unreachable = wf.nodes.filter((n) => !seen.has(n.name) && n.type !== 'n8n-nodes-base.stickyNote').map((n) => n.name);
    expect(unreachable).toEqual([]);
  });

  it('calls only allowlisted gateway tools, always with the turn token and credential-based auth', () => {
    const toolNodes = wf.nodes.filter((n) => typeof n.parameters.url === 'string' && (n.parameters.url as string).includes('/tools/'));
    expect(toolNodes.length).toBeGreaterThan(8);
    for (const n of toolNodes) {
      const tool = (n.parameters.url as string).split('/tools/')[1]!;
      expect(TOOL_NAMES).toContain(tool);
      expect(JSON.stringify(n.parameters.headerParameters)).toContain('X-Turn-Token');
      expect(n.parameters.authentication).toBe('genericCredentialType');
      expect(n.credentials).toHaveProperty('httpHeaderAuth');
    }
  });

  it('bounds every retry (max 3 tries) and never wires a node back upstream', () => {
    for (const n of wf.nodes) if (n.retryOnFail) expect(n.maxTries ?? 3).toBeLessThanOrEqual(3);
    // Topological check: the graph must be acyclic, so no error branch can loop.
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string) => {
      if (done.has(name)) return;
      expect(visiting.has(name), `cycle through ${name}`).toBe(false);
      visiting.add(name);
      for (const out of wf.connections[name]?.main ?? []) for (const t of out) visit(t.node);
      visiting.delete(name);
      done.add(name);
    };
    visit('Inbound Turn (from Gateway)');
  });

  it('routes every tool error output to the single safe fallback', () => {
    for (const name of ['WooCommerce: Search Products', 'WooCommerce: Verify Ownership & Get Order', 'HubSpot: Create Ticket & Handoff', 'Route (Server Guard)']) {
      expect(byName.get(name)!.onError).toBe('continueErrorOutput');
      expect(wf.connections[name]!.main[1]!.map((t) => t.node)).toContain('Safe Fallback: Escalate Tool Error');
    }
  });

  it('contains no secrets', () => {
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{10,}|pat-[a-z]{2,3}\d?-|EAA[A-Za-z0-9]{20,}|ck_[a-f0-9]{20,}|cs_[a-f0-9]{20,}|Bearer [A-Za-z0-9]/);
  });

  it('uses the webhook with header auth and immediate response', () => {
    const hook = byName.get('Inbound Turn (from Gateway)')!;
    expect(hook.parameters).toMatchObject({ httpMethod: 'POST', authentication: 'headerAuth', responseMode: 'onReceived' });
  });

  it('does not store successful execution data (privacy)', () => {
    expect(wf.settings.saveDataSuccessExecution).toBe('none');
  });

  describe('Code nodes execute correctly', () => {
    const envelope = {
      schema: 'synvoca.whatsapp.turn.v1',
      message_id: 'wamid.X',
      turn_token: 'tok',
      message_type: 'text',
      text_redacted: 'my email is [EMAIL], order 1002',
      awaiting: 'email',
      demo_mode: true,
    };

    it('Validate Envelope accepts the gateway schema and rejects anything else', () => {
      const out = runCode('Validate Envelope', { body: envelope });
      expect(out[0]!.json).toMatchObject({ message_id: 'wamid.X', turn_token: 'tok', demo_mode: true, tools_base_url: 'http://gateway:3000' });
      expect(runCode('Validate Envelope', { body: envelope }, {}, { SYNVOCA_TOOLS_BASE_URL: 'https://gw.internal/' })[0]!.json.tools_base_url).toBe('https://gw.internal');
      expect(() => runCode('Validate Envelope', { body: { ...envelope, schema: 'other' } })).toThrow(/Rejected/);
    });

    it('Build OpenAI Request produces the same request as the backend classifier', () => {
      const out = runCode('Build OpenAI Request', {}, { 'Validate Envelope': { text_redacted: envelope.text_redacted, awaiting: 'email' } });
      const expected = buildResponsesRequest('gpt-5-mini', { text: envelope.text_redacted, awaiting: 'email' });
      expect(out[0]!.json.openai_request).toEqual(expected);
      expect((out[0]!.json.openai_request as { store: boolean }).store).toBe(false);
      expect(JSON.stringify(out[0]!.json.openai_request)).toContain(JSON.stringify(CLASSIFICATION_JSON_SCHEMA));
    });

    it('Normalize Classification handles OpenAI, rules and garbage', () => {
      const openai = JSON.parse(readFileSync(new URL('./fixtures/openai/responses-classification.json', import.meta.url), 'utf8'));
      expect(runCode('Normalize Classification', openai)[0]!.json).toMatchObject({ classification_source: 'openai', classification: { intent: 'order_status' } });
      expect(runCode('Normalize Classification', { classification: { intent: 'greeting' }, source: 'mock' })[0]!.json.classification_source).toBe('mock');
      expect(runCode('Normalize Classification', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] })[0]!.json.classification).toBeNull();
    });
  });
});
