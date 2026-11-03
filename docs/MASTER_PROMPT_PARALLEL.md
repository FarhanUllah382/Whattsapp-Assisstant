# MASTER PROMPT — Observability + Fixes 2–6, run as parallel agents

> Paste everything below the line into Claude Code, opened in
> `C:\Users\w312\Desktop\ahmed-whatsapp-assistant`.
> Or save this file as `docs/MASTER_PROMPT_PARALLEL.md` and tell Claude Code:
> "Read docs/MASTER_PROMPT_PARALLEL.md and execute it exactly."

---

You are the **orchestrator** for this repository. Read `CLAUDE.md` and
`docs/ENGINEERING_ROADMAP.md` first; every rule in CLAUDE.md §3 applies to you
and to every sub-agent you start. You will run **6 workstreams** with
sub-agents, merge them safely, and leave a single green `main` for live
testing.

## 0. Hard rules (copy these into every sub-agent's prompt)

1. Never open, copy, migrate or write `ahmed.db` (the real shop database).
   Tests use the isolated runner (`npm test`), which fingerprints `ahmed.db`.
2. Never print or commit `.env` values, phone numbers, API keys, payment
   destinations or real customer messages. Never commit `*.db`.
3. Do not touch Docker containers, the WAHA session or its volume, and do not
   send any WhatsApp message.
4. Do not `git push`. The owner pushes.
5. Test-first: for every bug, first write a test that **fails on the current
   code**, show it failing, then fix it and show it passing.
6. Keep the architecture rules in CLAUDE.md §4 (single AI seam in
   `src/llm.ts`, tool-gated sends, server-side validation, teaching-text
   errors, integer paisa, forward-only FSM, trust envelopes, fail closed).
7. Register every new test file in `scripts/test-manifest.ts` with a
   coverage area.
8. Each agent must finish with `npm run typecheck`, `npm test` and
   `npm run test:e2e` all green **in its own worktree**, then commit on its
   branch with a clear message.
9. Schema changes: add them as idempotent startup migrations in `src/db.ts`
   and `db/schema.sql` (CREATE TABLE/INDEX IF NOT EXISTS, additive only; never
   drop or rewrite existing tables or history). Do not run them against
   `ahmed.db`; the owner runs `npm run backup` + `backup:verify` before the
   first live start.
10. Stay inside your **owned files** (listed per workstream). If you must
    change a file owned by another workstream, keep the change minimal and
    list it under "Cross-file edits" in your final report.

## 1. Phase 0 — setup (orchestrator, alone)

1. If `docs/MASTER_PROMPT_PARALLEL.md` is untracked, commit it first
   (`docs: add parallel master prompt`). Ignore untracked
   `scripts/start-live.*`, `start-live.cmd`, `qr.png` and `logs/`. Any other
   uncommitted change: stop and report. Note the base commit.
2. Run `npm ci` if needed, then `npm run typecheck`, `npm test`,
   `npm run test:e2e`. Record the baseline (file count, test count). If
   anything fails, stop and report.
3. Create one git worktree + branch per workstream from the base commit:
   ```
   git worktree add ../wt-obs  -b ws/observability
   git worktree add ../wt-fix2 -b ws/fix2-order-drafts
   git worktree add ../wt-fix3 -b ws/fix3-payment-claims
   git worktree add ../wt-fix4 -b ws/fix4-wording-language
   git worktree add ../wt-fix6 -b ws/fix6-whatsapp-down
   ```
   Run `npm ci` in each worktree (or junction `node_modules` if `npm ci` is
   too slow). Copy `.env` into each worktree only if a test needs it; tests
   should not.
4. If your Claude Code version can start sub-agents with their own worktree
   isolation, use that; otherwise point each sub-agent at its worktree folder
   explicitly and forbid it from working anywhere else.

## 2. Phase 1 — five agents in parallel

Start these five sub-agents **at the same time**. Give each one: the hard
rules (§0), its section below verbatim, and its worktree path.

---

### Agent OBS — Observability (worktree `../wt-obs`)

**Goal:** make the assistant fully visible. Totals and trends in
Prometheus/Grafana, plus a per-message trace showing every step of one
message.

