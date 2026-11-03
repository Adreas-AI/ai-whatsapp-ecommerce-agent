# Credentials and minimum permissions

Everything here is needed only for **live mode** (`DEMO_MODE=false`). Demo mode needs none of it.

Rules that apply to every credential:

- Put secrets in `.env` (git-ignored) or your secret manager. Never in the repo, the n8n workflow JSON, or screenshots.
- Use a separate credential per environment (staging and production).
- Grant the minimum scope listed. If a call fails with 403, add the one missing scope rather than switching to an admin token.
- Rotate on staff changes and at least yearly. The gateway reads secrets only at startup, so restart after rotating.

> Dashboards change often. Menu paths below were correct when written. Items marked **(verify)** are worth double-checking against the provider's current docs before go-live.

---

## 1. Meta: WhatsApp Cloud API

| Variable | Where it comes from |
|---|---|
| `META_APP_SECRET` | developers.facebook.com → your app → **App settings → Basic → App secret** |
| `META_VERIFY_TOKEN` | You invent it (`openssl rand -hex 32`) and paste the same value into the webhook config |
| `WHATSAPP_ACCESS_TOKEN` | System-user token (see below). The "temporary access token" on API Setup expires after ~24 h, so use it for a first smoke test only. |
| `WHATSAPP_PHONE_NUMBER_ID` | **WhatsApp → API Setup → Phone number ID**. This is a numeric ID, not the phone number. |
| `GRAPH_API_VERSION` | Use a currently supported version from the Graph API changelog **(verify)**. Default `v23.0`. |
| `WHATSAPP_FOLLOWUP_TEMPLATE_NAME` | Name of an **approved** template in WhatsApp Manager (optional) |

Steps:

1. Create an app at developers.facebook.com (use case: *Connect with customers through WhatsApp* / type *Business*) and add the **WhatsApp** product. Link it to your WhatsApp Business Account (WABA).
2. **Permanent token:** Meta Business Settings → **Users → System users**. Add a system user, assign it the **app** and the **WhatsApp account** as assets, then **Generate token** with these permissions:
   - `whatsapp_business_messaging`: send messages (required)
   - `whatsapp_business_management`: read the WABA and manage templates and webhook subscriptions (required for setup)

   Nothing else is needed. Do not add `business_management` unless your setup flow requires it.
3. **Webhook:** WhatsApp → **Configuration → Webhook → Edit**.
   - Callback URL: `https://<your-public-host>/webhook` (HTTPS is mandatory; locally use a tunnel such as `cloudflared tunnel --url http://localhost:3000`).
   - Verify token: the value of `META_VERIFY_TOKEN`.
   - Click **Verify and save**. The gateway answers the `hub.challenge`.
   - Under **Webhook fields**, subscribe to **`messages`** only.
4. Make sure the app is subscribed to the WABA. The dashboard usually does this automatically. If you receive no events, check with `GET /{WABA_ID}/subscribed_apps` and `POST` to it if needed **(verify)**.
5. With the test number, add your own phone to the allowed recipient list (API Setup → *To*).
6. Optional: create a **Utility** template (for example `support_followup`) in WhatsApp Manager for human follow-ups after the 24-hour window, wait for approval, and set `WHATSAPP_FOLLOWUP_TEMPLATE_NAME`.

Only the gateway needs the Meta credentials. n8n never sees them.

## 2. OpenAI

