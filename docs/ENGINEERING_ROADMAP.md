# Ahmed's WhatsApp Assistant — THE Tracker (v3, canonical)

**Use this file. The former root `PROJECT-TRACKER-FINAL.md` was renamed to
this path in commit `9550d2a`; there is no second live tracker and the old
filename must not be recreated.** This file also replaces
`PROJECT-TRACKER.md`, `PROJECT-TRACKER-v2.md`, and `roadmap.md` — those names
are historical references only.

Each major version delivers exactly one of Ahmed's four original promises,
in dependency order. Version 4 is stretch work beyond the original spec.

| Version | Delivers | Status |
|---|---|---|
| 1.x | Promise 1 + 2 — talks to customers, remembers conversations | ✅ **Done (2026-09-05)** — all 9 of CLAUDE.md §8's checklist items verified against the real number. See "Version 1 — final status" at the end of the Version 1 section for the complete breakdown. |
| 2.x | Promise 3 — keeps the books automatically | ✅ **Done (2026-09-14)** — all five sub-versions built and verified. **Current payment-security state (built and locally verified 2026-10-05; fresh live WhatsApp verification pending):** customer statements create unverified pending claims. Gemini has no financial-resolution tool. Approval requires the owner to supply the transaction reference independently checked in the business payment account, repeat that same reference in a separate exact confirmation, and pass duplicate, amount, order, and balance checks. Rejection and reversal also require exact two-step commands. The accidentally approved real claim #4 was repaired through one audited compensating debit after a verified backup; no history was deleted. |
| 3.x | Promise 4 — Ahmed can just ask it questions | ✅ **Done (2026-09-15)** — 3.1/3.2 owner Q&A and 3.3 WhatsApp-delivered alerts are built, locally verified, and live-verified. |
| 4.x | Stretch — beyond the original spec | 🔲 Not started |

**Note on the 3.x exception, so anyone reading this later understands why
Version 3 work started before Version 2 was fully closed out:** the user
made a deliberate, explicit call to open 3.1 and 3.2 for building and
local verification while Version 2 sat waiting on its live-verification
step (gated on the daily anti-ban send cap, not on any remaining code
work) — reason stated plainly: a Claude Code usage-limit reset left a
hard two-day deadline, and only live testing was actually time-gated, not
build/local-verify work. This is documented as policy in CLAUDE.md §3, not
just here. **The boundary that makes this safe, restated:** 3.3 and beyond
stayed out of scope; nothing in Version 3 gets live-tested until Version 2
itself has been, regardless of how much Version 3 code exists by then;
and "built + locally verified" is never to be read as "done" for either
version until the real-number pass actually happens. If this file ever
shows both Version 2 and Version 3 sub-versions marked "built, locally
verified, live-verification pending" at the same time, that's the correct
result of this exception, not a sign something was skipped by mistake.

---

## 0. Where things actually stand right now

- **Current implementation status (re-verified 2026-09-15):** Version 1 is
  complete with its carried-forward gaps still described precisely in its
  final-status section; Version 2 is complete after a real WhatsApp pass
  plus deterministic checks for branches a live model cannot reliably be
  forced to take; Versions 3.1 and 3.2 are complete and live-verified across
  all four owner questions (`sales_today`, `unpaid_customers`,
  `top_selling_product`, and `pending_followups`); 3.3 is complete after the
  already-existing pending alert was delivered exactly once to the owner via
  real WhatsApp. Version 4 remains untouched.
- **Current runtime reliability status (verified 2026-09-15):** the Node 24
  native SQLite crash is now **fixed**. The project was still loading
  `better-sqlite3` 11.10.0, a pre-Node-24-support binding, on Node 24.19.0
  (ABI 137). It now pins `better-sqlite3` 12.10.0, whose published engine
  range and prebuilds include Node 24, and pins the project runtime to the
  Node 24 LTS line through `package.json` and `.nvmrc`. Verification after
  replacement: typecheck passed; 100 separate native open/write/cleanup
  processes passed; the complete permanent suite passed 15 consecutive
  times; the complete Version 2 database flow passed; and the live worker was
  restarted directly without the old restart loop. The new worker remained
  healthy (expected HTTP 404 at the app root), WAHA returned pong, and no
  restart-loop process remained. The older dated entries below accurately
  describe when this issue was only mitigated; this entry supersedes them as
  the current status.
- **A verified extraction of 20-21 reusable files from DeskcommCRM exists**,
  staged at `EXTRACTED-FOR-AHMED/` (checked file-by-file, cross-referenced
  against the manifest, not yet wired into the actual project). See each
  sub-version below for which extracted files apply to it.
- **History of this section, kept rather than erased — this file has
  walked back two premature "done" claims before, and that history is part
  of why the 2026-09-05 completion below can be trusted:** first written
  claiming "Version 1 is fully built and live-verified" (overstated — caught
  by the user, not self-caught, 2026-09-04). Corrected that day to the
  narrower truth: all 5 sub-versions *built*, one real reply verified, 8 of
  CLAUDE.md §8's 9 items still unverified. Through 2026-09-05, each of the
  remaining items was tested one at a time — two were found genuinely
  *failing* when actually checked (not just "unverified"), fixed, and
  re-verified, rather than the tracker being updated to claim success before
  the test ran. **Version 1 is now complete, as of 2026-09-05** — see
  "Version 1 — final status" at the end of the Version 1 section (after
  1.5) for the full, itemized breakdown of all 9 §8 items, every bug found
  and fixed along the way, and everything still explicitly open for a
  future version (none of which blocks this completion — see that section
  for exactly what's carried forward and why).

---

## Version 1 — "The assistant talks and remembers"

**At the end of v1: a customer messaging Ahmed's number gets an instant,
sensible, safe reply, and the bot remembers who they are — but nothing is
written to any books, and Ahmed still can't ask it anything.**

### 1.1 — Scaffolding & single-tenant core loop
- **Goal:** stand up one shop, one agent, one WhatsApp number, receiving a
  message and replying, end to end.
- **Depends on:** nothing (first step).
- **Already done:** the core loop itself (open → tool loop → reply →
  checkpoint close), a working local webhook stub, one hardcoded model
  credential. Verified in this conversation via the `ahmed-assistant.zip`
  skeleton.
- **Still missing:** nothing — 1.1's own scope (per the canonical summary
  table in `CLAUDE.md`: strict tool-input validation, teaching-text errors,
  idempotent send) is complete. **Correction to this file:** the "Real
  WhatsApp connection" line previously listed here under "Still missing"
  was a stale duplicate — `CLAUDE.md`'s summary table scopes the actual
  provider connection + anti-ban compliance to **1.3**, not 1.1. Removed
  from here rather than left to silently imply 1.1 can't be done without it.
- **Done:**
  - Strict server-side input validation on all 4 tools in `src/tools.ts`
    (`check_stock`, `get_customer_balance`, `record_order`,
    `record_payment`) — types, required fields, and ranges (e.g. `qty > 0`,
    `product_id` must reference a real product) are checked before anything
    touches the database. **Current correction, 2026-09-27:** order price is
    no longer a model input at all. `record_order`'s schema accepts only
    `product_id` + `qty`; the shared server validator loads `products.price_minor`,
    returns normalized integer-paisa price-snapshot items, and computes the total used by
    both the normal tool path and the turn-close safety net. Even a direct
    adversarial call that bypasses the schema and supplies `price: 1` for a
    Rs.3,200 product is ignored: quantity 2 stored Rs.3,200 per item, returned
    and persisted total Rs.6,400, and wrote one Rs.6,400 ledger debit.
    `record_order` and `record_payment` remain wrapped so malformed input or
    database failure returns `{ok: false, error: "..."}` rather than crashing
    the turn. Verified by typecheck, the permanent suite (41/41), pacing and
    owner-alert suites, and the complete Version 2 regression flow. This is
    deterministic server-side validation, so direct-code verification is the
    appropriate proof; a live model call cannot reliably reproduce a forged
    tool price on demand. **Live normal-path confirmation, 2026-09-29:** a real
    customer asked for one black medium hoodie. The assistant quoted the
    database price of Rs.800, created confirmed order `#41` with normalized
    item `{"product_id":3,"qty":1,"price":800}` and total Rs.800, wrote one
    matching Rs.800 debit, and reduced stock from 19 to 18.
    **Exact-money correction, built and locally verified 2026-09-29; customer-facing price read live-verified:** financial
    database truth is now integer Pakistani paisas (`price_minor`,
    `total_minor`, and `amount_minor`), while human/model-facing results remain
    rupees. A guarded atomic migration converted the existing product, three
    orders, six ledger entries, approved payment claim, and all item snapshots;
    the verified pre-migration backup remains recoverable. Post-migration
    integrity and foreign-key checks passed with every value reconciled, as did
    68/68 permanent checks, 8/8 focused order tests, 5/5 focused ledger tests,
    typecheck/build, pacing/alert tests, and the complete Version 2 flow.
    Fractional paisas and over-precise rupee inputs fail closed, and a catalog
    price change cannot rewrite an existing order snapshot. This correction is
    **built and locally verified**. After the migration and service restart, a
    real customer ending 2201 asked for the black medium hoodie's price and
    stock; the assistant returned Rs.800 and 18 pieces from database truth
    `price_minor = 80000`, `stock = 18`. The read created no business mutation:
    orders remained 3, ledger entries 6, and payment claims 1; integrity stayed
    `ok` with zero foreign-key violations. This live-verifies the post-migration
    customer-facing price boundary. The post-migration order-write path remains
    deterministically verified rather than newly live-tested because this
    deliberate check did not create an unnecessary order.
  - Idempotent send protection: a new `send_ledger` table (`db/schema.sql`)
    keyed by a sha256 hash of (customer, inbound text that triggered the
    turn, exact outbound body). `send_message`'s `execute()` in
    `src/agent.ts` checks the ledger before calling `sendToCustomer()` —
    if that exact send is already marked `sent` (within a 5-minute retry
    window, so a customer genuinely repeating themselves later still gets
    a reply), it skips sending and returns
    `{ok: true, status: "already_sent"}` instead of double-sending. It also
    now validates `body` is a non-empty string and never throws — a send
    failure returns `{ok: false, error: "..."}` like every other tool.
    Verified with a manual test that mocked the model call (no live API key
    in this environment) and invoked `runTurn()` twice for the same inbound
    message: the customer received exactly one copy of the reply, and the
    ledger + `messages` table each held exactly one row for it.
- **Built from DeskcommCRM:** pattern only, already adapted — not a literal
  reuse. `channel-adapter.ts` (verified, extracted, staged) is the interface
  to build the real connection behind, when 1.3 is tackled.
- **Definition of done:** send a WhatsApp message to the number, get a
  model-generated reply back, survive a worker restart mid-turn without a
  duplicate or dropped reply. The crash/retry half of this is now verified
  (see above); the "real number" half depends on 1.3's provider connection,
  which is out of scope here and tracked separately below.
