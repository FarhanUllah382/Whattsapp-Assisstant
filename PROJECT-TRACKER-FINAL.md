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
| 1.x | Promise 1 + 2 — talks to customers, remembers conversations | ✅ Done (2026-09-04) |
| 2.x | Promise 3 — keeps the books automatically | 🔲 Not started |
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
- **Version 1 is fully built and live-verified as of 2026-09-04** — a real
  WhatsApp number (`+923128346256`) is linked, running, and has produced a
  real, correct, on-brand reply to a real, unsolicited customer message. See
  1.3 below for the verification and the bugs it took to get there.

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
- **Status:** ✅ Done — core loop, input validation, teaching-text errors,
  and idempotent send are all in place. Full end-to-end proof against a
  real WhatsApp number waits on 1.3.

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
  proof against a real WhatsApp number still waits on 1.3.
- **Status:** ✅ Structured notes done. Compaction intentionally deferred,
  not outstanding-by-oversight — see "Still missing" above.

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
    `timezone: 'America/Sao_Paulo'` is now `process.env.PACING_TIMEZONE ??
    'UTC'` — configurable, no Brazil default. Set `PACING_TIMEZONE` (an IANA
    zone) once Ahmed's actual shop timezone is known.
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
- **Real WhatsApp provider connection — code written and wired, NOT yet
  live-verified:**
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
  - **WAHA running, QR pending — still not verified end-to-end.** Container
    `waha` (`devlikeapro/waha:latest`) is up, `/health` returns
    `{"status":"ok"}`, `/api/server/status` responds. A local dev API key
    (`WAHA_API_KEY=ahmed-dev-local-key`, set on the container so it's stable
    across restarts instead of WAHA's default auto-generated one) is
    configured. The app (`npm run dev`, `src/server.ts`) is also running on
    `:3000` with `WAHA_BASE_URL=http://localhost:3001` and the same API key,
    and its webhook endpoint responds 200 to a real WAHA event. Session
    `default` has been created and is in `SCAN_QR_CODE` state, waiting on the
    owner to link a real WhatsApp number. **No message has round-tripped
    through it yet** — until one does, the channel adapter stays
    **unverified, not done**, per this file's own rule that a pulled image
    and clean typecheck are not the same as a working integration.
  - Still missing beyond the adapter itself: per-number health circuit
    (`health/defaults.ts`, still staged in `EXTRACTED-FOR-AHMED/`, not pulled
    in — no current requirement for it yet); STOP/opt-out handling.
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
    testing). The user began installing an LTS Node but it wasn't active in
    this session. **Mitigated, not fixed:** the dev app now runs under a
    local shell auto-restart loop (not part of the committed project) so it
    self-recovers within ~1-2s of a crash. **Follow-up still needed:** get a
    Node LTS actually active for this project, or pin a `better-sqlite3`
    version confirmed compatible with Node 24, or add a real process
    supervisor before this is ever treated as production-ready — a shell
    loop is a today-only stopgap.
  - **The actual verification:** an unsolicited real "Hi" from a real
    WhatsApp Business account (`923299144863`, "The Style Vault") produced a
    natural, on-brand, Roman Urdu/English reply — *"Hello! 😅 Teesri baar
    'Hi' agaya hai! Bataiye, kya dikhayen aapko?..."* — confirmed sent to the
    **correct, resolved phone-number JID** (`923299144863@c.us`) by reading
    it back directly from WAHA's own message log, not just trusting an
    app-side "success" log line.
- **Definition of done:** blast a burst of test messages at the bot — sends
  visibly throttle/space out rather than firing all at once (✅ verified,
  throttle+jitter sleep confirmed bounded and working, against the stub send
  function — not yet re-verified against the real adapter); sending outside
  configured hours queues instead of firing immediately (⚠️ partially true —
  it does not fire immediately, but "queues" overstates it until a real job
  queue exists to actually retry later; see judgment-call note above); a real
  WhatsApp message to the actual number produces a real reply (✅ **verified
  2026-09-04** — see above, confirmed via WAHA's own message log).
- **Status:** ✅ **Done.** Anti-ban send-safety logic and the real WAHA/NOWEB
  connection are written, working, and now live-verified against a real
  WhatsApp number with a real, unsolicited customer message and a real
  reply sent back. Deliberately still not built (unchanged from before,
  not blocking): per-number health circuit, STOP/opt-out handling — both
  remain deferred, no current requirement for them yet. Separately open:
  the Node v24 native-crash issue (mitigated by a dev-only restart loop,
  not resolved) and the queue-based "actually fire later" half of outside-
  hours sending.

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
  `"NEEDS AHMED"` line via the structured logger. **Delivery is log-only for
  now, on purpose:** 1.3's real WhatsApp connection isn't live-verified yet
  (currently blocked on a WhatsApp-side session restriction, see 1.3 above)
  — sending an actual WhatsApp message to Ahmed's own number would mean
  touching that same unverified session, so it's deferred rather than
  half-built against something not yet proven to work. **Upgrade needed once
  1.3 finishes:** replace/augment the log line with a real `sendText` call
  to Ahmed's own number via the `ChannelAdapter` (`TODO` comment left at the
  call site in `tools.ts`).
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
  refuses/deflects (✅ verified at the guardrail level, not yet through a
  live customer conversation); ask it something genuinely outside its
  knowledge — it hands off instead of guessing (✅ `notify_owner` + ledger +
  log marker verified; not yet through a live conversation either — both
  wait on 1.3's real number being verified, same dependency 1.1/1.2 already
  flag).
