# `EXTRACTED-FOR-AHMED/` — What Each File Is For

This describes what each file in the extraction folder **does for this
project**, in plain terms — not how its code works internally. Every file
here was individually verified (see `EXTRACTED-FOR-AHMED/MANIFEST.md` for
the verification detail) and is currently **staged, not yet wired into
`ahmed-assistant`.** "Version" below refers to `PROJECT-TRACKER-FINAL.md`.

---

## Anti-ban & WhatsApp send safety — for Version 1.3

### `pacing/engine.ts` + `pacing/defaults.ts`
Decides, for any given moment, whether it's actually okay to send a message
right now — or whether the bot should wait, and for how long. This is what
stops the assistant from firing off messages back-to-back in a way that
looks automated and risks WhatsApp flagging the number. Includes a slow
daily "warm-up" ramp for a number that's just starting to send volume.
`defaults.ts` holds the starting configuration (currently set to a
Brazilian timezone default — needs changing to Ahmed's actual timezone
before use).

### `spinning/engine.ts` + `spinning/defaults.ts`
Stops the bot from sending the same or near-identical message over and over
to different customers — a known pattern WhatsApp treats as spam/bot
behavior. Compares new outgoing text against recently sent messages and
flags repeats before they go out.

### `guardrails/messaging-window.ts`
Figures out whether a customer's WhatsApp "24-hour free-form messaging
window" is currently open (relevant mainly if the project ever moves to
Meta's official Cloud API rather than a QR-code connection). Doesn't store
anything itself — just calculates, from the last time the customer wrote
in, whether free replies are still allowed right now.

### `health/defaults.ts`
Starting thresholds for monitoring whether Ahmed's WhatsApp number is
showing signs of being at risk (e.g. message block rate creeping up). Not
urgent at Ahmed's single-number scale — lowest priority file in this
category.

---

## Safety guardrails — for Version 1.4

### `guardrails/human-promise.ts`
Scans a reply the bot is about to send and detects whether it promises
that "a human will follow up" — used to make sure that promise is only
ever made when a real handoff to Ahmed has actually happened, never as an
empty line the bot says just to end a conversation politely.
**Needs translation before use** — its detection rules are written in
Portuguese; Ahmed's customers write in Roman Urdu/Hindi-English, so the
patterns themselves need to be rewritten, not just plugged in.

### `edge/llm/orcamento.ts` *(extracted in an edited form)*
Pure decision logic for "has spending crossed a limit, and if so what
should happen" (allow / warn / block). The original file also contained
SQL text tied to DeskcommCRM's own billing tables — that part was removed
before extraction since it doesn't apply here. What's left is a general
building block for a **personal safety cap** on Ahmed's own AI spending
(e.g. "don't let a bug burn through my API budget overnight") — not a
multi-customer billing system, which this project will never have.

---

## Core infrastructure — cross-cutting, useful as soon as they're wired in

### `obs/logger.ts`
The project's structured logging tool — replaces scattered `console.log`
calls with a consistent format that's safe to keep customer data out of
(the project's own rule is "no raw customer data ever lands in a log").
Should be one of the first files actually wired in.

### `edge/egress.ts`
A safety wrapper around any outgoing web request the bot's tools make.
Refuses to let a tool call out to any web address that isn't on an
approved list — protects against a manipulated conversation tricking the
bot into leaking data to an attacker-controlled server.

### `channel-adapter.ts`
Defines the shape a "send/receive WhatsApp messages" connection must have,
without committing to *which* WhatsApp provider is behind it. This is what
lets the real WhatsApp integration (WAHA, or Meta's Cloud API) be built
and swapped later without rewriting the rest of the assistant.

---

## Follow-ups — for Version 2.5

### `cron/schedule.ts`
The scheduling math behind "remind this customer again on Thursday" —
given a time the bot should follow up, works out exactly when that
reminder should actually fire, including spacing multiple reminders apart
so they don't all go out at once, and what to do if a reminder is missed
and needs retrying.

### `queue/loop.ts`
A generic "keep checking if there's work to do, and sleep efficiently in
between" loop — the pattern a background process would use to notice when
a scheduled follow-up is due and act on it. Only relevant if/when this
project adds any kind of background job processing; not needed for the
current inline-processing design.

---

## Model/cost infrastructure — future use, not urgent

### `edge/llm/providers.ts`
A factory for building a connection to an AI model (Anthropic, OpenAI,
Google, etc.) from an API key and model name. Useful only if this project
ever needs to support more than one AI provider — right now it uses a
single direct connection to Claude.

### `edge/llm/capabilities.ts`
Answers "can this particular AI model understand an image if I send it
one?" — relevant for a future feature like the bot understanding a photo a
customer sends of an item they want.

### `edge/llm/stable-prefix.ts`
An optimization for reducing AI API costs on repeated conversations by
structuring requests so the provider can reuse work it already did. A
later cost-saving measure, not a functional requirement.

### `edge/llm/pricing.ts`
A lookup table of how much each AI model costs per use, for calculating
what a given conversation cost to run. Needs its model list updated to
match whatever models this project actually uses.

### `edge/llm/count-tokens.ts`
Measures the real, exact cost of a prompt using the AI provider's own
counting method, rather than estimating. Only useful once there's an
actual cost dashboard or budget cap to feed — not needed yet.

### `edge/llm/embed.ts`
Converts text into a numeric form used for meaning-based search (e.g.
"find the FAQ answer closest in meaning to this question"). Only needed if
Version 1.5's catalog/FAQ feature ends up using semantic search rather
than simpler keyword matching.

---

## Optional / not currently planned

### `agent/janela-de-atendimento.ts`
Business-hours gating — lets a bot be configured to only reply during set
hours, rescheduling anything outside that window instead of dropping it.
Not part of the current plan (the assistant is meant to reply 24/7), kept
in case Ahmed ever wants "quiet hours."

### `agent/split-message.ts`
Breaks a long reply into several shorter WhatsApp-style messages instead
of one big paragraph, the way a person texting naturally would. A
polish item — Version 1.6 territory once core functionality works.
