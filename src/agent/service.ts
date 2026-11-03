import type { Config } from '../config.js';
import type { CommerceClient } from '../integrations/commerce.js';
import type { CrmClient, TicketPriority } from '../integrations/crm.js';
import { UpstreamError } from '../integrations/http.js';
import type { Logger } from '../observability/logger.js';
import type { ToolCallTrace, TraceStore } from '../observability/trace.js';
import { extractEmail, extractOrderNumber, maskPhone, redactText } from '../security/redact.js';
import type { KeyValueStore } from '../store/kv.js';
import type { WhatsAppClient } from '../whatsapp/client.js';
import type { InboundMessage } from '../whatsapp/parse.js';
import { decideOutbound, isWindowOpen } from '../whatsapp/window.js';
import type { Classification, Classifier } from './classifier.js';
import { ContactService, type UpsertResult } from './contacts.js';
import { OrderService, type LookupResult } from './orders.js';
import { replies, staticReply, type ReplyContext } from './replies.js';
import { decideRoute, type EscalationReason, type RouteDecision } from './router.js';
import { ConversationRepo } from './state.js';

/** Everything the server knows about one inbound message. Kept server-side only, for TURN_TTL_MS. */
export interface TurnContext {
  messageId: string;
  waId: string;
  profileName: string | null;
  type: string;
  text: string | null;
  redactedText: string | null;
  entities: { orderNumber?: string; email?: string };
  awaiting: 'order_number' | 'email' | null;
  receivedAt: number;
}

export const TURN_TTL_MS = 60 * 60 * 1000;

export type ClassificationSource = 'openai' | 'mock' | 'fallback';
export type Delivery = 'sent' | 'mock_not_sent' | 'duplicate_suppressed' | 'blocked' | 'failed';

export interface AgentDeps {
  config: Config;
  logger: Logger;
  store: KeyValueStore;
  now: () => number;
  commerce: CommerceClient;
  crm: CrmClient;
  whatsapp: WhatsAppClient;
  /** OpenAI in live mode, rules in DEMO_MODE. */
  classifier: Classifier;
  /** Rules, used if the primary classifier fails. */
  fallbackClassifier: Classifier;
  traces: TraceStore;
}

export class AgentService {
  readonly conversations: ConversationRepo;
  readonly contacts: ContactService;
  readonly orders: OrderService;
  private readonly replyCtx: ReplyContext;

  constructor(private readonly d: AgentDeps) {
    const cfg = d.config;
    this.conversations = new ConversationRepo(d.store, cfg.retention.conversationMs, d.now);
    this.contacts = new ContactService(d.crm, d.store, cfg.retention.conversationMs, d.logger);
    this.orders = new OrderService(d.commerce, d.store, {
      maxFailures: cfg.verification.maxFailures,
      windowMs: cfg.verification.windowMs,
      defaultCountryCode: cfg.store.defaultCountryCallingCode,
      now: d.now,
    });
    this.replyCtx = { storeName: cfg.store.name, supportEmail: cfg.store.supportEmail };
  }

  // -------------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------------

  async beginTurn(msg: InboundMessage): Promise<TurnContext> {
    const now = this.d.now();
    // Use the customer's own timestamp (never later than now): the window closes 24h after *they* wrote.
    const sentAt = Math.min(msg.timestampMs || now, now);
    const state = await this.conversations.update(msg.waId, (s) => {
      s.lastInboundAt = Math.max(s.lastInboundAt ?? 0, sentAt);
      if (msg.profileName) s.profileName = msg.profileName;
    });
    const awaiting = state.awaiting?.kind ?? null;
    const turn: TurnContext = {
      messageId: msg.messageId,
      waId: msg.waId,
      profileName: msg.profileName,
      type: msg.type,
      text: msg.text,
      redactedText: msg.text === null ? null : redactText(msg.text),
      entities: msg.text
        ? { orderNumber: extractOrderNumber(msg.text, awaiting === 'order_number'), email: extractEmail(msg.text) }
        : {},
      awaiting,
      receivedAt: now,
    };
    await this.d.store.set(`turn:${turn.messageId}`, turn, TURN_TTL_MS);

    const demo = this.d.config.demoMode;
    this.d.traces.start({
      turnId: turn.messageId,
      waIdDisplay: demo ? `+${turn.waId}` : maskPhone(turn.waId),
      profileName: demo ? turn.profileName : null,
      receivedAt: new Date(now).toISOString(),
      orchestrator: this.d.config.orchestrator,
      demo,
      messageType: turn.type,
      inboundText: demo ? turn.text : turn.redactedText,
    });
    return turn;
  }