**Owned files:** `src/obs/*` (new files), `src/llm.ts`, `src/server.ts`
(new routes only), `src/db.ts` + `db/schema.sql` (new trace tables only),
the new folder `observability/`, `docs/OBSERVABILITY.md`, new tests.
Instrumentation hooks may touch `src/agent/customer-turn.ts`,
`src/agent/owner-turn.ts`, `src/agent/send-guards.ts`,
`src/outbound-delivery.ts`, `src/inbound-jobs.ts`, but only by adding
calls to `src/obs/*` (no behaviour change). List each one under
"Cross-file edits".

**A. Per-message trace (SQLite)**
- New tables:
  - `turn_traces` (id, job_id, customer_id, turn_kind, started_at,
    finished_at, outcome: replied | fallback | no_reply | error | deferred,
    model_calls, prompt_tokens, output_tokens, total_ms);
  - `turn_trace_events` (id, trace_id, seq, at, kind: model_call |
    tool_call | guard_block | send | fallback | error, name, duration_ms,
    prompt_tokens, output_tokens, ok, code, detail_json).
- **Privacy:** never store message bodies, phone numbers, names, addresses
  or payment destinations. Store only ids, tool names, guard check ids,
  error codes, lengths and hashes.
- Instrument:
  - every `callModel` (latency, tokens from `usageMetadata`, status);
  - every tool execution (name, ms, ok);
  - every `send_message` veto, with a **stable guard check id** such as
    `inventory_disclosure`, `order_summary`, `handoff_claim`,
    `spinning`, `pacing`, etc. Add an optional `check` field to the
    guard result; keep the teaching text unchanged;
  - fallback sends, final send result and ledger status;
  - job lifecycle (queued, started, completed, deferred, failed).
- Tracing must **never** break a turn: wrap every write in try/catch and
  count failures in a metric.
- Retention: delete traces older than `TRACE_RETENTION_DAYS` (default 14)
  on startup and daily.

**B. Prometheus endpoint `GET /metrics`**
- Prometheus text exposition format, written by hand (no new runtime
  dependency).
- Auth: `Authorization: Bearer <OPERATIONS_API_KEY>`. Fail closed when the
  key is missing or shorter than 24 characters.
- Labels must be low-cardinality: **no customer ids, phones or texts**.
- Metrics (minimum):
  - `wa_inbound_messages_total{turn_kind}`
  - `wa_turns_total{turn_kind,outcome}`
  - `wa_turn_duration_seconds` (histogram)
  - `wa_model_calls_total{status}`
  - `wa_model_call_duration_seconds` (histogram)
  - `wa_model_tokens_total{type="prompt|output"}`
  - `wa_model_calls_per_turn` and `wa_prompt_tokens_per_turn` (histograms)
  - `wa_tool_calls_total{tool,ok}`
  - `wa_guard_blocks_total{check}`
  - `wa_fallback_replies_total`
  - `wa_sends_total{recipient_kind,status}`
  - `wa_send_duration_seconds` (histogram)
  - `wa_queue_jobs{status}` (gauge)
  - `wa_ai_budget_used_ratio` (gauge)
  - `wa_whatsapp_session_up` (gauge 0/1, from the cached WAHA session status)
  - `wa_owner_alerts_pending` (gauge)
  - `wa_trace_write_failures_total`
  - `wa_estimated_cost_usd_total`, only if `GEMINI_PRICE_INPUT_PER_MTOK`
    and `GEMINI_PRICE_OUTPUT_PER_MTOK` are set. Do not hardcode prices.
- Also add `GET /operations/traces` (same auth) returning recent traces as
  JSON (`?limit=`, `?outcome=`), and `GET /operations/traces/:id` with its
  events, for Grafana's table panels.

**C. Prometheus + Grafana (Docker), folder `observability/`**
- `observability/docker-compose.yml` with **pinned** image versions:
  - Prometheus on `localhost:9090`, scraping
    `host.docker.internal:3000/metrics` every 15 s, bearer token from a
    gitignored file `observability/secrets/ops_key` (document how the owner
    creates it from `.env` without printing it);
  - Grafana on `localhost:3002` with anonymous access off and the admin
    password set by env, never committed.
- Do not include or touch the WAHA container. Use separate named volumes.
- Provisioned datasources: Prometheus, plus the Infinity datasource
  (`yesoreyeram-infinity-datasource`) pointed at `/operations/traces` with
  the bearer header.