| Variable | Notes |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com → **Project → API keys → Create secret key**. Create the key in a dedicated project. |
| `OPENAI_MODEL` | Default `gpt-5-mini`. Any model that supports **Structured Outputs on the Responses API** works **(verify the model's availability on your account)**. |
| `OPENAI_REASONING_EFFORT` | Optional (`minimal`/`low`) for reasoning models; leave empty otherwise. |

Minimum permission: if you use a *Restricted* key, allow only the model-request capability used by `POST /v1/responses` and deny everything else (files, assistants, fine-tuning and so on) **(verify current permission names)**. Set a monthly **usage limit** on the project.

The same key goes into the n8n **OpenAI** credential (n8n calls OpenAI in `ORCHESTRATOR=n8n` mode) and into `.env` (the gateway calls OpenAI in `ORCHESTRATOR=local` mode). You only need it where you use it.

Requests use `store: false` and contain redacted text only. See [security-and-privacy.md](security-and-privacy.md).

## 3. HubSpot: private app access token

| Variable | Notes |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | Private app token (starts with `pat-`) |
| `HUBSPOT_TICKET_PIPELINE` / `HUBSPOT_TICKET_STAGE` | Internal IDs. In a default portal the support pipeline is `0` and its first stage `1`. Check under **Settings → Objects → Tickets → Pipelines** **(verify in your portal)**. |

Steps: **Settings → Integrations → Private Apps → Create a private app**. Newer portals place this under **Development → Legacy apps → Create → Private** **(verify)**. Under **Scopes**, select exactly:

| Scope | Why |
|---|---|
| `crm.objects.contacts.read` | Search contacts by WhatsApp number |
| `crm.objects.contacts.write` | Create the contact / fill empty fields |
| `tickets` | Create support tickets and associate them with the contact |

Not needed: any `deals`, `companies`, `owners`, `files` or `settings` scope. The integration creates **tickets, never deals**.

Endpoints used (CRM v3): `POST /crm/v3/objects/contacts/search`, `POST /crm/v3/objects/contacts`, `PATCH /crm/v3/objects/contacts/{id}`, `POST /crm/v3/objects/tickets` (with an inline association to the contact, `associationTypeId 16`, HUBSPOT_DEFINED). HubSpot has introduced date-versioned API paths. v3 remains documented, but **verify** it is not scheduled for sunset when you deploy.

## 4. WooCommerce REST API

| Variable | Notes |
|---|---|
| `WOOCOMMERCE_BASE_URL` | Store root, **https://** only (keys are sent with HTTP Basic auth) |
| `WOOCOMMERCE_CONSUMER_KEY` / `_SECRET` | WP Admin → **WooCommerce → Settings → Advanced → REST API → Add key** |
| `WOOCOMMERCE_ETA_META_KEY` | Optional order meta key with a store-provided delivery date |
| `DEFAULT_COUNTRY_CALLING_CODE` | Used to compare billing phones saved without a country code |

When creating the key:

- **Permissions: Read.** The agent never writes to WooCommerce.
- **User:** a dedicated user with the *Shop manager* role, not your personal admin account, so the key can be revoked independently.
- WordPress permalinks must not be "Plain" (otherwise `/wp-json/` is unavailable).

Endpoints used: `GET /wp-json/wc/v3/products?search=&status=publish`, `GET /wp-json/wc/v3/orders/{id}`.

Assumptions to **verify** for your store:

- The customer-facing order number equals the order ID. Sequential-order-number plugins break this, so extend `WooCommerceClient.getOrder` to search by the plugin's meta key.
- Tracking numbers are read from the WooCommerce *Shipment Tracking* extension's `_wc_shipment_tracking_items` order meta. Other tracking plugins use different keys, and underscore-prefixed meta may be hidden from the REST API by some plugins.

## 5. n8n credentials

Create these three in n8n (**Credentials → Add credential**). The workflow references them by name:

| n8n credential | Type | Fields |
|---|---|---|
| `Synvoca Gateway → n8n (X-Gateway-Token)` | Header Auth | Name `X-Gateway-Token`, Value = `N8N_GATEWAY_TOKEN` |
| `Synvoca Tools API (Authorization: Bearer)` | Header Auth | Name `Authorization`, Value = `Bearer <TOOLS_API_TOKEN>` |
| `OpenAI account` | OpenAI | API key |

`n8n/demo-credentials.json` contains **public demo values only**, for the local demo stack. Never import it into a production n8n.

Also set a long random `N8N_ENCRYPTION_KEY` for the n8n instance (it encrypts stored credentials), and keep the n8n editor behind authentication. n8n never receives Meta, HubSpot or WooCommerce credentials. Those stay in the gateway.

## 6. Gateway-internal secrets

| Variable | Generate with | Purpose |
|---|---|---|
| `TOOLS_API_TOKEN` | `openssl rand -hex 32` | n8n → gateway tool API |
| `TURN_TOKEN_SECRET` | `openssl rand -hex 32` | Signs per-message turn tokens (keep stable across restarts and replicas) |
| `ADMIN_TOKEN` | `openssl rand -hex 32` | Protects `/api/*` (dashboard) in live mode |
| `N8N_GATEWAY_TOKEN` | `openssl rand -hex 32` | Gateway → n8n webhook header |

The gateway refuses to start in live mode if any of these are missing, too short, or still look like placeholders.
