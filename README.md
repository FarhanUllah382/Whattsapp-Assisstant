# Ahmed's WhatsApp Assistant

![Node](https://img.shields.io/badge/node-24%20LTS-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-07405e?logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-informational)

A single-tenant WhatsApp AI sales assistant for one clothing/footwear shop in
Pakistan. One business, one WhatsApp number, one owner, no staff. It replies
to customers in English and Roman Urdu using only approved shop data,
remembers customers across days, keeps the books (orders, stock, double-entry
ledger, payment claims, refund review cases), and lets the owner run the shop
and query it from his own phone — all while a non-deterministic LLM is kept
on a short, fully-guarded leash around deterministic backend code that owns
every price, total, status change and payment resolution.

Stack: Node 24 LTS, TypeScript (strict), Express, SQLite via `better-sqlite3`
12.10.0, Google Gemini over raw REST (`gemini-flash-lite-latest`), and
[WAHA](https://waha.devlike.pro/) (an unofficial WhatsApp Web HTTP gateway run
in Docker). No other runtime dependencies.

## Engineering highlights

- **The model proposes, fixed code disposes.** Every price, stock check,
  order total, FSM transition and payment/refund resolution is computed and
  authorized by deterministic backend code; the model's plain text is
  discarded and only a guarded `send_message` tool call can ever reach a
  customer.
- **Financial correctness.** Integer-paisa money, balances derived from a
  `ledger` table (never a stored balance column), atomic stock reservation,
  append-only audit trails, and SQLite triggers that physically forbid
  editing or deleting verified payment/refund history.
- **Security-first by default.** Raw-body HMAC-verified webhooks, replay
  quarantine and provider-event dedupe, per-sender rate limiting, trust
  envelopes around every piece of untrusted stored/tool data, and fail-closed
  configuration everywhere — a missing secret disables the feature, it never
  silently widens access.
- **Operational maturity.** A durable, at-least-once inbound job queue with a
  worker pool and crash/restart recovery; verified online SQLite backups with
  `integrity_check`/`foreign_key_check` on every run; Prometheus metrics,
  a Grafana dashboard and per-message trace tables, with tests that scan
  every trace row and every byte of `/metrics` for leaked phone numbers or
  message text.
- **Test discipline.** 40 test files, each run against its own throwaway
  temporary database, with the real production database fingerprinted
  before and after every run so a test cannot touch real data even by
  accident. A maintained manifest maps every file to the specific security
  property it proves.
- **Honest status tracking.** One canonical roadmap distinguishes `BUILT`
  from `LOCALLY VERIFIED` from `LIVE VERIFIED` — nothing is marked done until
  it has actually passed against the real WhatsApp number or a deterministic
  test at the real security boundary.

## Status

| Area | Status |
|---|---|
| V1 — talks to customers and remembers them | Done, live-verified on the real number |
| V2 — keeps the books (orders, stock, ledger, payment claims) | Done, live-verified |
| V3 — owner Q&A and WhatsApp owner alerts | Done, live-verified |
| Real-business hardening (fulfilment, STOP/START, webhook HMAC, payment claims, refunds, PII, identity) | Built, locally verified |
| Security/ops backlog HARD-01–07 (abuse limits, injection defence, outbound idempotency, durable queue, backups, monitoring) | Built + locally verified; live WhatsApp acceptance in progress |
| Observability — Prometheus metrics, Grafana dashboard, per-message traces | Built + locally verified; first live start pending |
| Official WhatsApp API migration, real-shop pilot, multi-business support | Decision required / not started (see roadmap) |

**This project is not approved for an unattended real-shop launch.** The
inventory and policy text are demonstration data, and WAHA is an unofficial
WhatsApp Web bridge with real account-ban risk — a documented, deliberate
decision point (`HARD-13`), not an oversight. The canonical, itemised status
lives in [docs/ENGINEERING_ROADMAP.md](docs/ENGINEERING_ROADMAP.md).

## What it does

### Customer conversations
- Answers product, stock and policy questions from the product table and the
  owner-approved [catalog.md](catalog.md). Policy answers fail closed if the
  file's SHA-256 does not match `APPROVED_CATALOG_SHA256`. Unknown attributes
  and unsupported questions are handed off to the owner instead of guessed.
- Remembers customers across days through conversation checkpoints and
  durable customer notes.
- Detects whether a customer is writing English or Roman Urdu from function
  words (no extra LLM call) and matches the reply language; ambiguous input
  gets both languages together.
- Shows public stock only as availability bands or a yes/no for a requested
  quantity; exact stock counts stay private.
- Sends up to three product image cards per reply (`show_product_images`)
  from `assets/product-images/` when a customer asks for pictures.
- Refuses unauthorised discounts and blocks replies that promise human
  actions which were not actually recorded.
- Normalises every outbound message body (strips the model's own escaped
  `\n\n`, stray emoji, invisible/zero-width characters) in one place, before
  any guard, idempotency hash or stored transcript sees it — so every
  downstream check sees exactly what the customer receives.

### Orders and bookkeeping
- **Two-step order confirmation.** `prepare_order` shows a server-computed
  summary. Only a *later* inbound message with explicit wording about
  confirming, booking or placing the order books it. Bare "yes", "ok",
  "haan", "ji", "okay" or "done" is rejected. Price and stock are rechecked
  and booking is atomic.
- Prices come from the database, never from the model. Money is stored as
  integer paisa.
- Forward-only order state machine
  `placed -> confirmed -> paid -> shipped -> delivered`, with cancellation only
  before shipping, actor-specific permissions, and an append-only
  `order_status_events` audit trail.
- **Fulfilment is a text command, not a tool.** The owner ships/delivers an
  order with the exact two-step command `SHIP ORDER <ref>` /
  `CONFIRM SHIP ORDER <ref>` (and `DELIVER ORDER` / `CONFIRM DELIVER ORDER`),
  parsed before the model ever sees the message — same no-model-in-the-loop
  discipline as payment resolution.
- Balances are derived from the `ledger` table (sum of debits minus credits);
  there is no stored balance column.
- Order references are high-entropy and bound to the sender's WhatsApp
  number; another customer's order and a nonexistent order produce the same
  response.

### Payments and refunds
- Customers can only create **unverified** payment claims. The model has no
  tool that resolves a claim or credits money.
- The owner approves a claim with an exact two-step text command that
  includes the transaction reference he checked in the business account:

  ```
  APPROVE CLAIM 12 REF TXN123456
  CONFIRM APPROVE CLAIM 12 REF TXN123456
  ```

  Rejection and reversal use `REJECT CLAIM <id>` / `CONFIRM REJECT CLAIM <id>`
  and `REVERSE CLAIM <id>` / `CONFIRM REVERSE CLAIM <id>`. Natural-language
  approval changes nothing. Approval checks duplicate references, amount,
  order and balance; SQLite triggers require an exactly linked ledger credit
  and forbid editing or deleting verification and audit history. Reversal
  writes a compensating debit.
- Payment methods other than cash on delivery stay unavailable until their
  `PAYMENT_*` destinations are configured.
- Refund requests on delivered orders create a **review case** only. The
  owner approves or rejects it; no money moves automatically, and the
  assistant may not claim a refund was paid.

### Owner mode
- Messages from `AHMED_OWNER_PHONE` (fail-closed if unset) go to a separate
  owner assistant with report tools: `inventory_overview`, `sales_today`,
  `unpaid_customers`, `top_selling_product`, `pending_followups`,
  `pending_payment_claims`, `pending_refund_requests`,
  `resolve_refund_request`.
- Owner alerts (handoffs, reply failures, unlogged orders/payments, new
  payment claims, refund requests) are delivered over WhatsApp with a flood
  limit; excess alerts are kept and retried.

### Safety and operations
- **Consent:** `STOP` (and Roman Urdu equivalents such as `messages band
  karo`) stops automated messages; `START` restores them. These commands
  bypass rate limits so a customer can always opt out.
- **Webhook HMAC:** every `POST /webhook/whatsapp` is verified against the
  raw body with an HMAC-SHA512 shared secret (`WAHA_WEBHOOK_HMAC_KEY`, set as
  `WHATSAPP_HOOK_HMAC_KEY` in WAHA). Missing or invalid signatures get HTTP 401.
- **Replay quarantine:** messages older than the stored replay cutoff (advanced
  at every start, optional `INBOUND_ACCEPT_AFTER`) are acknowledged but never
  processed, and provider events are deduplicated.
- **Durable inbound queue:** accepted messages are committed to SQLite before
  WAHA gets HTTP 200, processed by a worker pool (default 4 workers, 500
  pending, lease and retry), resumed after restart, and answered with HTTP 503
  when saturated.
- **Channel-outage detection:** a session monitor tracks whether the WhatsApp
  connection is actually usable and pauses AI work while it is down, instead
  of spending model calls on a turn whose reply can never be delivered (built
  from a real incident where a failed WAHA session still ran Gemini and
  logged turns "completed" while every send got rejected).
- **Abuse limits:** durable per-sender turn limits (default 20 customer / 60
  owner turns per 10 minutes) and a deterministic busy reply with cooldown.
- **AI daily budget:** a shared daily Gemini call and token cap on the
  Karachi business day (defaults 500 calls / 500,000 tokens).
- **Outbound controls:** the model's plain text is discarded; only the
  `send_message` tool reaches a customer, after guardrails, a send lock,
  anti-ban pacing (warm-up cap, configurable sending window, jitter,
  repetition check) and `send_ledger` idempotency.
- **Untrusted data and truthful wording:** stored text and tool results are
  wrapped as untrusted data; replies that falsely claim a payment was
  verified, a refund paid, or the owner viewed something are vetoed.
- **PII redaction:** structured logs are redacted, model-visible contact
  details are masked, and owner alerts are sanitised.
- **Backups:** a verified online SQLite backup at startup and every 24 hours
  (retain 14), each checked with `integrity_check` and `foreign_key_check`.
- **Health and metrics:** `GET /health` (process alive), `GET /ready` (SQLite
  and WAHA session ready, else 503), `GET /operations/metrics` (queue and
  delivery counts, `X-Operations-Key` header, fails closed), and the
  Prometheus/Grafana surface below.

### Observability
- `GET /metrics` exposes Prometheus-format counters/histograms (turn
  outcomes, tool calls, guard blocks, send status) with every label drawn
  from a small fixed set — no customer id, phone number or message text is
  ever a label value.
- Every processed message also gets one `turn_traces` row and an ordered
  `turn_trace_events` list (model calls, tool calls, guard blocks, sends,
  fallbacks, errors), readable via `GET /operations/traces[/:id]` and
  rendered in Grafana's **"Ahmed Assistant — Live"** dashboard.
- Both endpoints require `Authorization: Bearer <OPERATIONS_API_KEY>` and
  fail closed (401) if the key is missing or under 24 characters.
- `tests/observability.test.ts` scans every trace row and the entire
  `/metrics` response for every customer phone and message body in the test
  database — this is enforced, not just documented.
- Run it with `npm run obs:up` / `npm run obs:down` (Prometheus + Grafana in
  Docker, scraping the app on the host). Full setup, including secret
  provisioning, is in [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

## Architecture

```mermaid
flowchart TD
    C([Customer]) --> WAHA[WAHA gateway in Docker]
    O([Owner phone]) --> WAHA
    WAHA -->|POST /webhook/whatsapp| HMAC[Raw-body HMAC check<br/>webhook-auth.ts]
    HMAC -->|401 if invalid| X[Rejected]
    HMAC --> EV[Replay cutoff + dedupe<br/>inbound-events.ts]
    EV --> RL[Per-sender limits<br/>abuse-control.ts]
    RL --> Q[(Durable queue<br/>inbound-jobs.ts)]
    Q -->|503 when saturated| WAHA
    Q --> SM{Session usable?<br/>session-monitor.ts}
    SM -->|no, pause AI| Q
    SM --> W[Worker pool]
    W --> ISO{Owner phone?<br/>owner.ts}
    ISO -->|yes| OT[runOwnerTurn<br/>agent/owner-turn.ts]
    OT --> PR[Exact claim/fulfilment commands<br/>payment-resolution.ts, fulfilment-commands.ts]
    OT --> OTL[Owner tools<br/>analytics, claims, refunds]
    ISO -->|no| CS[STOP / START<br/>consent.ts]
    CS --> CT[runTurn<br/>agent/customer-turn.ts]
    CT --> OPEN[OPEN: history, checkpoint, notes]
    OPEN --> LOOP[LOOP: Gemini tool calls<br/>llm.ts + ai-budget.ts]
    LOOP --> TOOLS[Customer tools<br/>tools/*.ts]
    TOOLS --> DB[(SQLite · 31 tables)]
    OTL --> DB
    PR --> DB
    LOOP --> CLOSE[CLOSE: checkpoint + safety-net extraction]
    LOOP --> SEND[send_message / show_product_images]
    SEND --> G[Guardrails, truthful-wording veto,<br/>send lock, pacing, text normalisation]
    G --> SL[send_ledger idempotency<br/>outbound-delivery.ts]
    SL --> WAHA
    DB -.->|traces + metrics| OBS[Prometheus + Grafana<br/>obs/http.ts, obs/metrics.ts, obs/trace.ts]
```

More detail: [docs/SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md) and
[docs/ARCHITECTURE_GUIDELINES.md](docs/ARCHITECTURE_GUIDELINES.md).

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
tests/                        40 test files run by scripts/run-isolated-tests.ts
scripts/                      seed-catalog, import-inventory, backup/verify, test-manifest,
                               run-isolated-tests, test-v2-flow, live-verify, portfolio demo seed/build/verify
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
triggers and indexes that make the financial and audit guarantees above
enforceable at the database layer, not just in application code.

The real database (`ahmed.db`) is gitignored and must never be committed.

## Setup

### Prerequisites
- Node.js 24 LTS (see `.nvmrc`; `package.json` requires `>=24 <25`)
- Docker (for WAHA, and optionally for the observability stack)
- A Google Gemini API key from [Google AI Studio](https://aistudio.google.com/)
- A WhatsApp number you are allowed to link to WAHA (expect ban risk on new
  or heavily used numbers)

### 1. Install

```bash
git clone https://github.com/FarhanUllah382/Whattsapp-Assisstant.git
cd Whattsapp-Assisstant
npm ci
```

### 2. Configure

```bash
cp .env.example .env
```

Every variable is documented in [.env.example](.env.example). Required for a
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

### 3. Start WAHA

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

### 4. Seed and run

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
[docs/INVENTORY_CSV_GUIDE.md](docs/INVENTORY_CSV_GUIDE.md).

Check the service:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl -H "X-Operations-Key: $OPERATIONS_API_KEY" http://localhost:3000/operations/metrics
```

### 5. Optional: observability stack

```bash
npm run obs:up      # Prometheus + Grafana in Docker, scraping the app on the host
npm run obs:down
```

Secret provisioning and the Grafana dashboard are documented in
[docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

## Testing

```bash
npm run typecheck      # tsc --noEmit
npm test               # all 40 test files, each against its own temporary database
npm run test:security  # the security manifest, printing each file's protection areas
npm run test:e2e       # Version 2 order/ledger end-to-end flow
npm run cost:measure   # model-call/token cost harness for a customer turn
```

The runner fingerprints `ahmed.db` and its SQLite sidecars before and after
every run and fails if they change. Test entry points refuse to open
`ahmed.db` directly, so running a test file with `npx tsx` outside the runner
fails on purpose; always use the npm scripts above.

## Backups

```bash
npm run backup                                    # create a verified backup now
npm run backup:verify -- /absolute/path/to/backup.db
npm run catalog:verify-media                      # check product image files
```

Restore steps and incident procedures are in
[docs/OPERATIONS_RUNBOOK.md](docs/OPERATIONS_RUNBOOK.md).

## Docker

The `Dockerfile` builds a two-stage Node 24 image that compiles TypeScript and
runs `npm start` on port 3000. It copies `catalog.md`, `db/schema.sql` and
`assets/product-images/` into the image.

```bash
docker build -t ahmed-assistant .
docker run --env-file .env -p 3000:3000 \
  -v "$(pwd)/ahmed.db:/app/ahmed.db" \
  -v "$(pwd)/backups:/app/backups" \
  ahmed-assistant
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

## Portfolio demo

A separate, demo-only build uses seeded fake data and is configured for Render
in `render.yaml`:

```bash
npm run demo:build    # seed demo data and assemble .portfolio-runtime/
npm run demo:start    # run the demo server
npm run demo:verify   # check the demo build
```

These scripts read from a `portfolio-demo/` source folder, which is currently
missing from the working copy, so `demo:build` fails until it is restored.

## Documentation

- [CLAUDE.md](CLAUDE.md): entry point, working rules, conventions, file map
- [docs/ENGINEERING_ROADMAP.md](docs/ENGINEERING_ROADMAP.md): the only canonical status tracker
- [docs/SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md): component and workflow detail
- [docs/ARCHITECTURE_GUIDELINES.md](docs/ARCHITECTURE_GUIDELINES.md): engineering principles
- [docs/OPERATIONS_RUNBOOK.md](docs/OPERATIONS_RUNBOOK.md): health checks, backup/restore, incidents
- [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md): Prometheus/Grafana/trace setup and privacy rules
- [docs/HARD-01_LIVE_CHECKLIST.md](docs/HARD-01_LIVE_CHECKLIST.md): live WhatsApp acceptance checklist
- [docs/REAL_BUSINESS_PRODUCTION_READINESS.md](docs/REAL_BUSINESS_PRODUCTION_READINESS.md): readiness specification
- [docs/INVENTORY_CSV_GUIDE.md](docs/INVENTORY_CSV_GUIDE.md): inventory CSV format

## License

Licensed under the [MIT License](LICENSE).
