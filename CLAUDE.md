# CLAUDE.md — Ahmed's WhatsApp Assistant

This file governs how Claude Code works in this repository. Read it in
full before making any change. If anything you're about to do conflicts
with a rule below, the rule wins — stop and ask, don't quietly proceed.

**Current mission: Version 2, plus Version 3.1/3.2 as an explicit, time-
boxed exception (see §3).** Version 1 is complete and live-verified — see
`PROJECT-TRACKER-FINAL.md`'s "Version 1 — final status" section for the
full proof, including everything explicitly carried forward unresolved
(Version 1 completion did not fix the Node v24 crash mitigation, the
per-number health circuit, STOP/opt-out handling, or several other named
items — see §3 below for why later work must not make any of those
worse). Version 2 is built and locally verified end to end; only its
*live* verification against the real number remains, gated on the daily
send cap, not on any remaining code work. **§3 also documents a deliberate
exception, made consciously by the user, not a drift in scope:** Version
3.1 and 3.2 are open for building and local verification now, in parallel
with waiting on that cap — see §3 for the exact reasoning and boundary.
Everything not listed in §3 is explicitly out of scope for this phase,
and a large portion of it is *permanently* out of scope for this project
altogether (§6) — read that section before importing any pattern from the
reference repository.

---

## 1. What this project is

A WhatsApp-based AI sales assistant for **one single-owner retail shop**
(the running example is "Ahmed," who sells clothes). It replies to
customers instantly, remembers every customer's history, keeps a running
record of orders and payments with zero manual data entry, and lets the
owner ask it business questions in plain language through the same
WhatsApp thread he already uses.

It is **not** a CRM, **not** multi-tenant, and **not** built for a team.
There is exactly one business, one WhatsApp number, one owner, and no
staff. Every architectural decision should be evaluated against that
reality, not against what a larger system might do.

---

## 2. Source-of-truth documents — read before touching code

| File | What it's for |
|---|---|
| `ahmed-whatsapp-assistant.md` | The original problem/solution brief — Ahmed's four promises. Every feature traces back to one of these four. |
| `PROJECT-TRACKER-FINAL.md` | **The single canonical build plan and status log.** Supersedes every earlier tracker/roadmap file in this repo's history — if you find an older one, it's historical record only, not current. |
| `EXTRACTED-FOR-AHMED/MANIFEST.md` | A verified inventory of files pulled from the DeskcommCRM reference repo that are safe to reuse. Every file in that folder was checked individually for database coupling and scope-fit — do not assume a file is safe just because it's present; read its manifest row first. |

**Before starting any task:** check `PROJECT-TRACKER-FINAL.md` for the
current status of the relevant sub-version. **After finishing any task:**
update that same file's status marker and, if scope or approach changed
from what was planned, update the relevant section's text too. This file
is a living log, not a one-time snapshot — treat an out-of-date tracker as
a bug.

---

## 3. Current scope: Version 2 (primary) + Version 3.1/3.2 (explicit exception)

Full detail lives in `PROJECT-TRACKER-FINAL.md` §Version 2 and §Version 3.
Summary below for orientation; the tracker file is authoritative if the
two ever disagree.

### Version 2 — built and locally verified; live verification pending

| Sub-version | Goal | Status |
|---|---|---|
| 2.1 | Retail data model — a real debit/credit ledger, balance always reconstructable from history, not a single mutable field | ✅ Built, deterministically verified (2026-09-05) |
| 2.2 | Order-status tracking — forward-only `placed → confirmed → paid → shipped → delivered`, invalid transitions rejected with a teaching error | ✅ Built, deterministically verified (2026-09-05) |
| 2.3 | Automatic order & payment extraction — conversation → real order/line-item/payment rows, zero manual entry, plus a safety net catching anything mentioned but never explicitly logged | ✅ Built, deterministically verified (2026-09-05) |
| 2.4 | Live stock-aware replies — `check_stock` queries real quantity; stock actually decrements on order confirmation and restores on a pre-shipping cancellation | ✅ Built, deterministically verified (2026-09-05) |
| 2.5 | Follow-up tracking tied to unpaid orders — an owner-*queryable* read path ("what's pending"), not the bot auto-firing reminders on its own | ✅ Built, deterministically verified (2026-09-05) |

