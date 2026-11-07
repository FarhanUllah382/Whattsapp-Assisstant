# Setup

Full local setup, Docker, backups and the project file layout. See the
[README](../README.md) for the project overview, architecture diagram and
quick start.

## Prerequisites

- Node.js 24 LTS (see `.nvmrc`; `package.json` requires `>=24 <25`)
- Docker (for WAHA, and optionally for the observability stack)
- A Google Gemini API key from [Google AI Studio](https://aistudio.google.com/)
- A WhatsApp number you are allowed to link to WAHA (expect ban risk on new
  or heavily used numbers)

## 1. Install

```bash
git clone https://github.com/FarhanUllah382/whatsapp-shop-agent.git
cd whatsapp-shop-agent
npm ci
```

## 2. Configure

```bash
cp .env.example .env
```

Every variable is documented in [.env.example](../.env.example). Required for a
real run (each feature fails closed when its value is missing):

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Gemini API credential |
| `WAHA_BASE_URL` | WAHA URL, e.g. `http://localhost:3001` |
| `WAHA_SESSION` | WAHA session name, e.g. `default` |
| `WAHA_API_KEY` | WAHA API key |
| `WAHA_WEBHOOK_HMAC_KEY` | Long random webhook secret; same value as WAHA's `WHATSAPP_HOOK_HMAC_KEY` |
| `AHMED_OWNER_PHONE` | Owner number in E.164 digits, e.g. `923001234567` |
| `APPROVED_CATALOG_SHA256` | SHA-256 of the approved `catalog.md` |
| `PACING_NUMBER_ACTIVATED_ON` | Date the sending number was activated (drives the warm-up cap) |
| `OPERATIONS_API_KEY` | Separate key for `/operations/metrics`, `/metrics`, `/operations/traces` — at least 24 characters |

Optional, with finite defaults: `PORT`, `PACING_TIMEZONE`,
`PACING_WINDOW_START_HOUR`, `PACING_WINDOW_END_HOUR`, `INBOUND_ACCEPT_AFTER`,
`INBOUND_RATE_WINDOW_MINUTES`, `INBOUND_CUSTOMER_TURNS_PER_WINDOW`,
`INBOUND_OWNER_TURNS_PER_WINDOW`, `AI_BUDGET_TIMEZONE`, `AI_DAILY_CALL_LIMIT`,
`AI_DAILY_TOKEN_LIMIT`, `INBOUND_JOB_WORKERS`, `INBOUND_JOB_MAX_PENDING`,
`INBOUND_JOB_LEASE_SECONDS`, `INBOUND_JOB_MAX_ATTEMPTS`,
`INBOUND_JOB_RETRY_BASE_SECONDS`, `DATABASE_BACKUP_ENABLED`,
`DATABASE_BACKUP_DIRECTORY`, `DATABASE_BACKUP_INTERVAL_HOURS`,
`DATABASE_BACKUP_RETENTION_COUNT`, `OWNER_ALERT_WINDOW_MINUTES`,
`OWNER_ALERT_MAX_SENDS_PER_WINDOW`, `BUSY_REPLY_COOLDOWN_MINUTES`.

Payment destinations (`PAYMENT_EASYPAISA_*`, `PAYMENT_JAZZCASH_*`,
`PAYMENT_BANK_*`) stay blank until the owner provides real details; blank
methods are not offered. Never commit real numbers, keys or account details.

After any edit to `catalog.md`, recompute its hash and update
`APPROVED_CATALOG_SHA256`:

```bash
sha256sum catalog.md
```

## 3. Start WAHA

```bash
docker run -d --name waha --restart unless-stopped -p 127.0.0.1:3001:3000 \
  -e WHATSAPP_HOOK_URL=http://host.docker.internal:3000/webhook/whatsapp \
  -e WHATSAPP_HOOK_EVENTS=message \
  -e WHATSAPP_HOOK_HMAC_KEY=<same value as WAHA_WEBHOOK_HMAC_KEY> \
  -v waha_sessions:/app/.sessions \
  devlikeapro/waha
```

Open `http://localhost:3001`, link the WhatsApp number (QR code, or request a
pairing code via `POST /api/{session}/auth/request-code` to link by phone
number instead), and keep the `waha_sessions` volume — deleting it forces a
relink and can replay message history. Configure the WAHA API key to match
`WAHA_API_KEY` as described in the WAHA documentation.

## 4. Seed and run

```bash
npm run seed       # seed products
npm run dev        # loads .env and runs src/server.ts on port 3000
```

Or compiled:

```bash
npm run build
npm start          # node dist/server.js
```

Import a real inventory CSV with
`npx tsx scripts/import-inventory.ts <file.csv>`; see
[INVENTORY_CSV_GUIDE.md](INVENTORY_CSV_GUIDE.md).

Check the service:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl -H "X-Operations-Key: $OPERATIONS_API_KEY" http://localhost:3000/operations/metrics
```

## 5. Optional: observability stack

```bash
npm run obs:up      # Prometheus + Grafana in Docker, scraping the app on the host
npm run obs:down
```

Secret provisioning and the Grafana dashboard are documented in
[OBSERVABILITY.md](OBSERVABILITY.md).

## 6. Portfolio demo

A separate, demo-only build uses seeded fake data (no model calls, no real
customers) and is configured for Render in [`render.yaml`](../render.yaml):

```bash
npm run demo:build    # seed synthetic data and assemble .portfolio-runtime/
npm run demo:start    # run the demo server
npm run demo:verify   # check the demo build (schema, read-only enforcement, no write tools)
```

These scripts read from the `portfolio-demo/` source folder: `server.ts` and
`public/` are the demo's own code, while `runtime-db.ts` / `runtime-ledger.ts`
are read-only stand-ins for `src/db.ts` / `src/ledger.ts`. Everything else
served by the demo (`src/analytics.ts`, `src/followups.ts`, the pacing engine)
is copied in unmodified from the real application, so the numbers on the
dashboard come from the same code a real deployment would run.

## Docker

The `Dockerfile` builds a two-stage Node 24 image that compiles TypeScript and
runs `npm start` on port 3000. It copies `catalog.md`, `db/schema.sql` and
`assets/product-images/` into the image.

```bash
docker build -t whatsapp-shop-agent .
docker run --env-file .env -p 3000:3000 \
  -v "$(pwd)/ahmed.db:/app/ahmed.db" \
  -v "$(pwd)/backups:/app/backups" \
  whatsapp-shop-agent
```

The database path is fixed at `ahmed.db` in the project root (`/app/ahmed.db`
in the image), so mount it and the backup directory to keep data across
container restarts. Create an empty `ahmed.db` file first if it does not exist,
otherwise Docker creates a directory at that path. WAHA still runs as its own
container; point `WAHA_BASE_URL` and WAHA's `WHATSAPP_HOOK_URL` at addresses
both containers can reach. The repository does not include a managed
production deployment or process supervisor — see `docs/ENGINEERING_ROADMAP.md`
(`HARD-13`) for the deployment/hosting decisions still open before a real
pilot.

## Backups

```bash
npm run backup                                    # create a verified backup now
npm run backup:verify -- /absolute/path/to/backup.db
npm run catalog:verify-media                      # check product image files
```

Restore steps and incident procedures are in
[OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md).

## Project structure

```
catalog.md                    Owner-approved policy/FAQ text (hash-checked)
db/schema.sql                 SQLite schema: 31 tables, triggers, indexes
assets/product-images/        Product images used by show_product_images
Dockerfile                    Two-stage Node 24 image (runs dist/server.js)
render.yaml                   Render config for the portfolio demo
observability/                Prometheus + Grafana docker-compose, dashboards, alerts
src/
  server.ts                   Express entry: /health, /ready, /metrics,
                               /operations/metrics, /operations/traces, /webhook/whatsapp
  agent.ts                    Public barrel — import runTurn/runOwnerTurn from here
  agent/  shared.ts             send lock, nowSql, inbound recording, pacing state
          prompts.ts            customer SYSTEM_PROMPT + OWNER_SYSTEM_PROMPT
          send-guards.ts        guarded customer send_message + send checks
          customer-sends.ts     show_product_images, consent confirmation, busy reply
          owner-send.ts         paced owner send_message, owner-alert send/retry
          customer-turn.ts      runTurn OPEN + LOOP + silent-no-reply guard
          turn-close.ts         runTurn CLOSE: checkpoint/notes + safety net
          owner-turn.ts         runOwnerTurn
  tools.ts                    Public barrel — builds baseTools / ownerTools
  tools/  catalog-stock.ts      check_stock, search_catalog
          customer-memory.ts    get_customer_balance, get_customer_note
          order-validation.ts   server pricing, fulfilment validation, stock check
          order-drafts.ts       draft row/summary, pending-draft lookup, confirm-wording parser
          orders.ts             prepare_order, confirm_order, update_order_status
          handoff.ts            handoff_ledger record, notify_owner
          owner-analytics.ts    inventory_overview, sales_today, unpaid_customers, ...
  fulfilment-commands.ts      Owner SHIP/DELIVER ORDER two-step text commands
  llm.ts                       The single Gemini seam (callModel)
  db.ts                        SQLite connection and startup migrations
  orders.ts  order-access.ts  order-summary.ts      FSM, sender-bound lookup, summaries
  inventory.ts  inventory-visibility.ts  catalog.ts  business-grounding.ts
  ledger.ts  money.ts  payments.ts  payment-resolution.ts  payment-instructions.ts
  refunds.ts  consent.ts  privacy.ts  untrusted-data.ts
  customer-language.ts        English vs Roman Urdu detection for fixed replies
  outbound-format.ts          One normalisation pass for every outbound message body
  sensitive-action-wording.ts  handoff-claims.ts  customer-reply-safety.ts
  alerts.ts  followups.ts  analytics.ts  owner.ts
  inbound-events.ts  inbound-jobs.ts  abuse-control.ts  ai-budget.ts  busy-reply.ts
  outbound-delivery.ts  operations.ts  database-backup.ts  product-media.ts
  webhook-auth.ts
  channel/  types.ts (ChannelAdapter)  waha.ts (WahaAdapter)  session-monitor.ts (outage tracking)
  guardrails/ discount-rules.ts  human-promise.ts  messaging-window.ts  pacing/  spinning/
  obs/  logger.ts (redacting structured logger)  metrics.ts  trace.ts  http.ts
tests/                        39 test files run by scripts/run-isolated-tests.ts
scripts/                      seed-catalog, import-inventory, backup/verify, test-manifest,
                               run-isolated-tests, test-v2-flow, live-verify, portfolio demo seed/build/verify
portfolio-demo/                server.ts, public/, runtime-db.ts, runtime-ledger.ts — the
                               read-only Render demo build (see "Portfolio demo" above)
docs/                         ENGINEERING_ROADMAP.md (tracker), SYSTEM_ARCHITECTURE.md,
                               ARCHITECTURE_GUIDELINES.md, OPERATIONS_RUNBOOK.md,
                               OBSERVABILITY.md, HARD-01_LIVE_CHECKLIST.md, INVENTORY_CSV_GUIDE.md
```

### Database

`db/schema.sql` defines 31 tables, including `customers`, `products`,
`orders`, `order_drafts`, `order_status_events`, `order_fulfilment_intents`,
`ledger`, `payment_claims`, `payment_claim_verifications`,
`payment_claim_ledger_links`, `refund_requests`, `inbound_events`,
`inbound_jobs`, `ai_model_calls`, `customer_notes`, `handoff_ledger`,
`owner_alerts`, `turn_traces` and `turn_trace_events` — all with the
triggers and indexes that make the financial and audit guarantees described
in the README enforceable at the database layer, not just in application code.

The real database (`ahmed.db`) is gitignored and must never be committed.
