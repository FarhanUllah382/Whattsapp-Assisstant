# Ahmed's WhatsApp Assistant — THE Tracker (v3, canonical)

**Use this file. It replaces `PROJECT-TRACKER.md` and `PROJECT-TRACKER-v2.md`
— both are now obsolete, keep them only as historical record.** It also
replaces `roadmap.md` as a standalone reference — that document's structure
and rigor were better than v2's, so this file adopts its shape, but corrects
the one thing it got wrong (it was written as if nothing had been built yet)
and restores the permanent-exclusions list it was missing.

Each major version delivers exactly one of Ahmed's four original promises,
in dependency order. Version 4 is stretch work beyond the original spec.

| Version | Delivers | Status |
|---|---|---|
| 1.x | Promise 1 + 2 — talks to customers, remembers conversations | ✅ **Done (2026-09-05)** — all 9 of CLAUDE.md §8's checklist items verified against the real number. See "Version 1 — final status" at the end of the Version 1 section for the complete breakdown. |
| 2.x | Promise 3 — keeps the books automatically | 🟡 In progress — 2.1, 2.2, and 2.3 done (2026-09-05); 2.4-2.5 not started |
| 3.x | Promise 4 — Ahmed can just ask it questions | 🔲 Not started |
| 4.x | Stretch — beyond the original spec | 🔲 Not started |

---

## 0. Where things actually stand right now

- **`ahmed-assistant` skeleton exists** (delivered earlier this
  conversation): SQLite schema, single LLM-call seam, 4 business tools,
  the open→loop→checkpoint-close turn pattern, and a webhook stub. This
  already covers a real slice of 1.1 and 1.2 below — see those sections for
  exactly what's done vs. still missing.
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
    `price >= 0`, `product_id` must reference a real product) are checked
    before anything touches the database. `record_order` and
    `record_payment` previously could throw and crash the whole turn on
    malformed input (e.g. a non-numeric `product_id`); both are now wrapped
    so any failure returns `{ok: false, error: "..."}`, a teaching-text
    sentence the model can read and recover from mid-turn, same pattern
    `check_stock` already used for a missing product. Tool schemas
    (`input_schema`) were left unchanged — only `execute()` got stricter.
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
  - **Content caveat, unchanged from 2026-09-02:** `catalog.md`'s three
    sections are still the placeholder text ("Example entry — replace with
    your real product lineup," etc.), not Ahmed's actual policies. Today's
    test proves the *mechanism* (answer correctly from the document;
    deflect instead of inventing when not covered) works end-to-end against
    the real number — it does not mean the content customers currently see
    is Ahmed's real catalog. Filling in real content is a content task for
    Ahmed, not a code task, and isn't blocking on anything.
- **Status:** ✅ Done, and now the one sub-version in this file with full
  live proof against the real number, both cases. Catalog file, search
  tool, and the don't-invent-an-answer discipline are all built and
  verified locally *and* live. Content is still placeholder text for Ahmed
  to replace with his real catalog (see caveat above) — that's a content
  gap, not a code gap.

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
   **Caveat, not a code gap:** `catalog.md`'s content is still placeholder
   text ("Example entry — replace with your real product lineup," etc.) —
   the *mechanism* is proven, Ahmed's real catalog content still needs to
   be written in.
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
  recurred during today's own testing) — a random, load-independent
  assertion crash in `better-sqlite3`'s native bindings on process
  cleanup. **Explicitly NOT fixed, only mitigated** — a dev-only shell
  auto-restart loop (not part of the committed project) recovers within
  ~1-2s of a crash; the actual Node 24 / native-binding incompatibility has
  never been touched. **This is not resolved by Version 1 completion** —
  do not read anything above as implying otherwise.

### Standing operational fact, not a bug

The test number's daily warm-up cap (20/day for a day-0 number, per
`pacing/defaults.ts`'s conservative warm-up schedule) is **exhausted** from
today's own testing volume and resets at the next local-midnight window
open (Asia/Karachi). Real customer traffic will queue behind this same cap,
same as any test message would, until it resets — this is the anti-ban
throttle doing its job, not a defect.

### Explicitly carried forward, unresolved — Version 1 completion does not mean any of these are fixed

- **Node v24 native crash** — mitigated by a dev-only restart loop only;
  root cause unresolved (see above).
- **Per-number health circuit** (`health/defaults.ts`) — staged in
  `EXTRACTED-FOR-AHMED/`, never pulled in; no current requirement forced it
  yet.
- **STOP/opt-out handling** — not built.
- **A real async job queue for outside-hours retry** — a message outside
  the sending window correctly does not fire immediately, but nothing
  auto-fires it later on its own either; that needs genuinely new
  infrastructure, not a wiring task.
- **`notify_owner` handoff delivery is still log-only** — satisfies
  CLAUDE.md §8's literal wording (a handoff is triggered, not a guess), but
  Ahmed only sees a log line today, not an actual WhatsApp message to his
  own number. The blocker that originally deferred this (1.3 unverified) is
  gone; the upgrade itself simply hasn't been built yet.
- **`catalog.md`'s content is still placeholder text**, not Ahmed's real
  product lineup/return policy/delivery info — a content task for Ahmed,
  not a code gap.
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
- **Not done, deliberately, per explicit scope for this session:** no new
  AI-facing tool exposes order-status transitions to the model yet — this
  session was scoped to the data model and its enforcement, verified
  locally, not wiring it into a live conversation. That wiring (a tool the
  model calls, or extraction logic that infers it) is 2.2's/2.3's own
  remaining work, not done here. Whether/how to live-test this against real
  messages is a separate decision, not yet made.
- **Built from DeskcommCRM:** nothing for the ledger — no analog exists
  anywhere in the module, confirmed during extraction. The order-status
  *mechanism* re-implements `agent/lead-state.ts`'s pattern (did not
  qualify for extraction — DB-coupled) with retail vocabulary; see above.