  async loadTurn(messageId: string): Promise<TurnContext | undefined> {
    return this.d.store.get<TurnContext>(`turn:${messageId}`);
  }

  completeTurn(turn: TurnContext, status: 'done' | 'error', note?: string): void {
    this.d.traces.update(turn.messageId, (t) => {
      t.status = status;
      if (note) t.route = { route: t.route?.route ?? 'none', reason: t.route?.reason ?? '', guardNotes: [...(t.route?.guardNotes ?? []), note] };
    });
  }

  /** Runs fn, records it as a tool call in the trace, and rethrows failures. */
  private async tool<T>(
    turn: TurnContext,
    name: string,
    mock: boolean,
    fn: () => Promise<T>,
    describe: (r: T) => Pick<ToolCallTrace, 'summary' | 'detail'> & { status?: ToolCallTrace['status'] },
  ): Promise<T> {
    const started = this.d.now();
    const t0 = performance.now();
    try {
      const result = await fn();
      const d = describe(result);
      this.d.traces.addToolCall(turn.messageId, { name, mock, status: d.status ?? 'ok', durationMs: Math.round(performance.now() - t0), summary: d.summary, detail: d.detail });
      return result;
    } catch (err) {
      const message = err instanceof UpstreamError ? `${err.service} ${err.status ?? 'network'} error` : 'internal error';
      this.d.traces.addToolCall(turn.messageId, { name, mock, status: 'error', durationMs: Math.round(performance.now() - t0), summary: message });
      this.d.logger.error('tool failed', { tool: name, turn: turn.messageId, startedAt: started, error: err });
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Tools (also exposed to n8n over HTTP, see http/tools.ts)
  // -------------------------------------------------------------------------

  async getContext(turn: TurnContext) {
    const state = await this.conversations.get(turn.waId);
    return {
      handoff_active: Boolean(state.handoff?.active),
      awaiting: state.awaiting?.kind ?? null,
      window_open: isWindowOpen(state.lastInboundAt, this.d.now()),
      demo_mode: this.d.config.demoMode,
      classifier: this.d.classifier.mock ? 'mock_rules' : 'openai',
      openai_model: this.d.config.openai.model,
      message_type: turn.type,
      text_redacted: turn.redactedText,
    };
  }

  async upsertContact(turn: TurnContext, verifiedEmail?: string): Promise<UpsertResult> {
    const result = await this.tool(
      turn,
      'hubspot.upsert_contact',
      this.d.crm.mock,
      () => this.contacts.upsertFromWhatsApp({ waId: turn.waId, profileName: turn.profileName, verifiedEmail }),
      (r) => ({ summary: `${r.action} contact ${r.contact.id}${r.changes.length ? ` (${r.changes.join(', ')})` : ''}` }),
    );
    await this.conversations.update(turn.waId, (s) => {
      s.crmContactId = result.contact.id;
    });
    this.d.traces.update(turn.messageId, (t) =>
      t.crmUpdates.push(`Contact ${result.action}: ${result.contact.id}${result.changes.length ? ` · set ${result.changes.join(', ')}` : ''}`),
    );
    return result;
  }

  /** Primary classifier with automatic fallback to rules (used by the local orchestrator). */
  async classify(turn: TurnContext): Promise<{ classification: Classification; source: ClassificationSource }> {
    const input = { text: turn.redactedText ?? '', awaiting: turn.awaiting ?? undefined };
    try {
      const classification = await this.tool(turn, `classify.${this.d.classifier.name}`, this.d.classifier.mock, () => this.d.classifier.classify(input), (c) => ({
        summary: `${c.intent} (${c.confidence.toFixed(2)})`,
      }));
      return { classification, source: this.d.classifier.mock ? 'mock' : 'openai' };
    } catch {
      return { classification: await this.classifyWithRules(turn, 'fallback'), source: 'fallback' };
    }
  }

  async classifyWithRules(turn: TurnContext, source: 'mock' | 'fallback'): Promise<Classification> {
    return this.tool(
      turn,
      source === 'mock' ? 'classify.rules (DEMO mock AI)' : 'classify.rules (fallback)',
      true,
      () => this.d.fallbackClassifier.classify({ text: turn.redactedText ?? '', awaiting: turn.awaiting ?? undefined }),
      (c) => ({ summary: `${c.intent} (${c.confidence.toFixed(2)})` }),
    );
  }

  /** Server-side guard: validates the classification and decides the route. */
  async route(turn: TurnContext, rawClassification: unknown, source: ClassificationSource): Promise<RouteDecision & { replyText: string | null }> {
    const state = await this.conversations.get(turn.waId);
    const decision = decideRoute({
      classification: rawClassification,
      rawText: turn.text,
      messageType: turn.type,
      entities: turn.entities,
      state,
      minConfidence: this.d.config.classifierMinConfidence,
    });
    await this.conversations.update(turn.waId, (s) => {
      Object.assign(s, decision.statePatch);
    });
    this.d.traces.update(turn.messageId, (t) => {
      t.classification = { ...decision.classification, source, mock: source !== 'openai' };
      t.route = { route: decision.route, reason: decision.reason, guardNotes: decision.guardNotes };
    });
    const replyText = decision.route === 'reply' && decision.replyKey ? staticReply(decision.replyKey, this.replyCtx) : null;
    return { ...decision, replyText };
  }

  async searchProducts(turn: TurnContext, query: string): Promise<{ count: number; reply: string; products: Awaited<ReturnType<CommerceClient['searchProducts']>> }> {
    const products = await this.tool(
      turn,
      'woocommerce.search_products',
      this.d.commerce.mock,
      () => this.d.commerce.searchProducts(query, 3),
      (p) => ({ summary: `"${query}" → ${p.length} product(s)`, detail: p.map((x) => ({ name: x.name, price: x.price, stock: x.stockStatus })) }),
    );
    return { count: products.length, products, reply: replies.products(products, query) };
  }

  async lookupOrder(turn: TurnContext, orderNumber: string): Promise<LookupResult & { reply: string }> {
    const state = await this.conversations.get(turn.waId);
    const result = await this.tool(
      turn,
      'woocommerce.verify_and_get_order',
      this.d.commerce.mock,
      () =>
        this.orders.lookup({
          waId: turn.waId,
          orderNumber,
          email: turn.entities.email,
          previouslyVerified: state.verifiedOrders.includes(orderNumber),
        }),
      (r) => ({
        summary: `order #${orderNumber}: ${r.outcome}${r.order ? ` via ${r.order.verifiedBy}` : ''}`,
        status: r.outcome === 'verified' ? 'ok' : 'blocked',
      }),
    );

    this.d.traces.update(turn.messageId, (t) => {
      t.orderLookup = { outcome: result.outcome, order: result.order };
    });

    let reply: string;
    switch (result.outcome) {
      case 'verified':
        await this.conversations.update(turn.waId, (s) => {
          if (!s.verifiedOrders.includes(orderNumber)) s.verifiedOrders.push(orderNumber);
          s.awaiting = undefined;
        });
        if (result.verifiedEmail) {
          await this.upsertContact(turn, result.verifiedEmail).catch(() => undefined);
        }
        reply = replies.orderStatus(result.order!);
        break;
      case 'need_email':
        await this.conversations.update(turn.waId, (s) => {
          s.awaiting = { kind: 'email', orderNumber };
        });
        reply = replies.askEmail(orderNumber);
        break;
      case 'not_verified':
        // Let the customer retry the email for the same order; failures are rate-limited.
        await this.conversations.update(turn.waId, (s) => {
          s.awaiting = { kind: 'email', orderNumber };
        });
        reply = replies.notVerified();
        break;
      case 'locked': {
        await this.conversations.update(turn.waId, (s) => {
          s.awaiting = undefined;
        });
        const esc = await this.escalate(turn, 'verification_locked', 'HIGH');
        reply = esc.reply;
        break;
      }
      case 'invalid_order_number':
        reply = replies.invalidOrderNumber();
        break;
    }
    return { ...result, reply };
  }

  async escalate(
    turn: TurnContext,
    reason: EscalationReason,
    priority: TicketPriority = 'MEDIUM',
  ): Promise<{ outcome: 'ticket_created' | 'ticket_failed' | 'already_active'; ticketId: string | null; reply: string }> {
    const state = await this.conversations.get(turn.waId);
    if (state.handoff?.active) {
      return { outcome: 'already_active', ticketId: state.handoff.ticketId, reply: '' };
    }

    let contactId = state.crmContactId ?? null;
    if (!contactId) contactId = (await this.upsertContact(turn).catch(() => null))?.contact.id ?? null;

    const content = [
      'Escalated from the WhatsApp support assistant.',
      `Reason: ${reason}`,
      `Customer WhatsApp: ${maskPhone(turn.waId)} (full number is on the associated contact)`,
      `Last customer message (redacted): ${(turn.redactedText ?? `[${turn.type} message]`).slice(0, 1000)}`,
      `Orders verified in this chat: ${state.verifiedOrders.join(', ') || 'none'}`,
      'Reply to the customer from the shared WhatsApp inbox. Outside the 24-hour window only an approved template can be sent.',
    ].join('\n');

    let ticketId: string | null = null;
    try {
      const ticket = await this.tool(
        turn,
        'hubspot.create_ticket',
        this.d.crm.mock,
        () => this.d.crm.createTicket({ subject: `WhatsApp support: ${reason.replace(/_/g, ' ')}`, content, priority, contactId }),
        (t) => ({ summary: `ticket ${t.id} (${priority}) linked to ${contactId ?? 'no contact'}` }),
      );
      ticketId = ticket.id;
      this.d.traces.update(turn.messageId, (t) => t.crmUpdates.push(`Ticket created: ${ticket.id} · ${priority} · ${reason}`));
    } catch {
      this.d.traces.update(turn.messageId, (t) => t.crmUpdates.push('Ticket creation FAILED, customer told to use the support email'));
    }

    await this.conversations.update(turn.waId, (s) => {
      s.handoff = { active: true, ticketId, reason, since: this.d.now() };
      s.awaiting = undefined;
    });

    const { supportEmail } = this.replyCtx;
    let reply: string;
    if (reason === 'verification_locked') reply = replies.verificationLocked(ticketId, supportEmail);
    else if (reason === 'tool_error') reply = `${replies.technicalIssue(supportEmail)}${ticketId ? ` (ticket ${ticketId})` : ''}`;
    else reply = ticketId ? replies.escalated(ticketId) : replies.escalatedNoTicket(supportEmail);
    return { outcome: ticketId ? 'ticket_created' : 'ticket_failed', ticketId, reply };
  }

  async releaseHandoff(waId: string): Promise<boolean> {
    let released = false;
    await this.conversations.update(waId, (s) => {
      released = Boolean(s.handoff?.active);
      s.handoff = undefined;
      s.lowConfidenceStreak = 0;
    });
    return released;
  }

  /**
   * Sends the bot's reply for this turn. At most one reply per inbound message
   * (idempotency key = inbound message id), only inside the 24h window, and
   * never while a human handoff that started before this message is active.
   */
  async sendReply(turn: TurnContext, rawText: string): Promise<{ delivery: Delivery; reason?: string }> {
    // eslint-disable-next-line no-control-regex -- intentionally strips control characters (keeps \t and \n)
    const text = rawText.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 4096);
    const record = (delivery: Delivery, reason?: string) => {
      this.d.traces.update(turn.messageId, (t) => {
        t.reply = { text, delivery: reason ? `${delivery}: ${reason}` : delivery, mock: this.d.whatsapp.mock };
      });
      return { delivery, reason };
    };
    if (!text) return record('blocked', 'empty reply');

    const state = await this.conversations.get(turn.waId);
    if (state.handoff?.active && state.handoff.since < turn.receivedAt) return record('blocked', 'human handoff active');

    const decision = decideOutbound({
      lastInboundAt: state.lastInboundAt,
      now: this.d.now(),
      purpose: 'bot_reply',
      templateLanguage: this.d.config.meta.templateLanguage,
    });
    if (decision.kind !== 'text') return record('blocked', decision.kind === 'blocked' ? decision.reason : 'template required');

    const key = `reply:${turn.messageId}`;
    if (!(await this.d.store.setIfAbsent(key, this.d.now(), this.d.config.retention.dedupeMs))) {
      return record('duplicate_suppressed');
    }
    try {
      await this.tool(turn, 'whatsapp.send_text', this.d.whatsapp.mock, () => this.d.whatsapp.sendText(turn.waId, text), (r) => ({
        summary: r.mock ? 'DEMO: not sent, recorded in mock outbox' : `sent ${r.providerMessageId ?? ''}`,
      }));
      return record(this.d.whatsapp.mock ? 'mock_not_sent' : 'sent');
    } catch (err) {
      // If Meta definitely did not accept it (HTTP error response), allow a later retry.
      // On network errors the message may have gone out, so keep the key (at-most-once).
      if (err instanceof UpstreamError && err.status !== null) await this.d.store.delete(key);
      return record('failed', err instanceof UpstreamError ? `${err.status ?? 'network'}` : 'error');
    }
  }

  /** Agent-initiated follow-up (human agent), allowed outside 24h only via approved template. */
  async sendAgentFollowup(waId: string, text: string): Promise<{ delivery: string }> {
    const state = await this.conversations.get(waId);
    const decision = decideOutbound({
      lastInboundAt: state.lastInboundAt,
      now: this.d.now(),
      purpose: 'agent_followup',
      templateName: this.d.config.meta.followupTemplateName,
      templateLanguage: this.d.config.meta.templateLanguage,
    });
    if (decision.kind === 'blocked') return { delivery: `blocked: ${decision.reason}` };
    if (decision.kind === 'template') {
      await this.d.whatsapp.sendTemplate(waId, decision.name, decision.language);
      return { delivery: `template ${decision.name}` };
    }
    await this.d.whatsapp.sendText(waId, text.slice(0, 4096));
    return { delivery: 'text' };
  }

  // -------------------------------------------------------------------------
  // Local orchestrator. Mirrors the n8n workflow node-for-node so DEMO_MODE
  // works without n8n, and tests cover the same flow.
  // -------------------------------------------------------------------------

  async processLocally(turn: TurnContext): Promise<void> {
    const context = await this.getContext(turn);
    if (context.handoff_active) {
      await this.route(turn, null, 'mock');
      this.completeTurn(turn, 'done', 'message left for the human agent');
      return;
    }

    await this.upsertContact(turn).catch(() => undefined); // CRM failure must not block the answer

    let replyText: string | null = null;
    try {
      const { classification, source } = turn.text === null ? { classification: null, source: 'mock' as const } : await this.classify(turn);
      const decision = await this.route(turn, classification, source);
      switch (decision.route) {
        case 'none':
          break;
        case 'reply':
          replyText = decision.replyText;
          break;
        case 'product_search':
          replyText = (await this.searchProducts(turn, decision.productQuery!)).reply;
          break;
        case 'order_lookup':
          replyText = (await this.lookupOrder(turn, decision.orderNumber!)).reply;
          break;
        case 'escalate': {
          const esc = await this.escalate(turn, decision.escalation!.reason, decision.escalation!.priority);
          replyText = esc.reply || null;
          break;
        }
      }
    } catch {
      // Any tool failure → one escalation attempt and an honest message. No retry loop.
      const esc = await this.escalate(turn, 'tool_error', 'MEDIUM').catch(() => null);
      replyText = esc?.reply || replies.technicalIssue(this.replyCtx.supportEmail);
    }

    if (replyText) await this.sendReply(turn, replyText);
    this.completeTurn(turn, 'done');
  }
}