**Version 2 is done when**, beyond the deterministic verification above,
**all of it has also been checked against the real number**: every order
and payment discussed in a normal customer conversation is automatically
and correctly recorded, with zero manual data entry by Ahmed — and
anything mentioned but never explicitly confirmed via a tool call is
still caught, not silently lost. Stock is live-accurate: a stock check
reflects the real current quantity, and a confirmed order decrements it
by the right amount. Order status only ever moves forward, with an
invalid backward transition rejected via a teaching-text error, never a
crash. Every unpaid order has a follow-up tracked against it, queryable
by Ahmed on demand. **This live-verification pass has not happened yet**
— it's gated on the daily anti-ban send cap resetting, not on any
remaining code work; see `PROJECT-TRACKER-FINAL.md` for the exact plan
and current status. Do not report Version 2 complete until it has.

### Explicit exception: Version 3.1 and 3.2 opened early

**This is a deliberate, conscious choice by the user — not scope drift,
and not a precedent for skipping ahead by default in future sessions.**
Reason, stated plainly: the user's Claude Code usage limit resets
mid-month, leaving a hard deadline of roughly two days to get as much
done as possible. The only thing actually time-gated right now is *live*
verification against the real WhatsApp number (the daily send cap); build
and local-verification work is not blocked by anything, so it makes sense
to keep producing it in parallel rather than sitting idle waiting on a
clock.

**The exception covers exactly this, no more:**
- Building and **locally, deterministically** verifying 3.1 (owner
  recognition & dedicated owner turn) and 3.2 (owner analytics Q&A tools)
  is permitted now, even though Version 2 has not finished its own live
  verification and even though 3.2's own stated dependency
  (`PROJECT-TRACKER-FINAL.md`: "Depends on: 3.1, version 2 complete") is
  not yet fully satisfied.
- 3.3 (WhatsApp-delivered alerts) and anything beyond 3.1/3.2 remain
  **out of scope** — this exception was not extended to the rest of
  Version 3.
- **Live-testing anything in Version 3, against the real number, remains
  fully gated**, exactly like Version 2's own live testing — on the send
  cap allowing it, and additionally on Version 2's own live verification
  actually completing first. Building ahead does not change that gate.

| Sub-version | Goal | Status |
|---|---|---|
| 3.1 | Owner recognition & dedicated owner turn — sender-identity check, a distinct turn kind for owner messages that never talks to a customer | 🔲 Not started — opened for building now under this exception |
| 3.2 | Owner analytics Q&A tools — `sales_today`, `unpaid_customers`, `top_selling_product`, `pending_followups`, a small fixed set of safe report functions, never a freely-written SQL query from the model | 🔲 Not started — opened for building now under this exception |

**The one rule this exception must not break, stated as plainly as
possible: code existing and being locally verified is not the same as a
version being "done."** Whoever reads this file next — including a future
instance of Claude — must not treat Version 2 or Version 3 as complete,
or safe to build further on top of without checking, until each has
actually been verified against the real number. If both versions'
`PROJECT-TRACKER-FINAL.md` entries end up saying "built and locally
verified, live verification pending" at the same time, that is the
correct, honest state produced by this exception — not a mistake to
paper over.

**Carried forward from Version 1, unresolved — neither Version 2 nor
Version 3 work under this exception may make any of these worse, even
incidentally:**
- **The Node v24 / `better-sqlite3` native crash is still only mitigated
  (a dev-only shell restart loop), not fixed** — root cause untouched, and
  it has recurred during ordinary local testing multiple times since
  (see `PROJECT-TRACKER-FINAL.md`). Version 2 already added order/payment/
  ledger writes to nearly every turn; do not layer speculative retry logic
  or defensive transaction-wrapping around this to compensate — if this
  work makes the crash noticeably more frequent, that's a signal to
  actually fix the root cause (or escalate to the user), not to paper over
  it with more workarounds.
- **`notify_owner` handoff delivery is still log-only**, not a real
  WhatsApp message to Ahmed's own number. Not this work's job to fix, but
  don't build features that assume it already sends a real message.
- **Per-number health circuit and STOP/opt-out handling are still not
  built.** Don't let new send paths skip past guardrails that a manual
  reply already goes through, on the assumption these will exist later.
- **No real async job queue exists** for outside-hours retry — a message
  outside the sending window still just doesn't fire, it doesn't queue and
  auto-send later.
- **Two narrow live-verification gaps remain genuinely open:** the crash
  window between `sendToCustomer()` succeeding and `send_ledger` being
  marked `'sent'`; and cross-conversation memory recall proven correct
  across a real day boundary, but not yet proven to survive a fact aging
  out of the raw 20-message window `agent.ts` loads per turn.
