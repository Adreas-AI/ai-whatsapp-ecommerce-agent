# Security, privacy and platform rules

## Trust boundaries

| Input | Trusted? | How it is handled |
|---|---|---|
| Meta webhook POST | Only after signature check | `X-Hub-Signature-256` HMAC-SHA256 over the **raw** body with `META_APP_SECRET`, constant-time compare. Invalid → 401, nothing processed. |
| Customer message text | **Untrusted** | Redacted before the LLM; wrapped in `<customer_message>` delimiters (delimiter injection stripped); the model has no tools; its output is schema-validated by the server guard. |
| LLM output | **Untrusted** | Must match a strict JSON schema; intent is allowlisted; an `order_number` is discarded unless it literally appears in the customer's message; the model never writes reply text. |
| WooCommerce / HubSpot responses | **Untrusted** | Parsed with schemas; HTML and control characters stripped; lengths capped; product URLs accepted only on the store's own domain. |
| n8n → tool API | Authenticated | Bearer `TOOLS_API_TOKEN` **plus** a gateway-signed, 1-hour **turn token** that binds the call to one message and one customer. The customer is never taken from the request body; strict schemas reject extra fields such as `wa_id`. |
| Dashboard `/api/*` | Admin only in live mode | Bearer `ADMIN_TOKEN`; demo endpoints (`/api/demo/*`, `/api/crm`) return 404 in live mode. |

Only `/webhook` should be reachable from the internet. Keep `/tools/*`, `/api/*` and n8n on a private network or behind a reverse-proxy allowlist.

## Order privacy: ownership before disclosure

An order number alone never reveals anything. Details are shown only if:

1. the sender's WhatsApp number equals the order's billing phone (normalised to international digits), **or**
2. the customer provides the billing email of that order, **or**
3. the same order was already verified in this conversation.

Further protections:
- "Order not found" and "not your order" get identical replies, so the bot can't be used to discover which orders exist.
- After `ORDER_VERIFICATION_MAX_FAILURES` failures per WhatsApp user, or twice that many on a single order number across users, lookups are locked and the chat is escalated. Both limits apply within `ORDER_VERIFICATION_WINDOW_MINUTES`.
- Replies include status, items, dates and tracking only. They never include addresses, emails, phone numbers, totals or payment data.
- An email typed into the chat is **not** used to match or merge CRM contacts. It is only added to the contact after it passed order verification, and even then it only fills an empty field.

## No fabrication

Every customer-facing sentence comes from `src/agent/replies.ts`, filled with tool results:
- Stock is reported exactly as WooCommerce returns it (in stock / out of stock / backorder / "not confirmed").
- Delivery dates appear only if the store stored one (`WOOCOMMERCE_ETA_META_KEY`). Otherwise the reply says the estimate is not available.
- Unknown products → "I couldn't find… and I don't want to guess."

## PII minimisation

| Data | Gateway | n8n | OpenAI | HubSpot | Logs |
|---|---|---|---|---|---|
| Full WhatsApp number | memory (TTL) | ✗ (masked) | ✗ | contact `phone` | masked `1555*****01` |
| Message text | memory, 1 h (turn) | redacted | redacted | redacted, in ticket body on escalation | length only (`LOG_MESSAGE_TEXT=false`) |
| Email typed by customer | memory, 1 h | ✗ (`has_email: true` only) | ✗ (`[EMAIL]`) | only after verification | masked |
| Order details | memory (trace) | reply text only | ✗ | ✗ | ✗ |
| WhatsApp profile name | memory | ✗ | ✗ | `firstname` (only if empty) | ✗ |

Redaction replaces email addresses, phone-like numbers (8+ digits) and card or ID-like numbers (13+ digits). It is pattern-based, so treat it as risk reduction rather than a guarantee.

OpenAI requests set `store: false`. Under OpenAI's API data policies, inputs may still be retained for a limited period for abuse monitoring unless your organisation has zero-data-retention **(verify the current policy and your agreement)**.

## Retention

| Store | Default | Setting |
|---|---|---|
| Conversation state (verification status, handoff flag, awaiting) | 72 h after last activity | `CONVERSATION_RETENTION_HOURS` |
| Turn context (raw text, extracted email) | 1 h | `TURN_TTL_MS` in code |
| Dedupe and reply-idempotency keys | 72 h | `DEDUPE_TTL_HOURS` |
| Dashboard trace buffer | last 100 turns, memory only | `TraceStore` capacity |
| n8n execution data | success: not saved; errors: pruned after 72 h | workflow settings + `EXECUTIONS_DATA_MAX_AGE` |
| HubSpot contacts/tickets | your CRM policy | HubSpot |

The default `MemoryStore` holds no data on disk and loses state on restart. For production with more than one replica, implement `KeyValueStore` on Redis with TLS and authentication, and keep the TTLs.

## GDPR checklist (for the business deploying this)

- **Lawful basis:** answering a customer's own request is typically *contract / pre-contract* or *legitimate interest*. Document it in your privacy notice and link it from your WhatsApp business profile.
- **Processors:** Meta (WhatsApp), OpenAI, HubSpot and your hosting/n8n provider process personal data. Sign DPAs and check international-transfer mechanisms (for example SCCs or the EU-US Data Privacy Framework).
- **Data subject requests:** deletion means removing the HubSpot contact and its tickets, letting gateway state expire (or deleting the `conv:<wa_id>` key) and pruning n8n executions. Access requests are answered from HubSpot.
- **Minimisation:** keep `LOG_MESSAGE_TEXT=false`; don't widen the fields sent to n8n or OpenAI.
- **Security of processing:** TLS everywhere, secrets in a secret manager, least-privilege scopes ([credentials.md](credentials.md)), restricted network access to `/tools` and n8n.

## WhatsApp platform rules

- **24-hour customer service window:** free-form replies are sent only within 24 h of the customer's last message (`src/whatsapp/window.ts`). The bot never re-engages outside the window, and a reply that becomes late is blocked.
- **Templates:** a human agent's follow-up outside the window can only use the approved template in `WHATSAPP_FOLLOWUP_TEMPLATE_NAME`, and only to a customer who wrote first. With no template configured, the send is blocked.
- **No unsolicited messages:** there is no broadcast or marketing path. Numbers that never messaged the business are blocked (`no_prior_customer_message`).
- **Opt-out / human request:** "agent", "human", complaints and refund requests open a HubSpot ticket and silence the bot for that customer until an agent releases it (`POST /api/admin/handoff/release`).

## Reliability and abuse controls

- **Idempotency:** each WhatsApp message id is processed once (Meta retries are ignored). At most one bot reply is sent per inbound message id, even if n8n retries the send.
- **Bounded retries:** HTTP retries are capped at 5 attempts in code (3 by default), and n8n nodes at 3. Non-idempotent creates and sends are not retried on 5xx or network errors. The n8n graph is acyclic, and every error branch ends in one escalation.
- **Timeouts:** 8 s upstream default, 15 s for OpenAI, a request body limit of 1 MB, and `requestTimeout` on the HTTP server.
- **Contact de-duplication:** a per-customer lock plus a local id cache, which also covers HubSpot's search indexing lag.
