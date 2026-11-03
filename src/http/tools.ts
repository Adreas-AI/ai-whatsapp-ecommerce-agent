import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { Services } from '../container.js';
import { verifyTurnToken } from '../security/turnToken.js';
import { bearerMatches, HttpError } from './util.js';

/**
 * Allowlisted tool API for the n8n workflow.
 *
 * Every call needs:
 *   Authorization: Bearer <TOOLS_API_TOKEN>   (n8n is an allowed caller)
 *   X-Turn-Token: <token from the gateway envelope>  (binds the call to one customer/message)
 * Bodies are validated with strict schemas; unknown fields are rejected. The
 * customer identity always comes from the turn token, never from the body.
 */

const escalationReason = z.enum(['customer_request', 'complaint', 'verification_locked', 'low_confidence', 'tool_error']);

export const TOOL_SCHEMAS = {
  context: z.object({}).strict(),
  'crm/upsert-contact': z.object({}).strict(),
  'classify/rules': z.object({ source: z.enum(['mock', 'fallback']).default('mock') }).strict(),
  route: z.object({ classification: z.unknown(), source: z.enum(['openai', 'mock', 'fallback']) }).strict(),
  'products/search': z.object({ query: z.string().trim().min(1).max(80) }).strict(),
  'orders/lookup': z.object({ order_number: z.string().regex(/^\d{1,12}$/) }).strict(),
  'handoff/escalate': z.object({ reason: escalationReason, priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM') }).strict(),
  'whatsapp/reply': z.object({ text: z.string().min(1).max(4096) }).strict(),
  'turn/complete': z.object({ status: z.enum(['done', 'error']), note: z.string().max(300).optional() }).strict(),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

export async function handleToolCall(services: Services, req: IncomingMessage, name: string, body: unknown): Promise<unknown> {
  if (!bearerMatches(req, services.config.toolsApiToken)) throw new HttpError(401, 'invalid tools token');
  if (!(name in TOOL_SCHEMAS)) throw new HttpError(404, 'unknown tool');
  const tool = name as ToolName;

  const tokenHeader = req.headers['x-turn-token'];
  const claims = verifyTurnToken(typeof tokenHeader === 'string' ? tokenHeader : undefined, services.config.turnTokenSecret, services.now());
  if (!claims) throw new HttpError(403, 'invalid or expired turn token');
  const turn = await services.agent.loadTurn(claims.messageId);
  if (!turn || turn.waId !== claims.waId) throw new HttpError(403, 'turn not found or expired');

  const parsed = TOOL_SCHEMAS[tool].safeParse(body);
  if (!parsed.success) throw new HttpError(400, `invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'} ${i.message}`).join('; ')}`);
  const input = parsed.data as Record<string, unknown>;
  const agent = services.agent;

  switch (tool) {
    case 'context':
      return agent.getContext(turn);
    case 'crm/upsert-contact': {
      const r = await agent.upsertContact(turn);
      return { contact_id: r.contact.id, action: r.action, mock: services.crm.mock };
    }
    case 'classify/rules': {
      const classification = await agent.classifyWithRules(turn, input.source as 'mock' | 'fallback');
      return { classification, source: input.source, mock: true };
    }
    case 'route': {
      const d = await agent.route(turn, input.classification, input.source as 'openai' | 'mock' | 'fallback');
      return {
        route: d.route,
        reason: d.reason,
        intent: d.intent,
        confidence: d.confidence,
        product_query: d.productQuery ?? null,
        order_number: d.orderNumber ?? null,
        escalation_reason: d.escalation?.reason ?? null,
        escalation_priority: d.escalation?.priority ?? null,
        reply_text: d.replyText,
        guard_notes: d.guardNotes,
      };
    }
    case 'products/search': {
      const r = await agent.searchProducts(turn, input.query as string);
      return { count: r.count, reply_text: r.reply, mock: services.commerce.mock };
    }
    case 'orders/lookup': {
      const r = await agent.lookupOrder(turn, input.order_number as string);
      // Only the outcome and the customer-safe reply leave the server; no raw order data.
      return { outcome: r.outcome, reply_text: r.reply, mock: services.commerce.mock };
    }
    case 'handoff/escalate': {
      const r = await agent.escalate(turn, input.reason as z.infer<typeof escalationReason>, input.priority as 'LOW' | 'MEDIUM' | 'HIGH');
      return { outcome: r.outcome, ticket_id: r.ticketId, reply_text: r.reply || null, mock: services.crm.mock };
    }
    case 'whatsapp/reply':
      return { ...(await agent.sendReply(turn, input.text as string)), mock: services.whatsapp.mock };
    case 'turn/complete':
      agent.completeTurn(turn, input.status as 'done' | 'error', input.note as string | undefined);
      return { ok: true };
  }
}
