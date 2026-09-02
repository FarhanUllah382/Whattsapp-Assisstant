# CLAUDE.md — Ahmed's WhatsApp Assistant

This file governs how Claude Code works in this repository. Read it in
full before making any change. If anything you're about to do conflicts
with a rule below, the rule wins — stop and ask, don't quietly proceed.

**Current mission: complete Version 1 only.** Nothing else. See §3 for the
exact, exhaustive scope of Version 1. Everything not listed there is
explicitly out of scope for this phase, and a large portion of it is
*permanently* out of scope for this project altogether (§6) — read that
section before importing any pattern from the reference repository.

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

## 3. Version 1 — the ONLY thing in scope right now

Full detail lives in `PROJECT-TRACKER-FINAL.md` §Version 1. Summary below
for orientation; the tracker file is authoritative if the two ever
disagree.

| Sub-version | Goal | Status |
|---|---|---|
| 1.1 | Core loop hardening — strict tool-input validation, teaching-text errors instead of crashes, idempotent send | 🟡 Core loop exists; hardening not done |
| 1.2 | Conversational memory upgrade — structured per-customer notes, compaction for long threads | 🟡 Flat checkpoint summary exists; structured version not done |
| 1.3 | Real WhatsApp connection + anti-ban compliance (pacing, spinning, messaging window, disclosure) | 🔲 Not started — source files already verified in `EXTRACTED-FOR-AHMED/` |
| 1.4 | Promise & safety guardrails (unauthorized-discount detection, human handoff) | 🔲 Not started — deliberately deferred until needed, see §5 |
| 1.5 | Static catalog/FAQ grounding (answer from a maintained document, never invent) | 🔲 Not started |

**Version 1 is done when:** a customer can message the real number at any
time, get a fast, safe, on-brand reply that correctly remembers their
history, sourced from real catalog/FAQ content when asked, with no
possibility of an unauthorized promise reaching them and no possibility of
the number getting banned from sending too fast. Orders, payments, and
stock do **not** need to work yet — that is Version 2, a separate phase,
not to be started until Version 1's definition of done is fully met.

**Do not begin Version 2 or Version 3 work under this file's authority.**
If a task description asks for order tracking, payment ledgers, or
owner-facing analytics, stop and confirm with the user first — that work
belongs to a later phase with its own CLAUDE.md scope, not this one.

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

## 8. Definition of Done for "Version 1 complete"

Do not report Version 1 as finished until all of the following are true,
verified, not assumed:

- [ ] A real WhatsApp message to the actual number produces a real reply
- [ ] A crash-and-retry mid-turn does not produce a duplicate customer
      message
- [ ] A malformed or unexpected tool call does not crash a turn
- [ ] A fact told to the bot in one conversation is correctly recalled in a
      separate conversation days later
- [ ] A burst of test messages visibly throttles/spaces out rather than
      firing at once; messages outside configured sending hours queue
      instead of firing immediately
- [ ] A request for an unauthorized discount is refused or deflected, not
      granted
- [ ] A question genuinely outside the bot's knowledge triggers a handoff
      to the owner, not a guess
- [ ] A catalog/FAQ question answered from the maintained document is
      correct; a question not covered by it results in "I'll confirm and
      get back to you," never an invented answer
- [ ] `PROJECT-TRACKER-FINAL.md` accurately reflects all of the above as
      done, with no stale "not started" markers left behind

When every box is checked, stop and report Version 1 complete. Do not
proceed into Version 2 scope without the user explicitly starting that
phase.
