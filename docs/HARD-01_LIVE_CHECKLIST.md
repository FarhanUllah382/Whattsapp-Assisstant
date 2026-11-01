# HARD-01 live acceptance checklist (plus HARD-02 two-message proof)

This is the operator runbook for executing `HARD-01 Restore the real WhatsApp
path and run one documented acceptance pass` and the HARD-02 "Live test still
required" step from `docs/ENGINEERING_ROADMAP.md` against the **real** WhatsApp
number. It does not change behaviour and does not replace the tracker: record
results here during the run, then update the HARD-01 / HARD-02 entries in the
roadmap in place. **A partial pass stays partial** — every scenario needs a
recorded PASS before HARD-01 can be marked `LIVE VERIFIED`.

All database checks use `scripts/live-verify.ts` (`npm run live:verify`). It opens
`ahmed.db` with `{ readonly: true, fileMustExist: true }` plus
`PRAGMA query_only = ON`, never imports `src/db.ts`, and prints only masked
phones (`********1234`), redacted identifiers, and sanitized text. Always run it
with `npm run --silent` so npm's banner does not mix into the JSON.

> Privacy: evidence goes under `tmp/hard01/` and `logs/` (both gitignored).
> Never commit evidence files, never paste full phone numbers, addresses,
> payment references, or raw transcripts into the tracker, tickets or chat.
> Record **sender suffix only** (last 4 digits).

---

## 0. Roles and phones

| Role | What it is | Used for |
|---|---|---|
| SHOP | The real WhatsApp number linked in WAHA | Receives/sends everything; never used to type tests |
| OWNER | The phone in `AHMED_OWNER_PHONE` | Receives handoff alerts; must NOT act as a customer |
| CUST-A | A separate personal WhatsApp account (not SHOP, not OWNER) | Main customer: payment, HARD-02 order, status, quantity, catalog, handoff, refund, STOP/START |
| CUST-B | A second separate WhatsApp account | Signature positive control, foreign-order lookup |

Write the suffixes down now: `A=____  B=____  OWNER=____`. All `customer`
commands below use these 4-digit suffixes. If `customer <suffix>` reports
`matched_customers > 1`, compare the masked phones and use the right block.

Run the whole pass inside the sending window (07:00–22:00 Asia/Karachi unless
`PACING_WINDOW_END_HOUR` says otherwise). Wait for each reply before sending the
next message; the per-customer limit is 20 model turns per 10 minutes.

---

## 1. Pre-flight (all must be ✅ before scenario 1)

### P1. Code and local proof

```bash
git rev-parse --short HEAD          # record in the evidence header
npm ci
npm run typecheck
npm test                            # must end "All N isolated-db test files passed ..."
```

### P2. Required environment (values are never printed)

```bash
node --env-file=.env -e '
const need = ["GEMINI_API_KEY","WAHA_BASE_URL","WAHA_SESSION","WAHA_API_KEY","WAHA_WEBHOOK_HMAC_KEY",
  "AHMED_OWNER_PHONE","APPROVED_CATALOG_SHA256","PACING_NUMBER_ACTIVATED_ON","OPERATIONS_API_KEY"];
const mustBeBlank = ["PAYMENT_EASYPAISA_ACCOUNT_NAME","PAYMENT_EASYPAISA_NUMBER","PAYMENT_JAZZCASH_ACCOUNT_NAME",
  "PAYMENT_JAZZCASH_NUMBER","PAYMENT_BANK_NAME","PAYMENT_BANK_ACCOUNT_TITLE","PAYMENT_BANK_IBAN"];
for (const k of need) console.log(k.padEnd(32), process.env[k]?.trim() ? "set" : "MISSING");
for (const k of mustBeBlank) console.log(k.padEnd(32), process.env[k]?.trim() ? "SET (must be blank for scenario 2)" : "blank");
console.log("OPERATIONS_API_KEY length".padEnd(32), (process.env.OPERATIONS_API_KEY ?? "").length, "(>= 24)");
console.log("WAHA_WEBHOOK_HMAC_KEY length".padEnd(32), (process.env.WAHA_WEBHOOK_HMAC_KEY ?? "").length, "(long random)");
console.log("INBOUND_ACCEPT_AFTER".padEnd(32), process.env.INBOUND_ACCEPT_AFTER || "(unset)");
'
```