- **`catalog.md`'s content is still placeholder text**, not Ahmed's real
  catalog — a content task for Ahmed, not something to touch as part of
  this work (unless the user is actively dictating real content, which is
  its own separate, explicit task).

**Do not begin Version 3.3 or any work beyond 3.1/3.2 under this file's
authority.** If a task description asks for WhatsApp-delivered alerts or
anything past what's explicitly opened above, stop and confirm with the
user first — that work belongs to a later phase with its own CLAUDE.md
scope, not this one.

---

## 4. Non-negotiable conventions

These apply to every file you write or edit in this repository, no
exceptions without explicit user sign-off.

1. **Every AI model call goes through exactly one function** (`src/llm.ts`
   or its eventual multi-provider successor). Never call the AI SDK or a
   raw fetch to a model endpoint from anywhere else. This is what makes
   "swap providers" or "add logging" a one-file change later.

2. **Sending a message to a customer is always a deliberate, gated tool
   call — never a side effect of raw model text.** The model's plain-text
   output is discarded; only an explicit `send_message` tool invocation
   reaches the customer. This applies to every new tool you add, forever.

3. **Tool input is validated strictly on the server side**, even though the
   tool's schema exposed to the model can be looser. Never trust a tool
   argument at face value — validate shape, type, and range before it
   touches the database or business logic.

4. **A failed tool call returns structured, model-readable text, never a
   thrown exception that crashes the turn.** Format:
   `{ok: false, error: "short, plain-language, actionable sentence"}`.
   The model needs to be able to read the failure and recover mid-turn.

5. **No `console.log`.** Use the structured logger. If
   `EXTRACTED-FOR-AHMED/obs/logger.ts` hasn't been wired in yet as part of
   your current task, that's acceptable only as a temporary placeholder —
   flag it in the tracker, don't leave it silently unresolved.

6. **Nothing is built speculatively.** Every guardrail, every defensive
   check, every piece of infrastructure gets added in response to an
   actual, current requirement in §3 — not a problem that might happen
   later. If you find yourself building something "just in case," stop and
   check whether it's actually in this version's scope.

7. **Relative imports, no file extensions** (`from './tools'`, not
   `from './tools.ts'`) — matches the module resolution already in use.

8. **TypeScript strict mode stays on.** Don't loosen `tsconfig.json` to
   make a change compile faster.

---

## 5. How to use `EXTRACTED-FOR-AHMED/`

That folder contains files copied from the DeskcommCRM reference
repository, each individually verified to have zero database coupling and
confirmed relevant to this project's actual roadmap. It is **reference
material staged for reuse, not yet wired into the running application.**

Rules for pulling a file in:

- Only pull in a file when the sub-version that needs it is actually being
  worked on (check §3's status table). Do not pre-wire files for a later
  sub-version "while you're in there."
- Before wiring a file in, re-read its row in
  `EXTRACTED-FOR-AHMED/MANIFEST.md` — some are flagged with a **content
  note** (e.g. a Portuguese-language regex needing translation, a
  placeholder timezone default) that must be addressed as part of wiring
  it in, not left as-is.
- If a needed pattern exists only in a file that did **not** qualify for
  extraction (check `MANIFEST.md`'s rejected list first), re-implement the
  pattern from scratch in this project's own style — do not go copy the
  original DeskcommCRM file directly, and do not modify anything in a
  cloned DeskcommCRM checkout if one is present in this environment.
- After wiring a file in, note it in `PROJECT-TRACKER-FINAL.md` so the
  "already done" state stays accurate for the next session.

---

## 6. Permanent exclusions — do not build these, ever, under this scope

These are standing decisions, not deferred work. They solve problems
specific to DeskcommCRM's multi-tenant, team-operated architecture that
this single-owner project does not have. **If you notice a DeskcommCRM
pattern that looks reusable but falls into one of these categories, do not
port it — even in simplified form — without explicit user sign-off:**

- Multi-tenancy or organization/tenant scoping of any kind
- Per-org budget enforcement, encrypted multi-tenant API credential storage,
  or billing infrastructure
- The B2B sales-funnel / lead-qualification model (`new → contacted →
  qualifying → qualified → negotiating → won/lost`, or BANT-style
  qualification fields) — this project uses a retail order-status model
  instead, permanently, not as an interim step
- The Operator/Conversador dual-agent-role split as a literal pattern
- Any agent-config publish/version/rollback workflow, or routing between
  multiple agents by intent — this project has exactly one agent
  configuration, edited directly
- Role-based access control, staff assignment/transfer, rotating queues —
  "hand off to a human" always means messaging the owner directly, never
  opening a ticket in a queue
- The self-optimizing "flywheel" training system
- Jailbreak/prompt-injection classification — not until there's evidence of
  actual abuse
- LGPD or any jurisdiction-specific compliance tooling not relevant to this
  project's actual operating context

---

## 7. Working style expectations

- **Small, verifiable steps.** Prefer finishing one sub-version's
  definition-of-done completely over touching five files across three
  sub-versions at once.
- **Show your reasoning for judgment calls**, especially anything touching
  §6. A one-line note in the commit or response is enough — the point is
  making the decision checkable later, not writing an essay.
- **When a mechanical check exists, use it instead of manual judgment** —
  e.g. grep for disqualifying imports before hand-reading a file for reuse
  eligibility. Manual review is for the cases the mechanical check can't
  resolve, not a replacement for it.
- **If a manifest, tracker, or status claim and the actual file contents
  disagree, the file contents are the truth.** Fix the documentation, don't
  trust it blindly — this project has already had one incident of a
  manifest silently omitting files it should have documented; verify
  before repeating that mistake.
- **Ask before expanding scope.** If completing a task well seems to
  require something outside §3, stop and ask rather than deciding
  unilaterally to include it.

---

## 8. Definition of Done for "Version 1 complete" — ✅ satisfied 2026-09-05

Every item below was verified true against the real number, not assumed —
see `PROJECT-TRACKER-FINAL.md`'s "Version 1 — final status" section for
what specifically verified each one, including the two bugs that were
found genuinely *failing* on first real test (burst-message throttling;
the discount guardrail's interaction with memory recall) and fixed before
being checked off. Kept here, checked off, as the historical record of what
"done" actually required — not a currently-open checklist.

- [x] A real WhatsApp message to the actual number produces a real reply
- [x] A crash-and-retry mid-turn does not produce a duplicate customer
      message
- [x] A malformed or unexpected tool call does not crash a turn
- [x] A fact told to the bot in one conversation is correctly recalled in a
      separate conversation days later
- [x] A burst of test messages visibly throttles/spaces out rather than
      firing at once; messages outside configured sending hours queue
      instead of firing immediately
- [x] A request for an unauthorized discount is refused or deflected, not
      granted
- [x] A question genuinely outside the bot's knowledge triggers a handoff
      to the owner, not a guess
- [x] A catalog/FAQ question answered from the maintained document is
      correct; a question not covered by it results in "I'll confirm and
      get back to you," never an invented answer
- [x] `PROJECT-TRACKER-FINAL.md` accurately reflects all of the above as
      done, with no stale "not started" markers left behind

## 9. Definition of Done for "Version 2 complete"

Do not report Version 2 as finished until all of the following are true,
verified against real conversation data, not assumed:

- [ ] A real customer conversation that agrees on product/size/color/
      quantity/price produces a correct order row with correct line items
      and total — zero manual entry by Ahmed
- [ ] A real payment mentioned in conversation is recorded and correctly
      reduces what the customer owes, with the balance reconstructable
      from ledger history, not just a mutated single field
- [ ] An order or payment mentioned in passing but never explicitly
      confirmed via a tool call is still caught and flagged, not silently
      lost
- [ ] A real order is correctly moved through `placed → confirmed → paid
      → shipped → delivered` as the conversation progresses (or cancelled
      before shipping, restoring any reserved stock); an invalid or
      backward transition is rejected with a teaching-text error, not a
      crash
- [ ] A real "do you have X in stock" question gets the live, current
      quantity, not a stale or invented number
- [ ] Completing a real order decrements real stock by the correct amount
- [ ] A real unpaid order automatically gets a follow-up tracked against it
- [ ] Ahmed asking what follow-ups are pending, in his own words, gets a
      correct answer sourced from real order/follow-up data — this is a
      query path only; the bot proactively pushing this to him unprompted
      is Version 3, not Version 2
- [ ] None of Version 1's now-verified guarantees have regressed — a
      spot-check that a real reply, discount refusal, catalog grounding,
      and burst-message throttling all still work exactly as before adding
      Version 2's order/payment writes to the turn
- [ ] `PROJECT-TRACKER-FINAL.md` accurately reflects all of the above as
      done, with no stale "not started" markers left behind

When every box is checked, stop and report Version 2 complete. Do not
proceed into Version 3 scope without the user explicitly starting that
phase.