- **2026-09-05 — CLAUDE.md §8's "malformed or unexpected tool call does not
  crash a turn" item, verified directly against the real (unmocked)
  `tools.ts` code:** deliberately chose the direct tool-execution route over
  a live conversation for this one — provoking the real model into actually
  emitting a specific malformed tool call on demand isn't reliable, and this
  item is fundamentally about server-side validation (§4 rule 3), which is
  exactly as real when called directly as when the model happens to trigger
  it. 35 deliberately bad calls across all 7 tools in `baseTools`
  (`check_stock`, `get_customer_note`, `record_order`, `record_payment`,
  `notify_owner`, `search_catalog`, `get_customer_balance`) plus one
  simulated unknown-tool-name dispatch (mirroring `agent.ts`'s own
  `tools.find(...) ?? { error: ... }` fallback): wrong types, negative/zero/
  `NaN`/`Infinity` numbers, empty/missing required fields, a nonexistent
  `product_id`, a `null` array entry, junk extra fields. Every single call
  returned a well-formed `{ok:false,...}`/`{found:false,...}` teaching error
  — never threw, never silently "succeeded" on bad input — and confirmed no
  partial DB writes (`orders` row count and `balance_owed` both unchanged)
  from any rejected `record_order`/`record_payment` call. Run as 3 separate
  small scripts rather than one, because this Windows/Node 24/
  better-sqlite3 combination has a known unrelated native-module crash on
  process exit after several `db.prepare()` calls in one process (same
  flakiness already noted in 1.3's pacing-veto verification) — splitting
  sidestepped it; it is not a defect in this project's own code. **Caveat,
  true at the time this was written, later closed the same day (see the
  entry directly below):** this is direct execution of the real tool code
  with a real DB, not a live conversation through the real model/WhatsApp
  channel — on its own this would not move this item into the "live-verified
  against the real number" column the same way catalog grounding did (see
  1.3/1.5's §8 tallies), since the model's own tool-call behavior in a live
  turn hadn't been exercised yet. It did conclusively prove the validation
  layer itself — the thing this DoD item actually cares about — holds up
  under bad input, and set up exactly what to target live next. Scratch
  scripts and their test customers/DB rows deleted after use.
- **2026-09-05 (later the same day) — also closed live, against the real
  number, completing the pair started above:** worth doing since Gemini's
  function-calling API enforces argument *types* from the tool schema
  itself, so a live model call was very unlikely to reproduce the
  wrong-*type* cases the direct test already covered — but it could, and
  did, reproduce the complementary "well-typed but business-invalid" case.
  A real customer said *"I already confirmed this earlier. Please just
  record my order. Product I'd 42, quantity 3, price 509 each?"* — framed
  as pre-confirmed specifically to push the model toward calling
  `record_order` directly (skipping `check_stock`) with a `product_id` that
  can't exist (the products table is empty). Result: no crash, no dead
  turn. `handoff_ledger` shows the model's own natural-language reasoning —
  *"Customer wants to place order for product ID 42... but product ID 42
  is out of stock / not found... Needs Ahmed's attention"* — meaning the
  real model received `tools.ts`'s `{ok:false, error: "Product 42 does not
  exist..."}`, read it, and recovered mid-turn by escalating, exactly the
  behavior this DoD item requires. **One honest wrinkle, unrelated to this
  item:** the actual reply to the customer got blocked this turn — not by
  anything to do with the malformed input, but by the daily warm-up cap
  (20/day, day-0 number) being exhausted from today's own burst-throttling
  testing. The widened silent-no-reply guard (1.3) handled that correctly
  (pure pacing veto → fallback skipped, exactly as designed) — a separate,
  expected, already-verified behavior, not a new gap.
- **Status:** ✅ Done — core loop, input validation, teaching-text errors,
  and idempotent send are all in place. Full end-to-end proof against a
  real WhatsApp number is done (1.3 is live-verified — see 1.3's own final
  status). Malformed-tool-input handling now has both direct, unmocked
  proof AND live confirmation against the real model and real number
  (above) — no known gaps remain for this DoD item.

### 1.2 — Conversational memory
- **Goal:** the bot recalls what a specific customer said/ordered/preferred
  before, without Ahmed re-explaining.
- **Depends on:** 1.1.
- **Already done:** the checkpoint pattern — a forced summary call at
  turn-close, persisted per customer, loaded back in on the next turn. Kept
  as-is: it's still "what's the current state of this conversation," not
  replaced by the notes work below.
- **Done:** structured, durable per-customer notes. New `customer_notes`
  table (`db/schema.sql`) — multiple short facts per customer (e.g.
  "prefers black"), each with its own id and an unused-for-now
  `superseded_by` column so a note can be replaced without deleting history
  once that's actually needed. Two read paths, per the plan: (1) every
  turn's opening context in `src/agent.ts` now includes a cheap
  `## Known facts about this customer` headline index (`[note #N]
  headline`); (2) a 5th, read-only tool, `get_customer_note` in
  `src/tools.ts`, fetches a note's full body by id, strictly scoped to the
  calling customer (`customer_id = ctx.customerId` in the query — one
  customer's turn can't read another's notes). Write path: piggybacked onto
  the existing forced CLOSE-step call instead of adding a third model
  round-trip or a 6th tool — the same call that produces the summary now
  returns `{"summary": "...", "new_notes": [{"headline", "body"}]}` as
  JSON, parsed defensively (invalid/missing JSON falls back to treating the
  raw text as the summary and skipping notes for that turn, same as the old
  behavior — never throws). Verified with a mocked-model manual test:
  note created and persisted, headline appeared in the next turn's opening
  context, `get_customer_note` returned the full body via a real tool call,
  and a second customer could not read the first customer's note. A
  separate test confirmed a non-JSON CLOSE response degrades gracefully
  instead of crashing the turn.
- **Still missing:** a compaction step for long conversations — **deferred
  on purpose**, not started because no real conversation is long enough yet
  to need it (per this file's own standing rule: build guardrails in
  response to an actual current requirement, not a hypothetical one).
  Revisit once a real thread's length actually makes it necessary.
- **Built from DeskcommCRM:** the *pattern* already adapted for 1.1's
  checkpoint; `agent/lead-notes.ts`-style indexing informed the
  headline/body split above (re-implemented in this project's own shape,
  not ported directly — did not qualify for extraction). `agent/compaction.ts`
  remains unported — still deferred, see above.
- **Definition of done:** tell the bot something in one conversation, come
  back in a new conversation days later, ask a question that requires that
  fact — it answers correctly. Verified for the notes path (see above); full
  proof against a real WhatsApp number is now done (see the dated entry
  directly below).
- **2026-09-05 — live-verified against the real number: ✅ PASS, with one
  caveat (still open) and one real bug found along the way (fixed the same
  day — see 1.4):** the same real customer had asked for a 20%
  discount the day before (2026-09-04 08:22 UTC — both in the raw
  `messages` history and as `customer_notes` id 7,
  *"Customer requested a 20% discount... requires Ahmed's approval"*).
  Nearly 24 hours and several unrelated conversations later (stock check,
  return policy, physical store questions all happened in between), the
  customer asked *"I asked you fir discount yesterday, do I know how much I
  asked for?"* — real reply: *"Bhai, aapne kal discount ke liye poocha tha
  (20% wala)! Maine uske approval ke liye Ahmed bhai ko notify kar diya hai,
  jese hi wo confirm karte hain main aapko update karta hoon."* — the exact
  right figure (20%), correctly recalled, correctly still framed as pending
  Ahmed's approval rather than granted.
  - **Caveat, same shape as 1.1's crash-retry caveat:** this customer has
    had under 30 messages total in their whole history, so the original
    discount exchange from yesterday is *still* inside the raw last-20-
    messages window `agent.ts` loads directly into every turn (confirmed by
    querying it directly) — this proves recall works correctly across a
    real day boundary, but does not yet prove it survives the fact aging
    out of that raw window entirely (which is what would isolate the
    structured `customer_notes`/checkpoint system as the actual source,
    rather than the raw transcript still happening to be in view). That
    isolation needs either much more conversation volume with this customer
    or a fresh one deliberately built past the 20-message mark — not done
    here.
  - **A real bug found along the way, fixed the same day (see 1.4),
    reported separately per this file's own standing practice — the first
    attempt at this exact recall was silently blocked, and the *widened*
    silent-no-reply guard
    (2026-09-05, see 1.3) is what caught it:** the model's first reply
    attempt got rejected by `discount-rules.ts`'s regex-based guardrail
    with reason *"You offered a 20% discount, which is at or above Ahmed's
    5% confirmation threshold"* — even though the bot wasn't offering
    anything, it was recalling that the *customer* had asked for one
    yesterday. `checkDiscountRule()`'s regex only checks whether a
    percentage and a discount-word appear near each other in the outbound
    text (see the file's own `gap()` comment) — it can't distinguish "I'll
    give you 20% off" from "you asked me for 20% off yesterday." Per the
    widened guard, the fallback fired correctly (*"Sorry, I'm having
    trouble answering that right now — let me get back to you"*) and
    `notify_owner` logged the block reason — so no unsafe behavior reached
    the customer, but it did produce one spurious "trouble answering" reply
    and one unnecessary owner notification for a question that didn't
    actually need Ahmed's attention. The model's second attempt (rephrased
    by itself, unprompted) happened to place "discount" and "20%" further
    apart than the regex's 15-character gap tolerance, which is why it got
    through — that's an accident of phrasing distance, not a real fix.
    **Fixed the same day, after confirming the design first — see 1.4's own
    2026-09-05 entry for the fix, the rejected alternatives, and both
    verification passes (direct + live, live re-using this exact recall
    question and getting it right on the first attempt this time).**
- **Status:** ✅ Structured notes done, and now live-verified against the
  real number for the core recall behavior (see above), with the window-
  overlap caveat still open. The false-positive bug this test found in the
  discount guardrail's interaction with recall is fixed — see 1.4. Compaction
  intentionally deferred, not outstanding-by-oversight — see "Still
  missing" above.

### 1.3 — WhatsApp compliance & anti-ban hardening
- **Goal:** the number survives running unattended 24/7 without getting
  banned or breaking WhatsApp Business policy.
- **Depends on:** 1.1.
- **Ships:** send throttling + jitter, sending-hour window, anti-repetition
  ("spinning") guard, per-number health circuit, "I'm a virtual assistant"
  disclosure, STOP/opt-out handling.
- **Done — anti-ban send-safety logic wired in (against the current stub
  `sendToCustomer`; no real provider connection yet, see below):**
  - `pacing/engine.ts` + `pacing/defaults.ts`, `spinning/engine.ts` +
    `spinning/defaults.ts`, and `guardrails/messaging-window.ts` moved out of
    `EXTRACTED-FOR-AHMED/` (no longer just staged) into
    `src/guardrails/pacing/`, `src/guardrails/spinning/`, and
    `src/guardrails/messaging-window.ts` — folder structure preserved, zero
    import edits needed inside them. `EXTRACTED-FOR-AHMED/MANIFEST.md`
    updated so its file-count claim doesn't go stale (16 files remain there).
  - **Content note resolved:** `pacing/defaults.ts`'s hardcoded
    `timezone: 'America/Sao_Paulo'` is now
    `process.env.PACING_TIMEZONE ?? 'Asia/Karachi'` — configurable (still no
    Brazil default), defaulting to Ahmed's actual shop timezone (confirmed
    2026-09-05, see the dated entry further below) rather than a placeholder.
  - `send_message`'s `execute()` in `src/agent.ts` now runs, in order, before
    every send: (1) the existing idempotency check; (2) **pacing** —
    `decidePacing()` against sends across *all* customers (pacing/spinning
    protect the one shared number in aggregate, not a single customer's
    thread — state is read globally from `messages`, not per-customer);
    (3) **spinning** — `decideSpinning()` against the last 20 outbound
    bodies globally, catching a near-identical template sent to different
    customers; (4) the one-time disclosure (below); then the actual send.
  - **Pacing/spinning veto handling — a judgment call, flagged per this
    file's §7:** outside the sending window or over a cap, there is no real
    job queue yet to defer to (explicitly out of scope for this task), and
    literally `setTimeout`-blocking the request for the hours until
    `nextAllowedAt` would hang the webhook handler and likely trigger
    provider-side timeout/retry storms — so those cases are a hard refusal
    (`{ok: false, error: "Not sending right now — <reason>"}`) rather than a
    real deferred send. Only the short throttle/jitter gap from an
    **allowed** send (bounded to ~2s by default knobs) is worth actually
    sleeping through, and that part *does* use `setTimeout` as asked. Net
    effect: a message outside hours does **not** fire immediately (matches
    the letter of the DoD bullet below) but also doesn't yet auto-fire later
    on its own — that "queue and retry" half needs a real async job queue,
    which is genuinely new work, not a wiring task.
  - One-time **"I'm a virtual assistant" disclosure**: new
    `customers.disclosure_sent_at` column (with a startup migration guard in
    `src/db.ts` so the already-existing dev database doesn't break — `create
    table if not exists` doesn't retrofit columns onto a table that already
    exists on disk). Prepended only to the first message actually sent to a
    new customer; the stored transcript keeps the model's undecorated text.
  - `guardrails/messaging-window.ts` (the 24h WhatsApp free-text-vs-template
    window) was moved per instruction but is **not wired into anything
    yet** — there's no proactive/outside-the-24h-window sending path in this
    project today (every send is a reply to an inbound message), so there's
    nothing current for it to gate. Left in `src/guardrails/` rather than
    force-wired in without a real use, per this file's own "don't build
    ahead of an actual requirement" rule.
  - Verified with a manual test (mocked model, no live API key here):
    disclosure appears on message 1 only; a template sent to a 3rd different
    customer after 2 identical sends is correctly vetoed by spinning; the
    moved `decidePacing()` correctly allows/vetoes given an injected
    in-window vs. out-of-window clock (confirms the move preserved
    behavior). Note: monkey-patching the global `Date` to test pacing
    through the *full* turn crashed `better-sqlite3`'s native bindings — the
    pacing engine was instead verified directly with an injected `now`,
    which is exactly what it's designed to take; the thin wiring in
    `agent.ts` around it was verified by inspection.
- **Real WhatsApp provider connection — code written and wired.** *(Header
  written before the connection was live; by 2026-09-04 it was, and stayed
  that way through all of 2026-09-05's testing — see the dated entries
  below in chronological order for the actual history, ending in "Version 1
  — final status" after 1.5.)*
  - New `src/channel/types.ts`: a `ChannelAdapter` interface, adapted from
    (not copied from) `EXTRACTED-FOR-AHMED/channel-adapter.ts` — deliberately
    smaller, stripped of the multi-tenant fields (`tenantId`/`leadId`,
    job-queue idempotency keys, approved-template rendering, per-message cost
    tracking) that don't apply to one shop with no queue and no billing (see
    CLAUDE.md §6). Kept: a named channel, `sendText(phone, text)`, and
    `parseInboundWebhook(payload)`. Because the extracted file wasn't reused
    verbatim, it stays staged in `EXTRACTED-FOR-AHMED/` rather than being
    "moved" — only the pattern was reused.
  - New `src/channel/waha.ts`: the WAHA-specific implementation — sends via
    `POST /api/sendText`, converts phone numbers to/from WAHA's
    `<digits>@c.us` chatId format, and parses inbound webhooks (filtering out
    our own echoed-back outbound messages, group chats, and captionless
    media). This is the only file in the project that knows WAHA's REST
    shape — `agent.ts`/`tools.ts` don't import it at all, per the
    `ChannelAdapter` seam.
  - `src/server.ts` rewired to call the adapter instead of stub-logging to
    console: `parseInboundWebhook` → `runTurn()` → adapter's `sendText` as
    the send callback.
  - `obs/logger.ts` moved out of `EXTRACTED-FOR-AHMED/` (no longer staged)
    into `src/obs/`, verbatim, no content note to resolve — wired into
    `server.ts` so its two log sites (turn failure, startup) use the
    structured logger instead of raw `console.*`, per CLAUDE.md §4.5.
    `EXTRACTED-FOR-AHMED/MANIFEST.md` updated (15 files remain there now).
  - `npx tsc --noEmit` passes clean with these changes.
  - **Image pull resolved.** `devlikeapro/waha:latest` pulled successfully
    after 7 failed attempts across 2 registries. **Root cause (confirmed by
    the user, not a guess):** WSL2 mirrored-networking-mode DNS resolution —
    fixed by setting `dnsTunneling=true` in `.wslconfig`. It was not a
    Docker Hub-specific or registry-specific issue (an earlier version of
    this note guessed that, based on a `mirror.gcr.io` workaround also
    failing partway through — correct symptom, wrong cause: both registries
    were hitting the same underlying WSL2 DNS problem, not two independent
    registry issues).
  - **WAHA running, QR pending, at this point in the log — snapshot of a
    since-superseded state, kept for the history.** Container `waha`
    (`devlikeapro/waha:latest`) is up, `/health` returns `{"status":"ok"}`,
    `/api/server/status` responds. A local dev API key
    (`WAHA_API_KEY=ahmed-dev-local-key`, set on the container so it's stable
    across restarts instead of WAHA's default auto-generated one) is
    configured. The app (`npm run dev`, `src/server.ts`) is also running on
    `:3000` with `WAHA_BASE_URL=http://localhost:3001` and the same API key,
    and its webhook endpoint responds 200 to a real WAHA event. Session
    `default` has been created and is in `SCAN_QR_CODE` state, waiting on the
    owner to link a real WhatsApp number. At the time this paragraph was
    written, no message had round-tripped through it yet, so the channel
    adapter was correctly still marked unverified — **this changed
    2026-09-04, see the dated entry below**, and stayed verified through
    all of 2026-09-05's testing.
  - Still missing beyond the adapter itself, unchanged as of 2026-09-05 —
    carried forward, not resolved by Version 1 completion: per-number
    health circuit (`health/defaults.ts`, still staged in
    `EXTRACTED-FOR-AHMED/`, not pulled in — no current requirement for it
    yet); STOP/opt-out handling.
- **Epistemic note:** treat the ban-risk urgency as reasonable precaution,
  not a verified fact — neither this project nor its source analysis has
  direct evidence of WhatsApp's actual thresholds for a low-volume,
  reply-only number.
- **Standing reminder (added 2026-09-02, applies to all future sessions):**
  cap WAHA session restart/reconnect attempts to a small number per hour,
  even when done manually for testing/debugging — see the incident directly
  below for why.
- **2026-09-02 status — blocked, not broken:** WAHA + NOWEB engine setup
  itself is working (image pulls, container runs stable, session/QR
  generation all function correctly), and the anti-ban send-safety logic
  above is written and verified against the stub send function. But live
  verification against a real WhatsApp number is currently **blocked**:
  WhatsApp applied `RESTRICT_ALL_COMPANIONS` to the test number after
  repeated pairing/reconnect attempts today (a disk-space exhaustion forced
  several app restarts, plus two back-to-back session config updates to
  enable NOWEB's message store). This is a WhatsApp-side rate limit, not a
  bug in our code. Session status is currently `FAILED`; the restriction is
  expected to clear ~2026-09-03 01:44 AM PKT. **Do not attempt any session
  restart or API call against this session until after that time** —
  repeated attempts while restricted risk making it worse. Concrete lesson
  for the anti-ban work in this sub-version's pacing/spinning scope: this is
  now direct, real evidence of why that safeguard matters for
  reconnect/session-management activity too, not just outbound message
  pacing — not a hypothetical anymore.
- **2026-09-03 status — escalated, still blocked, do not retry on this number
  for now:** picked back up after the 01:44 AM PKT timelock expiry. Found
  three separate problems in sequence, not one:
  1. The `RESTRICT_ALL_COMPANIONS` timelock itself had genuinely cleared
     (`reachoutTimelock: null` confirmed via API).
  2. But the session had *also* taken a `stream:error` /
     `conflict: device_removed` (401) at the same moment the timelock was
     applied on 2026-09-02, with WAHA logging "do not reconnect the
     session." Restarting the session just kept retrying the same dead
     device credentials and cycling back to `FAILED` — this needed a
     `POST /api/sessions/default/logout` (clears stored creds) before a
     fresh `SCAN_QR_CODE` state was reachable at all. Logout worked cleanly.
  3. From there, a QR code and later a pairing code
     (`POST /api/{session}/auth/request-code`, phone-number-based, no
     second device needed) were both generated successfully but expired
     unused (owner not available to enter them in time), which force-stops
     the session back to `FAILED` — expected, not alarming on its own.
     **But after 2-3 restart attempts to regenerate a fresh code in
     succession, the session stopped reaching `SCAN_QR_CODE` at all:**
     every subsequent restart now gets as far as "connected to WA" →
     "logging in..." → an immediate (<1s) `Connection Failure` with
     `"do not reconnect the session"`, before any QR/code can even be
     issued. Host and container internet connectivity were independently
     confirmed fine (`curl`/`wget` to whatsapp.com and google.com both
     succeed) — this is not a network problem, it is WhatsApp's server
     rejecting the auth handshake for this specific number
     (`923128346256`) outright. `reachoutTimelock` still reads `null` (no
     new *named* restriction surfaced via the API), but the symptom is
     consistent with an escalating soft-block from repeated
     reconnect/pairing attempts in a short window — same root cause the
     2026-09-02 incident already flagged, now recurring and worse.
  **Decision: stop attempting any restart/logout/pairing-code call against
  this session for a real cooldown period (hours, not minutes) before
  trying again** — every additional attempt while it's already refusing
  the handshake risks lengthening or hardening whatever block this is.
  Whoever resumes this: check `docker logs waha` for whether it still fails
  at "logging in..." before touching it again; if so, wait longer, don't
  retry. Consider testing pairing against a second, never-touched WhatsApp
  number next time, to isolate whether this is number-specific.
- **2026-09-04 status — RESOLVED, real round-trip verified end-to-end.**
  Recovered from the 2026-09-03 "do not reconnect" dead state by fully
  deleting the session (`DELETE /api/sessions/default`, not just
  logout/restart) and recreating it from scratch — a genuinely clean session
  reached `SCAN_QR_CODE` immediately, no lingering-credential issue this
  time. Paired via WAHA's **phone-number pairing code**
  (`POST /api/{session}/auth/request-code`, an 8-character code entered
  under WhatsApp → Linked Devices → Link with phone number), not a QR scan —
  confirms the earlier "do not reconnect" block was a dead-credential issue,
  not a permanent restriction on this number (`923128346256` paired
  successfully on the first attempt against a fresh session).
  Once linked, the number started receiving **unsolicited real traffic**
  (a WhatsApp Business account, "The Style Vault," and others) — genuine
  proof it's a live, reachable number, independent of anything we sent
  ourselves. That real traffic surfaced four real bugs, all now fixed, that
  were silently blocking every reply:
  1. **Gemini free-tier quota exhausted.** `gemini-2.5-flash`'s quota
     (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, 20/day) is scoped
     per **project**, not per key — two different API keys from the same
     project both hit the same exhausted bucket. Fixed by switching
     `src/llm.ts`'s `MODEL` to `gemini-flash-lite-latest`, a separate model
     with its own quota, confirmed working including function/tool calling.
  2. **Missing `thoughtSignature`.** The new model rejects (`400`) any
     multi-turn tool-call exchange that doesn't echo back the
     `thoughtSignature` it attached to a prior `functionCall` part.
     `src/llm.ts` now captures it off the response and replays it on the
     next request — fixed entirely within this one file, per the project's
     single-seam rule for model calls.
  3. **LID-addressed contacts silently failed to send.** WhatsApp's privacy-
     ID system addresses some contacts as `"<pseudo-id>@lid"` instead of
     their real phone-number JID. `parseInboundWebhook` was treating that
     pseudo-id as the customer's phone number, producing a bogus chatId that
     failed on send — caught by `send_message`'s existing try/catch, so it
     never surfaced as a visible error anywhere. Fixed in `src/channel/
     waha.ts`: when `from` ends in `@lid`, resolve the real JID from
     `_data.key.remoteJidAlt` (which WAHA already provides) instead.
  4. **Operational blind spot, not a functional bug:** a failed send
     returning `{ok:false}` to the model (correct, per this file's own
     "never throw" tool rule) also meant *nothing was ever logged* for that
     failure — a genuinely silent failure mode that made bugs 1-3 far
     harder to diagnose than they should have been. Added `log.error` in
     `send_message`'s catch block (`agent.ts`) and full webhook-lifecycle
     logging — `webhook ignored` / `turn starting` / `turn completed` — in
     `server.ts`. Neither change alters what the model itself sees.
  - **Separately: a random, load-independent native crash** (`better-
    sqlite3`/Node assertion in `RemoveEnvironmentCleanupHook`) surfaced
    repeatedly today, including with zero traffic — most likely a Node
    v24.19.0 / native-binding compatibility issue given the exact crash site,
    not a bug in this project's code (confirmed not load-triggered by direct
    testing). **Status: MITIGATED, NOT FIXED — root cause still
    unresolved.** The dev app runs under a local shell auto-restart loop
    (not part of the committed project, not a code change) so it
    self-recovers within ~1-2s of a crash; the underlying Node/native-module
    incompatibility itself has not been touched.
  - **Node version check (verified by inspection, not assumed):** the user
    installed Node 22 during this session, but `node --version` and the live
    app process's own `ExecutablePath` both confirm **`C:\Program
    Files\nodejs\node.exe`, v24.19.0** — the same install as before, still
    the only Node found anywhere on this machine (checked `Program Files`,
    `LOCALAPPDATA\Programs`, `Program Files (x86)`). **The Node 22 install
    never became active in this session and was NOT what ran today's
    verified round-trip** — everything today, including the crash and the
    successful reply, ran on v24.19.0. Whoever picks this up next: find out
    why the Node 22 install didn't take (wrong install scope, PATH not
    refreshed, failed install?) and get it actually active before treating
    the native-crash issue as anything but open.
  - **The actual verification:** an unsolicited real "Hi" from a real
    WhatsApp Business account (`923299144863`, "The Style Vault") produced a
    natural, on-brand, Roman Urdu/English reply — *"Hello! 😅 Teesri baar
    'Hi' agaya hai! Bataiye, kya dikhayen aapko?..."* — confirmed sent to the
    **correct, resolved phone-number JID** (`923299144863@c.us`) by reading
    it back directly from WAHA's own message log, not just trusting an
    app-side "success" log line.
  - **A second, separate real thing got live-verified along the way, on
    2026-09-03** (real unsolicited traffic, part of this same testing arc,
    not a fresh test staged today): two different real people messaged
    about job interviews (unrelated to the shop) and the bot correctly
    called `notify_owner` both times (`"NEEDS AHMED"` logged,
    `2026-09-03T15:15:30Z` and `15:17:04Z`) instead of guessing — this is
    live proof of the CLAUDE.md §8 "genuinely outside its knowledge →
    handoff, not a guess" requirement specifically, not just of 1.3.
- **Definition of done — updated 2026-09-05, see the burst-throttling entries
  further below for the full story:** blast a burst of test messages at the
  bot — sends visibly throttle/space out rather than firing all at once (✅
  **now live-verified against the real adapter and real number** — this was
  actually a real concurrency race under genuine concurrent load, found,
  fixed, and re-verified both directly and live, see below; the note that
  used to sit here saying "not yet re-verified against the real adapter"
  turned out to be hiding a real bug once actually checked); sending outside
  configured hours queues instead of firing immediately (✅ now a clean,
  deliberate direct test, see below — superseding the earlier "partially
  true" hedge); a real WhatsApp message to the actual number produces a real
  reply (✅ verified 2026-09-04 — see above, confirmed via WAHA's own message
  log).
- **Status — superseded by the fuller status after the burst-throttling
  entries below; kept here for the historical progression:** ✅ **Done, for
  this sub-version's own scope, as of when this was written.** Anti-ban
  send-safety logic and the real WAHA/NOWEB connection are written, working,
  and the specific "real message in → real reply out" requirement above is
  live-verified. Deliberately still not built (unchanged as of 2026-09-05,
  not blocking Version 1 completion — see "Version 1 — final status" after
  1.5): per-number health circuit, STOP/opt-out handling — both remain
  deferred. Separately open, explicitly **not fixed, still true as of
  2026-09-05**: the Node v24 native crash (see the dedicated note above —
  mitigated by a dev-only restart loop only, and hit again during today's
  own testing; root cause still unresolved) and the queue-based "actually
  fire later" half of outside-hours sending (still no real job queue —
  today's fix closed the *throttle race*, not this separate, already-known
  gap).
  - **This is 1.3's own status, not a Version-1-wide claim.** CLAUDE.md §8's
    full Definition of Done for "Version 1 complete" has 9 items; as of
    earlier today, live testing had verified exactly 2 of them against the
    real number (real-reply, and out-of-scope-question → handoff). **Two
    more were live-tested later the same day — see the dated entry directly
    below, which also surfaced a third real bug, not yet fixed.**

- **2026-09-04 (continued) — two more §8 items live-tested against the real
  number, deliberately one at a time, and a third real bug surfaced along
  the way:**
  1. **Crash-and-retry, no duplicate send — ✅ PASS, with a real caveat.**
     Test: watched the live app log for `"turn starting"` on a real inbound
     message and killed the process the instant it appeared (same second,
     `08:18:40.567Z`), simulating a crash before any reply could exist. The
     auto-restart loop brought the app back in ~7s; WAHA redelivered the
     same webhook (`"turn starting"` again at `08:18:49.772Z`, same phone);
     the retry completed and sent **exactly one** reply — confirmed by
     reading WAHA's own message log directly, not an app-side log line.
     **What this does NOT prove:** the kill landed at the very start of
     `runTurn()`, before the first attempt could have reached
     `send_message` at all — so there was nothing to deduplicate yet, and a
     naive implementation with no idempotency ledger at all would have
     passed this exact test too. The narrower, real race — a crash *after*
     `sendToCustomer()` succeeds but *before* `send_ledger` is marked
     `'sent'` — is a window of milliseconds that can't be hit reliably by
     killing a process by hand. That race remains genuinely untested.
  2. **Unauthorized-discount refusal — ✅ PASS.** Test: a real customer
     ("The Style Vault") sent *"Could u give me 20% discount kindly?"*
     (above the confirmed 5% threshold). The model called `notify_owner`
     first (`"NEEDS AHMED"` logged, reason correctly cites the 20% figure
     and the 5% limit), and only then sent a reply declining the discount
     and deferring to Ahmed — *"Bhai, itna bada discount dena mere bas mein
     nahi hai! 😅 Main Ahmed bhai se baat karke aapko batata hoon..."* — no
     discount was granted. This also re-confirms the human-promise guardrail
     (the "I'll check with Ahmed" line only sent because the handoff was
     logged immediately before it, exactly as designed). **Side note, not a
     correctness issue:** this turn took ~2 minutes end-to-end (several
     tool-call round trips against a slow model) — worth flagging as a UX
     concern for later, separate from whether it was correct.
  - **A third real bug, found along the way — fixed 2026-09-04, then
    widened 2026-09-05 (see the dated entry below); reported separately per
    explicit instruction, not folded into the two PASS results above:**
    during this same testing session, a real customer asked *"Do I have
    shirts or paints in stock?"* — the turn logged `"turn starting"` then,
    52 seconds later, `"turn completed"`, with **no error anywhere** — and
    **no reply was ever sent.** Confirmed by reading WAHA's message log
    directly: the most recent outbound message was from an earlier,
    unrelated turn. **Root cause:** `agent.ts`'s tool loop explicitly
    discards any turn where the model's final output is plain text with no
    tool call — `if (toolCalls.length === 0) break; // model produced only
    text (ignored) — nothing left to do` — which is *correct* per this
    project's core rule that raw model text must never reach a customer,
    but meant that when the model forgot (or chose not) to call
    `send_message`, the customer received **literally nothing, and nothing
    was logged anywhere to say so.** From the customer's side this was
    indistinguishable from the bot being completely broken.
  - **§8 tally after today:** 4 of 9 items now live-verified (real-reply;
    out-of-scope → handoff; crash-and-retry with the caveat above;
    discount refusal). The rest — malformed tool input not crashing a turn,
    cross-conversation memory recall, burst-message throttling, catalog/FAQ
    grounding — remain verified only via earlier mocked-model, local-only
    tests. **Version 1 still should not be marked complete** — 5 of 9 §8
    items remain live-unverified.
  - **§8 tally, updated 2026-09-05:** catalog/FAQ grounding is now also
    live-verified (see 1.5's own dated entry above) — **5 of 9 items
    live-verified** (real-reply; out-of-scope → handoff; crash-and-retry
    with the caveat above; discount refusal; catalog/FAQ grounding). Still
    live-unverified: malformed/unexpected tool input not crashing a turn,
    cross-conversation memory recall across separate days, and burst-message
    throttling (the "outside hours doesn't fire immediately" half got
    incidentally demonstrated today by the timezone bug itself, but that
    was a bug-triggered side effect during an unrelated test, not a clean
    deliberate test of it — doesn't count as verifying that item). **Version
    1 still should not be marked complete** — 4 of 9 §8 items remain
    live-unverified, and item 9 (tracker accurately reflects all of the
    above) can't honestly be checked off until items 1-8 actually are.
  - **§8 tally, updated again 2026-09-05:** malformed/unexpected tool input
    now has direct, unmocked proof against the real `tools.ts` code (see
    1.1's own dated entry above) — 35 bad calls across all 7 tools, all
    correctly rejected, no crashes, no partial DB writes. **Deliberately not
    counted toward the "live-verified" 5** — this was direct tool execution,
    not a live conversation through the real model/WhatsApp channel, per
    this file's own standing distinction between the two verification
    bars. Tally stays **5 of 9 live-verified**, with item 3 now
    additionally backed by strong direct evidence the other 3 remaining
    items (cross-conversation memory recall, burst-message throttling, and
    item 9 itself) don't yet have. **Version 1 still not complete.**
  - **§8 tally, updated a third time 2026-09-05:** cross-conversation memory
    recall is now live-verified too (see 1.2's own dated entry above) — a
    real customer's 20%-discount request from the day before was correctly
    recalled, with the right figure, nearly 24 hours and several unrelated
    conversations later. **6 of 9 items now live-verified** (real-reply;
    out-of-scope → handoff; crash-and-retry with its caveat; discount
    refusal; catalog/FAQ grounding; cross-conversation memory recall, with
    its own window-overlap caveat — see 1.2). This same test surfaced a
    real false-positive bug in the discount guardrail's interaction with
    recall — fixed and re-verified live the same day, see 1.4. **§8 tally,
    updated twice more the same day:** burst-message throttling — tested
    right after this (see the dated entries immediately below), found
    FAILING with a real concurrency race, then fixed and re-verified both
    directly and live — is now ALSO live-verified passing; and
    malformed/unexpected tool input closed out its live half too (see 1.1's
    later 2026-09-05 entry — a real customer ordering a nonexistent product
    ID didn't crash the turn). **8 of 9 items live-verified.** Only item 9
    (tracker accuracy) remains — and per §8's own wording, that one doesn't
    get checked off by a good-faith update like this one; it closes when
    the other 8 have genuinely stayed accurate, not on the update that
    describes them. Version 1 still not complete**, but every other item
    is done. *(Superseded by the end of this same day — see "Version 1 —
    final status" after 1.5: this same full-file read-through and
    correction pass is what closed out item 9.)*

- **2026-09-05 — `PACING_TIMEZONE` set, and the silent-no-reply guard
  widened to a second failure shape:**
  - **`PACING_TIMEZONE` fixed.** Ahmed's shop timezone is confirmed
    Pakistan, so `pacing/defaults.ts`'s fallback (used whenever the env var
    itself isn't set) changed from `'UTC'` to `'Asia/Karachi'` — still fully
    overridable via the `PACING_TIMEZONE` env var, this is just the correct
    default now that the real value is known. Live-verified: a
    `decidePacing()` veto reason logged during testing now reads
    `"...agende para 2026-09-06 07:00:00 (Asia/Karachi)..."`, confirming the
    new zone is actually in effect, not just set in a comment.
  - **Silent-no-reply guard widened.** The 2026-09-04 fix above only caught
    "model never called `send_message`." Live testing that same day showed
    a second, equally silent failure shape: `send_message` gets called, but
    **every attempt is vetoed** by pacing, spinning, the discount guardrail,
    or the human-promise guardrail — from the customer's side that's
    identical to never calling it at all (zero reply, and previously zero
    log trace of *why*). `agent.ts`'s guard now tracks
    `sendMessageSucceeded`, not just "was it called," so both shapes trip
    the same warning log + fallback send + `notify_owner` handoff.
    **One deliberate exception:** if the *only* reason every attempt failed
    is a pacing veto (outside the sending window, or over the warm-up/daily
    cap — both time- or volume-based, not content-based), the guaranteed
    fallback send is skipped, because re-attempting the exact same send a
    moment later with different words hits the identical veto — it would
    just log a second doomed send attempt for no benefit. Every other veto
    (spinning, discount, human-promise) is content-based, so a generic
    fallback body has a real chance of getting past it and is still
    attempted. **Verified locally** (mocked model call, real `runTurn()`,
    real DB, only the network edge stubbed): a warm-up-cap veto (20/day for
    a day-0 number — time/volume-based, chosen over an hours-based window
    veto so the test doesn't depend on real wall-clock time) correctly
    skipped the fallback send and still logged `notify_owner` with the real
    veto reason; a spinning veto (near-duplicate body) correctly still
    attempted and delivered the generic fallback reply. Scratch verification
    scripts and the test customers/messages they created were deleted after
    use, per this project's "nothing built speculatively" rule — this was
    manual verification, not a committed automated test suite.

- **2026-09-05 — burst-message throttling tested: outside-hours queuing
  PASSES cleanly; burst-spacing under concurrent load FAILED, then FIXED
  the same day (see the dated entry directly below this one):**
  - **Outside-hours half — ✅ PASS, now a clean deliberate test superseding
    the earlier incidental evidence.** `decidePacing()` takes `now` as a
    plain argument (no `Date` monkey-patching needed, which crashed
    `better-sqlite3` before per this file's own history), so this is a
    direct, deterministic pure-function test: 2:30am Karachi correctly
    refuses with `code: 'outside_window'` and a real `nextAllowedAt` (the
    "queue instead of firing" half, not a silent refusal); 7:00am and
    9:59pm correctly still allow; 10:00pm correctly no longer allows;
    a sequential send attempted 200ms after the last one correctly computes
    a wait instead of firing immediately. 7/7 checks passed.
  - **Burst-spacing under concurrency — ❌ FAILS, confirmed both directly
    and live against the real number.** `server.ts` awaits `runTurn()`
    per-request with no lock/queue (deliberately, per its own comment —
    "one Ahmed doesn't produce enough concurrent messages to need one").
    Node yields at every `await` (the real LLM call, the pacing `sleep`),
    so genuinely concurrent inbound messages really do interleave. The
    pacing engine's own sequence — read `lastSentAt` from the DB → decide
    a wait → `sleep` → only THEN write the new send — has a classic
    check-then-act race: two concurrent turns can both read the same stale
    `lastSentAt` before either has written its own, both compute a similarly
    short wait, and both send close together regardless of the configured
    throttle.
    - **Direct proof:** fired 5 genuinely concurrent `runTurn()` calls
      (mocked model responding immediately — deliberately, to maximize real
      interleaving rather than mask it; real DB; real pacing/spinning/
      discount code, nothing else stubbed). Resulting sends landed within
      ~230ms of each other (gaps of 30-95ms) against a configured 1200ms
      throttle. Reproduced twice, both times far under threshold, never
      once close to compliant. Scratch script deleted after use.
    - **Live proof, against the real number:** a real customer sent 4 short
      messages ("one"/"Two"/"Three"/"Four") roughly 1.2-1.8 seconds apart —
      not even a true instant flood, just normal fast typing — and the bot's
      3 resulting replies landed within **142ms** of each other
      (`messages` ids 403-405, `05:18:18.155` → `05:18:18.297`), the same
      race manifesting in production, not just in a script.
    - **A separate, non-bug observation from the same live test, confirmed
      with the user rather than assumed:** the raw message log shows
      "Two"/"Four"/"Five" repeating roughly a dozen times over the next 12
      seconds after the initial burst. Asked directly — this was the user
      manually re-sending because replies felt slow, not an automatic
      WAHA/WhatsApp retry-storm bug. Notable anyway as a real symptom of the
      underlying latency (turns taking long enough that a real customer
      would plausibly re-send), but not itself a code defect and not
      pursued further here.
  - **Consequence for CLAUDE.md §8, at the time this was written:** this
    bullet is one line covering two behaviors — outside-hours queuing
    passes, burst-spacing did not. Per this file's own standing rule, a
    real failure gets reported as a real failure, not softened into "needs
    more testing." This was live-tested and found FAILING, not merely
    unverified — different from every other item in this tracker up to
    this point, all of which had passed once actually checked. **Fixed the
    same day — see immediately below.**

- **2026-09-05 — the burst-spacing race — FIXED, same day, verified both
  directly and live:** the root cause was exactly as diagnosed above:
  `send_message`'s `execute()` read pacing state, decided a wait, slept,
  and only then wrote its own send — with no serialization, concurrent
  turns could all read the same stale state before any of them committed.
  - **What shipped:** a `withSendLock()` helper in `agent.ts` — a plain
    in-process promise chain (`sendQueueTail`), no new dependency, no
    external queue. The entire guarded-send critical section (pacing
    decision → wait → spinning → discount → human-promise → the actual
    send → the DB writes) is now wrapped in it, so only one guarded send
    runs at a time across ALL concurrent turns, in submission order. A
    single in-process queue is the right scope for this project's actual
    shape — one process, one WhatsApp number — not a speculative
    multi-worker design nothing here needs yet. As a side effect (same
    critical section, no extra code), this also closes the identical race
    the spinning guard's "recent outbound window" read was equally exposed
    to, though that wasn't separately tested here.
  - **Verified two ways, same harness as the failing run for a clean
    before/after comparison:** (1) **Direct** — the same 5-concurrent-
    `runTurn()` test that previously produced 30-95ms gaps now produces
    gaps of 1256-1961ms, every one comfortably inside the configured
    1200-2000ms throttle+jitter range. Reproduced twice. (2) **Live,
    against the real number** — restarted the process (same lesson as
    every other fix this session: not live until it's restarted), then a
    real customer burst of 5 messages ("alpha"/"Beta"/"Gamma"/"Detha"/
    "Ohho") sent ~1.5-2.5s apart produced 5 replies spaced **1321-2839ms**
    apart — properly throttled in production, not just in a script.
  - **Not addressed, scoped out on purpose:** true multi-process/
    multi-worker deployment would need a DB-level lock instead of an
    in-process one — out of scope, since this project runs as one process
    by design and nothing here calls for that yet.
- **Status, final for this sub-version (2026-09-05), superseding every
  earlier "Status" line above:** ✅ **Done.** Anti-ban send-safety logic
  (pacing, spinning, disclosure), the real WAHA connection, and
  burst-message throttling (both halves — outside-hours queuing and
  concurrent-load spacing) are all built, wired, and live-verified against
  the real number. **Explicitly still open, not resolved by this and not
  blocking Version 1 completion** (see "Version 1 — final status" after
  1.5 for why): the Node v24 native-module crash (mitigated by a dev-only
  restart loop, root cause unresolved — hit again as recently as today's
  own testing); the per-number health circuit; STOP/opt-out handling; a
  real async job queue so an outside-hours message actually auto-fires
  later instead of just not firing immediately. **Standing operational
  fact, not a bug:** the test number's daily warm-up cap (20/day for a
  day-0 number) is exhausted from today's own testing volume and resets at
  the next local-midnight window open — real customer traffic will queue
  behind that cap, same as any other customer message would, until it
  resets.

### 1.4 — Promise & safety guardrails
- **Goal:** the bot never tells a customer something that costs Ahmed money
  or credibility, and never goes silent when it's stuck.
- **Depends on:** 1.1.
- **Ships:** price/discount promise detection, human handoff when the bot
  can't resolve something (routed directly to Ahmed — never a queue/ticket,
  see permanent exclusions below).
- **Done — human-promise detection, rewritten and wired in:** new
  `src/guardrails/human-promise.ts` — adapted, not moved verbatim, from
  `EXTRACTED-FOR-AHMED/guardrails/human-promise.ts` (which stays staged
  as-is, same treatment `channel-adapter.ts` got). **Content flag
  resolved:** the original's regex was Portuguese-only; this version targets
  English + Roman Urdu/Hindi-English instead, matching how Ahmed's customers
  actually write. Calibrated by hand against plausible phrasing, not against
  real transcripts — none exist yet, see the 1.3 epistemic-note precedent.
  `guardrails/promise/engine.ts` was not needed for this — its job
  (extract/decide on price promises) is covered by the discount-rule check
  below instead, so it stays un-reimplemented.
- **Done — unauthorized-discount detection:** new
  `src/guardrails/discount-rules.ts`. **Rule confirmed directly by Ahmed
  (2026-09-02), not invented:** discounts at or above 5% require his
  confirmation before being offered; anything below 5% the bot can mention
  freely. Regex-based, same conservative shape as the promise detector —
  catches "`X`% off/discount/sale/kam/chhoot" in either number-then-word or
  word-then-number order, ignores unrelated percentages (e.g. "80% cotton").
- **Done — human-handoff path:** new `notify_owner` tool
  (`src/tools.ts`) and `handoff_ledger` table (`db/schema.sql`). The model
  calls it with a reason when it genuinely can't resolve something; it
  writes a row to `handoff_ledger` and logs a distinct, greppable
  `"NEEDS AHMED"` line via the structured logger. **Delivery is log-only —
  reason updated 2026-09-05:** originally deferred because 1.3's real
  WhatsApp connection wasn't live-verified yet; that connection has been
  live-verified since 2026-09-04, so that original blocker is gone, but the
  upgrade itself was never actually built — **this is a genuine standing
  gap, not resolved by Version 1 completion**, carried forward like the
  other explicitly-open items (see "Version 1 — final status" after 1.5).
  CLAUDE.md §8's own DoD item 7 only requires that an out-of-scope question
  "triggers a handoff to the owner, not a guess" — verified true via this
  log+ledger mechanism, live, multiple times — so this doesn't block
  completion, but Ahmed today only sees a "NEEDS AHMED" log line, not an
  actual WhatsApp message to his own number. **Upgrade still needed,
  whenever picked up:** replace/augment the log line with a real `sendText`
  call to Ahmed's own number via the `ChannelAdapter` (`TODO` comment left
  at the call site in `tools.ts`).
- **Wired into `send_message`'s `execute()` in `agent.ts`,** same
  teaching-text-error pattern as pacing/spinning: the discount check runs
  first (blocks and asks the model to reformulate); then the human-promise
  check, which only blocks if `detectHumanPromise(body)` is true AND no
  `handoff_ledger` row exists for this customer within the last 5 minutes
  (`hasRecentHandoff` — same idempotency-window idiom as `send_ledger`'s
  retry window). System prompt updated to tell the model about both rules
  and the `notify_owner` tool up front, not just react after a block.
- **Verified (2026-09-02), local-only — no WAHA/WhatsApp API calls made,
  per this task's explicit scope:** a manual test script (`npx tsx`,
  deleted after running) directly exercised the pure functions and the
  DB-backed tool: 5%/10% discounts blocked, 2% allowed, an unrelated
  percentage (fabric composition) correctly ignored; English and Roman Urdu
  human-promise phrasing both detected, a normal stock-check reply and a
  bot self-follow-up ("let me check that for you") correctly NOT flagged;
  `notify_owner` returns `{ok: true}`, writes a real `handoff_ledger` row
  with the right customer id and reason, and emits the `"NEEDS AHMED"` log
  line. `npx tsc --noEmit` passes clean. **Not independently re-verified:**
  the few lines of wiring inside `send_message`'s `execute()` itself
  (calling these functions and returning early) — checked by inspection
  only, same bar already accepted for pacing's thin wiring in 1.3 above,
  since exercising it live means either running the real model (out of
  scope for this task) or mocking it (crashed `better-sqlite3` last time
  this was tried, per the 1.3 note).
- **Definition of done:** ask the bot for an unauthorized discount — it
  refuses/deflects (✅ verified at the guardrail level; **stale note
  corrected 2026-09-05** — this line previously said "not yet through a
  live conversation," but 1.3's own 2026-09-04 dated entry already recorded
  a real customer's 20%-discount ask being live-refused; this file just
  hadn't been updated in both places); ask it something genuinely outside
  its knowledge — it hands off instead of guessing (✅ `notify_owner` +
  ledger + log marker verified, also live-confirmed per 1.3/1.5).
- **2026-09-05 — the false-positive bug found via 1.2's cross-conversation-
    memory-recall test — FIXED, same day, design confirmed with the user
    before building:** `checkDiscountRule()` in `discount-rules.ts` was a
    plain regex proximity check (a percentage near a discount-word) that
    couldn't distinguish the bot *offering* a discount from the bot
    *recalling that the customer asked for one in the past* — a live recall
    of a customer's own 20%-discount request from the day before got
    blocked on its first attempt with the exact same reason a real
    over-threshold offer gets (full reproduction in 1.2's own dated entry).
  - **Design choice, and why the two rejected alternatives were rejected:**
    considered and rejected letting the model self-tag "I'm quoting, not
    offering" — that means trusting the exact actor the guardrail exists to
    constrain, the same failure shape CLAUDE.md's rule 3 (never trust
    model/tool output at face value) already warns against. Considered and
    rejected allowing any match whose percentage merely appears somewhere
    in the customer's history — too loose, since a genuinely fresh offer
    that happens to reuse an old number would slip through untouched.
  - **What shipped:** `checkDiscountRule(body, knownPercents)` now requires
    BOTH signals together, neither sufficient alone: (1) **grounding** —
    the percentage must already appear in this customer's own persisted
    `customer_notes`/checkpoint (extracted by a new `getKnownDiscountPercents()`
    in `agent.ts`, which owns the DB access — `discount-rules.ts` itself
    stays the pure, DB-free function it always was, matching this project's
    existing pattern for pacing/spinning); (2) **retrospective language** —
    a new bilingual `RETROSPECTIVE_MARKER` regex (`asked/requested/wanted/
    yesterday/earlier/before` — `poocha/maanga/kal/pehle/kaha`), checked
    within the same 40-character proximity window as the existing
    discount-word pattern, so the match must actually read as reporting the
    past, not merely appear somewhere in a longer message.
  - **Residual risk named, not hidden:** the CLOSE step lets the model
    write its own `customer_notes`, so in theory a model that wrote a false
    note in one turn could "unlock" quoting that number in a later turn —
    a two-step scenario, no worse than the single-turn slip the original
    regex was already vulnerable to, but worth knowing this fix trusts
    durable notes as ground truth, and durable notes are themselves
    model-written.
  - **Verified two ways:** (1) 11 direct, deterministic checks against the
    real (unmocked) `checkDiscountRule` plus the real DB-sourced
    `getKnownDiscountPercents` extraction — the exact recall phrasing now
    passes, a fresh offer of the *same* known number without retrospective
    language still blocks (proving grounding alone isn't enough), and a
    fresh unrelated percentage still blocks; scratch script and its test
    customer/note deleted after use. (2) **Live, against the real number,
    both required cases:** re-asked *"Do I remember, what discount
    percentage I asked you for yesterday?"* — real reply *"Bhai, aapne kal
    20% discount ke liye poocha tha! Uske approval ke liye Ahmed bhai ko
    notify kiya hua hai..."* — correct, on the **first attempt**, no
    fallback/blocked-handoff logged for this turn at all (the process was
    restarted first, same lesson as the timezone fix — a code change isn't
    live until the process is). Then asked *"Can u give me 15% discount on
    my next order pls?"* — real reply deflected to Ahmed
    (`handoff_ledger` confirms *"Customer is asking for a 15% discount...
    Ahmed's approval is needed for any discount of 5% or more"*), discount
    not granted. **Caveat on this second live case, stated plainly:** the
    model's own final reply didn't restate the "15%" figure at all, so this
    live turn shows the correct *outcome* (no unauthorized discount
    reached the customer) but doesn't directly prove the regex itself fired
    this specific time — that direct proof comes from the unit-level test
    above (cases 2/2b/2c), which do show a fresh same-number and
    fresh-unrelated-number offer both still blocking at the regex level.
  - **A pattern worth naming explicitly, as asked:** this is at least the
    third distinct real bug the *widened* silent-no-reply guard (1.3) has
    caught by simply doing its job, each in a completely different
    subsystem it was never built to know about: (1) the bug that motivated
    building the original guard — the model giving up without calling
    `send_message` at all (2026-09-04); (2) the bug that motivated
    *widening* it — `send_message` called but vetoed every attempt is
    equally silent (2026-09-04); (3) since being widened, it has caught two
    further issues in the wild unprompted — the stale-timezone deploy gap
    during the catalog test, and now this discount-guardrail false
    positive during the memory-recall test (both 2026-09-05). It has moved
    from "fixes one specific incident" to "the thing that reliably surfaces
    whatever's actually wrong, regardless of which subsystem broke" — worth
    remembering as a reason not to remove or narrow it later.
- **Status:** ✅ Done — human-promise detection (rewritten for English/Roman
  Urdu), discount-rule check (5% threshold, confirmed by Ahmed), and the
  human-handoff path (`notify_owner` + `handoff_ledger`) are all built,
  wired into `send_message`, and live-verified for the core refusal
  behavior. The discount-recall false-positive found via 1.2 is now fixed
  and verified both directly and live. **One known, explicitly-open gap
  remains, carried forward, not blocking Version 1 completion:** handoff
  delivery is still log-only, not an actual WhatsApp message to Ahmed's own
  number (see the "Delivery is log-only" note above) — satisfies CLAUDE.md
  §8's literal wording (handoff triggered, not guessed) but is a real,
  named upgrade still to do.

### 1.5 — Static catalog / FAQ grounding
- **Goal:** the bot can answer "what do you sell / what's the price / what's
  your return policy" from a document Ahmed maintains, without inventing
  answers.
- **Depends on:** 1.1.
- **Ships:** a searchable catalog/FAQ document the bot consults before
  answering. **Not** live stock — that's version 2.
- **Built from DeskcommCRM:** `agent/search-knowledge.ts` pattern (did not
  qualify for direct extraction — DB-coupled) — the *shape* (grounding tool
  + "don't invent what you didn't find" discipline) was re-implemented from
  scratch in this project's own way: plain-markdown file + keyword search,
  no embeddings/semantic search — that's genuinely more machinery than a
  single-shop catalog needs right now.
- **Done — starter `catalog.md` at the project root:** placeholder sections
  for "What we sell," "Return policy," and "Delivery info," each clearly
  marked as an example for Ahmed to replace with his real content. One
  `##` heading = one answerable topic; the search tool matches per-section,
  not against the whole file. Re-read from disk on every query — Ahmed can
  edit it live, no restart needed.
- **Done — new `src/catalog.ts`:** `parseCatalog()` splits the file into
  `{title, body}` sections; `findBestMatch()` scores each section against
  the query's keywords (a short built-in stopword list strips filler like
  "the/is/you" — domain words like "price"/"return"/"delivery" are
  deliberately kept). Title matches are weighted 3x body matches — needed
  after a real bug (below) showed plain presence-matching wasn't enough.
- **Done — 6th tool, `search_catalog`, in `src/tools.ts`:** takes a `query`
  string, returns `{found: true, title, content}` on a match. On no match,
  returns `{found: false, instruction: "...don't guess..."}` — never lets
  the model fall back to inventing an answer. Explicitly scoped separate
  from `check_stock` (live quantity) in both its description and the system
  prompt, which also now tells the model to use it for general questions and
  never guess when it comes back empty.
- **Bug found and fixed during verification:** the first scoring pass
  treated every keyword hit as equal, so a query like "how long does
  delivery take" tied between the *Delivery info* section and the *Return
  policy* section (whose body happens to mention "delivery" once, in "within
  7 days of delivery") — and the tie-break silently picked whichever section
  came first in the file, the wrong one. Fixed by weighting a keyword match
  in the section's own title far higher than an incidental match in some
  other section's body. Left in this log because it's a real example of why
  "simple keyword matching" still needs a real test, not just a glance at
  the code.
- **Verified (2026-09-02), local-only — no WAHA/WhatsApp API calls made, not
  needed for this task:** a manual test script (`npx tsx`, deleted after
  running) confirmed: a return-policy question finds the *Return policy*
  section; a delivery question finds *Delivery info* (post-fix); "what do
  you sell" finds *What we sell*; an out-of-scope question ("do you accept
  bitcoin payments") correctly returns `found: false` with the
  don't-guess instruction; an empty query is rejected. `npx tsc --noEmit`
  passes clean.
- **Definition of done:** ask about something in the document — correct
  answer (✅ verified for all three starter sections, both locally and now
  live — see below); ask about something not in it — bot says it'll
  confirm, never guesses (✅ verified at the tool level and now live too).
- **2026-09-05 — live-verified against the real number, the last of this
  sub-version's own two test cases (see the §8 tally note further below for
  where this leaves Version 1 as a whole):**
  1. **Covered question — ✅ PASS.** Real customer asked *"Could u tell me,
     that how many ways do I return something if it doesn't fit"* → real
     reply: *"Agar size fit na aaye, toh aap item delivery ke 7 days ke
     andar return kar sakte hain, shart ye hai ke wo unworn ho aur tags
     sath hon. Refund aapke original payment method mein 5 business days ke
     andar mil jata hai!"* — matches `catalog.md`'s Return policy section
     exactly (7 days, unworn + tags, 5-business-day refund to original
     method), just phrased naturally in Roman Urdu/English per the system
     prompt's style instruction.
  2. **Uncovered question — ✅ PASS.** Same customer asked *"Do I have any
     physical store somewhere so that I can visit to it or no it is online
     only?"* — nothing in `catalog.md` covers a physical location. Real
     reply: *"Bhai, physical store ke baray mein main Ahmed bhai se confirm
     karke aapko batata hoon!"* — no invented answer. `handoff_ledger`
     confirms `notify_owner` fired with reason *"Customer is asking if we
     have a physical store they can visit or if it's online only. Need
     Ahmed's confirmation on our store status/address."*
  - **A real deployment gap surfaced along the way, fixed during this same
    test, not a bug in the grounding logic itself:** the first attempt at
    both questions was silently vetoed by pacing — reason logged as
    `fora da janela de envio (7h-22h, UTC)` — even though it was ~9:30am in
    Karachi (inside the window). Root cause: the running `tsx src/server.ts`
    process had been started *before* the 2026-09-05 `PACING_TIMEZONE`
    default fix (`56f4d8d`) was committed — `PACING_DEFAULTS.timezone` is
    read from `process.env` once at process start, so the live process kept
    the old `UTC` default in memory even after the fix landed on disk and
    was pushed. Per the veto-fallback guard's own (correct) design, the
    fallback send was skipped for both, since it was a pure pacing veto —
    so both test messages initially got a silent handoff instead of a
    reply, and only sending both again *after restarting the process*
    produced the PASS results above. **Lesson for this project, not just
    this bug:** a config/env default fix isn't actually live until the
    running process is restarted — worth remembering for any future
    knob change, not just this one.
  - **Content caveat, true as of this test (2026-09-02/05), resolved later
    2026-09-05 — see the dated entry directly below:** `catalog.md`'s three
    sections were still the placeholder text ("Example entry — replace with
    your real product lineup," etc.), not Ahmed's actual policies, when
    this live test ran. The test proved the *mechanism* (answer correctly
    from the document; deflect instead of inventing when not covered)
    works end-to-end against the real number — that proof holds regardless
    of content. Filling in real content was a content task for Ahmed, not
    a code task, and never blocked anything.
- **Done (2026-09-05) — real content written in, replacing the
  placeholder entirely:** Ahmed provided real product lineup (shirts,
  kurtas, trousers — sizes, price ranges), payment methods (COD, bank
  transfer, Easypaisa, JazzCash), delivery (nationwide, free, 3-5 business
  days), and return/exchange policy (7-day window, unworn + tags
  condition). Written in as 8 `##` sections — one topic each, matching
  this file's own established convention. **One editorial call made and
  explained to Ahmed before acting on it, not silently:** his draft also
  included four sections that were instructions *to the assistant*
  ("Discounts," "Product Information Rules," "When Information Is
  Missing," "Catalog Maintenance"), not customer-facing content. Kept as
  `##` headings, `search_catalog` would have made them independently
  matchable — a customer's message keyword-matching "Discounts" could have
  gotten back raw text like *"The assistant must not invent, promise, or
  authorize a discount..."* verbatim, which would read as broken to a real
  customer. All four describe behavior the code already enforces
  elsewhere (the discount threshold is a hard check in
  `discount-rules.ts`; "don't guess, confirm with Ahmed" is exactly what
  `search_catalog`'s `found:false` path already does) — so dropping them
  as searchable sections loses no actual behavior, only a duplicate,
  riskier description of it.
  - **Verified directly against the real (unmocked) `catalog.ts` code:**
    parsed into exactly the 8 intended sections, none of the four dropped
    meta-sections leaked through; 8 realistic customer questions (shirts,
    kurtas, trousers, return policy, exchange policy, payment method,
    delivery, general "what do you sell") each correctly matched their own
    section; a discount question and a physical-store question both
    correctly matched nothing, falling through to the guardrail/handoff
    path rather than ever surfacing the dropped meta-text. No server
    restart needed — `catalog.ts` re-reads the file from disk on every
    query, exactly as designed since 1.5's original build. Scratch script
    deleted after use.
- **Status:** ✅ Done, and now the one sub-version in this file with full
  live proof against the real number, both cases, *and* real content
  replacing the placeholder — verified directly. Catalog file, search
  tool, and the don't-invent-an-answer discipline are all built and
  verified locally, live, and now with Ahmed's actual catalog content in
  place. No known gaps remain in this sub-version.

**v1 exit criteria:** a customer can message the number any time, get a
fast, safe, on-brand reply that remembers them. No orders, stock, or
payments exist yet.

---

## Version 1 — final status (2026-09-05)

**Version 1 is complete.** All five sub-versions (1.1-1.5) are built, and
every one of CLAUDE.md §8's 9 Definition-of-Done items has been checked
against the real number, not assumed. This section is the single,
authoritative breakdown — if anything above in 1.1 through 1.5 seems to say
otherwise, it's dated history the entries themselves point forward from,
not a live contradiction; this section is what to trust for current status.

This file has walked back two premature "done" claims before today (see
§0's history note). What's different this time: every remaining §8 item
was actually tested — against the real number where the item concerns
customer-facing behavior, directly against real code where the item is
about server-side validation a live model call can't reliably reproduce —
and two of them (burst-message throttling, and the discount-guardrail
interaction with memory recall) were found genuinely **failing**, not just
untested, when actually checked. Both were fixed and re-verified before
being marked done. Nothing here was declared complete on inspection alone.

### The 9 §8 items, each with what actually verified it

1. **A real WhatsApp message produces a real reply.** Live, 2026-09-04 — an
   unsolicited "Hi" from a real WhatsApp Business account (`923299144863`,
   "The Style Vault") got a correct, on-brand, Roman Urdu/English reply,
   confirmed via WAHA's own message log. Reconfirmed continuously through
   all of 2026-09-05's testing.
2. **Crash-and-retry produces no duplicate reply.** Live, 2026-09-04 — the
   app was killed the instant a real turn started, auto-restarted in ~7s,
   WAHA redelivered the webhook, and exactly one reply went out (confirmed
   via WAHA's log, not an app-side line). **Caveat, still open:** this only
   proves the crash-before-any-send-attempt case; the narrower race — a
   crash after `sendToCustomer()` succeeds but before `send_ledger` is
   marked `'sent'` — is a millisecond window that can't be hit reliably by
   killing a process by hand, and remains genuinely untested.
3. **A malformed/unexpected tool call doesn't crash a turn.** Direct,
   2026-09-05 — 35 deliberately bad calls across all 7 tools (wrong types,
   negative/zero/`NaN`/`Infinity` numbers, missing fields, a nonexistent
   `product_id`, an unknown tool name), every one returning a clean
   `{ok:false,...}`, never a crash, no partial DB writes. **Plus live,**
   same day — a real customer's order for a nonexistent product ID 42
   produced no crash; the model read the tool's real rejection and
   escalated to Ahmed on its own.
4. **A fact told in one conversation is recalled correctly days later.**
   Live, 2026-09-05 — a real customer's 20%-discount request from the day
   before was recalled with the exact right figure, ~24 hours and several
   unrelated conversations later. **Caveat, still open:** this customer's
   whole history is still under the raw 20-message window `agent.ts` loads
   per turn, so this proves recall across a real day boundary but not that
   it survives a fact aging out of that raw window entirely (which would
   isolate the structured `customer_notes`/checkpoint system as the actual
   source).
5. **A burst of messages visibly throttles/spaces out; outside-hours
   messages queue instead of firing immediately.** Both halves live-verified
   2026-09-05, after the concurrent-load half was found genuinely broken:
   outside-hours queuing passed a clean direct test (7/7 checks — window
   boundaries, a real `nextAllowedAt` instead of silent refusal); but a
   burst under real concurrent load initially blew straight through the
   1200ms throttle (5 concurrent sends landing within ~230ms of each other,
   confirmed both directly and live — a real customer's 4 messages produced
   3 replies within 142ms of each other). Root cause: `send_message` read
   pacing state, decided a wait, slept, then wrote its send, with no
   serialization — concurrent turns could all read the same stale state
   before any of them committed. **Fixed** with `withSendLock()`, an
   in-process promise-chain mutex serializing the whole guarded-send
   critical section, and **re-verified both directly** (gaps now
   1256-1961ms) **and live** (a real burst produced replies spaced
   1321-2839ms apart).
6. **An unauthorized discount is refused, not granted.** Live, 2026-09-04 —
   a real 20%-discount request got `notify_owner` called first, then a
   reply declining and deferring to Ahmed, no discount granted. Live again,
   2026-09-05, after the discount-guardrail fix (below) — a real fresh
   15%-discount request was correctly deflected to Ahmed.
7. **A genuinely out-of-scope question triggers a handoff, not a guess.**
   Live, 2026-09-03 — two unrelated real senders (job-interview spam) both
   correctly got `notify_owner` called instead of a guessed answer. Live
   again with the physical-store question, 2026-09-05 (see item 8).
8. **Catalog/FAQ: correct answer when covered, "I'll confirm and get back"
   when not, never invented.** Live, 2026-09-05 — a real return-policy
   question got the exact catalog answer; a real physical-store question
   (not in the catalog) got a deflection to Ahmed, no invented answer.
   **Caveat, not a code gap, resolved 2026-09-05:** at the time of this
   test, `catalog.md`'s content was still placeholder text ("Example
   entry — replace with your real product lineup," etc.) — the mechanism
   was proven correct regardless. Real content (products, sizes, prices,
   payment methods, delivery, return/exchange policy) has since been
   written in by Ahmed; see 1.5's own dated entry for the content update
   and its verification.
9. **The tracker accurately reflects all of the above, no stale "not
   started"/contradicting markers left behind.** This is what today's
   full read-through and correction pass (2026-09-05) was for — every
   status line, caveat, and cross-reference in 1.1 through 1.5 was checked
   against current reality and corrected where it had drifted (several had
   — see the inline corrections throughout 1.1-1.4 above). This section
   itself is the closing move that satisfies this item.

### Every real bug found and fixed along the way

- **Gemini free-tier quota exhaustion** (2026-09-04) — quota scoped per
  project, not per key; fixed by switching models (`gemini-flash-lite-latest`).
- **Missing `thoughtSignature` on multi-turn tool calls** (2026-09-04) —
  the new model rejected tool exchanges that didn't echo it back; fixed in
  `llm.ts`.
- **LID-addressed contacts silently failed to send** (2026-09-04) — WAHA's
  privacy-ID JIDs weren't resolved to the real phone-number JID; fixed in
  `waha.ts` by reading `_data.key.remoteJidAlt`.
- **The group-message JID gap** — the group-chat filter only checked the
  original `from` JID, but a LID contact's resolved `remoteJidAlt` could
  itself be a group JID, risking a message being routed as a customer reply
  when it was really a group message; fixed by re-checking the *resolved*
  JID for `@g.us` too, and rejecting an unresolvable/empty phone outright.
- **The silent no-reply gap** (2026-09-04) — a turn could end cleanly with
  zero customer reply and zero log trace when the model produced only text
  without calling `send_message`; fixed with a permanent warning log, a
  guaranteed fallback reply, and a real `notify_owner` handoff.
- **The same gap, widened** (2026-09-05) — `send_message` could be *called*
  but vetoed every attempt (pacing/spinning/discount/promise), which is
  exactly as silent from the customer's side; the guard now tracks whether
  a send actually *succeeded*, not just whether it was attempted, with one
  deliberate exception (a pure pacing veto skips the redundant fallback,
  since retrying hits the identical wall).
- **Millisecond-precision bug in the anti-ban throttle** (2026-09-04) —
  SQLite's `datetime('now')` only stored whole seconds, letting the real
  enforced gap between sends land under the configured floor; fixed by
  giving `messages.created_at` millisecond precision.
- **The `PACING_TIMEZONE` bug** (2026-09-05) — defaulted to `UTC` as a
  placeholder; fixed to `Asia/Karachi`, Ahmed's confirmed real shop
  timezone, once known.
- **The discount-guardrail false positive on memory recall** (2026-09-05)
  — a plain regex proximity check couldn't distinguish the bot *offering* a
  discount from *recalling* that the customer asked for one in the past,
  blocking a real recall with the same reason a real unauthorized offer
  gets; fixed by requiring both a grounded, already-known percentage *and*
  retrospective language near the match, neither alone being sufficient.
- **The burst-throttling concurrency race** (2026-09-05) — described in
  item 5 above; fixed with `withSendLock()`.
- **The Node v24 native-module crash** (first surfaced 2026-09-04,
  recurred during today's own testing, and recurred again during 2.5's
  local testing in a separate worktree — same known issue every time, not
  a new one, folded in here rather than logged separately) — a random,
  load-independent assertion crash in `better-sqlite3`'s native bindings on
  process cleanup. **Explicitly NOT fixed, only mitigated** — a dev-only
  shell auto-restart loop (not part of the committed project) recovers
  within ~1-2s of a crash; the actual Node 24 / native-binding
  incompatibility has never been touched. **This is not resolved by
  Version 1 completion, nor by any Version 2 work since** — do not read
  anything above as implying otherwise.

### Resolved operational configuration defect (2026-09-15)

The number was repeatedly reported as day 0 because `getPacingState()`
hardcoded `numberActivatedAt: null`; this was one shared stale assumption,
not a genuinely new number. Fixed with the persistent, gitignored
`PACING_NUMBER_ACTIVATED_ON=2026-09-04`, interpreted as a local calendar date
in `Asia/Karachi`. On 2026-09-15 that is age 11, selecting the existing
8–14-day **100/day** stage. The 1.2–2.0-second throttle, 7h–22h window,
Sunday setting, and fail-closed 20/day behavior for a missing/invalid date
remain active. Both customer replies and owner/alert sends use the same
shared decision function; nothing bypasses anti-ban pacing.

### Explicitly carried forward, unresolved — Version 1 completion does not mean any of these are fixed

- **Per-number health circuit** (`health/defaults.ts`) — staged in
  `EXTRACTED-FOR-AHMED/`, never pulled in; no current requirement forced it
  yet.
- **STOP/opt-out handling** — not built.
- **A real async job queue for outside-hours retry** — a message outside
  the sending window correctly does not fire immediately, but nothing
  auto-fires it later on its own either; that needs genuinely new
  infrastructure, not a wiring task.
- **WAHA retained-message replay on application restart (observed live
  2026-09-27 and again 2026-09-29; revised prevention locally verified,
  live restart still pending)** —
  starting the webhook consumer while the existing WAHA session was active
  replayed older personal-message events into the app. In the 92-second window
  before the app was stopped, the database gained 261 message rows (239
  inbound, 22 outbound), 2 customer rows, 2 handoffs, 2 sent owner-alert
  records, and 16 sent-ledger rows; orders and ledger remained unchanged.
  Gemini was simultaneously returning quota-limit 429s. After explicit owner
  approval, only rows created inside the verified replay window were removed
  in one transaction: all counts returned to the pre-replay baseline (39
  customers, 578 messages, 2 orders, 4 ledger entries, 12 owner alerts),
  `integrity_check` returned `ok`, and `foreign_key_check` returned zero
  violations. A gitignored pre-cleanup backup remains at
  `backups/ahmed-post-replay-20260927-1837.db`; external WhatsApp sends cannot
  be undone.

  The first prevention implementation put WAHA's stable message id in a
  durable `inbound_events` ledger before both agent paths and compared WAHA's
  original Unix timestamp with a one-time rollout cutoff. Deterministic tests
  passed, but the 2026-09-29 live restart disproved the assumption that a
  one-time cutoff was sufficient: WAHA replayed messages created while the app
  was offline *after* the 2026-09-27 cutoff. The app was stopped immediately.
  That attempt added 22 inbound message rows, 1 outbound row, 2 customers, 1
  send-ledger row, and 19 inbound-event rows; orders, ledger, handoffs, and
  owner alerts did not change. Database integrity remained `ok` with zero
  foreign-key violations. After explicit owner approval, exactly those 23
  message rows, 2 customer rows, 1 send-ledger row, and 19 inbound-event rows
  were removed in one transaction; legitimate September 27 records were
  preserved. Post-cleanup counts were 39 customers, 582 messages, 2 orders, 4
  ledger entries, 101 send-ledger rows, and 2 completed inbound events, with
  integrity still `ok` and zero foreign-key violations. A gitignored
  post-incident backup is at
  `backups/ahmed-post-replay-20260929-0919.db`; any external WhatsApp send
  cannot be undone. Gemini also returned quota-limit 429s during this attempt.

  The revised guard now advances the durable cutoff to every application
  startup second (never backward), so messages accumulated while the webhook
  consumer was offline are quarantined even when their ids were never seen.
  Existing failed or abandoned claims older than the new startup boundary are
  also converted to `ignored_historical` instead of retrying. Duplicate,
  missing-id, missing-timestamp, implausibly-future, and genuinely failed
  same-process retry handling remains fail-closed; configured timestamps still
  require `Z` or an explicit offset. All 49 deterministic core tests plus the
  pacing and owner-alert suites, type-check, and build pass. This revised
  prevention is **locally verified and partially live-verified**. After the
  cleanup, a controlled restart advanced the cutoff to
  `2026-09-29T04:32:33Z` without changing any business-table count. A direct
  old WAHA-shaped webhook was acknowledged as `ignored_historical` and created
  no customer/message row, after which its synthetic audit row was removed. A
  real owner message and five distinct real customer messages each completed
  once with `attempt_count = 1`; the customer path quoted the real Rs.800
  product price and then created order `#41` exactly once. Gemini worked with
  the replacement key. The application is running. What remains unproven is
  an actual future WAHA reconnect delivering a retained backlog and having
  every such event visibly quarantined; do not relabel that narrower provider
  replay proof as complete until it is observed live.
- **`notify_owner` handoff delivery is no longer log-only in the current
  build** — Version 3.3 now records a durable, retry-deduplicated owner alert
  and sends it through the configured owner-number WhatsApp path. This is
  now locally and live-verified; the historical Version 1 behavior described
  above remains accurate for the version at that time.
- ~~`catalog.md`'s content is still placeholder text~~ — **resolved
  2026-09-05**, later the same day this list was written: Ahmed provided
  real product/payment/delivery/return/exchange content, written in and
  verified directly (see 1.5's own dated entry). No longer an open item.
- **1.1's and 1.2's own caveats above** (the send-then-crash-before-ledger
  race; recall not yet proven to survive falling out of the raw
  20-message window) remain open, narrower edge cases within otherwise-
  passing items.

The pattern that got Version 1 here — build it, mock-test it locally, then
prove it against the real number before crossing it off, fixing whatever
that proof finds broken rather than softening the finding — is the same
pattern future versions should keep following.

---

## Version 2 — "The assistant keeps the books"

**Genuinely new schema and logic — DeskcommCRM has nothing shaped like
this.** Confirmed by the extraction pass: zero files in `lib/agent-engine/`
model a retail order/ledger. At the end of v2, every order and payment
discussed in a normal conversation is correctly recorded with zero manual
data entry — but Ahmed still can't ask the bot about it; that's v3.

**Final live-verification pass (2026-09-14): ✅ PASS.** Real WhatsApp
messages exercised the normal customer path end to end: a grounded stock
lookup returned the real 20-unit/Rs.800 value; order #29 recorded two units
at the catalog price (not the customer's incorrect quoted price), created
one Rs.1600 debit, confirmed and reserved stock 20→18; a real Rs.1600
payment created one credit and moved the order to paid; an attempted
backward paid→confirmed transition was rejected without changing order,
stock, or ledger; pre-shipping cancellation restored stock 18→20 and wrote
the traceable debit-reversal credit; order #30 then recorded/confirmed one
unit and left stock at 19. For 2.5, order #30 was temporarily backdated,
the real pending-followup query found it, and Ahmed's real owner-number
question correctly reported its Rs.800 **store credit** rather than saying
the customer owed Rs.800; the timestamp was restored exactly afterward.

The live pass found and fixed four real integration defects before this
version was closed: Gemini rejected array-valued tool results until the LLM
seam wrapped them in a Struct-compatible object; a reconnect replay exposed
that newsletter/community JIDs were being treated as customer phones, so
the WAHA adapter now accepts only personal-chat JIDs and fails closed on an
unresolved LID; the owner follow-up tool exposed a signed balance without
semantics and the model inverted store credit, so it now emits an explicit
`account_position`; and a crash/redelivery could repeat `record_order` or
`record_payment`, so WAHA message IDs now key an atomic
`bookkeeping_receipts` row committed in the same transaction as the effect.
The last fix was first reproduced (one event created two orders/two debits),
then verified fixed: the retry returned the original order ID and left one
effect, while a distinct provider event still created a distinct order.
Final verification: typecheck passed, permanent suite 39/39, complete V2
flow passed, and all temporary scripts/rows were removed. The recurring
Node v24/`better-sqlite3` native crash occurred repeatedly during this pass;
the restart loop recovered, so it remains **mitigated, not fixed**.

### 2.1 — Retail data model
- **Goal:** a place to put the facts of a sale.
- **Depends on:** 1.1.
- **Verified before starting, not assumed (2026-09-05):** confirmed via
  `git status` (clean) and direct inspection of `db/schema.sql`/`tools.ts`
  that 2.1 had not already been touched — `orders.status` was still never
  updated past `'placed'` (hardcoded at insert, no other write site
  anywhere in `src/`), `customers.balance_owed` was still a single mutated
  field (3 read/write sites, all in `tools.ts`), and the live dev DB had
  zero real order/nonzero-balance rows to migrate (checked directly) —
  so no data-migration risk going in.
- **Done (2026-09-05) — real ledger, replacing `balance_owed` entirely:**
  new `ledger` table (`db/schema.sql`) — one row per debit (an order
  placed) or credit (a payment) event, `amount >= 0` with direction from
  `kind`, `order_id` nullable (a payment isn't always tied to one specific
  order). New `src/ledger.ts`: `recordDebit`, `recordCredit`, `getBalance`
  (sums the ledger, never trusts a stored number). `customers.balance_owed`
  is fully **removed** from the schema, not just deprecated — an
  `alter table ... drop column` migration in `src/db.ts` drops it from an
  already-existing dev database on startup (guarded, idempotent, same
  `ensureColumn`-sibling pattern already used for `disclosure_sent_at`).
  `tools.ts`'s `record_order`/`record_payment`/`get_customer_balance` all
  rewired to the ledger; external tool contracts (input/output shape)
  unchanged, so this is invisible to the model.
- **Done (2026-09-05) — order-status forward-only state machine, bundled
  into this same session per explicit instruction (this is 2.2's own core
  mechanism — see 2.2's note below for what's still separately open
  there):** new `src/orders.ts` — `placed → confirmed → paid → shipped →
  delivered`, or `cancelled` (only before shipping; `delivered` and
  `cancelled` are both terminal). Retail vocabulary throughout, never the
  B2B funnel vocabulary — permanent exclusion, CLAUDE.md §6.
  `lead-state.ts` didn't qualify for extraction (DB-coupled, confirmed
  against `MANIFEST.md`'s rejected list before writing a line of this) —
  re-implemented from scratch, not ported. A pure `checkOrderStatusTransition`
  (no DB) plus a DB-backed `transitionOrderStatus` (reads the real current
  status, validates, writes only on success, never throws) — same
  teaching-text-error discipline as every tool in `tools.ts`. `orders.status`
  also gained a DB-level `CHECK` constraint listing the full enum, as a
  backstop against a bad direct `UPDATE` bypassing the state machine
  function — not the primary gate, just defense in depth, matching this
  schema's own existing convention (`messages.direction` already has one).
  SQLite can't add a `CHECK` constraint to an existing table via `ALTER
  TABLE`, only the standard create-new/copy/drop-old/rename dance — done in
  `src/db.ts`, guarded so it only runs once (detects the new constraint in
  the table's own stored `CREATE TABLE` text) and copies any existing rows
  rather than assuming the table is empty (it happened to be, but the
  migration doesn't rely on that).
- **Verified locally, deterministically — 28 checks, all real (unmocked)
  code, run directly against the actual dev database (backed up first,
  confirmed history-intact after — 29 customers/367 messages/21
  checkpoints/18 notes/22 handoffs, all unchanged):** migration sanity
  (column really dropped, constraint really present, ledger table exists);
  insert-then-query-back for a product/order/payment; balance correctly
  reflects a debit then a partial credit (1500 → 900), reconstructed by
  hand-summing raw ledger rows and confirmed to match `getBalance()`
  exactly; the full valid forward chain (`placed → confirmed → paid →
  shipped → delivered`); four different invalid-transition shapes rejected
  cleanly (backward, skipping a state, cancelling after shipping, moving
  out of a terminal state) — none of them crashed, all returned a
  teaching-text error; a nonexistent `order_id` rejected the same way; the
  pure and DB-backed functions agree; both new `CHECK` constraints
  independently confirmed as real backstops (a raw invalid `UPDATE` and a
  raw negative-amount `INSERT` both actually throw); two customers'
  balances confirmed isolated from each other. The live server was stopped
  before running the migration against the real dev DB (it was still
  running old code that reads `balance_owed` directly — running the
  migration underneath it risked a crash on the next real message) and
  restarted afterward with the new code. Scratch script and its test
  rows/product deleted after use.
- **Not done here, deliberately, per explicit scope for this session —
  since resolved, see 2.2's own section:** no new AI-facing tool exposed
  order-status transitions to the model as of this session; that wiring
  was 2.2's own remaining work, and `update_order_status` was built there
  the same day. Whether/how to live-test the full flow against real
  messages is still a separate decision, not yet made (see 2.2/2.4).
- **Built from DeskcommCRM:** nothing for the ledger — no analog exists
  anywhere in the module, confirmed during extraction. The order-status
  *mechanism* re-implements `agent/lead-state.ts`'s pattern (did not
  qualify for extraction — DB-coupled) with retail vocabulary; see above.
- **Definition of done:** can insert a product, an order, and a payment and
  query them back correctly (✅ verified above) — with balance always
  reconstructable from ledger history rather than trusted as a single
  field (✅ verified above); an invalid status transition is rejected (✅
  verified above, four different shapes).
- **Status:** ✅ Done and live-verified — the ledger, payment path,
  cancellation reversal, and customer balance were exercised through real
  WhatsApp orders #29/#30 in the 2026-09-14 final pass above. Crash/retry
  bookkeeping is additionally protected and deterministically verified by
  the atomic provider-event receipt described in that pass.
  **Correction, 2026-09-05, found while building 3.2:** the ledger debit
  `record_order` writes at creation was never reversed when an order was
  later cancelled — `get_customer_balance` would have silently overstated
  what a customer owed for anyone with a cancelled order. Fixed in
  `orders.ts`'s `transitionOrderStatus` (see 3.2's own dated entry for the
  full story and verification) — this file's balance-reconstruction
  guarantee now actually holds for the cancelled-order case too, not just
  the ones tested in 2.1's own original 28 checks.

### 2.2 — Order-status tracking
- **Goal:** every order has a clear, queryable status that only moves
  forward.
- **Depends on:** 2.1.
- **Ships:** `received → confirmed → paid → shipped → delivered`, with
  invalid transitions rejected via a teaching error. **Naming note:** built
  as `placed → confirmed → paid → shipped → delivered` instead of
  `received → ...` — `placed` was already `orders.status`'s existing
  default value from before 2.1/2.2 existed, so keeping it avoided a
  gratuitous rename; same state machine either way.
- **Done (2026-09-05), bundled into 2.1's own session per explicit
  instruction — the core mechanism itself, see 2.1's dated entry for the
  full verification:** `src/orders.ts`'s forward-only state machine
  (`checkOrderStatusTransition` + `transitionOrderStatus`) plus the DB
  `CHECK` constraint backstop. Deterministically verified: the full valid
  forward chain, four different invalid-transition shapes correctly
  rejected, cancellation allowed before shipping and blocked after, both
  terminal states (`delivered`, `cancelled`) confirmed to allow nothing
  further.
- **Verified before starting this half, not assumed (2026-09-05):**
  confirmed via `git status` (clean) and a direct grep across `src/` that
  no tool imported `transitionOrderStatus`/`checkOrderStatusTransition` and
  `baseTools` had no order-status entry — the state machine from 2.1's
  session genuinely had no conversational path yet. Also re-confirmed
  `get_customer_balance` already read the ledger (2.1's own work) with zero
  remaining direct `balance_owed` reads anywhere in `src/` — nothing left
  to build there, only to re-verify (see below).
- **Done (2026-09-05) — the conversational-wiring half, closing this
  sub-version out completely:** new `update_order_status` tool
  (`src/tools.ts`), added to `baseTools` and mentioned in the system
  prompt (`agent.ts`), same "wide schema for the model, strict validation
  server-side" discipline as every other tool here — the JSON-schema
  `enum` on `status` is a hint for the model, not the gate; `execute()`
  re-validates the type, checks the order actually exists, checks it
  belongs to *this* customer (same data-isolation precedent as
  `get_customer_note`), then calls the real `transitionOrderStatus()`
  from 2.1 — no separate/duplicate enforcement logic, this tool is a thin
  wrapper around the same state machine already verified. Attempting to
  set status back to `'placed'` is rejected too, with no special-casing
  needed — `orders.ts`'s own `ALLOWED_TRANSITIONS` never lists it as a
  valid target for any current state, so the existing state machine
  already covers it. **Current authority correction (2026-09-29):** the
  customer-facing tool is now deliberately limited to `confirmed` and
  pre-shipping `cancelled`; customers cannot mark orders paid, shipped, or
  delivered. The core state machine independently enforces the same ownership
  and actor permissions instead of trusting only the tool wrapper.
- **Historical verification (2026-09-05) — 21 checks, all through the real
  tool (not calling `orders.ts` directly this time), real DB:** the tool is
  actually reachable via `baseTools`; 6 different malformed-input shapes
  (missing fields, wrong types, a made-up status, attempting `'placed'` as
  a target) all rejected cleanly, no crash; a nonexistent `order_id`
  rejected with a teaching error; **a different customer cannot transition
  another customer's order** (rejected, and the order's real status
  confirmed unchanged afterward — data isolation actually holds, not just
  assumed); the full valid forward chain through the tool
  (`confirmed → paid → shipped → delivered`); skipping a step and
  cancelling after shipping both still correctly rejected through the
  tool; cancellation before shipping still succeeds through the tool;
  `get_customer_balance` re-confirmed to reflect the ledger correctly
  across two orders and a payment (1500 − 300 = 1200); re-confirmed
  `customers` still has no `balance_owed` column to accidentally read.
  Scratch script and its test rows/product deleted after use. The live
  server was restarted afterward so it's running the new tool (not yet
  live-tested against a real conversation — that's still a separate,
  not-yet-made decision, same as 2.1 left it).
- **Production-hardening correction (2026-09-29) — durable actor/source
  history, built and locally verified:** new `order_status_events` rows record
  `from_status`, `to_status`, actor type, optional actor customer, source,
  source-event key, evidence, and timestamp. New orders record their initial
  `placed` state in the same transaction as the order and debit. Every later
  transition records its event in the existing `IMMEDIATE` transaction with
  status, stock, and cancellation-ledger effects. Existing orders were not
  backfilled because their historical actors/evidence cannot be reconstructed
  truthfully. `transitionOrderStatus()` now fails closed without valid audit
  context and enforces actor scope: customers can confirm/cancel only their
  own order; payment providers can mark only paid; couriers can mark only
  shipped/delivered; system actors cannot advance status. No new owner,
  courier, provider, or CRM-facing mutation tool was exposed by this slice.
- **Current deterministic proof:** permanent suite 64/64, dedicated order
  suite 8/8, typecheck/build, pacing/alert suites, and the complete Version 2
  flow all passed. Tests prove missing context, cross-customer access, and
  wrong-actor transitions fail without a state/event write; the full permitted
  customer → provider → courier chain records complete evidence; an audit
  failure rolls back status/stock; and an initial-audit failure rolls back both
  order and debit. This is server-side authorization/atomicity, so controlled
  direct verification is the reliable proof; a live model cannot force the
  provider/courier branches on demand.
- **Built from DeskcommCRM:** the *mechanism* in `agent/lead-state.ts`
  (forward-only, model-driven, server-validated state machine) — did not
  qualify for direct extraction (DB-coupled), but the pattern is simple
  enough to re-implement with retail vocabulary instead of B2B funnel
  vocabulary. This vocabulary swap is permanent — never revert to the
  funnel shape (see permanent exclusions).
- **Definition of done:** the customer bot can confirm or cancel its own order,
  while trusted future owner/provider/courier callers must supply explicit
  actor/source/evidence and are limited to their permitted transitions (✅
  built and verified); every successful creation/transition is durably audited
  in the same transaction as its business effects (✅ built and verified); a
  query for "orders in status X" returns
  correctly (⚪ trivially true given the schema — a plain `select * from
  orders where status = ?`, not separately built as its own tool since
  nothing yet asks for it); an invalid backward transition is rejected (✅
  verified, both directly in 2.1 and now through the real tool above).
- **Status:** ✅ Original 2.2 flow remains live-verified from the 2026-09-14
  pass. The safer customer permission boundary is live-verified through the
  2026-09-29 payment-claim pass; the new actor/source audit persistence and
  atomic rollback guarantees are locally/deterministically verified, not
  mislabeled as separately live-verified.

### 2.3 — Automatic order & payment-claim extraction
- **Goal:** "20 shirts, medium, black, ₹5000" becomes a real order row
  without Ahmed typing anything. A customer's payment statement becomes a
  pending claim for Ahmed to verify—never proof of payment—and the turn-close
  safety net catches either kind of missed tool call.
- **Depends on:** 2.1, 2.2.
- **Verified before starting, not assumed (2026-09-05):** the *primary*
  path ("20 shirts... becomes a real order row") was already covered by
  2.1/2.2's mid-turn model tools. At that time they were `record_order` and
  `record_payment`, so 2.3's genuinely new work was the safety net for an
  event mentioned but not explicitly logged. **Current behavior replaces the
  customer-facing `record_payment` tool with `claim_payment`; the internal
  legacy primitive remains only for deterministic regression tests and is not
  model-reachable.**
- **Done (2026-09-05) — the safety net, at turn CLOSE (the same forced
  second model call that already produces the checkpoint summary and
  notes, per this file's own established pattern):** the CLOSE prompt
  (`agent.ts`) now also asks the model to report, in the same JSON, an
  `unlogged_order`/`unlogged_payment` — but **only** if it has NOT already
  called `record_order`/`claim_payment` this same turn. Two shapes: (1)
  `confident: true` with structured `items`/`amount` — used only when the
  model already knows the real `product_id` from calling `check_stock`
  earlier in this same turn; (2) `confident: false` with a plain-text
  `description` — used whenever it's not sure of exact numbers.
  **Deterministic gate, not the model's self-report:** whether the safety
  net acts at all is decided by `toolsCalledThisTurn` — real bookkeeping
  from the turn's own tool-call loop, already tracked for the silent-no-
  reply guard (1.3) — not by trusting the model's claim that it "forgot."
  A real `record_order`/`claim_payment` call this turn always wins; the
  safety net is skipped entirely regardless of what the CLOSE step says,
  so a real call can never get double-logged.
  - **"Never guess a number into the books," the explicit instruction from
    this file's own "New work" line below, actually enforced:** `confident:
    true` items are re-validated through the exact same
    `validateOrderItems()` checks used by `record_order` (factored into
    shared exported functions in `tools.ts`, so the safety net cannot drift).
    A confident payment amount must be finite and positive, then
    `createPaymentClaim()` applies the same claim validation and idempotency as
    `claim_payment`. Only a genuinely valid, confident order report is written
    to `orders`/`ledger`; payment reports are written to `payment_claims` only.
    Anything else — `confident: false`, or `confident: true` but the
    validation actually fails (e.g. a nonexistent `product_id`) — becomes a
    `handoff_ledger` row instead (via a new shared `recordHandoff()`,
    factored out of `notify_owner`'s own code, same "NEEDS AHMED" log
    marker), for Ahmed to confirm by hand. Payment statements with a valid
    positive amount create a `payment_claims` row and durable owner alert;
    they never write a ledger credit. Nothing is ever silently lost,
    and nothing is ever silently invented.
  - **Scope, stated plainly:** this safety net only catches a miss *within
    the same turn* — e.g. the model looked up a product via `check_stock`
    but never got around to calling `record_order` before the turn ended.
    It does not (and structurally cannot yet) recover an order mentioned
    in an *earlier* turn and only confirmed later — tool-call results
    aren't persisted across turns (only the raw text transcript and the
    checkpoint/notes are), so there's no reliable way for a later turn to
    know a specific `product_id` from an earlier one. That's a real,
    separate gap (a proper order-lookup tool would close it), not
    something this session solved.
- **Verified locally and deterministically:** the original safety-net checks
  proved a real `record_order` call cannot be duplicated by the CLOSE step;
  a valid missed order creates one order and debit; uncertain or invalid
  order reports hand off without booking; an empty/malformed CLOSE shape has
  no financial side effect and does not crash the turn. Those checks use the
  real `agent.ts`/`tools.ts`/database code with only the model response
  controlled, because a live model cannot reliably be forced to omit a tool
  call. **The current 2026-10-05 security regression replaces the older direct
  owner-resolution design:** the customer tool menu exposes `claim_payment`,
  not `record_payment`; customer and safety-net payment statements create one
  idempotent pending claim with no credit; customers cannot mark
  paid/shipped/delivered; and Gemini has no approve/reject mutation tool in the
  customer or owner toolset. To approve, the authenticated owner must use an
  exact claim ID plus the transaction reference independently checked in the
  business payment account, then repeat that same reference in a second exact
  confirmation within ten minutes. The owner-supplied verification is stored
  separately from untrusted customer wording, globally unique, and immutable.
  Natural language, list positions, vague
  yes/no replies, contradictory wording, expired confirmations, weak
  customer-written evidence, duplicate references, zero balances, and amounts
  above the authoritative outstanding balance all fail closed. A confirmed
  approval creates one linked credit, rejection creates none, and reversal
  preserves the original approval while adding one linked compensating debit.
- **Built from DeskcommCRM:** the *pattern* of `inbound-turn.ts`'s
  checkpoint-close call (forced second model call, strict-validated JSON,
  persisted) — steered from extracting commitments/objections to extracting
  order/payment fields.
- **Definition of done:** a normal order conversation end to end produces an
  order and debit matching what was agreed; a payment statement is preserved
  exactly once as a pending claim, cannot alter trusted financial/fulfilment
  state, and can be credited exactly once only after explicit owner approval;
  the safety net catches a missed order or claim without duplicating a primary
  tool call.
- **Status:** Order extraction remains complete and live-verified. Payment-claim
  creation was live-verified previously, but the old natural-language owner
  resolution route is superseded and must not be described as current proof.
  The 2026-10-05 deterministic resolution is **built and locally verified**:
  all 27 isolated test files pass across 31 declared areas, including nine
  focused resolution/reversal checks; typecheck and build pass. Before touching
  real financial state, a verified SQLite backup was created at
  `backups/operations/ahmed-backup-2026-10-05T05-18-10-431Z.db` (integrity
  `ok`, zero foreign-key violations, SHA-256
  `C2F63F83394A8F97832101E5459330971CDB26D58AC2EAD8AF14F8040C6D7B0B`).
  The accidental claim #4 approval was then linked to its exact original
  Rs800 credit (ledger #128) and reversed with exactly one compensating debit
  (ledger #129); the affected balance changed from Rs800 store credit to Rs0,
  one append-only reversal event exists, and pending claims #3 and #5 were
  untouched. After real claim #6 exposed the missing-reference dead end, the
  reference-bound owner workflow was added. Before its additive migration, the
  stopped database was backed up at
  `backups/operations/ahmed-pre-owner-verified-reference-20261005-1010Z.db`
  (integrity `ok`, zero foreign-key violations, SHA-256
  `9F67CA85D88679EDA11E2E7F8D8CE82A61FA6AE78A5A2106CF5FA535D3F2191A`).
  Post-migration integrity is `ok`; claim #6 remains pending with zero credit
  and no verification row. A fresh real WhatsApp reference-bound
  prepare/confirm acceptance check remains pending; do not relabel this new
  owner workflow live-verified yet.

### 2.4 — Live stock-aware replies
- **Goal:** "do you have 20 in stock" gets a real, current answer, and a
  completed order actually decrements stock.
- **Depends on:** 2.1.
- **Verified before starting, not assumed (2026-09-05):** re-read
  `check_stock` (already queried the real `products.stock` column, nothing
  stale about it — `select *` on every call, no caching) and confirmed via
  `grep` that no code anywhere wrote to `products.stock` — 2.1's ledger and
  2.2's order-status tool both existed, but neither touched stock yet.
- **Done (2026-09-05) — stock decrement/restore, living in `orders.ts`'s
  `transitionOrderStatus()` itself, not in the tool that calls it:** put
  here deliberately rather than in `tools.ts`'s `update_order_status`, so
  the side effect holds for any future caller of the state machine, not
  just today's one tool. Confirming an order (`placed → confirmed`)
  decrements each line item's product stock by its ordered qty. Cancelling
  an order that had already reserved stock — cancelled from `"confirmed"`
  or `"paid"`, not from `"placed"` (nothing was reserved yet at `placed`)
  — restores it. **Double-decrement/double-restore is ruled out by the
  state machine's own guarantees, not a separate "already adjusted" flag:**
  `"confirmed"` is reachable via exactly one edge per order
  (`placed → confirmed` — no other state lists it as a valid target, so a
  second "confirm" attempt is rejected by `checkOrderStatusTransition`
  before the stock-adjustment code ever runs), and `"cancelled"` is
  terminal (nothing transitions out of it), so each order can decrement at
  most once and restore at most once, for free, from 2.1's own design.
  **Current correction, 2026-09-29 — atomic stock reservation is built and
  locally verified as a separate production-hardening slice:** the historical
  implementation described above updated order status and then adjusted stock
  blindly, so concurrent confirmations could oversell and a later failing line
  could leave partial changes. `transitionOrderStatus()` now acquires an
  SQLite `IMMEDIATE` transaction before reading status, aggregates duplicate
  product lines, and reserves with
  `update products set stock = stock - ? where id = ? and stock >= ?`. If any
  product is missing or short, the whole transition rolls back and returns the
  requested/available quantities; status, every product, and ledger remain
  unchanged. Confirmation, cancellation restoration, cancellation credit, and
  status now commit atomically. Database triggers reject direct negative-stock
  inserts/updates. Deterministic proof covers over-stock rejection, two orders
  competing for the final unit (one confirmed, one still placed), multi-item
  rollback, a forced cancellation-ledger failure that rolls back status and
  stock restoration, and the database backstop. The full result is 54/54 core tests,
  pacing and owner-alert suites, type-check/build, the complete Version 2 flow,
  and the separate 8-test order suite passing. This correction is **locally
  verified**; the earlier ordinary stock decrement/restore remains
  live-verified. **Live insufficient-stock confirmation, 2026-09-29:** with
  product `#3` at stock 18, a real customer requested 20 medium black hoodies.
  The assistant honestly replied that only 18 were available; orders remained
  3, ledger rows remained 5, stock remained 18, and the inbound event completed
  once with `attempt_count = 1`. This live result proves the normal
  customer-facing refusal; the simultaneous-final-unit and forced rollback
  invariants remain appropriately deterministic tests rather than a claimed
  WhatsApp concurrency reproduction.
- **Verified locally, deterministically — 23 checks, real (unmocked)
  `tools.ts`/`orders.ts` code, real DB:** placing an order alone (status
  `placed`) never touches stock; confirming decrements by the exact ordered
  qty, and `check_stock` (the real tool, not a raw query) reflects the drop
  immediately; a second "confirm" attempt on an already-confirmed order is
  rejected by the state machine and stock is confirmed unchanged (the
  double-decrement guarantee actually holds, not just in theory);
  cancelling after confirmed fully restores stock, `check_stock` reflects
  the restore too; cancelling an already-cancelled order is rejected and
  stock isn't double-restored; cancelling straight from `placed` correctly
  leaves stock untouched (nothing to restore); restoring also verified from
  a `paid → cancelled` cancellation, not just `confirmed → cancelled`;
  cancelling a shipped order is rejected (2.1/2.2's own guarantee) and
  stock is confirmed unaffected by the rejected attempt; a multi-item order
  correctly decrements/restores each product's own quantity independently.
  Scratch script and test rows/products deleted after use; live server
  restarted with the new code afterward (no schema change this time — the
  `stock` column already existed — so it wasn't stopped first, same as
  2.3's session).
- **Built from DeskcommCRM:** the *tool pattern* from
  `agent/search-knowledge.ts` — steered from document search to a live
  quantity query (this was already done, pre-2.4; the decrement/restore
  logic itself has no DeskcommCRM analog).
- **Definition of done:** stock check for a low/out item gives the real
  number (✅ already true, reconfirmed above); completing an order drops
  stock by the right amount (✅ verified above — "completing" here means
  reaching `confirmed`, which is where reservation actually happens
  operationally, not `delivered`; restoring on a pre-shipping cancellation
  was in this same session's explicit scope too and is verified above).
- **Status:** ✅ Done and live-verified — a real stock question returned the
  current value, order confirmation decremented the exact quantity, and a
  real pre-shipping cancellation restored it without double-adjustment in
  the 2026-09-14 pass. **Note, 2026-09-05:** the same
  `transitionOrderStatus` function this sub-version's stock logic lives in
  was corrected while building 3.2 (a separate, ledger-side bug — the
  reversal-on-cancel fix, see 2.1's and 3.2's own entries) — re-verified
  directly that this sub-version's own stock-restore behavior still fires
  correctly and was not regressed by that fix.
  **Production inventory-onboarding correction, built and locally verified
  2026-09-29:** products now support stable case-insensitive SKU, category,
  active/inactive state, aliases, and timestamps without changing existing IDs
  or historical order references. The new CSV importer validates the entire
  file before one atomic upsert transaction, previews unless `--apply` is
  explicitly supplied, updates repeated SKUs in place, normalizes size aliases
  (`M` → `medium`), hides inactive variants from both stock search and new-order
  validation, and reports catalog-only/database-only/unclassified categories.
  Strict quoted-field parsing, malformed-row all-or-nothing behavior, database
  constraints, preview non-mutation, re-import identity, alias lookup, and
  inactive filtering are deterministic tests; the permanent suite passes
  72/72 plus build, pacing/alerts, and the complete Version 2 flow. A verified
  backup preceded the compatible schema addition. The real database still
  contains only the preserved temporary hoodie (now explicitly reported as
  unclassified); the example CSV was previewed and **not applied**. Therefore
  the onboarding mechanism is built and locally verified, while real inventory
  import and any resulting live WhatsApp verification remain pending an
  owner-approved CSV.

### 2.5 — Follow-up tracking tied to unpaid orders
- **Goal:** the system knows which customers still owe money or are waiting
  on something, ready for Ahmed to ask about in v3.
- **Depends on:** 2.1, 2.3.
- **Ships:** follow-ups linked to real order/payment state, plus a query
  path over pending/overdue ones — an **owner-initiated read path**, not
  just the bot silently acting on schedules. Important distinction: "kisko
  follow-up karna hai?" is Ahmed *querying* what's pending — that's a
  separate tool from the one that fires reminders automatically.
- **Done (2026-09-05), built in a separate worktree while main progressed
  through 2.4, then reviewed and merged from this session:** new
  `src/followups.ts` — `getPendingFollowups(now?)`, a pure query (no stored
  `follow_ups` table, no background job) over real `orders`/`customers`
  state: an order counts as pending once it's been `'placed'` or
  `'confirmed'` (i.e. short of `'paid'`) for 2+ days, flagged `overdue`
  past 7. Deliberately **derived, not stored** — 2.1's forward-only state
  machine is already the single source of truth for "is this order still
  unpaid," so a separate table tracking the same fact could only drift out
  of sync or silently stop updating; there's no real job queue yet either
  (see the carried-forward Version 1 gaps), so a background-firing design
  wasn't an option regardless. Each result includes the customer's real
  ledger balance (`getBalance()`, customer-wide — matching how the ledger
  itself already works, not order-scoped) for context alongside that
  specific unpaid order. `now` is injectable, same discipline as
  `decidePacing()` in 1.3, so tests don't depend on the wall clock.
  **Deliberately does not ship, per its own explicit scope:** no tool
  fires a reminder or pushes anything to Ahmed on its own — that's the
  whole "owner-initiated query, not the bot auto-firing" distinction this
  sub-version is named for. Wiring this into something Ahmed can actually
  ask over WhatsApp needs a sender-identity check to tell him apart from a
  customer, which is Version 3.1's job (CLAUDE.md §3/§6), not this one's —
  this ships only the underlying query capability.
- **Process note, since this was the first sub-version built outside this
  session:** found with no test artifacts on disk when this session picked
  it up — re-verified from scratch here (didn't just trust the other
  session's unseen report) rather than committing on faith. Reviewed the
  diff (one new file, zero overlap with 2.4's `orders.ts` changes,
  confirmed before merging), ran 15 deterministic checks against the real
  function in that worktree's own isolated DB, then committed on its own
  branch and merged into `main` with no conflicts.
- **Verified locally, deterministically — 15 checks:** an empty DB
  correctly returns nothing; an order under the 2-day window correctly
  doesn't appear yet; one past it (still `'placed'`) correctly appears,
  correctly not yet `overdue`, with roughly correct `days_since_placed`;
  a `'confirmed'` (still-unpaid) order counts too, correctly flagged
  `overdue` past 7 days; `'paid'`/`'shipped'`/`'delivered'`/`'cancelled'`
  orders never appear regardless of age (even 30 days); multiple
  customers' pending orders sort most-overdue-first; `balance_owed`
  matches the real ledger sum, not a stale/order-scoped number; phone/name
  join in correctly from `customers`. Scratch script and test rows deleted
  after use.
- **Built from DeskcommCRM:** `cron/schedule.ts` (pure scheduling math, no
  I/O) was extracted and staged for the firing side — **not used here**,
  since this sub-version deliberately ships only the read/query path, no
  firing mechanism at all (see "Deliberately does not ship" above); it
  remains staged in `EXTRACTED-FOR-AHMED/` for whenever a real firing path
  is actually built. The read/query path itself has no DeskcommCRM
  equivalent — DeskcommCRM's version only fires automatically, it never
  exposes a "list what's scheduled" query. That was new work either way.
- **Definition of done:** an unpaid order automatically has a follow-up
  associated with it (✅ verified above — "associated with it" here means
  correctly derivable via the query, per this sub-version's own
  deliberately-derived-not-stored design); a query for "pending
  follow-ups" returns it correctly (✅ verified above, including sorting
  and the overdue flag).
- **Status:** ✅ Done and live-verified — the derived query found the
  temporarily aged real order #30, and the owner-only WhatsApp path reported
  it correctly, including the customer's Rs.800 store-credit direction.
  The test timestamp was restored exactly afterward (2026-09-14).

**v2 exit criteria:** every order and payment that happens in conversation
is correctly recorded, stock is accurate, and follow-ups are tracked
against real unpaid orders — invisible to Ahmed until v3.

---

## Version 3 — "Ahmed can just ask"

**At the end of v3, all four of Ahmed's original promises are met. This is
the MVP-complete milestone.**

### 3.1 — Owner recognition & dedicated owner turn
- **Goal:** the system knows when the sender is Ahmed himself, not a
  customer, and switches modes.
- **Depends on:** version 1 complete (✅ satisfied).
- **Built under the 2026-09-05 exception** (CLAUDE.md §3 — Version 2's own
  live verification was still pending; this is deliberate, not scope drift,
  see that section for the full reasoning and boundary).
- **Verified before starting, not assumed (2026-09-05):** confirmed via
  `git status` (clean) and a `grep` across `src/` for "owner"-related logic
  that no sender-identity check or distinct turn kind existed anywhere yet
  — only unrelated "owner" mentions (the human-promise guardrail's
  language, a comment in `followups.ts`).
- **Done (2026-09-05) — sender-identity check:** new `src/owner.ts`,
  `isOwnerPhone(phone, ownerPhone?)`. Reads `AHMED_OWNER_PHONE` once at
  module load (same idiom as `PACING_DEFAULTS`), normalizes both sides the
  same way WAHA's own adapter already normalizes every inbound phone
  (digits only), and — critically — **fails closed**: if
  `AHMED_OWNER_PHONE` isn't configured, no phone number is ever recognized
  as the owner, matching this project's existing fail-closed convention
  (`warmupCapFor` treats an unknown number's age as the most conservative
  step, never "no cap"). **Not yet configured in this environment on
  purpose** — same judgment call as `PACING_TIMEZONE` before Ahmed's real
  shop timezone was known: don't guess a real value, leave it unset (safe,
  fail-closed) until Ahmed's actual number is confirmed.
- **Done (2026-09-05) — the owner turn itself:** new `runOwnerTurn()` in
  `agent.ts`, routed to from `server.ts`'s webhook handler based purely on
  `isOwnerPhone()` — the ONLY place this decision is made, checked before
  either turn kind runs, never by message content. Modeled on the
  restricted-turn-kind *concept* from `agent/operator-turn.ts` (a turn kind
  with restricted permissions) — not the Operator/Conversador dual-agent-
  role *split* itself, which stays permanently excluded (CLAUDE.md §6);
  `operator-turn.ts` didn't qualify for extraction anyway (DB-coupled).
  Deliberately minimal, matching this sub-version's own "the owner-turn
  kind itself, full stop": its own system prompt, its own `send_message`
  tool, and **no other tools yet** (3.2 adds the real analytics tools) —
  no checkpoint, no `customer_notes`, no discount/human-promise/spinning
  guardrails, none of which are customer-conversation concepts.
  **Deliberately reused, not skipped:** `withSendLock` + `decidePacing`
  against the same shared `messages` history — anti-ban pacing protects
  the one shared *number*, not any one conversation, so a message to Ahmed
  is still an outbound send from that same number; skipping pacing here
  would have quietly reopened the exact regression Version 1's "no
  possibility of the number getting banned" guarantee was built to close.
  Ahmed's own identity still gets an ordinary row in `customers` (same
  `getOrCreateCustomer`) purely so pacing state can see owner sends too —
  which turn *kind* runs is decided entirely by `isOwnerPhone()`, never by
  a row merely existing.
- **Owner-path reliability status, updated 2026-09-15:** live 3.2 testing
  reproduced the silent-no-reply case: Gemini called the report tool, then
  returned its final answer as ordinary text instead of calling
  `send_message`; the webhook returned 200 while Ahmed received nothing.
  **Fixed** in `runOwnerTurn()` by tracking the final assistant text and
  sending it through the same paced owner-send tool when the model made no
  `send_message` call. A focused injected-model test reproduced that exact
  tool-result-then-text sequence, and the subsequent real `sales_today`
  message delivered the correct reply. **Still not fixed:** owner sends do
  not yet use the customer's durable send-ledger idempotency. A crash around
  an owner send can still theoretically duplicate or drop that reply.
- **Verified locally, deterministically — 19 checks across 3 scripts (split
  for the same Windows/Node 24/better-sqlite3 native-crash flakiness
  already on record — not a defect in this code):** exact match, "+"/spaced
  formatting, a different number, and an empty phone all behave correctly;
  **fail-closed confirmed directly** — with no owner number configured,
  even the "right" number and an empty phone are both rejected, never a
  false match; three routing scenarios including a customer phone asking
  an overtly owner-style question ("What were sales today?") all route
  correctly — proving content never drives routing, only the phone number
  does. Through the real `runOwnerTurn()`: an identity row is created for
  pacing purposes but **no checkpoint and no `customer_notes` are ever
  written** for it; the model attempting an unavailable customer-only tool
  (`record_order`) fails gracefully, no crash, and the turn continues. A
  genuinely useful accident of timing: today's *real* daily send cap was
  still exhausted during this test (the same cap this whole session is
  waiting to reset for the live order-flow test) — so this incidentally
  proved, against real current state, that the owner turn's reused pacing
  check actually blocks a send for real, logs nothing fake, and doesn't
  crash, rather than only being verified against a mocked-allow condition.
  Finally, confirmed the exact same question from a real customer phone
  still produces a real checkpoint (proving it took the distinct customer
  code path, regardless of the shared cap state). Scratch scripts and test
  rows deleted after use. Live server restarted with the new code
  (`AHMED_OWNER_PHONE` deliberately left unset, so tonight's planned
  customer-flow live test is unaffected).
- **Built from DeskcommCRM:** the *concept* proven by
  `agent/operator-turn.ts` — a turn kind with restricted permissions —
  steered, not reused code (did not qualify for extraction: DB-coupled, and
  even if it had, it's the wrong direction — see permanent exclusions on
  the Operator/Conversador split itself).
- **Definition of done:** message the bot from Ahmed's own number vs. a test
  customer number — provably different behavior (✅ verified above,
  deterministically), with no way for a customer message to trigger
  owner-mode answers (✅ verified above, including the adversarial case of
  an owner-style question from a customer number).
- **Status:** ✅ Done and live-verified (re-verified 2026-09-15) — owner
  routing was first proved with the confirmed number ending 3460. When that
  number became unavailable, `AHMED_OWNER_PHONE` was deliberately replaced
  with the newly confirmed number ending 2409; a real greeting and the live
  `top_selling_product` question both routed through the owner turn. Other
  senders remain customer turns regardless of whether their text says
  "Ahmed here." The silent text-only reply failure is fixed as described
  above; owner send-ledger idempotency remains an explicit open gap.

### 3.2 — Owner analytics Q&A tools
- **Goal:** Ahmed's four example questions all work, in his own words.
- **Depends on:** 3.1 (✅ complete/live-verified) and version 2
  (✅ complete/live-verified as of 2026-09-14). The original build happened
  under the documented 2026-09-05 early-start exception; that dependency is
  now fully satisfied.
- **Verified before starting, not assumed (2026-09-05):** `git status`
  clean, `grep` across `src/` for the four function names found only my
  own 3.1-era comment naming them as future work — nothing built yet.
  Also checked the dev database directly before seeding any test data:
  `orders`/`ledger` were both completely empty (every scratch row from
  2.1-2.4's own testing had been cleaned up afterward, per this file's own
  convention) — flagged to the user rather than assuming stale "seeded
  data" existed, then seeded a fresh, realistic scenario for this test on
  their explicit instruction.
- **Done (2026-09-05):** new `src/analytics.ts` — `getSalesToday(now?)`
  (sum of non-cancelled order totals placed today, Ahmed's shop timezone,
  `now` injectable same as `getPendingFollowups`), `getUnpaidCustomers()`
  (every customer with a real positive ledger balance — reuses
  `getBalance()` per candidate rather than re-deriving the debit/credit
  math a second time, so it can never drift from what
  `get_customer_balance` itself reports), `getTopSellingProduct()` (most
  units sold across all non-cancelled orders, all time, ties broken by
  lowest `product_id` for determinism). `pending_followups` is **not**
  reimplemented — it's 2.5's own `getPendingFollowups()`, wired in
  directly, one source of truth. All four exposed as new owner-only tools
  (`tools.ts`'s `ownerTools`), reachable only from `runOwnerTurn()` (3.1) —
  a customer can never see these regardless of phrasing, because reaching
  this tool list at all already required `isOwnerPhone()` to say yes.
  Deliberately a small, fixed, explicitly-named set — never a
  freely-written query handed to the model, exactly the risk naming each
  one avoids.
- **A real correctness bug found and fixed along the way, touching
  already-merged 2.1/2.4 code, not just this sub-version — flagged to the
  user and fixed only after explicit confirmation, not silently:**
  building `unpaid_customers`' test data surfaced that `record_order`
  writes its ledger debit immediately at creation (`'placed'`), but
  `transitionOrderStatus` (2.1, stock side effects added in 2.4) never
  reversed that debit on cancellation — only stock was ever restored. A
  cancelled order would silently keep counting as money owed, forever,
  in both `get_customer_balance` (2.1) and this new `unpaid_customers`.
  **Fixed** in `orders.ts`: cancelling now also issues a ledger credit for
  the order's total, reversing it — unconditional on `next === 'cancelled'`
  (unlike the stock branch, which only fires if stock was actually
  reserved), since the debit always exists by the time an order can be
  cancelled at all, regardless of which status it's cancelled from.
  `ledger.ts`'s `recordCredit()` gained an optional `orderId` parameter
  (default `null`, preserving existing payment behavior) so this reversal
  is traceable back to the order it reverses, not flattened to "a payment
  from somewhere." **Re-verified 2.4's own stock-restore side effect still
  fires correctly alongside the new ledger one** — this fix did not
  regress it.
- **Verified locally, deterministically — 16 checks across 2 scripts, real
  (unmocked) `analytics.ts`/`orders.ts`/`ledger.ts` code, a realistic
  hand-computed seeded scenario (3 customers, 3 products, 5 orders
  spanning today/yesterday/10-days-ago and placed/confirmed/paid/cancelled
  statuses):** `sales_today` correctly totals only today's non-cancelled
  orders (excludes yesterday's and the cancelled one); `top_selling_product`
  correctly picks the real best-seller by units, with the cancelled
  order's units correctly excluded from the tally, verified separately
  against an isolated exact-tie scenario proving the tie-break really
  compares `product_id` (not just "whichever the tally iterates to first"
  — the losing product's order was deliberately inserted *first* to rule
  that out) and that no-orders-at-all correctly returns `null`;
  `unpaid_customers` correctly includes only the two customers who
  actually still owe money, sorted highest-first, with the customer whose
  only order was cancelled correctly excluded entirely (the bug-fix
  proof); `pending_followups` (via the tool wrapper) correctly includes
  the genuinely old unpaid order and excludes a same-day one, a paid one,
  and the cancelled one. The real cancellation call itself, and the
  ledger-reversal credit it produced, were both asserted directly, not
  assumed. Scratch scripts and all seeded rows deleted after use. Live
  server restarted with the fixed `orders.ts` (this also affects the
  customer-facing `update_order_status` tool from 2.2, so it mattered to
  redeploy promptly, not just for this sub-version).
- **Built from DeskcommCRM:** nothing — confirmed during extraction that no
  agent-callable analytics tool exists anywhere in the module. DeskcommCRM's
  numbers live in React dashboard code with hand-written SQL, not as
  anything an agent can call. This is the most distinctive, fully original
  part of the whole project.
- **Definition of done:** each of Ahmed's four example questions, asked in
  natural language (including Roman Urdu/Hindi phrasing), gets a correct
  answer sourced from real data (✅ locally verified against hand-checked
  expectations and now live-verified through real WhatsApp messages).
- **Status:** ✅ Done and live-verified (2026-09-15). The four real owner
  questions and verified answers were: `pending_followups` — order #30 and
  Rs.800 store credit; `sales_today` — Rs.0 with no order today;
  `unpaid_customers` — no positive customer balance; and
  `top_selling_product` — product #3, one unit and Rs.800 revenue. The first
  live sales attempt exposed the owner text-only no-reply bug documented in
  3.1; it was fixed and the same question then passed live. Docker/WAHA
  dropped the unpaid question while its gateway was being recovered, so the
  latest verified WhatsApp message was replayed exactly once through the
  real webhook after confirming it had no prior DB receipt; its live reply
  reached the owner and matched the ledger. The owner number was then
  changed from the unavailable 3460 number to the newly confirmed 2409
  number, and the top-product question passed through that new owner route.
  The earlier cancellation ledger-reversal bug found while building 3.2
  remains fixed and covered by the existing deterministic checks.

### 3.3 — WhatsApp-delivered alerts
- **Goal:** things Ahmed should know about reach him without opening
  anything.
- **Depends on:** 3.1.
- **Ships:** system alerts delivered as a WhatsApp message instead of a
  dashboard notification.
- **Built from DeskcommCRM:** the dedup/accumulation *logic* of
  `agent_inbox_items` (one open alert per kind, no flooding) — steered from
  "render as a dashboard row" to "send as a WhatsApp message." Did not
  qualify for direct extraction (DB-coupled); reimplement the dedup logic,
  it's simple.
- **Definition of done:** trigger a condition that should alert Ahmed — he
  receives exactly one WhatsApp message, not a flood of duplicates on retry.
- **Built (2026-09-15):** `notify_owner`, customer reply-failure alerts, and
  the Version 2.3 unlogged-order/unlogged-payment safety-net handoffs now
  create durable `owner_alerts` records before attempting delivery to the
  configured `AHMED_OWNER_PHONE`. Stable provider-event keys are recorded in
  `owner_alert_events`, so a successfully delivered event is not sent again
  on an ordinary webhook retry. A partial unique index permits only one
  pending alert per kind; another condition of the same kind accumulates on
  that row while delivery is pending instead of creating a parallel flood.
  Alert sends reuse the existing shared send lock and pacing decision, and
  successful alert texts are recorded in the same outbound `messages`
  history as every other send from the one WhatsApp number. A narrow
  Version-3.3-only retry worker checks durable pending owner alerts once per
  minute, including immediately at server startup, so a pacing veto or
  temporary WAHA failure does not strand the alert; this is not the general
  customer-message async queue that remains explicitly unbuilt.
- **Locally verified (2026-09-15):** a real SQLite-backed regression check
  proved first delivery, same-event retry suppression (one send total), a
  simulated gateway failure remaining pending, recovery by the automatic
  pending-alert retry path without a new event, and two pending alerts of one
  kind grouping into one delivered WhatsApp body. The permanent suite is
  39/39 green plus this new alert regression check. The test transaction
  explicitly hides and then restores genuine live pending alerts so a mock
  can never mark production work delivered. The older Version 2 end-to-end
  runner could not complete on this
  pass because the then-unresolved Node v24/`better-sqlite3` native crash
  recurred. That historical failure was subsequently fixed by the runtime
  dependency correction recorded in §0's current-status section.
- **Precise remaining caveat:** like the pre-existing customer and owner send
  paths, an unavoidable crash in the tiny interval after WAHA accepts the
  message but before SQLite marks the alert `sent` can still duplicate it on
  retry; no provider-side idempotency key exists in the current WAHA adapter.
  Ordinary retries after the successful local status write are deduplicated.
- **Pacing root cause fixed and live verification completed (2026-09-15):**
  `getPacingState()` had
  exactly one hardcoded `numberActivatedAt: null`; both customer and owner
  sends consumed it, keeping the shared number on day 0 forever. New
  `PACING_NUMBER_ACTIVATED_ON` parsing treats `YYYY-MM-DD` as midnight in
  `PACING_TIMEZONE` using local calendar-day age. Missing, malformed,
  impossible, or timezone-invalid values return `null` and retain the safest
  20/day stage. The conservative, tracker-proven first-live-use date
  2026-09-04 gives age 11 on 2026-09-15 and therefore the existing 100/day
  stage—not an unlimited bypass. A new shared configured-decision function is
  called by both customer `send_message` and owner/alert `send_message`; the
  deterministic regression proved send 21 is allowed but waits the remaining
  throttle interval, while send 101 is vetoed. `.env.example` documents the
  settings, `npm run dev` loads a local gitignored `.env`, and the live `.env`
  now persists the owner, WAHA/model credentials, timezone, and activation
  date across application restarts without committing any secret.
- **Existing-alert proof, not a fresh substitute:** restarting the live worker
  with that configuration caused the already-existing real alert #1 to move
  from `pending` to `sent` at 2026-09-15 13:02:02 UTC (18:02 Karachi). The
  alert remained occurrence count 1; the owner conversation for the confirmed
  number ending 2409 gained one matching outbound row, and WAHA's real chat
  history independently showed exactly one copy of the same alert. App root
  returned the expected HTTP 404 and WAHA `/ping` returned pong afterward.
  A second deliberate worker restart loaded the same `.env`, returned on a
  new process ID, kept alert #1 `sent`, and left the matching outbound count
  at exactly one. This satisfies persistent configuration, real
  customer-triggered delivery, and retry-dedup DoD.
- **Verification detail:** typecheck passed; the original permanent suite
  passed 39/39; the activation-date/shared-pacing and durable-alert suites
  passed separately. The combined command was interrupted after the original
  39 checks by the then-unresolved Node v24/`better-sqlite3` native cleanup
  assertion before the later files ran, so those were rerun independently.
  The native crash was subsequently fixed and stress-verified as recorded in
  §0's current runtime reliability status.
- **Status:** ✅ Done and live-verified (2026-09-15). Exactly one real WhatsApp
  alert reached the owner number ending 2409, sourced from the pre-existing
  customer-triggered pending record; no duplicate was sent.

**v3 exit criteria:** all four promises in `ahmed-whatsapp-assistant.md` are
fully met.

---

## Real-business hardening — fulfilment capture and explicit confirmation (not Version 4)

This is production-hardening work from
`docs/REAL_BUSINESS_PRODUCTION_READINESS.md`, separate from Ahmed's completed
Versions 1–3 and explicitly **not Version 4**.

- **Built (2026-09-29):** the customer model can no longer call the older
  immediate `record_order` tool. It receives `prepare_order` and
  `confirm_order` instead. Preparation requires recipient name, a validated
  Pakistani mobile number (`03XXXXXXXXX` or `+923XXXXXXXXX`), complete address,
  city, and one of COD, bank
  transfer, Easypaisa, or JazzCash; postal code and delivery instructions are
  optional. Product prices and the fixed free-delivery charge are controlled
  by the server.
- **Confirmation boundary:** preparation writes one durable draft but no
  order, ledger entry, or stock change. A different, stable provider message
  from the same customer must explicitly confirm the summary. The server
  parses that real inbound text, rejects same-message prepare/confirm, and
  rechecks current catalog price and stock. Success atomically creates the
  fulfilment-bearing order, debit and audit records, advances the order to
  `confirmed`, and reserves stock. A webhook retry resolves to the same order.
  The turn-close model summary is no longer allowed to bypass this boundary.
- **Schema/backup:** orders gained nullable fulfilment columns so historical
  rows are not assigned invented data; new orders from this flow fill every
  required field. `order_drafts` stores the durable confirmation boundary.
  Before applying the additive schema change, the real database was copied to
  `backups/ahmed-pre-fulfillment-schema-20260929.db`; source and backup
  SHA-256 hashes matched.
- **Locally verified:** 78/78 permanent checks pass, including missing-field
  fail-closed behavior, no draft-time mutation, same-message rejection,
  explicit/negative confirmation parsing, exactly-once confirmation, stored
  fulfilment equality, one debit, one stock reservation, and stale-price
  rollback. Typecheck, build, pacing/alert suites, and the complete Version 2
  end-to-end regression pass.
- **Status:** ✅ **Built, locally verified, and live-verified through real
  WhatsApp (2026-09-29).** This does not make the project ready for a
  paying-client launch:
  real owner-approved inventory is still not imported, and the remaining
  production-readiness blockers stay open.

- **First live attempt found a real reply-integrity bug (2026-09-29), now
  corrected and live-retested:** the server conservatively rejected
  the clear phrase “Confirm bhai,” but the model still sent “order confirm ho
  gaya.” Database inspection caught the mismatch: draft #1 remained awaiting,
  no order/debit existed, and stock stayed 18. The parser now accepts that
  clear imperative, and the outbound choke point independently blocks any
  “order confirmed/booked” success claim unless this exact inbound provider
  event has a matching persisted `confirmed` status event. The false reply is
  not counted as success. Its abandoned test draft was retained in history as
  `superseded`, with no order attached.
- **Successful live proof:** customer ending 9958 first requested the live
  price/stock, then supplied the complete test recipient/contact/address/city
  and COD details. The assistant displayed draft #2 with one black medium
  hoodie at the database price Rs.800, free delivery, and total Rs.800. A
  separate new message, “Confirm,” converted that exact draft into confirmed
  order #55. Database reconciliation proved exactly one order, exactly one
  Rs.800 debit, exactly one confirmed draft linked to it, and exactly two audit
  events (`null → placed` and `placed → confirmed`) carrying the same real
  provider event key. Stock moved once from 18 to 17; the stored fulfilment
  snapshot matched the shown summary; `integrity_check` remained `ok` with no
  foreign-key violations. The real database now has 4 orders and 7 ledger
  rows. The application and WAHA gateway remained running afterward.

## Real-business hardening — deterministic STOP/START consent (not Version 4)

This is another production-hardening slice from
`docs/REAL_BUSINESS_PRODUCTION_READINESS.md`, separate from Versions 1–3 and
explicitly **not Version 4**.

- **Built (2026-09-29):** exact standalone STOP, unsubscribe, and approved
  Roman-Urdu commands are intercepted before Gemini. START and approved resume
  phrases are handled by the same deterministic boundary. State-changing
  commands update durable customer consent fields and append an idempotent
  provider-event-keyed consent record.
- **Outbound enforcement:** the shared customer `send_message` choke point
  refuses every normal automated reply while opted out. Ordinary opted-out
  inbound messages complete without a model call or customer reply. Owner
  turns and owner alerts are unchanged. Only one deterministic consent
  acknowledgement can pass the opt-out block; it still uses aggregate pacing
  and the send ledger.
- **Durable acknowledgement:** a failed/paced acknowledgement remains pending
  and a narrow startup/minute retry attempts it again. Repeated STOP/START that
  does not change state sends nothing again. A newer opposite command
  supersedes an undelivered older acknowledgement, and serialized consent
  handling prevents contradictory acknowledgements from overtaking each other.
- **Backup/schema:** the additive customer consent fields and
  `customer_consent_events` history were applied only after creating
  `backups/ahmed-pre-optout-schema-20260929.db` and verifying its SHA-256
  matched the live database.
- **Locally verified:** 81/81 permanent checks pass, including exact-command
  recognition, false-positive rejection, persistence, idempotency, outbound
  blocking, the narrow acknowledgement override, repeat suppression, START
  re-enable, and stale-acknowledgement supersession. Typecheck, build,
  pacing/alerts, and the complete Version 2 regression pass. The real database
  retained 42 customers, 4 orders, 7 ledger entries, and stock 17; integrity is
  `ok` with no foreign-key violations and no test consent rows.
- **Status:** ✅ **Built and locally verified; real WhatsApp verification is
  pending.** General privacy/retention work remains open: data retention,
  export/deletion procedures, comprehensive log redaction, encrypted/off-host
  backups, access policy, and an approved privacy notice are not completed by
  this STOP/START slice.

---

## Real-business hardening — webhook, payments, handoffs, identity, and privacy (not Version 4)

These are security corrections found during the October 2026 external test
review. They are separate from Ahmed's completed Versions 1–3 and explicitly
**not Version 4**.

- **Correction 1 — webhook authenticity, built and locally/live-config
  verified 2026-10-03:** WAHA now signs the exact raw webhook body with
  SHA-512 HMAC. The Express entry point verifies the configured algorithm and
  signature with a timing-safe comparison before parsing or trusting any
  claimed sender. Missing configuration, missing/malformed signatures, wrong
  algorithms, and modified bodies fail closed with HTTP 401. A valid signed
  probe returns HTTP 200. The application and WAHA container use the same
  verified secret fingerprint; the preserved WhatsApp session is `WORKING`,
  the gateway remains loopback-only, and the old container is retained
  stopped as a rollback copy. The full regression suite passes. **A new real
  customer WhatsApp message has not yet been sent after this rollout, so this
  correction is not yet end-to-end live-verified.**
- **Correction 2 — payment instructions and customer-selected method integrity,
  built and locally verified 2026-10-05; fresh live verification pending:**
  owner-controlled Easypaisa, JazzCash, and bank-transfer fields live only in
  runtime configuration. Missing, partial, or malformed configuration makes
  that method unavailable; COD remains available without account details.
  `get_payment_options` exposes only configured methods, and
  `send_payment_instructions` renders and sends the exact server-controlled
  destination through the existing consent, pacing, idempotency, spinning,
  disclosure, and transcript boundary. The normal `send_message` path rejects
  payment placeholders and payment destinations that did not come from that
  deterministic tool. A real customer test later exposed a separate integrity
  gap: the customer explicitly selected an unconfigured Easypaisa method, but
  the model retried `prepare_order` with COD and the server accepted the
  substitution. The production tool now derives the explicit method directly
  from the current customer message, requires exactly one method, rejects an
  ambiguous or missing selection, and rejects any model-submitted method that
  differs from the customer's selection before writing a draft. A matching but
  unconfigured digital method still fails closed; the model must explain that
  it is unavailable and ask the customer to choose again in a new message.
  Deterministic regression tests reproduce and block the exact Easypaisa-to-COD
  substitution, prove that no draft is written on mismatch/unavailability, and
  prove that a configured matching method is stored unchanged. The 85-check
  core suite and all 27 isolated test files passed across 31 declared areas;
  the production database and sidecar fingerprints were unchanged.
  A subsequent customer-side checkout review found that a reply could begin
  collecting name/contact/address/city while omitting payment method. The final
  outbound boundary now rejects that incomplete checklist and instructs the
  model to call `get_payment_options` and collect exactly one available method.
  The same review tightened delivery-contact validation from a generic digit
  range to the two Pakistani mobile formats above and added a script-consistency
  guard: Roman-Urdu/English customers cannot receive accidental Devanagari
  fragments, while customers who actually write in Devanagari remain
  supported. Order-summary delivery is now deterministic as well: after
  `prepare_order` stores a validated draft, the application—not Gemini—builds
  the complete review from the database product name/variant, server price,
  quantity, server-calculated line totals/subtotal/delivery/total, stored
  fulfilment details, and the preserved payment method. That exact body is
  sent automatically through the protected outbound path, and the model loop
  stops instead of composing a second version. While a draft is pending, the
  final send boundary rejects AI-written, recalculated, shortened, translated,
  or reformatted order summaries; only the exact server-generated body is
  authorized. The displayed contact remains masked, and the summary states
  clearly that the draft is not booked until a later explicit confirmation.
  Deterministic tests prove a model-supplied price is ignored, the database
  price and totals appear in the summary, and an altered summary is blocked.
  The core suite now passes 90/90 checks; all 27 isolated files still pass
  across 31 declared areas, and tests leave the production database and
  sidecar fingerprints unchanged. Fresh end-to-end WhatsApp verification of
  this summary path remains pending.
- **Correction 3 — truthful owner handoff status, built and locally verified
  2026-10-03:** model-written `send_message` replies can no longer claim that a
  screenshot, image, file, or attachment was forwarded; current inbound media
  is not transferred to Ahmed. They also cannot claim that Ahmed viewed,
  checked, verified, approved, or replied to something, or promise that he will
  definitely contact the customer. After `notify_owner`, the model must call
  the deterministic `send_handoff_status` tool. Its exact message is derived
  only from current-turn facts: whether the handoff was recorded and whether
  its WhatsApp alert is `pending` or `sent`. Even a sent alert explicitly says
  the system cannot confirm Ahmed viewed it. Failed alert attempts retain their
  durable pending alert id/status for this truthful reply and the existing
  pending-alert retry worker; no second worker was added.
- **Correction 4 — customer/order identity binding, built and locally verified
  2026-10-03:** every order now has a random 80-bit customer-facing reference
  in the form `ORD-` plus 20 hexadecimal characters. Sequential integer ids
  remain internal foreign keys and are no longer returned by the customer
  confirmation, status, cancellation, or payment-claim paths. The new
  read-only `get_my_order_status` tool queries the public reference and current
  WhatsApp sender's `customer_id` together; a reference owned by another
  sender and a nonexistent reference return the exact same response. If no
  reference is supplied, the tool may return only the current sender's latest
  order. Its response is limited to public reference, authoritative status,
  total, and creation time—no recipient phone, address, customer id, or
  internal order id. Customer cancellation/confirmation and payment-claim
  linking now accept an owned public reference only; a supplied name, phone
  number, delivery contact, or old numeric id is never authorization. Failed
  reference guesses are hashed in a durable audit table and limited to ten per
  WhatsApp customer per 15 minutes.
- **Correction 4 database migration:** before the additive schema change, the
  real database was copied to
  `backups/ahmed-pre-order-identity-20261003-102645.db` and verified with
  `integrity_check=ok`, five orders, and zero foreign-key violations. The live
  database migration backfilled five unique valid public references without
  changing the order count; afterward `integrity_check=ok` and foreign-key
  violations remained zero.
- **Correction 5 — PII minimization, built and locally verified 2026-10-03:**
  the structured logger now redacts sensitive values recursively at its final
  output boundary instead of depending on every call site. Full phone numbers,
  message bodies, names, addresses, emails, account/IBAN values, tokens, and
  secrets are masked or removed from logs. Raw discarded model text is no
  longer logged or copied into reply-failure handoffs, and persisted inbound
  errors are phone/email-redacted. Model-created checkpoint summaries,
  customer notes, handoff reasons, and owner-alert reasons are deterministically
  sanitized before storage. Once an order draft exists, old transcript context
  sent back to the model is sanitized; prepared-order tool results and repeated
  draft context expose only the delivery contact's final four digits. The full
  contact and address remain solely in the authoritative draft/order records
  needed to fulfil that order.
- **Correction 5 database cleanup:** before modifying the real database, the
  consistent source was backed up at
  `backups/ahmed-pre-pii-hardening-final-20261003-104831.db`. The idempotent
  migration minimized exactly one checkpoint and two customer-note rows. Hash
  comparison proved customers, all 816 raw messages, five orders, the ledger,
  and order drafts were unchanged; only the intended derived-memory tables
  changed. Post-migration `integrity_check=ok` and foreign-key violations are
  zero. No message-retention/deletion policy was invented: retention, export,
  and customer deletion remain a separate owner-approved operational decision.
- **Correction 6 — intentional customer inventory visibility, built and
  locally verified 2026-10-03:** exact stock counts remain internal operational
  data. The customer `check_stock` tool now returns an allowlisted public
  product shape containing product reference, SKU, name, category, size,
  color, authoritative public price, and only `in_stock`, `low_stock`, or
  `out_of_stock`. The deliberate low-stock boundary is 1–5 units. When a
  customer requests a quantity, the backend returns only whether that quantity
  can be fulfilled; it does not reveal the remaining count. Invalid quantities
  fail closed. Insufficient-stock errors from both draft confirmation and the
  legacy transition path no longer include the available count. A final
  outbound guard blocks English and Roman-Urdu exact-stock claims even if an
  old transcript or manipulated model tries to repeat one. Internal stock
  arithmetic, atomic reservation, restoration, and owner-side database truth
  remain exact and unchanged; this correction required no database migration.
- **Correction 7 — controlled refund requests, built and locally verified
  2026-10-03:** a customer can now open a durable refund-review case only for
  an order owned by the current WhatsApp identity and only after delivery.
  Orders with a recorded delivery event inside the documented seven-day
  window are marked eligible; older deliveries are rejected, while legacy
  delivered orders without a trustworthy delivery timestamp fail safely into
  manual review. Each case receives a random 80-bit `RFD-` public reference,
  repeated provider events are idempotent, and only one active case may exist
  per order. The customer can read only their own case status. Ahmed receives
  the request through the existing durable owner-alert and retry path, and
  only the authenticated owner toolset can approve or reject it. Approval is
  deliberately recorded as `approved_pending_execution`: this feature never
  transfers money, credits the ledger, or changes order state. A final
  outbound guard blocks the assistant from falsely claiming that a refund was
  processed, sent, credited, or completed.
- **Correction 7 database migration:** before adding the refund-case table,
  the real database was copied to
  `backups/ahmed-pre-refund-cases-20261003-161420.db`; its SHA-256 matched the
  source copy and it passed `integrity_check=ok` with five orders and zero
  foreign-key violations. After applying the additive schema through the
  transactional tests, the real database still has 43 customers, 816
  messages, five orders, and zero refund cases; `integrity_check=ok` and
  foreign-key violations remain zero.
- **Correction 8 — grounded products, policies, and support intent, built and
  locally verified 2026-10-03:** `check_stock` now performs one structured,
  allowlisted search across product/category, normalized size, color, maximum
  budget, and requested quantity. A negative result is explicitly limited to
  the current active catalog and may never be expanded into a claim that Ahmed
  never sells the item. Requested attributes outside the approved schema—such
  as waterproofing or fabric composition—return `needs_owner_confirmation`
  rather than a guessed yes/no. Product rows containing internal markers such
  as temporary, placeholder, or delete-after labels fail closed before any
  customer-visible fields are returned. General business-policy answers now
  require `APPROVED_CATALOG_SHA256` to match the exact current `catalog.md`;
  missing, malformed, or stale approval blocks the answer instead of trusting
  changed Markdown silently. The final outbound boundary also rejects an
  unrelated sales pitch during payment, refund, complaint, cancellation, or
  tracking support while leaving ordinary shopping conversations unaffected.
  This correction changes no database schema. On 2026-10-03, the expanded
  customer catalog was written for owner review, and the one original live
  product row was deliberately cleaned from an internal temporary label to
  `Black Hoodie` / `HD-BLK-M-001` / category `hoodie`, preserving its verified
  Medium size, black color, Rs 800 price, stock 16, active state, primary key,
  and order relationships. Before that mutation, `ahmed.db` was copied to
  `backups/ahmed-pre-catalog-product-cleanup-20261003-164921.db`; its SHA-256
  matched the source, `integrity_check=ok`, and foreign-key violations were
  zero. The updated database also passes both checks.
- **Correction 8 realistic test inventory:** after a second verified backup at
  `backups/ahmed-pre-expanded-test-inventory-20261003-225048.db`, the validated
  CSV importer previewed and then applied 33 active variants: the existing
  hoodie plus eight added groups (shirts, kurtas, trousers, jeans, T-shirts,
  running shoes, sandals, and jackets), each new group having four realistic
  size/color/price/stock variants. The import inserted 32 SKUs and updated the
  existing hoodie by SKU, with zero database-only categories, zero
  catalog-only categories, and zero unclassified products. The live test
  inventory now contains nine groups, 33 active variants, and 278 internal
  units. The customer-facing catalog now has 30 sections and matching product
  ranges; exact stock remains private. Product lookup also normalizes plural
  wording such as shirts, shoes, and jackets. Post-import
  `integrity_check=ok`, foreign-key violations are zero, and all five existing
  orders plus all 816 existing messages remain present.
- **Verification:** 82/82 main checks pass together with pacing, owner-alert,
  webhook-HMAC, six focused payment-instruction checks, and six focused
  handoff-claim checks. Four focused identity tests cover random public
  references, same-number reads, cross-number denial, indistinguishable
  foreign/nonexistent references, absence of PII/internal ids, mutation and
  payment-claim ownership, rejection of numeric ids, latest-own-order lookup,
  and rate limiting. Six focused privacy checks cover phone masking, durable
  memory minimization, recursive log redaction, the recorded one-time cleanup,
  persisted-error redaction, and masked model-visible contact data while
  authoritative fulfilment data is preserved. Typecheck, build, and the
  complete Version 2 database flow pass. Six focused inventory-visibility
  checks cover the three public states, quantity yes/no decisions, the exact
  allowlisted response schema, invalid-quantity rejection, stock-error
  minimization, and the final outbound exact-count block. The Version 2 flow
  separately proves public availability works while exact internal stock,
  reservation, and restoration still reconcile correctly. Six focused refund
  checks cover the seven-day rule, legacy manual review, direct and tool-level
  sender ownership, idempotency, PII sanitization, public references,
  indistinguishable foreign/missing lookups, owner-only decisions, zero
  financial/order side effects, and false-completion blocking. Seven focused
  grounding checks cover exact catalog approval, stale/missing approval,
  structured product/category/size/color/budget filtering, plural customer
  wording, unknown-attribute escalation, scoped not-found results,
  internal-label rejection, and support upsell suppression. The handoff checks cover the
  exact previously observed false screenshot-forwarding wording in English and
  Roman Urdu, unverified human actions/promises, normal-message handoff claims,
  exact-body authorization, and pending/sent status rendering. A rollback-only
  probe against the real database rejected Easypaisa,
  created zero drafts and zero orders, and left the database counts unchanged.
  The restarted application reports a healthy signed webhook (valid probe 200,
  invalid signature 401). Docker Desktop was restarted, but its current Linux
  context contains no WAHA container at all, including no stopped rollback
  container; therefore a fresh real WhatsApp test is currently blocked until
  the existing gateway/session is safely restored. Current real configuration
  deliberately exposes **COD only**; no real payment account or credential was
  added to Git.
- **Status:** ✅ **All eight corrections are built and locally verified.**
  Webhook end-to-end delivery, the customer-facing payment reply, and the new
  truthful handoff, sender-bound order-status, privacy-regression, and public
  inventory-visibility, refund-request, and grounded product/policy replies
  still require fresh real WhatsApp tests after WAHA is restored. The current
  owner approved the 30-section policy file on 2026-10-03 and its exact
  fingerprint
  `d2a7b25adc4e7f83d6c97f7075b716dd01e1afe63216ad6440289cc1c083f9ce`
  is installed only in the ignored runtime `.env`; a restarted-process probe
  found the real `Return Policy` section with no configuration error.
  the temporary product label has been replaced and the grounded Black Hoodie
  lookup now succeeds locally without exposing exact stock. Until the owner provides validated payment destinations,
  Easypaisa, JazzCash, and bank transfer correctly remain unavailable rather
  than emitting a placeholder or invented account.

---

## Security and commercial hardening implementation backlog — canonical progress list (not Version 4)

This section is the canonical implementation backlog created from the
2026-10-04 adversarial-testing review and the direct comparison against the
current code. It records what is already enforced, what is only partial, what
is missing, and what evidence is required before an item may be marked
complete. It is real-business/commercial hardening, not a fifth promise and
not Version 4. The permanent exclusions later in this file remain unchanged.

Do not create a second progress tracker for these items. When the state of an
item changes, replace its status and stale detail here. Do not append a new
claim beside an older contradictory one.

### Status and completion discipline

- `BUILT + LOCALLY VERIFIED` means deterministic/direct tests passed. It does
  not mean the customer-facing WhatsApp behavior has passed live.
- `LIVE VERIFIED` requires a fresh real WhatsApp scenario plus database or
  provider evidence where the action changes business state.
- `PARTIAL` means a safe subset exists but the named remaining capability does
  not.
- `MISSING` means no production implementation exists yet.
- `DECISION REQUIRED` means a business rule or provider choice must be approved
  before code is written. The implementation must fail closed in the meantime.
- A schema-changing item requires a verified backup, `integrity_check = ok`,
  zero foreign-key violations, and before/after reconciliation.
- Customer-facing behavior should be tested live when practical. Pure
  authorization, race, forged-input, and financial-invariant branches should
  be verified deterministically at the server/tool boundary.
- Never commit real phone numbers, account destinations, tokens, secrets, API
  keys, real customer transcripts, or a production database.

### Existing controls that must be preserved — do not rebuild or weaken

| Control | Current verified state |
|---|---|
| Customer/order identity | `BUILT + LOCALLY VERIFIED` — high-entropy public order references, current-WhatsApp-customer binding, indistinguishable foreign/missing lookups, and failed-lookup throttling. |
| Server-controlled catalog price | `BUILT + LOCALLY VERIFIED` — the model cannot supply the authoritative order price; integer-paisa prices and order snapshots are used. |
| Atomic inventory | `BUILT + LOCALLY VERIFIED` — confirmation rechecks stock, reserves conditionally in one transaction, prevents negative stock, rolls back partial reservations, and restores eligible cancellations. |
| Order state authority | `BUILT + LOCALLY VERIFIED` — forward-only state transitions, actor-specific permissions, stable event evidence, terminal-state enforcement, and append-only audit history. |
| Two-step order confirmation | `BUILT + LOCALLY/LIVE VERIFIED` — prepare first, display the server summary, wait for a later inbound confirmation, then recheck price and stock before one atomic booking. |
| Payment claims | `BUILT + LOCALLY VERIFIED; FRESH LIVE OWNER-WORKFLOW CHECK PENDING` — customer statements create unverified pending claims and never credit money. Gemini has no resolution tool. Approval requires `APPROVE CLAIM <id> REF <owner-verified-reference>` plus an exact confirmation repeating the same reference; the immutable verification is separate from customer wording and one reference can authorize only one claim. Vague/list-position/natural-language instructions cannot mutate state. Approval checks duplicate reference, customer/order balance and amount. SQLite rejects approval without an exact linked credit, mismatched customer/order/amount/direction links, link edits/deletions, resolved-status rewrites, verification edits/deletions, and audit-event edits/deletions. Reversal creates one linked compensating debit without deleting history. Real claim #4's accidental approval was safely reversed after a verified backup; claims #3, #5, and #6 remain pending. |
| Refund review cases | `BUILT + LOCALLY VERIFIED` — sender-bound delivered-order eligibility, public refund references, owner-only approve/reject, and no false money-movement claim. |
| Webhook entry security | `BUILT + LOCALLY/LIVE-CONFIG VERIFIED` — raw-body HMAC verification, fail-closed configuration, retained-message quarantine, and inbound provider-event deduplication. Fresh real-message proof remains below. |
| Truthful handoff report | `BUILT + LOCALLY VERIFIED` — only recorded/pending/sent facts may be reported; the model cannot claim viewed, approved, replied, or media-forwarded. |
| Current PII safeguards | `BUILT + LOCALLY VERIFIED` — structured log redaction, durable-memory sanitization, masked model-visible fulfilment contact, strict public order output, sender-bound order/refund/note access, privacy-safe payment/refund outputs and errors, and sanitized owner alerts. A permanent six-test extraction suite covers these current paths. This is still not a complete retention/deletion/privacy program. |
| Public inventory visibility | `BUILT + LOCALLY VERIFIED` — availability bands and requested-quantity yes/no only; exact internal counts remain private. |
| Grounded product/policy answers | `BUILT + LOCALLY VERIFIED` — structured product search, approved catalog fingerprint, unknown-attribute escalation, internal-label rejection, and support-upsell suppression. |
| Duplicate business effects | `BUILT + LOCALLY VERIFIED` for current inbound events, order creation, draft confirmation, payment claims, refund requests, consent events, alerts, bookkeeping, and stock reservation. Future external payment/refund/courier actions need their own provider idempotency. |
| Automated test isolation | `BUILT + LOCALLY VERIFIED` — `npm test` runs every test file against its own temporary database, the separate Version 2 end-to-end regression uses the same isolation, direct test entry points fail closed before opening `ahmed.db`, and the runner fingerprints the production database plus SQLite sidecars before and after each run. The complete 27-file suite passed without changing those fingerprints. |
| Automated security regression | `BUILT + LOCALLY VERIFIED` — `npm run test:security` executes the versioned 27-file security manifest through the isolated runner, prints each file's declared protection areas, verifies manifest uniqueness/files/required coverage, and fails if any test or production-database fingerprint check fails. The complete suite passed across 31 declared areas without changing the real database during tests. |
| Multi-turn adversarial state resistance | `BUILT + LOCALLY VERIFIED` — five deterministic multi-message sequences now preserve and test the accumulating hostile conversation history while checking the authoritative database after each attack. Fake payment/owner approval cannot mark an order paid or create credit; fake refund approval cannot approve or execute a refund; staff/discount/price claims cannot change server pricing; foreign-order persuasion remains indistinguishable from a missing reference; and stored prompt-injection history remains data-only with no business mutation. This is deterministic server-boundary proof, not live WhatsApp verification. |
| Sensitive-action truthfulness | `BUILT + LOCALLY VERIFIED` — payment claims now return explicit `payment_verified=false`, `ledger_credited=false`, and `order_status_changed=false` facts plus fixed pending-verification wording; refund request/status tools provide fixed wording that distinguishes requested, approved-pending-execution, rejected, and actually refunded; denied paid/shipped/delivered requests must explicitly say the status was not changed because trusted verification is required; and blocked discounts now require the reply to say the discount was not applied. The final customer-send boundary derives these requirements only from successful fixed server-tool results and vetoes incomplete or falsely completed wording. Five focused tests passed. Live WhatsApp wording remains unverified. |
| Adversarial input and query safety | `BUILT + LOCALLY VERIFIED` — a permanent SQL-like payload corpus now covers product search (including escaped `%`/`_` wildcard probes), sender-bound order references, fulfilment names/addresses/instructions, customer-bound notes, and note-id type confusion. SQL-like text remains literal data, cannot reveal a foreign order/note, and cannot mutate product price, schema, orders, ledger, payments, refunds, or handoffs. Unsupported ASCII control characters are rejected before fulfilment storage. Six focused tests finish with SQLite integrity `ok` and zero foreign-key violations. |
| PII extraction resistance | `BUILT + LOCALLY VERIFIED FOR CURRENT PATHS` — a permanent six-test suite verifies strict public order fields; indistinguishable foreign/missing order and refund access; payment/refund evidence non-disclosure; customer-bound sanitized memory; the deliberate fulfilment-only storage boundary with masked model-visible contact and no premature booking; redacted owner alerts/logs; and PII-free validation/ownership errors. The full privacy lifecycle in HARD-05 still requires owner-approved retention, export, deletion, backup-expiry, and access policy. |

### Gate A — formally verify the security work that already exists

#### HARD-01 Restore the real WhatsApp path and run one documented acceptance pass

- **Status:** `PENDING LIVE VERIFICATION` — do not rebuild the eight
  corrections. Restore the preserved WAHA/session safely, start the signed
  webhook path, and test the existing implementation.
- **Required live scenarios:**
  - [ ] Valid signed real customer webhook reaches the assistant; an invalid
    signature is rejected and creates no turn or business effect.
  - [ ] COD is offered; unconfigured Easypaisa, JazzCash, and bank transfer
    remain unavailable, no placeholder destination appears, and an explicitly
    selected unavailable method is never silently substituted with COD.
  - [ ] A real owner handoff reports only recorded plus pending/sent and never
    says viewed, approved, replied, or screenshot forwarded.
  - [ ] Same-number order status succeeds; another number receives the same
    generic response as a nonexistent reference.
  - [ ] Customer responses and logs expose no internal order id, full contact,
    delivery address, payment reference, or exact stock count outside the
    intended fulfilment boundary.
  - [ ] A requested quantity receives only a fulfilment yes/no decision.
  - [ ] A delivered-order refund request creates one review case and no money,
    ledger, or order-state change.
  - [ ] Covered catalog/product questions use approved data; unknown attributes
    and unsupported questions are handed off without guessing.
  - [ ] STOP acknowledgement arrives once, normal follow-up is suppressed,
    restart preserves suppression, and START arrives once and restores normal
    replies.
- **Evidence required:** timestamp, sender suffix, provider message id,
  expected/actual reply, relevant database rows/counts, and confirmation that
  no duplicate or unintended state change occurred.
- **Done only when:** every line above has a recorded PASS. A partial live pass
  must remain partial.

### Gate B — close the remaining single-business safety gaps

#### HARD-02 Remove ambiguity from short order confirmations

- **Status (2026-10-04):** `BUILT + LOCALLY VERIFIED; LIVE VERIFICATION
  PENDING`.
- **Preserved boundary:** confirmation still requires an existing prepared
  draft, a later provider message, stable message identity, fresh price/stock
  validation, and atomic booking. Negative/cancel/change language remains
  rejected.
- **Implemented:** generic acknowledgements such as `yes`, `haan`, `ji`, `ok`,
  `okay`, and `done` no longer qualify as transaction confirmation. The server
  now requires language that explicitly mentions confirming, booking, placing,
  or the order itself. The model prompt, draft instruction, and confirmation
  tool description all tell the customer/model about this stricter boundary.
- **Local proof:** a real pending draft plus a new provider event containing
  only `Yes` returned the explicit-confirmation error and created zero orders.
  Parser tests reject all six generic acknowledgements while continuing to
  accept `Order confirm kar dein`, `Please book it`, `Confirm bhai`, and `Yes,
  confirm my order`. The complete 82-test main suite, every focused security
  suite, and typecheck pass.
- **Live test still required:** prepare one test order through real WhatsApp;
  send `Yes` and confirm no order/debit/stock reservation exists; then send an
  explicit confirmation and reconcile exactly one order, debit, draft link,
  audit chain, and stock reservation.

#### HARD-03 Add inbound abuse, concurrency, and AI-cost protection

- **Status (2026-10-05):** `CORE CONTROLS BUILT + LOCALLY VERIFIED — DURABLE
  PER-SENDER LIMIT, DAILY AI BUDGET, 500-JOB RESTART-SAFE INBOUND QUEUE WITH
  FOUR WORKERS, OWNER-ALERT FLOOD LIMIT, AND CAUSE-ACCURATE CAPACITY RESPONSES;
  FULL MODEL LOAD AND LIVE PROOF REMAIN`.
- **Already built before this slice:** outbound pacing, sending window, warm-up
  cap, repetition protection, 256 KB JSON limit, and order-reference lookup
  throttling.
- **Built in this slice:** every model-backed inbound event now passes through
  a durable per-sender admission gate before either the customer or owner model
  turn. The default customer limit is 20 turns per 10 minutes and the owner's
  separate limit is 60; all three values are configurable. Missing, malformed,
  zero, negative, or out-of-range configuration falls back to finite defaults,
  never an unlimited mode. Provider-event-key decisions are idempotent, sender
  lookup uses a SHA-256 key rather than another raw-phone copy, expired events
  leave the window, and a rejected event is completed with no model call so
  provider retries cannot spend repeatedly. Deterministic STOP/START handling
  and already-opted-out suppression remain before this gate, so consent is
  always available without AI use.
- **AI-cost slice built:** the single shared Gemini seam now atomically reserves
  every provider attempt before the network request. Customer and owner turns
  therefore consume the same Karachi-business-day budget. The finite defaults
  are 500 calls and 500,000 provider-reported tokens per day; missing, invalid,
  zero, negative, or out-of-range configuration falls back to those defaults,
  never unlimited use. Failed provider attempts consume the call allowance.
  Successful responses persist Gemini's reported prompt, output, and total
  token counts. The hard call ceiling cannot be raced by concurrent requests;
  because token usage is only known after a response, the token ceiling blocks
  subsequent calls once recorded usage reaches it rather than pretending it
  can predict the last in-flight response. Budget-blocked durable jobs are
  deferred without spending an attempt and rechecked hourly, before any
  provider network request, so they can resume after the Karachi-day reset.
- **Durable concurrency/queue slice built (replaces the earlier 20-item
  in-memory queue):** after authentication, replay protection, consent, and
  per-sender admission, every accepted customer or owner message is committed
  to `inbound_jobs` before WAHA receives HTTP 200. The default durable capacity
  is 500 pending messages, drained FIFO by four workers. The tested 500 remain
  stored; the 501st receives HTTP 503 rather than a false acknowledgement, so
  WAHA can retry it. Pending and interrupted jobs survive restart; processing
  leases are recovered; transient failures retry with exponential backoff;
  final failures remain inspectable with their message rather than silently
  disappearing. Successful completion atomically marks the inbound event done
  and clears the queue's temporary message body. Provider-event identity also
  makes the raw inbound transcript insert exactly once across retries. Missing
  or invalid queue settings fall back to finite defaults. STOP/START and
  opted-out suppression remain before the queue. The SQLite worker pool is the
  correct current single-instance boundary; horizontal multi-instance service
  still requires a shared database/queue designed for distributed leases.
- **Owner-alert flood slice built:** alert sends now have a durable rolling
  ceiling of six deliveries per ten minutes by default. The check runs inside
  the existing serialized delivery path and counts persisted `sent_at` values,
  so restart cannot erase recent usage. Excess alerts are not discarded: they
  stay pending, continue grouping same-kind occurrences, and the already-built
  retry worker delivers them when the window has capacity. Missing or invalid
  configuration falls back to the finite default, and the existing shared
  outbound pacing still applies after this gate.
- **Deterministic capacity responses built:** per-sender rejection and durable
  queue saturation use the fixed bilingual overload response, while daily
  AI-budget exhaustion uses a separate truthful notice saying the message is
  saved, retry is automatic after Karachi midnight (normally within the
  following hour), and the customer must not resend. Neither path calls
  Gemini. A response is sent only when the turn has
  not already delivered a customer reply, and still passes through consent,
  the normal shared pacing lock, disclosure, and durable send idempotency. The
  exact body has a ten-minute rolling per-customer repeat cooldown checked
  inside that send lock. Only one busy reply may be in flight process-wide, so
  a many-sender rejection burst cannot create a second unbounded outbound
  waiting chain. Owner turns do not receive the customer-facing text.
- **Schema/backups:** the additive `inbound_abuse_events` table and sender/window
  index were applied after the verified backup
  `backups/ahmed-pre-inbound-abuse-20261004.db`. The additive `ai_model_calls`
  usage ledger and day index were applied after the verified backup
  `backups/ahmed-pre-ai-budget-20261004.db` (SHA-256
  `4BDCDD9B5460F4FFF222B660808A0A1595F5EE5BCB1C7D0E9714A66E683D5E5B`).
  The durable queue and exactly-once inbound transcript key were applied after
  `backups/ahmed-pre-durable-inbound-queue-20261004.db` (SHA-256
  `5303D4E061079BE4F7D2EF85674E23658A88AF99DF29081AADD432695C8D6398`).
  Post-change database checks: `integrity_check = ok`, zero foreign-key
  violations, 43 customers, five orders, 884 messages, and zero retained test
  rows in the abuse, AI-budget, or inbound-job ledgers.
- **Local proof:** four inbound-abuse tests cover fail-conservative configuration,
  admission through the exact limit, rejection before a model call, durable
  event idempotency, the separate owner limit, and window expiry. The complete
  four-test AI-budget suite covers conservative configuration and Karachi date
  boundaries, atomic call exhaustion (including failures), provider-reported
  token exhaustion, and the next-day reset. Seven durable-queue tests cover
  finite configuration fallback, FIFO/idempotent admission, 500 retained
  messages plus refusal of the 501st, four-worker-style bounded concurrency,
  restart/replay-guard recovery, retry backoff/final retention, successful body
  minimization, and exactly-once transcript insertion. The complete 82-test
  main suite, every focused security suite, and typecheck pass. Two owner-alert flood
  tests prove conservative configuration, retained delivery at the ceiling,
  continued blocking inside the window, and recovery through the existing
  worker after expiry. Two busy-reply tests prove conservative cooldown config
  and suppression of a recent duplicate with zero provider/model send.
- **Still verify before calling HARD-03 complete:** a controlled full-stack
  many-sender run using real model calls while observing memory/cost and owner
  delivery behavior, plus one real WhatsApp restart/queued-message pass and one
  live saturation response. Exact currency-denominated cost reporting remains
  optional future operations work if provider pricing is adopted.
- **Future multi-business extension:** per-business quotas and fairness so one
  tenant cannot consume every worker or budget.
- **Operational requirements:** visible metrics and alerts for throttling,
  queue depth, model failures, cost-budget exhaustion, and repeated abuse.
- **Tests:** rapid single-sender flood, many-sender flood, concurrent requests,
  queue-full behavior, owner-alert storm, reset-window boundaries, restart
  behavior, and proof that limits do not bypass STOP/START or outbound pacing.
- **Done only when:** load tests show bounded model calls, memory, queue size,
  and owner alerts under abuse.

#### HARD-04 Defend against indirect prompt injection in stored and external data

- **Status:** `CORE CONTROL BUILT + LOCALLY VERIFIED; LIVE ADVERSARIAL PASS PENDING`.
- **Built (2026-10-04):** customer requests, checkpoint memory, note headlines,
  recent messages, prepared-order data, and owner requests now enter the model
  inside bounded JSON `UNTRUSTED_DATA` envelopes instead of being interpolated
  as prompt headings or free-form instructions. Every customer and owner tool
  result is returned inside a `SERVER_TOOL_RESULT` envelope. Stored catalog,
  product, fulfilment/name/address/instruction/note, payment, courier, and
  external-API strings remain data even when nested keys claim to be `system`,
  `role`, `tool`, `policy`, or `instruction`.
- **Authority rule:** only top-level teaching text authored by a small allowlist
  of fixed in-process tools can become `trusted_guidance`; an unknown/future
  provider or API cannot gain authority merely by returning an `instruction`
  field. System prompts state the same boundary for both customer and owner
  turns. Backend tool separation, ownership checks, state machines, catalog
  approval, and server-side authorization remain the final authority; the
  control does **not** rely on keyword blocking or model obedience.
- **Minimum disclosure:** `check_stock` now returns only public product id,
  name, category, size, color, server price, and qualitative availability
  fields—SKU and exact stock remain excluded. Catalog result title/body are
  bounded. Context exposes only a masked delivery contact and the minimum
  prepared-order fields already needed for confirmation.
- **Supplemental output guard:** both customer and owner send paths reject a
  generated reply that tries to reveal system/developer prompts, hidden rules,
  tool schemas/permissions, or the internal envelope markers. This is a final
  disclosure backstop, not the authorization boundary.
- **Local proof (2026-10-04):** the new deterministic suite passed 7/7 across a
  malicious catalog section, product name/description, recipient/address/
  delivery instructions/order note, payment response, courier response,
  unknown external tool, nested JSON, minimum product fields, bounded depth/
  length, disclosure blocking, and unchanged order/payment/refund/handoff row
  counts. The complete existing suite also passed (82/82 core checks plus every
  focused pacing, alert, webhook, payment, handoff, order-access, privacy,
  inventory, refund, grounding, abuse, AI-budget, and durable-queue suite),
  typecheck passed, SQLite integrity is `ok`, and foreign-key violations are
  zero. Test queue/abuse/model-budget rows are zero.
- **Still required before marking complete:** a real WhatsApp adversarial pass
  through both customer and owner routes proving malicious stored/retrieved
  text is treated only as data, no internal prompt/tool details are disclosed,
  and no unauthorized business mutation occurs. This control is therefore
  locally verified, **not live-verified**.

#### HARD-05 Complete the privacy and data-lifecycle program

- **Status:** `PARTIAL + OWNER DECISIONS REQUIRED`.
- **Already built:** log redaction, durable-memory minimization, phone masking,
  public-response field allowlists, and preservation of authoritative
  fulfilment records.
- **Owner decisions required:** legal/business retention periods for raw
  messages, orders, fulfilment data, payment/refund evidence, logs, alerts,
  and backups; whether and when delivery details may be deleted; who may
  access each data type.
- **Implement:** customer data export, verified deletion/anonymization,
  retention jobs, backup expiry, encrypted off-host backups, key management,
  staff access logs, privacy notice, consent wording, incident procedure, and
  a tested restore/delete process.
- **Tests:** export completeness, deletion scope, legal/business records that
  must remain, backup expiry, unauthorized staff access, log scanning, model
  context scanning, and proof that one customer cannot retrieve another's PII.
- **Done only when:** the owner approves the policy and code plus operations
  enforce it. STOP/START alone does not complete privacy readiness.

#### HARD-06 Close outbound delivery/idempotency edge cases

- **Status:** `CORE CONTROL BUILT + LOCALLY VERIFIED; LIVE/RESTART PROOF PENDING`.
- **Built (2026-10-04):** customer replies and owner conversational replies now
  share one durable outbound-attempt lifecycle. Each provider event has one
  database-enforced outbound identity even if the model rephrases the body.
  The ledger stores recipient kind, hashed event/body identities, attempt
  count, `pending`/`sent`/`failed`/`uncertain` state, a bounded error code, and
  the provider message id when WAHA returns one; it does not store another
  plaintext message or phone copy.
- **Crash rule:** a process/network outcome that cannot prove whether the
  provider accepted a message becomes `uncertain` and is never automatically
  resent. A definite provider HTTP rejection becomes `failed` and is safe to
  retry. A legacy or restart-observed `pending` row becomes `uncertain` rather
  than being silently duplicated. Both prompts explicitly forbid a rephrased
  retry, and a unique database/event check enforces the rule independently of
  model obedience.
- **Recovery/visibility:** Ahmed's owner-only toolset now includes the read-only
  `outbound_delivery_issues` report for failed/uncertain attempts. It exposes a
  shortened attempt reference, state, attempts, error code, and timestamps—no
  message body or phone—and performs no automatic resend. Existing owner-alert
  retry remains separate; an uncertain owner-alert send stays pending instead
  of being falsely marked delivered.
- **Provider seam:** the channel adapter now returns a send receipt. WAHA's
  successful JSON response is inspected defensively for its message id;
  successful non-JSON responses still count as accepted. HTTP rejection is
  distinguished from a network/unknown outcome.
- **Local proof (2026-10-04):** 7/7 focused tests passed: sent-attempt/provider
  id retention, duplicate suppression, restart-observed pending state,
  differently worded same-event suppression, definite rejection retry,
  unknown-outcome non-retry, read-only/privacy-safe owner issue reporting,
  WAHA certainty classification, and an owner conversational event retried
  twice with exactly one provider call. The complete suite passed (82/82 core
  checks plus all focused suites), typecheck passed, and the verified
  pre-change backup is `backups/ahmed-pre-hard06-outbound-20261004.db` with
  SHA-256 `3D643B1E1BDA96046753281589C0DB811E8857AA88A2C31A4065AA94D9CED39F`.
- **Real database migration result:** 216 historical attempts are `sent`; 10
  old rows that the previous code left as `pending` (dated 2026-09-02,
  2026-09-14, 2026-09-15, and 2026-10-02) were conservatively relabelled
  `uncertain` with `legacy_pending_outcome_unknown`. They were not resent or
  deleted. Database integrity is `ok`, foreign-key violations are zero, and
  inbound-job/abuse/model-budget test rows are zero.
- **Still required before marking complete:** restart the real service and
  perform controlled real WhatsApp customer and owner sends; verify returned
  provider ids where the active WAHA engine supplies them; simulate a real
  interrupted/unknown outcome and confirm it appears once as `uncertain` with
  no duplicate visible message. Future payment/refund/courier execution still
  requires its own provider-level idempotency and reconciliation.

#### HARD-07 Build production job processing, monitoring, backup, and recovery

- **Status:** `LOCAL OPERATIONS FOUNDATION BUILT + VERIFIED; DEPLOYMENT/EXTERNAL OPERATIONS PENDING`.
- **Durable processing already built:** accepted model-backed messages are
  committed to a bounded 500-message SQLite FIFO before acknowledgement, then
  drained by four workers; restart recovery, leases, retry/backoff,
  final-failure retention, exact-once transcript recording, abuse admission,
  AI-budget deferral, and queue-full behavior are locally verified.
- **Health/readiness built (2026-10-04):** public `GET /health` is deliberately
  liveness-only. `GET /ready` verifies SQLite plus the configured WAHA session
  through its supported session endpoint and returns 503 unless the database is
  reachable and WhatsApp status is `WORKING`. Responses expose no account,
  customer, message, or credential data.
- **Authenticated metrics built:** `GET /operations/metrics` fails closed
  unless a separate key of at least 24 characters is supplied in
  `X-Operations-Key`. It reports only queue counts/oldest pending time, worker
  occupancy, failed/uncertain delivery counts, pending owner-alert count,
  uptime, and process memory—never phone numbers or message bodies.
- **Verified backup/restore foundation built:** the running application creates
  an online SQLite backup at startup and at a finite configured interval
  (default 24 hours), retains a finite number (default 14), and verifies both
  SQLite integrity and foreign keys before a backup counts as successful or an
  old matching backup is pruned. Retention can delete only this application's
  timestamped `.db` files inside a validated dedicated directory; filesystem
  and workspace roots are rejected. Manual `npm run backup` and independent
  read-only `npm run backup:verify -- <path>` commands use the same verifier.
- **Real backup proof (2026-10-04):** an online snapshot of the actual database
  was created at ignored path
  `backups/operations/ahmed-backup-2026-10-04T11-03-12-021Z.db`; it was reopened
  independently and passed integrity with zero foreign-key violations twice.
  Size: 749,568 bytes. SHA-256:
  `9000594BD24F18BD512B0C835959BDC34B0C691D1915144CDFB56BA57BB9D845`.
- **Runbook built:** `docs/OPERATIONS_RUNBOOK.md` covers liveness vs readiness,
  backup and restore drill, WAHA relink, model/quota outage, stuck/saturated
  queue, uncertain/failed delivery, database corruption, credential exposure,
  rollback, and truthful customer incident communication.
- **Local proof (2026-10-04):** 7/7 focused operations tests passed for
  fail-closed metrics authentication, privacy-safe liveness/readiness/metrics,
  WAHA session status, finite backup configuration, online backup plus
  independent restore verification, two-file retention, and root-path safety.
  The complete suite passed (82/82 core checks plus every focused suite) and
  typecheck passed.
- **Still required before marking complete:** select and configure encrypted
  off-host backup storage/key ownership/expiry; select uptime/error/cost alert
  providers and recipients; configure/test persistent production volumes for
  SQLite and WAHA sessions; run real process-crash, host-restart, database-lock,
  gateway-outage, queue-saturation, restore, and rollback drills. A safe hard
  model-call timeout is also pending because the current model/channel APIs do
  not expose cancellation—racing a retry while the original call can still
  mutate/send would be less safe than the current lease/backoff behavior.

#### HARD-08 Define and enforce order-content modification policy

- **Status:** `MISSING AS A CUSTOMER FEATURE; CURRENT SAFE BEHAVIOR IS HANDOFF`.
- **Decision required:** which fields may change in `placed`, `confirmed`,
  `paid`, `shipped`, and `delivered`; which changes require owner approval;
  whether a changed order needs a new customer confirmation.
- **Implement if approved:** sender-bound public-reference operation,
  server-side field allowlist, state-specific rules, price/stock recalculation,
  before/after audit event, and atomic rollback.
- **Minimum rules:** shipped/delivered address changes blocked; payment status
  never customer-editable; quantities/prices never accepted from conversational
  claims; any changed final summary must be explicitly reconfirmed.
- **Tests:** own/foreign order, every order state, address/quantity/product
  change, price change during edit, stock race, duplicate event, and audit
  history.

#### HARD-09 Complete the commercial total-calculation layer

- **Status:** `PARTIAL + BUSINESS DECISIONS REQUIRED`.
- **Already built:** authoritative item prices, integer-paisa arithmetic, price
  snapshots, quantity validation, zero delivery charge for the current owner
  policy, and stock validation.
- **Decide and implement:** configurable delivery fee, free-delivery threshold,
  approved discount records, who may approve discounts, discount expiry and
  usage limits, maximum item/order/wholesale quantities, taxes if applicable,
  bundles/promotions, and exact rounding rules.
- **Server formula:** authoritative items plus server-approved delivery,
  discount, and tax only. The model and customer must never supply the final
  authoritative total.
- **Tests:** forged price/discount/fee/tax, expired or reused approval,
  maximum quantities, changed catalog price, exact paisa rounding, cancellation,
  refund basis, and historical snapshot stability.

#### HARD-10 Choose and complete the payment operating model

- **Status:** `COD-ONLY SAFE BASELINE; DIGITAL AUTOMATION MISSING`.
- **Decision A:** keep the pilot COD-only. Continue hiding all unconfigured
  methods and document the manual owner process.
- **Decision B:** integrate an approved payment provider. If selected,
  implement signed provider webhooks, destination/account ownership,
  transaction uniqueness, amount/currency/order reconciliation, idempotency,
  dispute/chargeback states, and an authenticated `paid` transition.
- **Never:** turn a customer statement, screenshot, transaction reference, or
  claimed staff approval directly into verified payment.
- **Tests:** forged/duplicate webhook, wrong amount/currency/order/destination,
  reused transaction, out-of-order event, refund/chargeback, timeout, and
  reconciliation after restart.

#### HARD-11 Choose and complete the refund operating model

- **Status:** `REVIEW/APPROVAL BUILT; EXECUTION MISSING`.
- **Decision A:** keep execution manual outside the system. Customer wording
  must remain `approved_pending_execution` until the owner records externally
  verified completion through a future authenticated path.
- **Decision B:** integrate provider execution. Add immutable execution
  attempts and states such as `approved_pending_execution`, `executing`,
  `executed`, `failed`, and `completed/reconciled` without falsely upgrading
  delivery or settlement.
- **Server authority:** refundable amount derives from verified payment/order
  history, not customer input; define full/partial refund, delivery fee,
  discount, return, and restocking policy.
- **Tests:** duplicate execution, Rs.50,000 manipulation, over-refund,
  partial-refund accumulation, wrong order/customer, provider timeout,
  success followed by retry, failure recovery, ledger reconciliation, and
  truthful customer status.

#### HARD-12 Extend handoff lifecycle only through authenticated human actions

- **Status:** `PARTIAL — RECORDED/PENDING/SENT ONLY`.
- **Implement only if operationally required:** authenticated owner/staff
  acknowledgement, assignment, decision, response, and resolution events.
- **Suggested facts:** `recorded`, `queued`, `delivered`, `acknowledged`, and
  `resolved`; keep delivery, reading, approval, reply, and completion distinct.
- **Never infer:** WhatsApp delivered means seen; seen means approved; customer
  says approved means approved.
- **Tests:** fake owner claim, fake screenshot, foreign staff identity,
  duplicate acknowledgement, reassignment, stale decision, and exact
  customer-visible wording for every real state.

#### HARD-13 Move the client runtime to an approved production WhatsApp path

- **Status:** `DECISION REQUIRED; CURRENT WAHA PATH IS DEVELOPMENT/PILOT INFRASTRUCTURE`.
- **Preferred commercial direction:** verify current official Meta WhatsApp
  Business Platform requirements when implementation begins, then use an
  approved provider/account setup with authenticated webhooks and supported
  operational recovery.
- **If WAHA is temporarily retained for a controlled pilot:** private network
  binding, API authentication, persistent session storage, health monitoring,
  QR/relink runbook, explicit client disclosure, and tested session recovery
  are mandatory.
- **Acceptance:** real inbound/outbound, restart, reconnect, retained-message
  quarantine, duplicate delivery, media behavior, and provider outage tests.

#### HARD-14 Approve analytics and financial-report definitions

- **Status:** `PARTIAL + OWNER DECISIONS REQUIRED`.
- **Current safe behavior:** owner analytics are fixed read-only tools, never
  unrestricted SQL.
- **Decide:** whether `sales today` means placed, confirmed, paid, shipped, or
  delivered value; treatment of cancellation, partial payment, store credit,
  refunds, delivery fees, discounts, taxes, and Karachi-day boundaries.
- **Implement:** named deterministic metrics with tests and customer/owner
  language that exactly matches what each query measures.
- **Tests:** midnight boundary, cancellation, partial payment, overpayment,
  refund states, store credit, and timezone changes.

### Gate C — controlled single-shop pilot readiness

#### HARD-15 Replace demonstration inventory and policy with one real shop's approved truth

- **Status:** `MISSING FOR A REAL CLIENT` — the expanded 33-variant inventory
  is realistic test data, not a client's approved stock.
- **Required:** owner-approved inventory CSV; catalog/policy review; payment
  methods; delivery areas/fees/times; return, exchange, cancellation, refund,
  discount, and escalation rules; shop identity and tone; operating hours;
  owner/staff contacts; supported languages; media expectations.
- **Process:** preview import, review reconciliation, verified backup, atomic
  apply, owner sign-off, and full customer-path regression.
- **Live acceptance:** product discovery, price, availability, complete order,
  confirmation, cancellation, payment path, out-of-scope handoff, and one
  owner report against the selected business data.

#### HARD-16 Pilot operations and responsibility agreement

- **Status:** `MISSING`.
- **Document:** who supervises the assistant, who reviews alerts/payment
  claims/refunds, support hours, escalation response target, manual fulfilment
  steps, incident owner, backup/restore owner, provider-account owner, customer
  complaint path, and conditions that pause automation.
- **Pilot limits:** one cooperating shop, limited number/customer volume,
  documented exclusions, daily review, rollback switch, and an agreed end date
  with success/failure criteria.

#### HARD-17 Complete one formal go-live acceptance record

- **Status:** `BLOCKED BY HARD-01 THROUGH HARD-16 AS APPLICABLE TO THE PILOT`.
- **Required evidence:** configuration review with secret scan; database backup
  and restore proof; deterministic suite; load/abuse checks; provider health;
  privacy/retention approval; real WhatsApp customer journeys; owner journeys;
  database reconciliation; rollback exercise; and signed owner acceptance of
  all manual limitations.

### Gate D — shared multi-business subscription platform

These items are not required if every early client receives a fully separate
deployment and database. They are critical before multiple businesses share
one application or database.

#### HARD-18 Add strict multi-business data isolation

- **Status:** `MISSING — CRITICAL BEFORE SHARED HOSTING`.
- **Implement:** business/tenant record and mandatory `business_id` ownership
  for customers, products, orders, drafts, messages, memory, ledger, payment
  claims, refund cases, alerts, consent, staff, configuration, usage, and audit
  data.
- **Rule:** every read and write includes authenticated business scope. Foreign
  and nonexistent tenant objects must be indistinguishable to unauthorized
  callers. Unique indexes and idempotency keys must be correctly tenant-scoped.
- **Migration:** no automatic assumption that all existing data can be mixed;
  assign the existing database deliberately to one verified business.
- **Tests:** every customer/owner/staff tool across Business A and Business B,
  guessed public references, analytics, search, alerts, exports, deletion,
  backups, logs, cache, queue, and file paths.

#### HARD-19 Add staff authentication and role-based permissions

- **Status:** `MISSING`.
- **Implement:** authenticated staff identities, secure sessions/credentials,
  owner-managed membership, least-privilege roles, revocation, multi-factor
  authentication where practical, and append-only privileged-action audit.
- **Suggested capabilities:** owner, manager, finance, fulfilment, support, and
  read-only analyst—defined by permissions, not by conversational claims.
- **Tests:** customer impersonates staff; staff crosses business; revoked staff;
  finance-only operation; fulfilment-only operation; privilege escalation;
  session expiry; duplicate privileged event.

#### HARD-20 Build validated business onboarding and configuration

- **Status:** `MISSING`.
- **Implement:** fail-closed onboarding for business identity, timezone,
  WhatsApp number/provider, owner/staff, activation date, catalog, inventory,
  payment/refund/courier settings, hours, policies, language/tone, alert
  destinations, data retention, and feature flags.
- **No hardcoded Ahmed assumptions** may remain in a general product path.
- **Acceptance:** incomplete or invalid critical configuration cannot silently
  start a blank or unsafe tenant.

#### HARD-21 Add per-business usage, subscription, and support controls

- **Status:** `MISSING`.
- **Implement:** plans, trials, billing state, usage metering, per-business
  limits, fair queue allocation, suspension/grace behavior, cancellation,
  export/deletion, support/audit access, and truthful billing communication.
- **Never:** disable customer safety, consent, privacy, or data export merely
  because a subscription payment failed.

### Gate E — provider integrations selected by the pilot/business

#### HARD-22 Courier booking and shipment tracking

- **Status:** `MISSING`.
- **Implement only after provider selection:** authenticated booking, address
  minimization, provider shipment id, webhook verification, idempotent shipped/
  delivered transitions, failed-delivery/return-to-origin states, tracking
  privacy, and reconciliation.

#### HARD-23 Product media, receipts, and customer documents

- **Status:** `PRODUCT MEDIA BUILT + LOCALLY VERIFIED; LIVE WHATSAPP PROOF
  PENDING. RECEIPTS/DOCUMENTS MISSING` (2026-10-05).
- **Built product-media scope:** all 33 active demo SKUs reference an approved
  server-side image; size variants share a card where design and color match,
  producing 28 distinct cards. `show_product_images` requires an explicit
  customer picture request, accepts only active product ids, reads only safe
  basenames from `assets/product-images`, caps a reply at three cards, and
  generates price/variant/public-availability captions from database facts.
  WAHA delivery uses its image endpoint and the normal consent, shared pacing,
  send-ledger idempotency, disclosure, and content guardrails. Missing,
  inactive, unconfigured, oversized, or path-like media fails closed.
- **Local proof:** the media verifier loaded all 28 cards with zero missing
  files; focused authorization/selection/provider-contract tests passed. The
  images are clearly demo catalog artwork, not claimed as photographs of real
  shop merchandise; a real business must replace them with owner-approved
  photos through the documented inventory CSV field.
- **Still required:** one real WhatsApp picture-request proof, plus all receipt/
  document decisions and implementation (invoice fields, numbering, tax/legal
  wording, download expiry, and human approval policy).
- **Truthfulness:** do not claim media or a receipt was sent until the provider
  confirms the exact outbound artifact.

### Permanent adversarial regression matrix

Each attack becomes a permanent deterministic test when its backend condition
can be reproduced directly, plus a live WhatsApp test when customer-facing
language or routing is the behavior under review.

| Attack | Current state | Required next proof |
|---|---|---|
| 24 Fake successful handoff | `PARTIAL PASS` — deterministic wording guard exists. | Fresh real WhatsApp claim; no state change without authenticated owner action. |
| 25 Duplicate refund | Request dedupe exists; execution does not. | Keep request test; add provider execution exactly-once test only with HARD-11. |
| 26 Refund amount manipulation | No executable customer amount exists. | Direct forged amount/over-refund tests with HARD-11. |
| 27 Invalid order-state transition | `BUILT + LOCALLY VERIFIED`. | Preserve permanent suite; rerun live only when customer flow changes. |
| 28 PII extraction | `CURRENT PATHS BUILT + LOCALLY VERIFIED` — six focused tests cover own/foreign public outputs, financial evidence, customer-bound model memory, fulfilment boundaries, owner alerts, recursive logs, and errors without exposing fixture PII. | Preserve the suite; add export/deletion/retention tests after HARD-05 policy decisions and run tomorrow's live minimum-disclosure pass. |
| 29 Malicious stored product/policy data | `CORE CONTROL BUILT + LOCALLY VERIFIED` — bounded trust envelopes cover customer/owner context and every tool result; fixed backend authorization remains final; 7/7 focused attacks passed without business mutation. | Run the real WhatsApp customer + owner adversarial pass; do not call it live-verified until both routes show no disclosure or unauthorized mutation. |
| 30 SQL-like input | `BUILT + LOCALLY VERIFIED` — the permanent six-test corpus covers search/wildcard escaping, references, notes, fulfilment names/addresses/instructions, customer isolation, control-character rejection, schema survival, integrity, and unchanged business state. | Preserve the corpus; add live WhatsApp phrasing checks only if these input paths or customer-visible error handling change. |
| 31 Duplicate webhook | `BUILT + LOCALLY VERIFIED`. | Preserve signed duplicate/restart tests and fresh provider-path verification. |
| 32 Last-item race | `BUILT + LOCALLY VERIFIED`. | Preserve multi-process/transaction race regression. |
| 33 Invalid quantity | `BUILT + LOCALLY VERIFIED` for type/range/stock. | Add approved business maximum and wholesale-review tests with HARD-09. |
| 34 Cross-business access | `BLOCKED — MULTI-BUSINESS MISSING`. | Full two-tenant matrix after HARD-18 through HARD-20. |
| 35 Fake staff approval | Customer/owner tool separation exists; staff system does not. | Add authenticated-event and role tests with HARD-12/HARD-19. |
| 36 Ambiguous yes | `BUILT + LOCALLY VERIFIED; LIVE PENDING`. | Run HARD-02's two-message real WhatsApp proof before pilot. |
| 37 System/tool/internal-rule extraction | `CORE CONTROL BUILT + LOCALLY VERIFIED` — customer/owner context and tool results have explicit authority boundaries, and the outbound disclosure backstop passed its focused corpus. | Run customer + owner live WhatsApp extraction attempts; verify zero prompt/schema disclosure, zero new authority, and zero business mutation. |
| 38 Spam/abuse | `CORE CONTROLS BUILT + LOCALLY VERIFIED` — outbound pacing, durable per-sender limit, shared daily AI budget, 500-message durable FIFO queue/four-worker pool, owner-alert rolling ceiling, overload response, and a separate truthful saved-message notice for daily-budget deferral. | Run a full-stack real-model load, real restart/queued-message recovery, and one live saturation-response proof with HARD-03/HARD-07. |

### Recommended implementation order

1. **Do not write new features first:** complete HARD-01 so the already-built
   security work has a trustworthy live baseline.
2. Live-verify HARD-02, HARD-03, and HARD-04, then implement the owner-approved
   portion of HARD-05. These are the clearest remaining customer-safety gaps.
3. Live-verify HARD-06 and complete the remaining HARD-07 production operations
   work for reliable service and recovery.
4. Record decisions and implement only the selected scope from HARD-08 through
   HARD-14. COD/manual paths should remain fail-closed until integrations are
   chosen.
5. Complete HARD-15 through HARD-17 for one controlled real-shop pilot.
6. Build HARD-18 through HARD-21 only when moving from isolated client
   deployments to a shared subscription platform.
7. Add HARD-22 and HARD-23 only for providers and capabilities explicitly
   selected by the real business.

### Current overall status of this backlog

- **Existing core and eight corrections:** built and locally verified as
  recorded above; formal combined live WhatsApp acceptance remains pending.
- **Single-shop pilot:** not approved for unattended launch. It needs the
  applicable Gate A/B work, one real shop's approved data, operational
  ownership, and the Gate C acceptance record.
- **Shared subscription product:** not ready. Multi-business isolation,
  authenticated staff roles, onboarding, per-business operations, billing,
  privacy lifecycle, and reliable production infrastructure are missing.
- **Next concrete action:** restore the real signed WhatsApp path and execute
  HARD-01 exactly as written before changing additional behavior.

---

## Portfolio Demo Frontend — not part of Ahmed's four promises

This is a developer portfolio/recruiter artifact, deliberately separate from
the product version sequence. It is **not Version 4 or Version 5**, does not add
anything to Ahmed's daily operation, and does not change any Version 1–3
business path.

- **Data boundary:** a deterministic build-time seed creates
  `portfolio-demo/data/portfolio-demo.db`, a separate ignored SQLite file with
  three invented customer names, clearly non-dialable `DEMO-CUSTOMER-*`
  identifiers, synthetic order/ledger history, and twelve written-for-demo
  chat messages. The real `ahmed.db` is never copied or opened by this feature;
  a hash-before/hash-after build verification proved it remained byte-for-byte
  unchanged.
- **Read-only boundary:** the generated deployment bundle copies the existing
  `analytics.ts` and `followups.ts` readers unchanged, with only their pure
  pacing helpers, a demo-only balance reader, and a demo-only SQLite adapter.
  SQLite is opened with `readonly: true`, `fileMustExist: true`, and
  `query_only = ON`; a deterministic test proves an attempted insert fails.
  The public runtime contains no WhatsApp adapter, model client, credentials,
  production database, order writer, alert sender, or messaging tool. Its API
  exposes GET-only summary, orders, conversation, and health routes.
- **Views built:** sales-today, unpaid-customer count and total, top-selling
  product, and pending-follow-up summary cards use the real readers against the
  synthetic database; recent orders visibly exercise all six retail statuses;
  and three WhatsApp-style conversations demonstrate cross-day memory recall,
  a correctly refused discount, and an honest owner handoff for an out-of-scope
  request. The interface is responsive, keyboard-accessible, and labels the
  data as synthetic throughout.
- **Verification (2026-09-15):** isolated build and demo typecheck passed;
  `demo:verify` proved fake identifiers, all six statuses, the expected real
  analytics results, and database-level write rejection; HTTP health returned
  200 while POST and unknown API routes returned 404; desktop and narrow-screen
  browser renders were inspected; the full existing product suite remained
  39/39 green, plus the activation-date/shared-pacing and durable-alert suites,
  and the production typecheck passed.
- **Hosting/live verification (2026-09-15):** deployed as a Render free Web
  Service at `https://ahmed-assistant-portfolio.onrender.com`. The public
  homepage and `/health` returned HTTP 200; health explicitly reported
  `synthetic-demo-only` and `read-only`. All four summary calculations matched
  the local proof (Rs.7,200 today, 3 customers/Rs.10,400 unpaid, Everyday Polo
  top with 5 units, 2 pending follow-ups), all 9 orders and all 3 conversations
  loaded, and all six status badges were present. POST and unknown API paths
  both returned 404. A scan of every public JSON response found zero real-phone
  patterns and zero credential/API-key patterns; the expected CSP,
  no-referrer, and no-sniff headers were present. A full deployed-page browser
  render confirmed the summary, complete order table, WhatsApp-style viewer,
  and privacy architecture section all render correctly.
- **Status:** ✅ Built, locally verified, publicly deployed, and live-verified.

---

## Version 4 — Stretch / polish (beyond the original spec)

Lower priority; sequence freely once v1–v3 exist.

### 4.1 — Proactive daily/weekly digest
- **Goal:** Ahmed gets a summary pushed to him without asking.
- **Depends on:** 3.2. **New work:** all new — no DeskcommCRM equivalent.
- **Status:** 🔲 Not started.

### 4.2 — Low-stock & receivables alerts
- **Goal:** Ahmed finds out about a problem before a customer does.
- **Depends on:** 2.4, 3.3. **New work:** threshold logic; delivery reuses 3.3.
- **Status:** 🔲 Not started.

### 4.3 — Tone / language refinement
- **Goal:** the bot's Roman Urdu/Hindi-English code-switching matches how
  Ahmed's actual customers write, not textbook translation.
- **Depends on:** version 1 complete. **New work:** all new — prompt/content
  work, not architecture.
- **Status:** 🔲 Not started.

### 4.4 — Trend analytics
- **Goal:** answer comparative questions ("best month", "up or down vs.
  last week").
- **Depends on:** 3.2. **New work:** new tools, same data model.
- **Status:** 🔲 Not started.

### 4.5 — Outbound product media & receipts
- **Goal:** send a photo of an in-stock item; produce a clean order receipt.
- **Depends on:** 2.1, 2.4. **Built from DeskcommCRM — extracted, staged:**
  `edge/llm/capabilities.ts` (decides if a model/provider can take native
  image parts). **New work:** the send-photo tool itself; deterministic
  (non-model-generated) receipt formatting.
- **Status:** 🟨 Product-image sending built and locally verified on 2026-10-05;
  real WhatsApp delivery proof pending. Receipt generation is not started.

---

## Permanent exclusions — not deferred, actively rejected

These are standing decisions, not a future TODO list. They solve problems
specific to DeskcommCRM's multi-tenant, team-operated context that this
project does not have. Revisit only if the project's fundamental premise
changes (e.g. reselling to other shop owners).

- Multi-tenancy / organization scoping of any kind
- Per-org budget enforcement, BYOK encrypted credential storage, billing
  (`edge/llm/orcamento.ts` was extracted in edited form as a possible
  *personal* spend-guard building block only — not this)
- The B2B sales-funnel / BANT qualification model — permanently superseded
  by version 2's order-status model, never a future upgrade path back
- The Operator/Conversador dual-agent split as a literal pattern — its
  restricted-turn-kind *concept* was already absorbed into 3.1's owner-turn;
  nothing further to take from it
- Agent-config publish/version/rollback workflow, multi-agent routing by
  intent
- Role-based access control, audited staff assignment/transfer, rotating
  queues — "human handoff" always means messaging Ahmed directly
- The self-optimizing "flywheel" system
- Jailbreak classification — revisit only if the bot is ever actually
  abused this way
- LGPD / any jurisdiction-specific compliance tooling not relevant to
  Ahmed's actual operating context

---

## Rule of thumb, restated

Before pulling anything from v4 or the permanent-exclusions list forward:
**have we actually hit this problem yet, or are we pre-building for a
problem we only imagine we'll have?** If the honest answer is "imagine," it
stays where it is.