- A provisioned dashboard **"Ahmed Assistant — Live"** with rows:
  1. **Health:** WhatsApp up, queue sizes, AI budget used %, owner alerts
     pending.
  2. **Traffic:** messages per hour, turns by outcome, fallback rate.
  3. **Speed:** p50/p95 turn time, p95 model call time, send time.
  4. **Cost:** tokens per hour, calls per turn, prompt tokens per turn,
     estimated cost today.
  5. **Failures:** guard blocks by check, failed or uncertain sends, model
     errors.
  6. **Message traces:** table of the last 50 traces; click one to see its
     events in order.
- Alert rules: WhatsApp down for more than 2 minutes, AI budget above 80%,
  any `no_reply` outcome, fallback rate above 20% over 30 minutes, queue
  above 50.
- `npm run obs:up` / `npm run obs:down` scripts (docker compose with that
  file).

**D. Tests:** metrics format and auth (401 without the key, fail closed
without the configured key); trace rows written for a stubbed turn (reuse
the Gemini stub style in `tests/silent-reply.test.ts`); no PII in trace
tables (assert that bodies and phones are absent); a tracing failure does
not break the turn. Write `docs/OBSERVABILITY.md` (how to start it, every
panel explained, how to read a trace).

---

### Agent FIX2 — Order drafts and order-flow loop (worktree `../wt-fix2`)

**Evidence from live test (2 Nov):** customer #117 still had draft #8
(`awaiting_confirmation`) 17 hours after it was prepared. A plain reply
"cheapest item is Black Hoodie Rs 800 … order?" was vetoed 3 times by
`checkDeterministicOrderSummaryReply` (`src/order-summary.ts`,
`looksLikeOrderSummary`: an amount plus the word "order" is enough to match),
so the customer got the fallback. On 1 Nov the order flow looped: the model
did not reuse the prepared draft, wrote its own "order confirmed" text and
was blocked.

**Owned files:** `src/order-summary.ts`, `src/tools/order-drafts.ts`,
`src/tools/orders.ts`, `src/tools/order-validation.ts`, related tests.
`src/agent/prompts.ts`: minimal edits only (list them).

**Required:**
1. **Draft lifecycle:** drafts expire after `ORDER_DRAFT_TTL_HOURS` (default
   6, fail-safe parse). Expired or superseded drafts get status `expired` or
   `superseded` (add statuses additively, keep history) and never block
   replies. A new `prepare_order` supersedes the old draft.
2. **Summary check:** `looksLikeOrderSummary` must only match text that is
   actually summary-shaped (for example at least 3 of: total, subtotal,
   recipient, address, payment method, qty/quantity, delivery; or the phrase
   "order summary"). Prices plus the word "order" alone must pass. Keep
   blocking real rewritten summaries.
3. **Reuse the draft:** when a pending draft exists, the model must be able
   to re-send the exact server summary. Give `prepare_order` (or a small new
   tool `show_pending_order`) a way to send the server-generated summary via
   the authorized-body path, so the model never rewrites it. Tell the model
   about the pending draft (id, item count, expiry) in OPEN context, without
   PII.
4. The model must never claim "order confirmed/booked" unless
   `confirm_order` succeeded this turn. Keep the two-step confirmation rules.
5. **Tests (must fail first):** a 17-hour-old draft does not block a price
   answer; a price answer with "order?" passes while a draft is pending; a
   rewritten summary is still blocked; an expired draft cannot be confirmed;
   an end-to-end stubbed turn where the customer asks again and receives
   exactly one server summary, with no loop.

---

### Agent FIX3 — Payment claims and payment methods (worktree `../wt-fix3`)

