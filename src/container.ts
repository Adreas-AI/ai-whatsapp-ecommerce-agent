import type { Config } from './config.js';
import { OpenAIClassifier, RuleClassifier, type Classifier } from './agent/classifier.js';
import { WebhookGateway } from './agent/gateway.js';
import { AgentService } from './agent/service.js';
import { MockCommerceClient, WooCommerceClient, type CommerceClient } from './integrations/commerce.js';
import { HubSpotClient, MockCrmClient, type CrmClient } from './integrations/crm.js';
import type { RequestOptions } from './integrations/http.js';
import { createLogger, type Logger } from './observability/logger.js';
import { TraceStore } from './observability/trace.js';
import { MemoryStore } from './store/kv.js';
import { CloudApiWhatsAppClient, MockWhatsAppClient, type WhatsAppClient } from './whatsapp/client.js';

export interface Services {
  config: Config;
  logger: Logger;
  store: MemoryStore;
  traces: TraceStore;
  commerce: CommerceClient;
  crm: CrmClient;
  whatsapp: WhatsAppClient;
  classifier: Classifier;
  agent: AgentService;
  gateway: WebhookGateway;
  now: () => number;
}

export interface ServiceOverrides {
  now?: () => number;
  logger?: Logger;
  commerce?: CommerceClient;
  crm?: CrmClient;
  whatsapp?: WhatsAppClient;
  classifier?: Classifier;
  http?: Pick<RequestOptions, 'fetchImpl' | 'sleep'>;
}

/** Wires real clients in live mode and clearly-labelled mocks in DEMO_MODE. */
export function createServices(config: Config, overrides: ServiceOverrides = {}): Services {
  const now = overrides.now ?? Date.now;
  const logger = overrides.logger ?? createLogger(config.logging.level, { logMessageText: config.logging.logMessageText });
  const store = new MemoryStore(now);
  const traces = new TraceStore();
  const demo = config.demoMode;
  const http = overrides.http;

  const commerce =
    overrides.commerce ??
    (demo
      ? new MockCommerceClient()
      : new WooCommerceClient({
          baseUrl: config.woocommerce.baseUrl!,
          consumerKey: config.woocommerce.consumerKey!,
          consumerSecret: config.woocommerce.consumerSecret!,
          currency: config.store.currency,
          etaMetaKey: config.woocommerce.etaMetaKey,
          http,
        }));

  const crm =
    overrides.crm ??
    (demo
      ? new MockCrmClient(now)
      : new HubSpotClient({
          accessToken: config.hubspot.accessToken!,
          baseUrl: config.hubspot.baseUrl,
          ticketPipeline: config.hubspot.ticketPipeline,
          ticketStage: config.hubspot.ticketStage,
          http,
        }));

  const whatsapp =
    overrides.whatsapp ??
    (demo
      ? new MockWhatsAppClient(now)
      : new CloudApiWhatsAppClient({
          accessToken: config.meta.accessToken!,
          phoneNumberId: config.meta.phoneNumberId!,
          graphApiVersion: config.meta.graphApiVersion,
          http,
        }));

  const classifier =
    overrides.classifier ??
    (demo
      ? new RuleClassifier('rules')
      : new OpenAIClassifier({
          apiKey: config.openai.apiKey!,
          model: config.openai.model,
          baseUrl: config.openai.baseUrl,
          reasoningEffort: config.openai.reasoningEffort,
          http,
        }));

  const agent = new AgentService({
    config,
    logger,
    store,
    now,
    commerce,
    crm,
    whatsapp,
    classifier,
    fallbackClassifier: new RuleClassifier('rules'),
    traces,
  });
  const gateway = new WebhookGateway({ config, logger, store, now, agent, traces, whatsapp, http });

  return { config, logger, store, traces, commerce, crm, whatsapp, classifier, agent, gateway, now };
}