- **Definition of done:** can insert a product, an order, and a payment and
  query them back correctly (✅ verified above) — with balance always
  reconstructable from ledger history rather than trusted as a single
  field (✅ verified above); an invalid status transition is rejected (✅
  verified above, four different shapes).
- **Status:** ✅ Done — real ledger and forward-only order-status state
  machine both built, migrated safely against the real dev database, and
  verified deterministically. Not yet wired into any AI-facing tool or
  live-tested against real messages (see "Not done" above) — a separate,
  not-yet-made decision.

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
  already covers it.
- **Verified locally, deterministically — 21 checks, all through the real
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
- **Built from DeskcommCRM:** the *mechanism* in `agent/lead-state.ts`
  (forward-only, model-driven, server-validated state machine) — did not
  qualify for direct extraction (DB-coupled), but the pattern is simple
  enough to re-implement with retail vocabulary instead of B2B funnel
  vocabulary. This vocabulary swap is permanent — never revert to the
  funnel shape (see permanent exclusions).
- **Definition of done:** the bot marks an order confirmed/paid/shipped
  during a natural conversation (✅ the tool exists and is verified to work
  correctly when called — not yet exercised through an actual live
  conversation, see above); a query for "orders in status X" returns
  correctly (⚪ trivially true given the schema — a plain `select * from
  orders where status = ?`, not separately built as its own tool since
  nothing yet asks for it); an invalid backward transition is rejected (✅
  verified, both directly in 2.1 and now through the real tool above).
- **Status:** ✅ Done — both halves complete: the state machine (2.1's
  session) and now the conversational tool that actually exposes it to the
  model, both verified deterministically. Not yet live-tested against a
  real conversation; that remains a separate, explicit decision for later.

### 2.3 — Automatic order & payment extraction
- **Goal:** "20 shirts, medium, black, ₹5000" becomes a real order row
  without Ahmed typing anything — including a safety net for orders/payments
  mentioned but never explicitly logged via a tool call.