**Evidence:** customers could file payment claims on COD orders that were not
yet delivered, and duplicate claims were created for the same order (#7 and
#8). The bot also listed payment methods that are not configured.

**Owned files:** `src/payments.ts`, `src/payment-instructions.ts`,
`src/payment-resolution.ts` (read mostly), related tests.

**Required:**
1. `claim_payment` on a COD order that is not delivered returns teaching
   text ("COD is paid to the rider at delivery; no claim is needed") and
   creates no row.
2. **Duplicates:** if an open (unverified) claim already exists for the same
   order (or the same customer and amount within 24 h when there is no
   order), return the existing claim id and the pending status message
   instead of inserting. Optionally add a partial unique index as an
   additive migration, only if the existing rows already satisfy it (check
   the shape in code; do not open `ahmed.db`).
3. **Payment methods:** the model may only ever see and mention methods whose
   `PAYMENT_*` configuration is present (COD always). Add a send guard (check
   id `unconfigured_payment_method`) that vetoes replies naming JazzCash,
   EasyPaisa, bank transfer, IBAN or card when that method is not configured.
4. **Tests (must fail first)** for each of the three points.

---

### Agent FIX4 — Promises, language and formatting (worktree `../wt-fix4`)

**Evidence:**
- The Roman Urdu promise "Woh jald hi aap se rabta karein ge!" slipped past
  the human-promise guard.
- The handoff confirmation was sent in English to a Roman Urdu customer.
- Replies contained literal `\n\n` and emojis.
- Handoffs are over-eager.

**Owned files:** `src/guardrails/human-promise.ts`, `src/handoff-claims.ts`,
`src/customer-reply-safety.ts`, `src/tools/handoff.ts`, the customer-facing
fixed texts in `src/sensitive-action-wording.ts`, related tests.
`src/agent/prompts.ts`: minimal edits only (list them).

**Required:**
1. Extend the human-promise guard to Roman Urdu and Urdu phrasings, for
   example "rabta karein ge / karenge", "contact karein ge", "call karein
   ge", "jald jawab denge", "Ahmed bhai baat karein ge", "wapas aap ko
   batayen ge". Do not block truthful forms such as "maine Ahmed ko alert
   bhej diya hai".
2. **Language:** detect the customer's language from their latest message (a
   simple Roman Urdu word heuristic). Fixed server texts (handoff
   confirmation, payment pending, refund status, fallback) are sent in that
   language; keep the English+Urdu fallback when unsure. Update
   `handoff-claims.ts` exemptions for the new exact texts.
3. **Formatting:** normalise outgoing bodies: literal `\n` sequences become
   real newlines, at most 2 consecutive newlines, and emojis are stripped
   unless `ALLOW_EMOJI=true`. Do this in one place before the guards run,
   so hashes and spinning see the final text.
4. **Over-eager handoff:** a plain discount question must first get the
   policy answer (the discount rule allows up to 5%, never invent more), not
   an immediate handoff. Handoff only when the customer insists or asks for
   more than policy.
5. **Tests (must fail first)** for every point, including the exact live
   sentence above.

---

### Agent FIX6 — Pause work while WhatsApp is down (worktree `../wt-fix6`)

**Evidence (2 Nov morning):** with the WAHA session `FAILED`, queued jobs
still ran Gemini (spending budget) and were marked `completed` although
every send failed with 422 "Session status is not as expected". Owner alert
sends sat `uncertain` after 16–17 attempts.

**Owned files:** `src/inbound-jobs.ts`, `src/channel/waha.ts`,
`src/channel/types.ts`, `src/server.ts` (`/ready` only), `src/alerts.ts`
(retry policy only), related tests.

**Required:**
1. A cached session-status check (`getSessionStatus`, refreshed at most
   every 10 s, timeout-guarded) on the channel adapter.
2. Before a job uses AI, if the session is not `WORKING`: put the job back
   with `available_at = now + 60 s` (configurable), **without** using an
   attempt or AI budget. Status `deferred` is shown in metrics and traces
   (coordinate the name with OBS: use the outcome `deferred`).
3. A WAHA 422 session error at send time is classified as
   `channel_unavailable` (not `uncertain`) so the send can be retried safely
   once the session is back. Keep the "timeout means uncertain, never
   resend" rule for real timeouts.