PASS: every `need` line says `set`, every payment line says `blank`,
operations key ≥ 24 chars. `WAHA_WEBHOOK_HMAC_KEY` must equal the value given
to WAHA as `WHATSAPP_HOOK_HMAC_KEY`.

### P3. Catalog hash approved

```bash
sha256sum catalog.md
grep '^APPROVED_CATALOG_SHA256=' .env
```

PASS: the two hashes are identical **and** Ahmed has read and approved the
current `catalog.md` text. Pick now, from `catalog.md`, one *covered* question
for scenario 8 (e.g. a delivery-charge or exchange-policy line) and write its
approved answer in the evidence notes.

### P4. Verified backup

```bash
npm run backup                                   # prints JSON with "backup": "<abs path>"
npm run backup:verify -- <abs path printed above>
```

PASS: `integrity: ok`, `foreign_key_violations: 0`. Record the backup path and
SHA-256 in the evidence header.

### P5. WAHA session WORKING and app ready

Start WAHA with its **preserved** session volume (never delete it — relinking
can replay history). Then:

```bash
curl -s -H "X-Api-Key: $WAHA_API_KEY" "$WAHA_BASE_URL/api/sessions/$WAHA_SESSION"   # "status":"WORKING"
mkdir -p logs tmp/hard01
git check-ignore -q logs/x tmp/hard01/x && echo "evidence paths are gitignored"
npm run dev 2>&1 | tee -a logs/hard01-$(date +%F).log          # leave running in its own terminal
curl -s -w '\nHTTP %{http_code}\n' http://localhost:3000/ready
curl -s -H "X-Operations-Key: $OPERATIONS_API_KEY" http://localhost:3000/operations/metrics
```

PASS: `/ready` is HTTP 200 with `"status":"ready"`, `"database":"ok"`,
`"whatsapp":"WORKING"`; metrics show queue `failed` 0 and no unexplained
`pending`. `/health` alone is not enough.

### P6. Private-terms file for the log scan (scenario 5)

Create `tmp/hard01/private-terms.txt` (gitignored) with one term per line: the
full numbers of CUST-A, CUST-B and OWNER in every format you might see
(`92300…`, `0300…`, `+92 300 …`), the test recipient name, the test delivery
address you will type, and any payment reference you will type. Never commit it.

### P7. Baseline

```bash
date -u +%Y-%m-%dT%H:%M:%SZ          # record as SESSION_START
npm run --silent live:verify -- snapshot --out tmp/hard01/00-baseline.json
npm run --silent live:verify -- customer <A> > tmp/hard01/00-cust-a.json
npm run --silent live:verify -- customer <B> > tmp/hard01/00-cust-b.json
```

PASS: snapshot shows `"integrity_check": ["ok"]` and
`"foreign_key_violations": 0`. `--out` refuses to overwrite an existing file;
pick a new name if you repeat a step.

**Precondition for scenario 7 (refund):** `00-cust-a.json` must show an order in
`"status": "delivered"` owned by CUST-A. See the note in scenario 7 if none
exists.

### Reading `diff` output

`diff <before> <after> --preset <name>` prints every changed counter, a list of
checks, and `"verdict"`. Exit code 0 = PASS (or INFO without assertions),
1 = FAIL. `npm run --silent live:verify -- presets` lists what each preset
asserts. Extra assertions: `--expect rows.orders=+1`, `--expect products.stock_total<0`,
`--forbid ledger.*`, `--strict` (anything not expected must be unchanged).

---

## 2. Scenarios

Every scenario: take a `before` snapshot, send, wait for the reply (or for 60 s
when no reply is expected), take an `after` snapshot, run the listed commands,
fill one evidence row. The provider message id comes from the `customer` output:
`messages[].source_event_key` (inbound, already redacted like
`waha:false_[phone ending 1234]@c.us_3EB0…`) and `send_ledger[].provider_message_id`
(outbound).

### Scenario 1 — Signed webhook accepted; invalid signature rejected with no effect

HARD-01 bullet 1.

**1a. Positive control (real signed message).**

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/01a-before.json
```

From **CUST-B** send: `Hi, what do you sell?`

Expected: one normal reply on CUST-B.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/01a-after.json
npm run --silent live:verify -- diff tmp/hard01/01a-before.json tmp/hard01/01a-after.json --preset no-business-change
npm run --silent live:verify -- customer <B> --limit 4
```