- **Depends on:** 2.1, 2.2.
- **Verified before starting, not assumed (2026-09-05):** the *primary*
  path ("20 shirts... becomes a real order row") was already fully covered
  by 2.1/2.2's `record_order`/`record_payment` tools, called mid-turn by
  the model — confirmed by re-reading them before writing anything new.
  2.3's own genuinely new work is only the *safety net* half — "mentioned
  but never explicitly logged" — which did not exist anywhere yet.
- **Done (2026-09-05) — the safety net, at turn CLOSE (the same forced
  second model call that already produces the checkpoint summary and
  notes, per this file's own established pattern):** the CLOSE prompt
  (`agent.ts`) now also asks the model to report, in the same JSON, an
  `unlogged_order`/`unlogged_payment` — but **only** if it has NOT already
  called `record_order`/`record_payment` this same turn. Two shapes: (1)
  `confident: true` with structured `items`/`amount` — used only when the
  model already knows the real `product_id` from calling `check_stock`
  earlier in this same turn; (2) `confident: false` with a plain-text
  `description` — used whenever it's not sure of exact numbers.
  **Deterministic gate, not the model's self-report:** whether the safety
  net acts at all is decided by `toolsCalledThisTurn` — real bookkeeping
  from the turn's own tool-call loop, already tracked for the silent-no-
  reply guard (1.3) — not by trusting the model's claim that it "forgot."
  A real `record_order`/`record_payment` call this turn always wins; the
  safety net is skipped entirely regardless of what the CLOSE step says,
  so a real call can never get double-logged.
  - **"Never guess a number into the books," the explicit instruction from
    this file's own "New work" line below, actually enforced:** `confident:
    true` items/amounts are re-validated through the exact same
    `validateOrderItems()`/positive-number checks `record_order`/
    `record_payment` themselves use (factored into shared, exported
    functions in `tools.ts` — `validateOrderItems`, `insertValidatedOrder`
    — so the safety net can never be looser than the real tool, one
    validation source of truth, not two that could drift). Only a
    genuinely valid, confident report gets written to `orders`/`ledger`.
    Anything else — `confident: false`, or `confident: true` but the
    validation actually fails (e.g. a nonexistent `product_id`) — becomes a
    `handoff_ledger` row instead (via a new shared `recordHandoff()`,
    factored out of `notify_owner`'s own code, same "NEEDS AHMED" log
    marker), for Ahmed to confirm by hand. Nothing is ever silently lost,
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
- **Verified locally, deterministically — 16 checks, real (unmocked)
  `agent.ts`/`tools.ts` code, real DB, only the model call stubbed (with
  full control over both the tool-calling loop and the CLOSE step's JSON,
  so every shape is exercised precisely):** a real `record_order` call this
  turn is never double-logged even when the CLOSE step also (wrongly)
  claims an unlogged order with different numbers — the real order's
  actual total is what's in the DB, not the decoy; a confident, valid
  unlogged order is correctly auto-logged (order row + ledger debit both
  correct); an unconfident report creates zero orders and a handoff
  mentioning the description instead; a `confident: true` report with an
  actually-invalid product is still rejected (no order created) and
  flagged via handoff citing the real validation error — proving
  `confident: true` alone is never enough to bypass validation; the same
  three shapes repeated for payments (double-log prevention, confident
  auto-credit, unconfident handoff); a turn with neither field present has
  zero side effects (regression check) while the checkpoint/notes path
  still saves correctly; a malformed shape (`unlogged_order` as a plain
  string instead of an object) does not crash the turn and is correctly
  ignored. Scratch script and its test rows/product deleted after use; the
  live server was restarted afterward to run the new code (this session's
  work was schema-free — no migration, so the running server wasn't
  stopped first, unlike 2.1's).
- **Built from DeskcommCRM:** the *pattern* of `inbound-turn.ts`'s
  checkpoint-close call (forced second model call, strict-validated JSON,
  persisted) — steered from extracting commitments/objections to extracting
  order/payment fields.
- **Definition of done:** a normal order conversation end to end produces
  order/line-item/payment rows matching what was actually agreed, with no
  manual entry (✅ already true via 2.1/2.2's tools, reconfirmed above); a
  mentioned-but-unlogged order/payment is still caught (✅ verified above,
  both the auto-log and the flag-for-Ahmed paths, deterministically — not
  yet exercised through an actual live conversation, a separate decision
  same as 2.1/2.2 left it).
- **Status:** ✅ Done — the safety net is built and verified
  deterministically, on top of 2.1/2.2's already-working primary path. Not
  yet live-tested against a real conversation.

### 2.4 — Live stock-aware replies
- **Goal:** "do you have 20 in stock" gets a real, current answer, and a
  completed order actually decrements stock.
- **Depends on:** 2.1.
- **Ships:** `check_stock` querying the real quantity table (already exists
  in `ahmed-assistant` in basic form), plus stock decrement on order
  confirmation (not yet built).
- **Built from DeskcommCRM:** the *tool pattern* from
  `agent/search-knowledge.ts` — steered from document search to a live
  quantity query.
- **Definition of done:** stock check for a low/out item gives the real
  number; completing an order drops stock by the right amount.
- **Status:** 🟡 Basic lookup exists; decrement-on-order not started.

### 2.5 — Follow-up tracking tied to unpaid orders
- **Goal:** the system knows which customers still owe money or are waiting
  on something, ready for Ahmed to ask about in v3.
- **Depends on:** 2.1, 2.3.
- **Ships:** follow-ups linked to real order/payment state, plus a query
  path over pending/overdue ones — an **owner-initiated read path**, not
  just the bot silently acting on schedules. Important distinction: "kisko
  follow-up karna hai?" is Ahmed *querying* what's pending — that's a
  separate tool from the one that fires reminders automatically.
- **Built from DeskcommCRM — extracted and verified, staged:**
  `cron/schedule.ts` (pure scheduling math, no I/O) for the firing side.
  The read/query path has no DeskcommCRM equivalent — DeskcommCRM's version
  only fires automatically, it never exposes a "list what's scheduled"
  query. That's new work either way.
- **Definition of done:** an unpaid order automatically has a follow-up
  associated with it; a query for "pending follow-ups" returns it correctly.
- **Status:** 🔲 Not started.

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
- **Depends on:** version 1 complete.
- **Ships:** sender-identity check (Ahmed's own number), a distinct turn
  kind for owner messages that never talks to a customer and only reads
  data.
- **Built from DeskcommCRM:** the *concept* proven by
  `agent/operator-turn.ts` — a turn kind with restricted permissions —
  steered, not reused code (did not qualify for extraction: DB-coupled, and
  even if it had, it's the wrong direction — see permanent exclusions on
  the Operator/Conversador split itself).
- **New work:** the owner-turn kind itself, full stop.
- **Definition of done:** message the bot from Ahmed's own number vs. a test
  customer number — provably different behavior, with no way for a customer
  message to trigger owner-mode answers.
- **Status:** 🔲 Not started.

### 3.2 — Owner analytics Q&A tools
- **Goal:** Ahmed's four example questions all work, in his own words.
- **Depends on:** 3.1, version 2 complete.
- **Ships:** `sales_today`, `unpaid_customers`, `top_selling_product`,
  `pending_followups` — a small, fixed set of safe report functions, never
  a freely-written SQL query from the model.
- **Built from DeskcommCRM:** nothing — confirmed during extraction that no
  agent-callable analytics tool exists anywhere in the module. DeskcommCRM's
  numbers live in React dashboard code with hand-written SQL, not as
  anything an agent can call. This is the most distinctive, fully original
  part of the whole project.
- **Definition of done:** each of Ahmed's four example questions, asked in
  natural language (including Roman Urdu/Hindi phrasing), gets a correct
  answer sourced from real data.
- **Status:** 🔲 Not started.

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
- **Status:** 🔲 Not started.

**v3 exit criteria:** all four promises in `ahmed-whatsapp-assistant.md` are
fully met.

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
- **Status:** 🔲 Not started.

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
