# CLAUDE.md — Ahmed's WhatsApp Assistant

Read this before touching anything. It is the entry point; the detailed
history and status live in `docs/ENGINEERING_ROADMAP.md` (the only canonical
tracker). Re-created 2026-11-01 after a full end-to-end review — the original
CLAUDE.md that the tracker cites as "§3", "§6", "§8" no longer exists; this
file replaces it, and §8 below restates the original Version 1
Definition-of-Done so those references still resolve.

---

## 1. What this is

A single-tenant WhatsApp AI sales assistant for **one** clothing/footwear shop
in Pakistan ("Ahmed's Shop"). One business, one WhatsApp number, one owner, no
staff. It:

1. Replies to customers in English / Roman Urdu, grounded in approved data.
2. Remembers customers across days (checkpoints + durable customer notes).
3. Keeps the books: orders, FSM status, stock, double-entry ledger, payment
   claims, refund review cases.
4. Lets Ahmed ask business questions from his own phone (owner mode).

Stack: Node 24 LTS, TypeScript strict, Express, SQLite (`better-sqlite3`
12.10.0), Google Gemini via raw REST (`gemini-flash-lite-latest`), WAHA
(unofficial WhatsApp Web HTTP gateway, run in Docker). No other runtime deps.

GitHub remote: `https://github.com/FarhanUllah382/Whattsapp-Assisstant.git`
(branch `main`).

## 2. Current status (verified 2026-11-01)

| Area | Status |
|---|---|
| V1 — talks + remembers | Done, live-verified 2026-09-05 |
| V2 — keeps the books | Done, live-verified 2026-09-14 |
| V3 — owner Q&A + WhatsApp alerts | Done, live-verified 2026-09-15 |
| Real-business hardening (fulfilment, STOP/START, webhook HMAC, payment claims, refunds, PII, identity) | Built + locally verified |
| HARD-01…HARD-07 (security/ops backlog, Gates A–B) | Built + locally verified; **live WhatsApp acceptance pending** |
| HARD-05, 08–14 | Partial / owner decisions required |
| HARD-15–17 (real-shop pilot) | Missing |
| HARD-18–23 (multi-business, staff, onboarding, courier) | Missing (and multi-tenancy is a permanent exclusion for this codebase) |
| V4 stretch | Only 4.5 product images built (local); 4.1–4.4 not started |
| Portfolio demo (Render) | Was deployed 2026-09-15; **`portfolio-demo/` source folder is now missing locally** — `npm run demo:build` will fail until it is restored from git or rebuilt |

Re-verified on 2026-11-01 (Node 22 container, fresh `npm ci`):
`npm run typecheck` ✅, `npm run build` ✅, `npm test` ✅ (27 files / 120
tests / 31 security areas, production DB fingerprint unchanged),
`npm run test:e2e` ✅.

**Next concrete action (from the tracker):** restore the real signed WAHA
path and execute HARD-01's live acceptance checklist exactly as written —
before adding new behaviour.

## 3. Working rules

- **Status words are precise.** `BUILT` ≠ `LOCALLY VERIFIED` ≠
  `LIVE VERIFIED`. Never mark something done until it has passed against the
  real WhatsApp number (customer-facing behaviour) or a deterministic test at
  the server/tool boundary (auth, race, financial invariants).
- **One tracker.** Update `docs/ENGINEERING_ROADMAP.md` in place — replace
  stale status, don't append a contradicting line. Never create another
  tracker file. `docs/REAL_BUSINESS_PRODUCTION_READINESS.md` is a spec, not a
  status source.
- **Version order.** Each version delivers one promise in dependency order.
  The one recorded exception: V3.1/3.2 were built while V2 awaited live
  verification (usage-limit deadline). Nothing in a later version is
  live-tested before the earlier version has been.
- **Rule of thumb:** "Have we actually hit this problem, or are we
  pre-building for one we imagine?" If imagined, it stays in V4 / excluded.
- **Never commit** real phone numbers, payment destinations, API keys,
  tokens, real customer transcripts, or any `*.db`.
- **Schema changes** require: a verified backup (`npm run backup` then
  `npm run backup:verify -- <path>`), `PRAGMA integrity_check = ok`, zero
  `foreign_key_check` violations, before/after row-count reconciliation.