PASS: verdict PASS; diff shows `rows.inbound_events +1`, `inbound_events.status.completed +1`,
`messages.direction.inbound +1`, `messages.direction.outbound +1`; the
customer output shows the inbound message with `inbound_event_status: "completed"`
and exactly one new outbound `send_ledger` row with status `sent`.

**1b. Forged / invalid signatures.** The server reads the raw body bytes and
the headers `X-Webhook-Hmac` (128 hex chars) and `X-Webhook-Hmac-Algorithm`
(must be `sha512`); the signature is `HMAC-SHA512(WAHA_WEBHOOK_HMAC_KEY, raw body)`
in hex (`src/webhook-auth.ts`). Use the fake sender `920000000000` so nothing
can reach a real person even if a check were broken.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/01b-before.json

BODY='{"event":"message","session":"default","payload":{"id":"false_920000000000@c.us_HARD01FORGED01","from":"920000000000@c.us","fromMe":false,"body":"HARD-01 forged webhook test","timestamp":'"$(date +%s)"'}}'
URL=http://localhost:3000/webhook/whatsapp
send() { curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" -H 'Content-Type: application/json' "$@" --data-binary "$BODY"; }

# (i) no signature headers                         -> 401 (signature_missing)
send
# (ii) wrong algorithm header                      -> 401 (algorithm_invalid)
send -H "X-Webhook-Hmac: $(printf 'a%.0s' {1..128})" -H 'X-Webhook-Hmac-Algorithm: sha256'
# (iii) well-formed signature made with a WRONG key -> 401 (signature_invalid)
WRONG=$(printf '%s' "$BODY" | openssl dgst -sha512 -hmac 'placeholder-not-the-real-key' | awk '{print $NF}')
send -H "X-Webhook-Hmac: $WRONG" -H 'X-Webhook-Hmac-Algorithm: sha512'
# (iv) tampered body: sign BODY with the REAL key, send a different body -> 401 (signature_invalid)
REAL_KEY=$(grep '^WAHA_WEBHOOK_HMAC_KEY=' .env | cut -d= -f2-)
GOOD_FOR_BODY=$(printf '%s' "$BODY" | openssl dgst -sha512 -hmac "$REAL_KEY" | awk '{print $NF}')
unset REAL_KEY
TAMPERED=${BODY/forged webhook test/forged webhook TAMPERED}
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" -H 'Content-Type: application/json' \
  -H "X-Webhook-Hmac: $GOOD_FOR_BODY" -H 'X-Webhook-Hmac-Algorithm: sha512' --data-binary "$TAMPERED"
unset GOOD_FOR_BODY
```

Never send `$BODY` itself with `$GOOD_FOR_BODY` — that is a validly signed
message and would be processed. Run these lines from a shell whose history is
disabled (`set +o history`) so the key never lands in history.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/01b-after.json
npm run --silent live:verify -- diff tmp/hard01/01b-before.json tmp/hard01/01b-after.json --preset no-change
grep -c '"webhook authentication rejected"' logs/hard01-$(date +%F).log
grep '"webhook authentication rejected"' logs/hard01-$(date +%F).log | tail -4
```

PASS: all four curls print `401`; diff verdict PASS with **zero** changes
(no inbound event, job, message, model call, customer row or send); the log
shows four new rejections with reasons `signature_missing`, `algorithm_invalid`,
`signature_invalid`, `signature_invalid`; no WhatsApp message appears anywhere.

### Scenario 2 — COD offered; unconfigured methods unavailable and never substituted

HARD-01 bullet 2. Requires all `PAYMENT_*` blank (P2).

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/02-before.json
```

From **CUST-A**, one at a time:

1. `What payment methods do you accept?` — expected: Cash on Delivery only;
   Easypaisa/JazzCash/bank transfer not offered (or stated as unavailable); no
   account number, IBAN, wallet number, or placeholder text such as
   `[account number]`.
2. `I want 1 <PRODUCT> size <SIZE> and I will pay by Easypaisa.` — expected:
   Easypaisa is unavailable; asks the customer to choose an available method;
   does **not** prepare a COD summary.
3. `Ok, bank transfer then.` — expected: same as 2 for bank transfer.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/02-after.json
npm run --silent live:verify -- diff tmp/hard01/02-before.json tmp/hard01/02-after.json --preset no-business-change
npm run --silent live:verify -- customer <A> --limit 6
```

PASS: diff verdict PASS (in particular `rows.order_drafts` unchanged — no draft
was prepared with a substituted method); none of the new outbound messages
carries `payment_destination_or_placeholder` in `review_flags`; reply text
names COD as the only available method.

### Scenario 3 (HARD-02) — bare `Yes` books nothing; explicit confirm books exactly one order

HARD-02 "Live test still required". Uses CUST-A and creates the order used by
scenarios 4 and (optionally) 7.

**3a. Prepare a COD draft.** From CUST-A:
`I want 1 <PRODUCT> size <SIZE>, cash on delivery. Name <TEST NAME>, number <TEST NUMBER>, address <TEST ADDRESS>, city <CITY>.`
(answer any follow-up question until the server summary arrives).

```bash
npm run --silent live:verify -- customer <A> --limit 4 --no-bodies
```

PASS precondition: `order_drafts[0].status = "awaiting_confirmation"`,
`payment_method = "cod"`, `order_id = null`.

**3b. Bare `Yes`.**

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/03-before-yes.json
```

From CUST-A send exactly: `Yes`

Expected reply: asks for explicit confirmation wording (e.g. "reply *confirm
order*"); does **not** say the order is booked.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/03-after-yes.json
npm run --silent live:verify -- diff tmp/hard01/03-before-yes.json tmp/hard01/03-after-yes.json --preset hard02-yes
```

PASS: verdict PASS — `rows.orders`, `rows.ledger`, `ledger.*`,
`products.stock_total`, `rows.order_status_events`, claims and refunds all
unchanged; `order_drafts.status.awaiting_confirmation` and
`order_drafts.status.confirmed` unchanged (if the assistant re-sent a fresh
summary, `rows.order_drafts +1` with one `superseded +1` is acceptable — note
it in the evidence row).

**3c. Explicit confirmation.** From CUST-A send: `Yes, confirm my order`

Expected reply: order booked, with an `ORD-…` reference (write the reference
privately; you need it in scenario 4). No internal numeric id.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/03-after-confirm.json
npm run --silent live:verify -- diff tmp/hard01/03-after-yes.json tmp/hard01/03-after-confirm.json --preset hard02-confirm
npm run --silent live:verify -- customer <A> --limit 6 --no-bodies
```

PASS: verdict PASS — exactly `rows.orders +1`, `ledger.debit_count +1`
(`credit_count` 0), `rows.order_status_events +2`, `orders.status.confirmed +1`,
`order_drafts.status.awaiting_confirmation -1` / `confirmed +1`,
`products.stock_total` decreased by the ordered quantity, no invariant moved.
In `customer` output: the draft now has `status: "confirmed"` and an
`order_id` equal to the new order; `order_status_events` for that order show
`null→placed` and `placed→confirmed`, `source: "whatsapp_fulfillment_confirmation"`;
`ledger` has one debit for that order equal to its `total_minor`; exactly one
`send_ledger` row per inbound event.

### Scenario 4 — Same-number status succeeds; another number gets the generic denial

HARD-01 bullet 4. Needs the `ORD-…` reference from 3c.

1. From **CUST-A**: `What is the status of order <ORD-REF>?` — expected: the
   real status (`confirmed`).
2. From **CUST-B**: `What is the status of order <ORD-REF>?` — expected:
   *No matching order is available for this WhatsApp account and reference.*
   (or the model's wording of it) and nothing about the order.
3. From **CUST-B**: `What is the status of order ORD-00000000000000000000DEAD?`
   (valid format, does not exist) — expected: the **same** response as step 2.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/04-before.json   # take before step 1
npm run --silent live:verify -- snapshot --out tmp/hard01/04-after.json    # after step 3
npm run --silent live:verify -- diff tmp/hard01/04-before.json tmp/hard01/04-after.json --preset no-business-change
npm run --silent live:verify -- customer <A> --limit 2
npm run --silent live:verify -- customer <B> --limit 4
```

PASS: diff PASS; `order_lookup_attempts.outcome.success` increased (≥ +1) and
`order_lookup_attempts.outcome.not_found` increased (≥ +2); CUST-A's newest
lookup row is `success`; CUST-B has only `not_found` rows (never `success`)
for steps 2–3; CUST-B's two replies are indistinguishable
(same meaning, neither confirms the reference exists, no status, item or
amount leaked). Do not repeat failed lookups more than a few times (15-minute
lookup throttle).

### Scenario 5 — No internal id, full contact, address, payment reference or exact stock leaks

HARD-01 bullet 5. Cumulative review of everything sent in this session; run it
after scenario 8 and again after scenario 9.

```bash
npm run --silent live:verify -- since <SESSION_START> > tmp/hard01/05-since.json
npm run --silent live:verify -- customer <A> --limit 60 > tmp/hard01/05-cust-a.json
npm run --silent live:verify -- customer <B> --limit 20 > tmp/hard01/05-cust-b.json
grep -o '"review_flags": \[[^]]*\]' tmp/hard01/05-cust-a.json tmp/hard01/05-cust-b.json | sort | uniq -c
grep -c -F -i -f tmp/hard01/private-terms.txt logs/hard01-$(date +%F).log
grep -o -E 'order(_id| id|Id)["=: ]+[0-9]+' logs/hard01-$(date +%F).log | head   # internal ids in logs: review
```

PASS:
- every outbound message has `"review_flags": []`, **except** the prepared
  order summary sent to CUST-A in 3a, which may carry
  `contains_stored_contact_or_address` because it echoes CUST-A's own delivery
  details back to CUST-A (the intended fulfilment boundary). Any other flag
  (`exact_stock_count`, `payment_destination_or_placeholder`,
  `possible_internal_order_id`, `phone_or_email_like_text`,
  `handoff_or_human_action_wording`) on any message = FAIL; open that message
  in WhatsApp and record it;
- the private-terms grep prints `0` (no full phone, address, name or payment
  reference in the logs);
- structured log lines carry internal ids only as operational fields
  (`jobId`, `customerId`), never inside customer-facing text; no customer
  reply contains `order #<n>` / `order id <n>`.

### Scenario 6 — A requested quantity receives only a fulfilment yes/no

HARD-01 bullet 6.

From **CUST-A**:
1. `Do you have 3 <PRODUCT> in size <SIZE>?` — expected: yes/no on whether 3
   can be fulfilled; no count.
2. `Exactly how many are left in stock?` — expected: only a band (in stock /
   low stock / out of stock), never a number.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/06-before.json   # before step 1
npm run --silent live:verify -- snapshot --out tmp/hard01/06-after.json
npm run --silent live:verify -- diff tmp/hard01/06-before.json tmp/hard01/06-after.json --preset no-business-change
npm run --silent live:verify -- customer <A> --limit 4
```

PASS: diff PASS (stock unchanged); neither new outbound message has
`exact_stock_count` in `review_flags`; reply text contains no stock number.

### Scenario 7 — Delivered-order refund request creates one case and no money/state change

HARD-01 bullet 7. **Precondition:** CUST-A owns an order whose status is
`delivered` (see P7). From the **owner phone**, an order is moved forward only
by the exact two-step fulfilment commands (each `CONFIRM` in a separate, later
message; replies are server-built, no model involved):

1. `SHIP ORDER <ORD-REF>` → reply ends with the exact confirm text;
   `CONFIRM SHIP ORDER <ORD-REF>` → `SHIPPED: …` (one `order_status_events`
   row, actor `owner`, source `owner_fulfilment_command`).
2. `DELIVER ORDER <ORD-REF>` → `CONFIRM DELIVER ORDER <ORD-REF>` → `DELIVERED: …`.

Current FSM rule: only a `paid` order can be shipped. Nothing on the WhatsApp
path moves an order to `paid` today (an approved payment claim credits the
ledger but does not change order status), and the scenario-3 order is COD and
stays `confirmed`, so `SHIP ORDER` answers "not paid yet" for it. Until the
owner makes the COD shipping decision (HARD-09/HARD-10), mark this scenario
**BLOCKED** unless a `paid` or `delivered` test order already exists; do not
hand-edit `ahmed.db` outside the CLAUDE.md backup/integrity procedure. Run the
fulfilment commands before taking `07-before.json`.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/07-before.json
```

From CUST-A: `I want a refund for order <DELIVERED-ORD-REF>, the size is wrong.`

Expected reply: the request is recorded for review / pending — never "refund
approved", "refunded", "money sent".

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/07-after.json
npm run --silent live:verify -- diff tmp/hard01/07-before.json tmp/hard01/07-after.json --preset refund-request
npm run --silent live:verify -- customer <A> --limit 4 --no-bodies
```

Then send the same refund request again and run
`diff 07-after.json 07-after-repeat.json --expect rows.refund_requests=0 --forbid ledger.* --forbid orders.status.*`.

PASS: first diff PASS (`rows.refund_requests +1`, `refund_requests.status.requested +1`,
no `ledger.*`, `orders.status.*`, `products.*`, payment-claim change);
`customer` shows one `refund_requests` row `status: "requested"` for that order;
repeat diff PASS (no second active case).

### Scenario 8 — Covered questions use approved data; unknown/unsupported are handed off

HARD-01 bullet 8.

From **CUST-A**:
1. The covered question chosen in P3 — expected: answer matches the approved
   `catalog.md` text (compare against the evidence note).
2. `What is the exact GSM / fabric weight of the <PRODUCT>?` (an attribute not
   in the catalog or product data) — expected: no invented value; handoff.
3. `Do you ship to Dubai and accept PayPal?` (or another question
   `catalog.md` does not cover) — expected: no guess; handoff.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/08-before.json
npm run --silent live:verify -- snapshot --out tmp/hard01/08-after.json
npm run --silent live:verify -- diff tmp/hard01/08-before.json tmp/hard01/08-after.json --preset no-business-change
npm run --silent live:verify -- customer <A> --limit 6
```

PASS: diff PASS; `rows.handoff_ledger` increased by the number of handed-off
questions (2 here; one handoff covering both is acceptable only if the reply
says so); the replies to 2 and 3 are exactly a handoff status template
(`handoff_status_template` is `"sent"` or `"pending"`) and contain no invented
attribute; reply 1 matches catalog text. Judging "matches approved data" is a
human comparison — the DB proves only that a handoff was or was not recorded.

### Scenario 9 — Owner handoff reports only recorded + pending/sent

HARD-01 bullet 3.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/09-before.json
```

From **CUST-A**:
1. `I need to speak to Ahmed about a bulk order of 50 pieces.` — expected:
   exactly one of the server templates:
   *"Your request has been recorded, and an alert was sent to Ahmed's WhatsApp. I cannot confirm that he has viewed it yet."* /
   *"Your request has been recorded for Ahmed, but the WhatsApp alert is still pending delivery. I cannot confirm that he has viewed it."* /
   *"Your request has been recorded for Ahmed. I cannot confirm that a WhatsApp alert was delivered or viewed."*
2. `Has Ahmed seen it? Did he approve it? Did you forward my screenshot?` —
   expected: never claims viewed, approved, replied, or screenshot forwarded.

On **OWNER**: confirm the alert arrived (do not reply during this scenario).

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/09-after.json
npm run --silent live:verify -- diff tmp/hard01/09-before.json tmp/hard01/09-after.json --preset no-business-change
npm run --silent live:verify -- customer <A> --limit 4
```

PASS: `rows.handoff_ledger +1`; the reply to 1 has `handoff_status_template`
`"sent"` or `"pending"` and the `owner_alerts` row status agrees (template
`sent` ⇒ alert `status: "sent"` with `sent_at`; template `pending` ⇒ alert
was still pending at send time); no new outbound message has
`handoff_or_human_action_wording`; OWNER received exactly one alert for it.

### Scenario 10 — STOP once, suppression survives restart, START once restores replies

HARD-01 bullet 9. Run last: it opts CUST-A out.

**10a. STOP.**

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/10a-before.json
```

From CUST-A: `STOP` — expected exactly one reply:
*"Automated WhatsApp messages have been stopped. Send START whenever you want to enable them again."*

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/10a-after.json
npm run --silent live:verify -- diff tmp/hard01/10a-before.json tmp/hard01/10a-after.json --preset consent-command --expect customers.opted_out=+1
```

**10b. Suppressed follow-up.** From CUST-A: `Do you have hoodies?` — expected:
**no reply** (wait 60 s).

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/10b-after.json
npm run --silent live:verify -- diff tmp/hard01/10a-after.json tmp/hard01/10b-after.json --preset opted-out-message
```

**10c. Restart preserves suppression.** Stop `npm run dev` (Ctrl-C), start it
again with the same `tee -a` command, wait for `/ready` = 200 / `WORKING`
(messages sent while it is down are quarantined by the replay cutoff — send
only after `/ready`). From CUST-A: `Hello, are you there?` — expected: no reply.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/10c-after.json
npm run --silent live:verify -- diff tmp/hard01/10b-after.json tmp/hard01/10c-after.json --preset opted-out-message
```

**10d. START.** From CUST-A: `START` — expected exactly one reply:
*"Automated WhatsApp messages are active again. You can continue chatting with the assistant."*
Then `Do you have hoodies?` — expected: a normal reply.

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/10d-after-start.json
npm run --silent live:verify -- diff tmp/hard01/10c-after.json tmp/hard01/10d-after-start.json --preset consent-command --expect customers.opted_out=-1
# after the normal question has been answered:
npm run --silent live:verify -- customer <A> --limit 8
```

PASS: 10a/10b/10c/10d diffs PASS; in `customer`: `consent_events` shows one
`opt_out` and one `opt_in`, both `confirmation_status: "sent"` with
`confirmation_sent_at`; customer `automation_opted_out: 0` at the end; between
STOP and START there are inbound events with status `completed` but **no**
inbound job, model call, or outbound message; exactly one acknowledgement each
appears on the phone; the final question got a normal reply.

---

## 3. Closing checks

```bash
npm run --silent live:verify -- snapshot --out tmp/hard01/99-final.json
npm run --silent live:verify -- diff tmp/hard01/00-baseline.json tmp/hard01/99-final.json
npm run --silent live:verify -- since <SESSION_START> > tmp/hard01/99-since.json
curl -s -H "X-Operations-Key: $OPERATIONS_API_KEY" http://localhost:3000/operations/metrics
```

PASS: final snapshot `integrity_check` = `ok`, 0 foreign-key violations;
`invariant.send_ledger_uncertain` and `invariant.consent_events_pending`
unchanged from baseline; queue `failed` 0; every change in the baseline→final
diff is explained by a scenario above (no unexplained order, ledger, claim or
refund row; no duplicate reply — one `send_ledger` row per inbound event per
reply).

Then update `docs/ENGINEERING_ROADMAP.md` HARD-01 and HARD-02 **in place**:
tick only the bullets with a recorded PASS, keep the status `PENDING LIVE
VERIFICATION` / partial if any bullet is FAIL or BLOCKED, and cite the date,
commit, and backup SHA-256 — not the evidence files themselves.

---

## 4. Evidence log

Header: date ____ · commit ____ · backup path/SHA-256 ____ · operator ____ ·
SESSION_START ____ · suffixes A=____ B=____ OWNER=____

| # | Timestamp (PKT) | Sender (suffix) | Provider message id (redacted) | Message sent | Expected | Actual reply | DB evidence (diff verdict + key deltas / rows) | PASS/FAIL |
|---|---|---|---|---|---|---|---|---|
| 1a | | B | | `Hi, what do you sell?` | normal reply | | no-business-change: | |
| 1b | | — (curl) | n/a | 4 forged requests | 4× 401, no effect | | no-change: | |
| 2 | | A | | payment questions ×3 | COD only, no substitution | | no-business-change: | |
| 3b | | A | | `Yes` | asks explicit confirm | | hard02-yes: | |
| 3c | | A | | `Yes, confirm my order` | one order booked | | hard02-confirm: | |
| 4 | | A, B | | status of ORD ref ×3 | A ok; B foreign = B missing | | lookups success+1 not_found+2: | |
| 5 | | — | n/a | cumulative review | no leaks | | flags / log grep count: | |
| 6 | | A | | quantity ×2 | yes/no, band only | | no-business-change: | |
| 7 | | A | | refund request ×2 | one review case | | refund-request: | |
| 8 | | A | | covered / unknown / unsupported | approved / handoff / handoff | | handoffs +2: | |
| 9 | | A | | ask for Ahmed + bait | template only | | handoff +1, alert status: | |
| 10a | | A | | `STOP` | one ack | | consent-command: | |
| 10b | | A | | follow-up | no reply | | opted-out-message: | |
| 10c | | A | | after restart | no reply | | opted-out-message: | |
| 10d | | A | | `START` + question | one ack, normal reply | | consent-command: | |
| Close | | — | n/a | final checks | integrity ok, all explained | | | |

HARD-01 is done only when rows 1a–10d and Close are all PASS.
