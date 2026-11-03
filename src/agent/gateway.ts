import { createHmac } from 'node:crypto';
import type { Config } from '../config.js';
import { requestJson, type RequestOptions } from '../integrations/http.js';
import type { Logger } from '../observability/logger.js';
import type { TraceStore } from '../observability/trace.js';
import { maskPhone } from '../security/redact.js';
import { createTurnToken } from '../security/turnToken.js';
import type { KeyValueStore } from '../store/kv.js';
import type { WhatsAppClient } from '../whatsapp/client.js';
import { parseWebhookPayload, type InboundMessage } from '../whatsapp/parse.js';
import { handleVerificationChallenge, verifyMetaSignature, type VerificationResult } from '../whatsapp/verify.js';
import { SERVICE_WINDOW_MS } from '../whatsapp/window.js';
import { replies } from './replies.js';
import { TURN_TTL_MS, type AgentService, type TurnContext } from './service.js';

export interface ReceiveResult {
  status: number;
  body: Record<string, unknown>;
  /** Resolves when all messages in the delivery were processed (or forwarded). Tests await this. */
  processing: Promise<void>;
}

export const N8N_ENVELOPE_SCHEMA = 'synvoca.whatsapp.turn.v1';

/**
 * Entry point for Meta webhook traffic.
 * Verifies the signature on the raw body, acknowledges quickly with 200,
 * de-duplicates by WhatsApp message id, then hands each new message to the
 * local orchestrator or to n8n.
 */
export class WebhookGateway {
  constructor(
    private readonly d: {
      config: Config;
      logger: Logger;
      store: KeyValueStore;
      now: () => number;
      agent: AgentService;
      traces: TraceStore;
      whatsapp: WhatsAppClient;
      http?: Pick<RequestOptions, 'fetchImpl' | 'sleep'>;
    },
  ) {}

  verifyChallenge(params: URLSearchParams): VerificationResult {
    const result = handleVerificationChallenge(params, this.d.config.meta.verifyToken);
    this.d.logger.info('webhook verification challenge', { status: result.status });
    return result;
  }

  async receive(rawBody: Buffer, signatureHeader: string | string[] | undefined): Promise<ReceiveResult> {
    if (!verifyMetaSignature(rawBody, signatureHeader, this.d.config.meta.appSecret)) {
      this.d.logger.warn('webhook rejected: missing or invalid X-Hub-Signature-256', { bytes: rawBody.length });
      return { status: 401, body: { error: 'invalid signature' }, processing: Promise.resolve() };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'invalid json' }, processing: Promise.resolve() };
    }

    const { messages, statuses, skipped } = parseWebhookPayload(payload);
    for (const s of statuses) this.d.logger.debug('delivery status', { status: s.status, to: s.recipientId });
    if (skipped) this.d.logger.debug('webhook entries skipped', { skipped });

    const processing = Promise.allSettled(messages.map((m) => this.handleMessage(m))).then((results) => {
      for (const r of results) if (r.status === 'rejected') this.d.logger.error('message handling failed', { error: r.reason });
    });
    return { status: 200, body: { received: messages.length }, processing };
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    const { config, store, logger } = this.d;
    if (!config.demoMode && config.meta.phoneNumberId && msg.phoneNumberId !== config.meta.phoneNumberId) {
      logger.warn('message for a different phone_number_id ignored');
      return;
    }

    // Idempotency: Meta retries deliveries it thinks failed; process each message id once.
    const firstDelivery = await store.setIfAbsent(`dedupe:${msg.messageId}`, this.d.now(), config.retention.dedupeMs);
    if (!firstDelivery) {
      logger.info('duplicate delivery ignored', { messageId: msg.messageId });
      this.d.traces.update(msg.messageId, (t) => {
        t.toolCalls.push({ name: 'gateway.dedupe', mock: false, status: 'skipped', durationMs: 0, summary: 'duplicate delivery of this message ignored' });
      });
      return;
    }

    if (this.d.now() - msg.timestampMs > SERVICE_WINDOW_MS) {
      logger.warn('stale message (older than 24h) not answered', { messageId: msg.messageId });
      return;
    }

    const turn = await this.d.agent.beginTurn(msg);
    logger.info('inbound message', { messageId: msg.messageId, waId: msg.waId, type: msg.type, text: msg.text ?? '' });

    if (!this.d.whatsapp.mock) {
      this.d.whatsapp.markRead(msg.messageId).catch(() => logger.debug('markRead failed'));
    }

    try {
      if (config.orchestrator === 'n8n') await this.forwardToN8n(turn);
      else await this.d.agent.processLocally(turn);
    } catch (err) {
      logger.error('turn processing failed', { messageId: msg.messageId, error: err });
      await this.d.agent.sendReply(turn, replies.technicalIssue(config.store.supportEmail)).catch(() => undefined);
      this.d.agent.completeTurn(turn, 'error', 'orchestrator unavailable: fallback message sent');
    }
  }

  /** Builds the minimal, redacted envelope n8n receives. No raw text, email or full phone number. */
  buildN8nEnvelope(turn: TurnContext): Record<string, unknown> {
    return {
      schema: N8N_ENVELOPE_SCHEMA,
      message_id: turn.messageId,
      wa_id_masked: maskPhone(turn.waId),
      message_type: turn.type,
      text_redacted: turn.redactedText,
      entities: { order_number: turn.entities.orderNumber ?? null, has_email: Boolean(turn.entities.email) },
      awaiting: turn.awaiting,
      demo_mode: this.d.config.demoMode,
      received_at: new Date(turn.receivedAt).toISOString(),
      turn_token: createTurnToken({ messageId: turn.messageId, waId: turn.waId }, this.d.config.turnTokenSecret, TURN_TTL_MS, this.d.now()),
    };
  }

  private async forwardToN8n(turn: TurnContext): Promise<void> {
    const { inboundUrl, gatewayToken } = this.d.config.n8n;
    if (!inboundUrl || !gatewayToken) throw new Error('n8n orchestrator selected but N8N_INBOUND_WEBHOOK_URL / N8N_GATEWAY_TOKEN missing');
    const envelope = this.buildN8nEnvelope(turn);
    const body = JSON.stringify(envelope);
    const t0 = performance.now();
    await requestJson('n8n', inboundUrl, {
      method: 'POST',
      // n8n tools are idempotent per turn (reply key, contact lock, handoff flag), so 5xx retries are safe.
      idempotent: true,
      maxAttempts: 3,
      headers: {
        'x-gateway-token': gatewayToken,
        'x-gateway-signature': `sha256=${createHmac('sha256', gatewayToken).update(body).digest('hex')}`,
      },
      body: envelope,
      ...this.d.http,
    });
    this.d.traces.addToolCall(turn.messageId, {
      name: 'n8n.forward_turn',
      mock: false,
      status: 'ok',
      durationMs: Math.round(performance.now() - t0),
      summary: 'redacted turn envelope forwarded to n8n workflow',
    });
  }
}
