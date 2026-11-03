import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Configuration is read once from process.env and validated.
 *
 * DEMO_MODE=true (the default) swaps every external integration for a clearly
 * labelled mock and fills in demo-only secrets. DEMO_MODE=false requires every
 * live credential and refuses to start with placeholders.
 */

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const num = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v)))
    .pipe(z.number().finite());

const envSchema = z.object({
  DEMO_MODE: bool(true),
  HOST: optionalString.transform((v) => v ?? '127.0.0.1'),
  PORT: num(3000).pipe(z.number().int().min(0).max(65535)),
  ORCHESTRATOR: optionalString.transform((v) => v ?? 'local').pipe(z.enum(['local', 'n8n'])),

  N8N_INBOUND_WEBHOOK_URL: optionalString.pipe(z.string().url().optional()),
  N8N_GATEWAY_TOKEN: optionalString,
  TOOLS_API_TOKEN: optionalString,
  TURN_TOKEN_SECRET: optionalString,
  ADMIN_TOKEN: optionalString,

  META_APP_SECRET: optionalString,
  META_VERIFY_TOKEN: optionalString,
  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  GRAPH_API_VERSION: optionalString.transform((v) => v ?? 'v23.0').pipe(z.string().regex(/^v\d+\.\d+$/)),
  WHATSAPP_FOLLOWUP_TEMPLATE_NAME: optionalString,
  WHATSAPP_TEMPLATE_LANGUAGE: optionalString.transform((v) => v ?? 'en_US'),

  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString.transform((v) => v ?? 'gpt-5-mini'),
  OPENAI_BASE_URL: optionalString.transform((v) => v ?? 'https://api.openai.com/v1'),
  OPENAI_REASONING_EFFORT: optionalString,

  HUBSPOT_ACCESS_TOKEN: optionalString,
  HUBSPOT_BASE_URL: optionalString.transform((v) => v ?? 'https://api.hubapi.com'),
  HUBSPOT_TICKET_PIPELINE: optionalString.transform((v) => v ?? '0'),
  HUBSPOT_TICKET_STAGE: optionalString.transform((v) => v ?? '1'),

  WOOCOMMERCE_BASE_URL: optionalString,
  WOOCOMMERCE_CONSUMER_KEY: optionalString,
  WOOCOMMERCE_CONSUMER_SECRET: optionalString,
  WOOCOMMERCE_ETA_META_KEY: optionalString,
  STORE_NAME: optionalString,
  STORE_CURRENCY: optionalString.transform((v) => v ?? 'EUR'),
  DEFAULT_COUNTRY_CALLING_CODE: optionalString.pipe(z.string().regex(/^\d{1,4}$/).optional()),
  SUPPORT_EMAIL: optionalString.transform((v) => v ?? 'support@example.com'),

  LOG_LEVEL: optionalString.transform((v) => v ?? 'info').pipe(z.enum(['debug', 'info', 'warn', 'error', 'silent'])),
  LOG_MESSAGE_TEXT: bool(false),
  CONVERSATION_RETENTION_HOURS: num(72).pipe(z.number().positive().max(24 * 90)),
  DEDUPE_TTL_HOURS: num(72).pipe(z.number().positive().max(24 * 30)),
  ORDER_VERIFICATION_MAX_FAILURES: num(3).pipe(z.number().int().min(1).max(10)),
  ORDER_VERIFICATION_WINDOW_MINUTES: num(60).pipe(z.number().int().min(1)),
  CLASSIFIER_MIN_CONFIDENCE: num(0.55).pipe(z.number().min(0).max(1)),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  demoMode: boolean;
  host: string;
  port: number;
  orchestrator: 'local' | 'n8n';
  n8n: { inboundUrl?: string; gatewayToken?: string };
  toolsApiToken: string;
  turnTokenSecret: string;
  adminToken?: string;
  meta: {
    appSecret: string;
    verifyToken: string;
    accessToken?: string;
    phoneNumberId?: string;
    graphApiVersion: string;
    followupTemplateName?: string;
    templateLanguage: string;
  };
  openai: { apiKey?: string; model: string; baseUrl: string; reasoningEffort?: string };
  hubspot: { accessToken?: string; baseUrl: string; ticketPipeline: string; ticketStage: string };
  woocommerce: { baseUrl?: string; consumerKey?: string; consumerSecret?: string; etaMetaKey?: string };
  store: { name: string; currency: string; defaultCountryCallingCode?: string; supportEmail: string };
  logging: { level: Env['LOG_LEVEL']; logMessageText: boolean };
  retention: { conversationMs: number; dedupeMs: number };
  verification: { maxFailures: number; windowMs: number };
  classifierMinConfidence: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

const PLACEHOLDER = /(replace[-_ ]?me|change[-_ ]?me|your[-_]|xxx|<.*>|^demo-)/i;

/** Values used only when DEMO_MODE=true. They are public and must never protect real traffic. */
export const DEMO_SECRETS = {
  appSecret: 'demo-app-secret-not-for-production',
  verifyToken: 'demo-verify-token',
  toolsApiToken: 'demo-tools-token-not-for-production',
  n8nGatewayToken: 'demo-n8n-gateway-token-not-for-production',
} as const;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const env = parsed.data;
  const demo = env.DEMO_MODE;

  if (!demo) {
    const problems: string[] = [];
    const requireSecret = (name: keyof Env, minLength = 1) => {
      const value = env[name];
      if (typeof value !== 'string' || value.length === 0) problems.push(`${name} is required when DEMO_MODE=false`);
      else if (value.length < minLength) problems.push(`${name} must be at least ${minLength} characters`);
      else if (PLACEHOLDER.test(value)) problems.push(`${name} still contains a placeholder value`);
    };
    requireSecret('META_APP_SECRET', 16);
    requireSecret('META_VERIFY_TOKEN', 16);
    requireSecret('WHATSAPP_ACCESS_TOKEN', 20);
    requireSecret('WHATSAPP_PHONE_NUMBER_ID');
    requireSecret('OPENAI_API_KEY', 20);
    requireSecret('HUBSPOT_ACCESS_TOKEN', 20);
    requireSecret('WOOCOMMERCE_BASE_URL');
    requireSecret('WOOCOMMERCE_CONSUMER_KEY', 10);
    requireSecret('WOOCOMMERCE_CONSUMER_SECRET', 10);
    requireSecret('TOOLS_API_TOKEN', 32);
    requireSecret('TURN_TOKEN_SECRET', 32);
    requireSecret('ADMIN_TOKEN', 32);
    if (env.WOOCOMMERCE_BASE_URL && !env.WOOCOMMERCE_BASE_URL.startsWith('https://')) {
      problems.push('WOOCOMMERCE_BASE_URL must use https:// (consumer keys are sent with HTTP Basic auth)');
    }
    if (env.ORCHESTRATOR === 'n8n') {
      requireSecret('N8N_INBOUND_WEBHOOK_URL');
      requireSecret('N8N_GATEWAY_TOKEN', 32);
    }
    if (problems.length > 0) throw new ConfigError(problems);
  }

  return {
    demoMode: demo,
    host: env.HOST,
    port: env.PORT,
    orchestrator: env.ORCHESTRATOR,
    n8n: {
      inboundUrl: env.N8N_INBOUND_WEBHOOK_URL,
      gatewayToken: env.N8N_GATEWAY_TOKEN ?? (demo ? DEMO_SECRETS.n8nGatewayToken : undefined),
    },
    toolsApiToken: env.TOOLS_API_TOKEN ?? DEMO_SECRETS.toolsApiToken,
    // A random per-process secret is fine in demo mode; live mode requires a stable one.
    turnTokenSecret: env.TURN_TOKEN_SECRET ?? randomBytes(32).toString('hex'),
    adminToken: env.ADMIN_TOKEN,
    meta: {
      appSecret: env.META_APP_SECRET ?? DEMO_SECRETS.appSecret,
      verifyToken: env.META_VERIFY_TOKEN ?? DEMO_SECRETS.verifyToken,
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      graphApiVersion: env.GRAPH_API_VERSION,
      followupTemplateName: env.WHATSAPP_FOLLOWUP_TEMPLATE_NAME,
      templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE,
    },
    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      baseUrl: env.OPENAI_BASE_URL.replace(/\/+$/, ''),
      reasoningEffort: env.OPENAI_REASONING_EFFORT,
    },
    hubspot: {
      accessToken: env.HUBSPOT_ACCESS_TOKEN,
      baseUrl: env.HUBSPOT_BASE_URL.replace(/\/+$/, ''),
      ticketPipeline: env.HUBSPOT_TICKET_PIPELINE,
      ticketStage: env.HUBSPOT_TICKET_STAGE,
    },
    woocommerce: {
      baseUrl: env.WOOCOMMERCE_BASE_URL?.replace(/\/+$/, ''),
      consumerKey: env.WOOCOMMERCE_CONSUMER_KEY,
      consumerSecret: env.WOOCOMMERCE_CONSUMER_SECRET,
      etaMetaKey: env.WOOCOMMERCE_ETA_META_KEY,
    },
    store: {
      name: env.STORE_NAME ?? (demo ? 'Lumen Leaf Co. (fictional demo store)' : 'our store'),
      currency: env.STORE_CURRENCY,
      defaultCountryCallingCode: env.DEFAULT_COUNTRY_CALLING_CODE ?? (demo ? '1' : undefined),
      supportEmail: env.SUPPORT_EMAIL,
    },
    logging: { level: env.LOG_LEVEL, logMessageText: env.LOG_MESSAGE_TEXT },
    retention: {
      conversationMs: env.CONVERSATION_RETENTION_HOURS * 3_600_000,
      dedupeMs: env.DEDUPE_TTL_HOURS * 3_600_000,
    },
    verification: {
      maxFailures: env.ORDER_VERIFICATION_MAX_FAILURES,
      windowMs: env.ORDER_VERIFICATION_WINDOW_MINUTES * 60_000,
    },
    classifierMinConfidence: env.CLASSIFIER_MIN_CONFIDENCE,
  };
}