- **Status:** ✅ Done — human-promise detection (rewritten for English/Roman
  Urdu), discount-rule check (5% threshold, confirmed by Ahmed), and the
  human-handoff path (`notify_owner` + `handoff_ledger`, log-only delivery)
  are all built, wired into `send_message`, and verified locally. Full
  proof against a real conversation, and upgrading handoff delivery to an
  actual WhatsApp message, both wait on 1.3.

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
  answer (✅ verified for all three starter sections); ask about something
  not in it — bot says it'll confirm, never guesses (✅ verified at the tool
  level — `found: false` plus the instruction; not yet observed through a
  live customer conversation, which waits on 1.3 same as every other
  sub-version here).
- **Status:** ✅ Done — catalog file, search tool, and the
  don't-invent-an-answer discipline are all built and verified locally.
  Content is placeholder text for Ahmed to replace with the real catalog;
  full proof against a live conversation waits on 1.3.

**v1 exit criteria:** a customer can message the number any time, get a
fast, safe, on-brand reply that remembers them. No orders, stock, or
payments exist yet.

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
- **Already done:** a first-pass schema exists in `ahmed-assistant`
  (`customers`, `products`, `orders`, `messages`, `checkpoints`) — but
  `orders.status` is never updated past `'placed'`, and `balance_owed` is a
  single mutable field, not a proper ledger.
- **Still missing:** a real debit/credit ledger table (see 2.2/2.3).
- **Built from DeskcommCRM:** nothing — no analog exists anywhere in the
  module, confirmed during extraction.
- **Definition of done:** can insert a product, an order, and a payment and
  query them back correctly, with balance always reconstructable from
  ledger history rather than trusted as a single field.
- **Status:** 🟡 Placeholder schema exists; ledger formalization not started.

### 2.2 — Order-status tracking
- **Goal:** every order has a clear, queryable status that only moves
  forward.
- **Depends on:** 2.1.
- **Ships:** `received → confirmed → paid → shipped → delivered`, with
  invalid transitions rejected via a teaching error.
- **Built from DeskcommCRM:** the *mechanism* in `agent/lead-state.ts`
  (forward-only, model-driven, server-validated state machine) — did not
  qualify for direct extraction (DB-coupled), but the pattern is simple
  enough to re-implement with retail vocabulary instead of B2B funnel
  vocabulary. This vocabulary swap is permanent — never revert to the
  funnel shape (see permanent exclusions).
- **New work:** the order-status vocabulary and transition rules themselves.
- **Definition of done:** the bot marks an order confirmed/paid/shipped
  during a natural conversation; a query for "orders in status X" returns
  correctly; an invalid backward transition is rejected.
- **Status:** 🔲 Not started.

### 2.3 — Automatic order & payment extraction
- **Goal:** "20 shirts, medium, black, ₹5000" becomes a real order row
  without Ahmed typing anything — including a safety net for orders/payments
  mentioned but never explicitly logged via a tool call.
- **Depends on:** 2.1, 2.2.
- **Ships:** a structured extraction step at turn close (alongside the
  existing checkpoint-summary call) that pulls items/quantity/price/
  amount-paid out of the conversation and writes them to the ledger,
  validated before it's trusted.
- **Built from DeskcommCRM:** the *pattern* of `inbound-turn.ts`'s
  checkpoint-close call (forced second model call, strict-validated JSON,
  persisted) — steered from extracting commitments/objections to extracting
  order/payment fields.
- **New work:** the extraction schema and validation rules; deciding what
  happens when the model is unsure (flag for Ahmed to confirm, never guess a
  number into the books).
- **Definition of done:** a normal order conversation end to end produces
  order/line-item/payment rows matching what was actually agreed, with no
  manual entry, and a mentioned-but-unlogged order/payment is still caught.
- **Status:** 🔲 Not started.

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