4. When the session has been down for more than 2 minutes: log once, raise
   one owner alert on recovery ("WhatsApp was disconnected from X to Y; N
   messages were held and are now being answered"), and make `/ready` report
   `not_ready` with the reason.
5. Cap owner-alert retries with backoff so alerts do not reach 17 attempts.
6. **Tests (must fail first):** a job is deferred, not completed, while the
   session is down; no `ai_model_calls` row is written; it completes after
   the session returns; 422 → `channel_unavailable`; a timeout is still
   `uncertain`.

---

## 3. Phase 2 — merge (orchestrator)

Merge into `main` in this order, running `npm run typecheck && npm test &&
npm run test:e2e` after **each** merge:

1. `ws/fix6-whatsapp-down`
2. `ws/observability`
3. `ws/fix2-order-drafts`
4. `ws/fix3-payment-claims`
5. `ws/fix4-wording-language`

Resolve conflicts by keeping both behaviours. If a merge makes tests fail,
fix it on `main` with a clearly named commit. Do not skip tests. After the
OBS merge, make sure the guard ids added by FIX3 and FIX4
(`unconfigured_payment_method`, etc.) appear in `wa_guard_blocks_total`.

## 4. Phase 3 — Agent FIX5, cost reduction (after Phase 2, alone)

Start this agent only after OBS is merged, because it must measure before and
after.

**Evidence:** 11 messages on 2 Nov → 66 Gemini calls (about 6 per message),
308k prompt tokens (about 28k per message), only 2.6k output tokens. Cost is
almost all re-sent prompt.

**Work on a new worktree `ws/fix5-cost` from the merged `main`.**

1. **Baseline:** using the OBS trace tables in a stubbed test turn (and the
   real counts above), document calls and prompt tokens per turn by step
   (OPEN, LOOP, CLOSE).
2. **Reduce,** keeping every guard. Candidates:
   - end the LOOP immediately after a successful `send_message`, instead of
     making another model call;
   - trim history (for example the last 8 messages plus the checkpoint
     summary instead of 20 raw);
   - shorten the system prompt and tool descriptions without losing rules;
   - send only the tools needed;
   - run the CLOSE summary call only when something changed (order, claim,
     note, handoff) or every N turns;
   - do not re-call the model after a guard veto more than twice; go to the
     fallback instead.
3. **Target:** at most 3 model calls and at most 12k prompt tokens per
   ordinary customer message, with **no** test regressions and no change to
   the guards.
4. **Tests:** a stubbed turn asserts the call count is at most 3 for a simple
   question; all existing tests stay green. Report before and after numbers.

Merge `ws/fix5-cost` into `main` with the full test suite green.

## 5. Phase 4 — independent verification

Start a **fresh verifier sub-agent** that wrote none of the code. Give it
this whole prompt and the diff `base..main`. It must:
- check every "Required" item above, one by one: done, partial or missing,
  each with a file:line reference;
- check that the hard rules were respected (no `ahmed.db` access, no PII in
  traces or metric labels, no new runtime dependency, no `.env` values
  committed);
- run `npm run typecheck`, `npm test`, `npm run test:security`,
  `npm run test:e2e`;
- report findings. The orchestrator fixes the confirmed ones and re-runs
  the verifier until it is clean.

## 6. Phase 5 — hand-off to the owner

1. Update `docs/ENGINEERING_ROADMAP.md` in place: each fix is
   `LOCALLY VERIFIED`, with live verification pending. Update `CLAUDE.md`
   §2 and §10 and `.env.example` (all new variables with safe defaults:
   `ORDER_DRAFT_TTL_HOURS`, `TRACE_RETENTION_DAYS`,
   `GEMINI_PRICE_INPUT_PER_MTOK`, `GEMINI_PRICE_OUTPUT_PER_MTOK`,
   `ALLOW_EMOJI`, the WhatsApp-down defer seconds).
2. Remove the worktrees (`git worktree remove`), keep the branches.
3. Print a short report for the owner:
   - what changed per workstream;
   - test counts before and after;
   - token numbers before and after;
   - the exact steps for the owner, in order:
     1. `npm run backup` and `npm run backup:verify -- <path>`;
     2. add `OPERATIONS_API_KEY` to `.env` if missing and create
        `observability/secrets/ops_key`;
     3. `npm run obs:up`;
     4. start the app;
     5. open Grafana at `localhost:3002`.
   - a **live test script, one block per fix, to be run in order** (the
     owner does not move on until each passes):
     - **Fix 6:** stop the WAHA session, send 1 message, confirm the job
       is deferred and no AI call is made; start the session and confirm it
       is answered once.
     - **Fix 2:** "cheapest item?" with an old draft present; full order
       flow, asking twice; confirm.
     - **Fix 3:** claim payment on an undelivered COD order; claim twice.
     - **Fix 4:** ask for a discount in Roman Urdu; ask for something that
       needs Ahmed; check the language, newlines and emojis.
     - **Fix 5:** 10 normal questions, then read calls and tokens per
       message on the dashboard.
     - **OBS:** every message above is visible as a trace, with the
       correct guard blocks.

Do not push. Stop after the report.