- **Never delete history** in the ledger, claims, events or audit tables —
  correct with compensating entries (see claim #4 repair).
- Ask before anything irreversible on the live number or the real `ahmed.db`.

## 4. Architecture

```
WAHA ──POST /webhook/whatsapp──▶ server.ts
  raw-body HMAC (webhook-auth.ts) → replay cutoff + dedupe (inbound-events.ts)
  → per-sender rate limit (abuse-control.ts) → durable queue (inbound-jobs.ts,
    4 workers, 500 max, lease/retry) → 503 when saturated
  → isOwnerPhone? (owner.ts, fail-closed)
       ├─ yes → runOwnerTurn (agent.ts) → owner tools (analytics, claims, refunds)
       └─ no  → STOP/START (consent.ts) → runTurn (agent.ts)
                 OPEN (history, checkpoint, notes)
                 LOOP (Gemini tool calls via llm.ts, AI budget ai-budget.ts)
                 CLOSE (checkpoint summary + safety-net extraction)
  outbound: send_message tool only → guardrails → withSendLock → pacing
            → send_ledger idempotency (outbound-delivery.ts) → WAHA sendText
```

Core conventions (see `docs/ARCHITECTURE_GUIDELINES.md`):

1. **Single AI seam** — every model call goes through `callModel` in
   `src/llm.ts`. Never call Gemini anywhere else.
2. **Tool-gated sends** — model plain text is discarded; only the
   `send_message` tool reaches a customer, after all guardrails.
3. **Server-side validation** of every tool input; the model never supplies
   authoritative prices, totals, ids or status changes.
4. **Teaching-text errors** — tools return `{ ok: false, error: "..." }`,
   never throw out of a turn.
5. **Derived balances** — Σdebits − Σcredits from `ledger`; no balance
   column. Money is integer paisa (`src/money.ts`).
6. **Forward-only order FSM** `placed → confirmed → paid → shipped →
   delivered`, cancel only before shipping; actor-specific permissions;
   append-only `order_status_events`.
7. **Two-step order booking** — `prepare_order` shows a server summary;
   only a *later* inbound message with explicit confirm wording ("confirm",
   "book it", "order") books it. Bare "yes/ok/haan/ji/done" is rejected.
8. **Payments** — customers can only create *unverified* claims. The model
   has no resolution tool. Owner must send
   `APPROVE CLAIM <id> REF <ref>` then `CONFIRM APPROVE CLAIM <id> REF <ref>`
   (same for `REJECT` / `REVERSE`). SQLite triggers enforce the links.
9. **Untrusted data** — stored text and tool results are wrapped in trust
   envelopes (`untrusted-data.ts`); only fixed backend checks grant authority.
10. **Truthful wording** — `sensitive-action-wording.ts`,
    `handoff-claims.ts` and `customer-reply-safety.ts` veto replies that
    claim a payment verified, refund done, owner viewed, etc. when it isn't.
11. **Privacy** — structured logs are redacted (`obs/logger.ts`, no raw
    `console.log`), exact stock counts are private (bands only), foreign and
    missing order references are indistinguishable.
12. **Fail closed everywhere** — missing owner phone, catalog hash, HMAC key,
    ops key, payment destination or pacing date ⇒ the feature is disabled,
    never unlimited.

## 5. File map (project files only)

```
src/
  server.ts               Express entry: /health, /ready, /operations/metrics, /webhook/whatsapp
  agent.ts                Public barrel (runTurn, runOwnerTurn, send helpers) — import from here
  agent/  shared.ts           send lock (withSendLock), nowSql, inbound recording, pacing state, customer row
          prompts.ts          customer SYSTEM_PROMPT + OWNER_SYSTEM_PROMPT
          send-guards.ts      guarded customer send_message + customer-send checks
          customer-sends.ts   show_product_images, consent confirmation, busy reply
          owner-send.ts       paced owner send_message, owner-alert send, retryOwnerAlerts
          customer-turn.ts    runTurn OPEN + LOOP + silent-no-reply guard
          turn-close.ts       runTurn CLOSE: checkpoint/notes + order/payment safety net
          owner-turn.ts       runOwnerTurn
  tools.ts                Public barrel: re-exports all tools, builds baseTools / ownerTools (order fixed)
  tools/  catalog-stock.ts    check_stock, search_catalog
          customer-memory.ts  get_customer_balance, get_customer_note
          order-validation.ts server pricing, fulfilment validation, stock check, order insert
          order-drafts.ts     draft row/summary, getPendingOrderDraft, isExplicitOrderConfirmation
          orders.ts           prepare_order, confirm_order, update_order_status
          handoff.ts          recordHandoff, notify_owner
          owner-analytics.ts  inventory_overview, sales_today, unpaid_customers, top_selling_product, pending_followups
  llm.ts                  Gemini REST seam
  db.ts  ../db/schema.sql SQLite singleton + startup migrations (28 tables)
  orders.ts order-access.ts order-summary.ts   FSM, sender-bound lookup, summaries
  inventory.ts inventory-visibility.ts catalog.ts business-grounding.ts
  ledger.ts money.ts payments.ts payment-resolution.ts payment-instructions.ts
  refunds.ts consent.ts privacy.ts untrusted-data.ts
  alerts.ts followups.ts analytics.ts owner.ts
  inbound-events.ts inbound-jobs.ts abuse-control.ts ai-budget.ts busy-reply.ts
  outbound-delivery.ts operations.ts database-backup.ts product-media.ts
  sensitive-action-wording.ts handoff-claims.ts customer-reply-safety.ts webhook-auth.ts
  channel/  types.ts (ChannelAdapter) waha.ts (WahaAdapter)
  guardrails/ discount-rules.ts human-promise.ts messaging-window.ts pacing/ spinning/
  obs/logger.ts
tests/                    27 files run by scripts/run-isolated-tests.ts (tests/index.ts = main suite)
scripts/                  seed-catalog, import-inventory, backup/verify, test-manifest,
                          run-isolated-tests, test-v2-flow, portfolio demo seed/build/verify,
                          repair-legacy-payment-claim, verify-product-media
catalog.md                Owner-approved policy/FAQ text (hash must match APPROVED_CATALOG_SHA256)
assets/product-images/    28 product PNGs used by show_product_images
docs/                     ENGINEERING_ROADMAP.md (tracker), SYSTEM_ARCHITECTURE.md,
                          ARCHITECTURE_GUIDELINES.md, REAL_BUSINESS_PRODUCTION_READINESS.md,
                          OPERATIONS_RUNBOOK.md, INVENTORY_CSV_GUIDE.md, diagrams
backups/                  Gitignored verified SQLite backups (keep — incident history)
ahmed.db                  REAL production database (gitignored) — never open from tests
```

Customer tools (`baseTools` in `tools.ts`, plus `send_message` and
`show_product_images` added in `agent/`): `check_stock`,
`get_customer_balance`, `get_customer_note`, my-order-status, `prepare_order`,
`confirm_order`, `update_order_status` (actor-limited), `claim_payment`,
`request_refund`, `get_my_refund_status`, `notify_owner`, payment options,
`search_catalog`. The legacy `record_order` / `record_payment` tools were
removed on 2026-11-01 (they bypassed two-step booking and claim verification);
tests assert no exported tool list contains them — never re-add them.
Owner tools (`ownerTools` in `tools.ts`): `inventory_overview`, `sales_today`,
`unpaid_customers`, `top_selling_product`, `pending_followups`,
`pending_payment_claims`, `pending_refund_requests`, `resolve_refund_request`.
Order shipping/delivery is also NOT a tool: exact two-step owner commands
`SHIP ORDER <ref>` / `DELIVER ORDER <ref>` then `CONFIRM SHIP ORDER <ref>` /
`CONFIRM DELIVER ORDER <ref>`, parsed in `src/fulfilment-commands.ts` before
the model (only `paid → shipped → delivered` is allowed today — see §10).
Payment-claim approval is deliberately NOT a tool — it is the exact two-step
text command parsed in `payment-resolution.ts`.

## 6. Commands

```bash
npm ci
npm run typecheck          # tsc --noEmit
npm test                   # all 27 test files, each on its own temp DB
npm run test:security      # same via security manifest, prints coverage areas
npm run test:e2e           # Version 2 order/ledger end-to-end flow
npm run dev                # loads .env, runs src/server.ts with tsx (port 3000)
npm run build && npm start # compiled dist/
npm run seed               # seed products
npx tsx scripts/import-inventory.ts <csv>   # see docs/INVENTORY_CSV_GUIDE.md
npm run backup / backup:verify -- <abs path>
npm run catalog:verify-media
npm run demo:build / demo:start / demo:verify   # needs portfolio-demo/ (currently missing)
```

Tests refuse to open `ahmed.db` and fingerprint it before/after; a test that
changes the real DB fails the run. Keep it that way.

WAHA locally: `docker run -p 3001:3001 -e WHATSAPP_HOOK_URL=http://host:3000/webhook/whatsapp -e WHATSAPP_HOOK_EVENTS=message -e WHATSAPP_HOOK_HMAC_KEY=<same as WAHA_WEBHOOK_HMAC_KEY> devlikeapro/waha`.
Preserve the WAHA session volume — deleting it forces a relink and can replay
history (see the 2026-09-27/29 replay incidents in the tracker).

## 7. Configuration

All variables are documented in `.env.example`. Must-haves for a real run:
`GEMINI_API_KEY`, `WAHA_BASE_URL`, `WAHA_SESSION`, `WAHA_API_KEY`,
`WAHA_WEBHOOK_HMAC_KEY`, `AHMED_OWNER_PHONE`, `APPROVED_CATALOG_SHA256`,
`PACING_NUMBER_ACTIVATED_ON`, `OPERATIONS_API_KEY` (≥24 chars). Payment
methods other than COD stay unavailable until their `PAYMENT_*` values are
set. After editing `catalog.md`, recompute its SHA-256 and update
`APPROVED_CATALOG_SHA256` or policy answers fail closed.

## 8. Version 1 Definition of Done (the original "§8")

1. A real WhatsApp message produces a real reply.
2. Crash-and-retry produces no duplicate reply.
3. A malformed/unexpected tool call doesn't crash a turn.
4. A fact told in one conversation is recalled correctly days later.
5. A burst of messages visibly throttles/spaces out; outside-hours messages
   queue instead of firing immediately.
6. An unauthorized discount is refused, not granted.
7. A genuinely out-of-scope question triggers a handoff, not a guess.
8. Catalog/FAQ: correct answer when covered, "I'll confirm and get back"
   when not, never invented.
9. The tracker accurately reflects all of the above — no stale or
   contradicting markers.

All 9 verified 2026-09-05 — details in the tracker's "Version 1 — final
status". Known open edge: crash after a successful send but before
`send_ledger` is marked sent.

## 9. Permanent exclusions (do not build)

Multi-tenancy/org scoping, billing/BYOK, B2B lead funnel, dual-agent split,
agent-config publishing, intent routing, staff RBAC/queues, self-optimising
flywheel, jailbreak classifier, LGPD-type tooling. Handoff always means
messaging Ahmed. A multi-business SaaS would be a new architecture, not an
increment to this repo.

## 10. Known gaps to keep in mind

Fixed on 2026-11-01 (Round 1): Gemini/WAHA timeouts + API key moved to the
`x-goog-api-key` header + `GEMINI_MODEL` setting; legacy `record_order` /
`record_payment` tools removed (`bookkeeping_receipts` now receives no new
rows — kept for history); README rewritten; `.gitattributes` added;
`portfolio-demo/` restored; HARD-01 kit added (`docs/HARD-01_LIVE_CHECKLIST.md`,
`npm run live:verify`, read-only).

Still open:
- **COD decision needed (HARD-09/10):** the FSM only allows
  `confirmed → paid → shipped`, and nothing reachable from WhatsApp sets
  `paid` (approving a payment claim credits the ledger but never changes
  order status). With COD the only enabled method, real orders stop at
  `confirmed`, so SHIP/DELIVER can't be used on them yet. Decide: allow owner
  `confirmed → shipped` for COD (and record cash at delivery), or add an
  authenticated owner `paid` command requiring a settled balance.
- Live acceptance (HARD-01) has not been run since the hardening work;
  scenario 7 (delivered-order refund) waits on the COD decision.
- Shipped/delivered changes do not message the customer yet (needs the
  guarded customer-send path + a messaging-window decision).
- `agent.ts` (~1500 lines) and `tools.ts` are very large — split only with
  tests green before and after.
- Stale `record_order` mentions in comments: `src/orders.ts`,
  `tests/orders.test.ts`, `scripts/verify-portfolio-demo.ts`.
- WAHA is an unofficial WhatsApp Web bridge: ban risk; HARD-13 is the
  decision to move to the official WhatsApp Cloud API for a real client.
