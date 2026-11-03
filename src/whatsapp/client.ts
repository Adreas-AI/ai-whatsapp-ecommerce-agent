import { requestJson, type RequestOptions } from '../integrations/http.js';

export interface SendResult {
  mock: boolean;
  kind: 'text' | 'template';
  providerMessageId: string | null;
}

export interface WhatsAppClient {
  readonly mock: boolean;
  sendText(to: string, body: string): Promise<SendResult>;
  sendTemplate(to: string, name: string, language: string): Promise<SendResult>;
  markRead(messageId: string): Promise<void>;
}

/** WhatsApp Cloud API: POST https://graph.facebook.com/{version}/{phone-number-id}/messages */
export class CloudApiWhatsAppClient implements WhatsAppClient {
  readonly mock = false;

  constructor(
    private readonly opts: {
      accessToken: string;
      phoneNumberId: string;
      graphApiVersion: string;
      baseUrl?: string;
      http?: Pick<RequestOptions, 'fetchImpl' | 'sleep'>;
    },
  ) {}

  private async post(body: Record<string, unknown>): Promise<{ messages?: { id: string }[] } | null> {
    const base = this.opts.baseUrl ?? 'https://graph.facebook.com';
    return requestJson('whatsapp', `${base}/${this.opts.graphApiVersion}/${encodeURIComponent(this.opts.phoneNumberId)}/messages`, {
      method: 'POST',
      // Sending is not idempotent: only 429 is retried (see http.ts).
      headers: { authorization: `Bearer ${this.opts.accessToken}` },
      body: { messaging_product: 'whatsapp', ...body },
      ...this.opts.http,
    });
  }

  async sendText(to: string, text: string): Promise<SendResult> {
    const res = await this.post({ recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text.slice(0, 4096) } });
    return { mock: false, kind: 'text', providerMessageId: res?.messages?.[0]?.id ?? null };
  }

  async sendTemplate(to: string, name: string, language: string): Promise<SendResult> {
    const res = await this.post({ recipient_type: 'individual', to, type: 'template', template: { name, language: { code: language } } });
    return { mock: false, kind: 'template', providerMessageId: res?.messages?.[0]?.id ?? null };
  }

  async markRead(messageId: string): Promise<void> {
    await this.post({ status: 'read', message_id: messageId });
  }
}

export interface MockOutboxEntry {
  to: string;
  kind: 'text' | 'template';
  body: string;
  at: string;
}

/** DEMO_MODE client: nothing leaves the machine. */
export class MockWhatsAppClient implements WhatsAppClient {
  readonly mock = true;
  outbox: MockOutboxEntry[] = [];
  failNext: Error | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  async sendText(to: string, body: string): Promise<SendResult> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.outbox.push({ to, kind: 'text', body, at: new Date(this.now()).toISOString() });
    return { mock: true, kind: 'text', providerMessageId: `mock.wamid.${this.outbox.length}` };
  }

  async sendTemplate(to: string, name: string, language: string): Promise<SendResult> {
    this.outbox.push({ to, kind: 'template', body: `[template ${name} / ${language}]`, at: new Date(this.now()).toISOString() });
    return { mock: true, kind: 'template', providerMessageId: `mock.wamid.${this.outbox.length}` };
  }

  async markRead(): Promise<void> {}
}
