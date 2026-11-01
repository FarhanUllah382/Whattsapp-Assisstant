# Ahmed WhatsApp Assistant — Operations and Recovery Runbook

This runbook covers the current single-shop deployment. It does not authorize
Version 4 work, multi-business hosting, automatic payment/refund execution, or
any permanent exclusion. Never paste credentials, customer phone numbers,
messages, addresses, or payment references into tickets or public logs.

## 1. Normal service checks

1. `GET /health` proves only that the application process is alive. Expected:
   HTTP 200 with `status: ok`.
2. `GET /ready` checks SQLite and the configured WAHA session. Expected:
   HTTP 200, `database: ok`, and `whatsapp: WORKING`. HTTP 503 means the
   process is alive but should not receive production traffic.
3. `GET /operations/metrics` requires the separate `X-Operations-Key` value.
   It exposes queue, delivery-issue, worker, and process counts only—never
   customer bodies or phone numbers. Missing/short/wrong configuration fails
   closed with HTTP 401.
4. Check structured logs for `durable inbound job attempt failed`, `owner alert
   delivery failed`, `delivery_uncertain`, or `verified database backup failed`.

Do not treat `/health` alone as proof that WhatsApp is connected. `/ready` is
the traffic-readiness signal.

## 2. Backup and restore proof

- The application creates a verified online SQLite backup at startup and then
  at the configured finite interval. Defaults: every 24 hours, retain 14, under
  `backups/operations/`.
- Each backup is opened read-only and must pass SQLite `integrity_check` and
  `foreign_key_check` before it counts as successful or older matching backup
  files are pruned.
- Run an additional backup manually with `npm run backup`.
- Verify any candidate independently with
  `npm run backup:verify -- <absolute-path-to-backup.db>`.
- Retention deletes only files matching this application's timestamped backup
  naming pattern inside the resolved dedicated backup directory. Files outside
  that directory are never touched.

### Restore drill or real restore

1. Stop the application worker so no new writes or WhatsApp replies occur.
2. Verify the candidate backup using `backup:verify` and record its SHA-256.
3. Preserve the current `ahmed.db` as a separately named incident snapshot;
   never overwrite the only copy.
4. Copy the verified candidate to a separate drill directory first and start a
   temporary process against that copy when rehearsing. For a real restore,
   replace `ahmed.db` only after the incident owner approves the exact source
   and destination paths.
5. Start the application, check `/health` and `/ready`, then reconcile queue,
   orders, ledger, alerts, payment/refund cases, and outbound uncertain sends.
6. Send no customer message until retained inbound events and uncertain
   outbound attempts have been reviewed. A restore can move local state behind
   provider state.

Local backups protect against a damaged database file but not host loss. An
encrypted off-host destination, key owner, retention policy, and restore
credential procedure remain deployment decisions and must be completed before
commercial unattended operation.

## 3. WAHA disconnected or QR/relink required

1. Confirm `/ready` reports a non-`WORKING` WhatsApp status. Do not repeatedly
   restart or relink a session that is merely rate-limited/capped.
2. Check WAHA itself and its persistent session volume. Preserve that volume;
   deleting it forces relinking and can replay retained history.
3. If authentication is genuinely lost, have the authorized phone holder scan
   the new QR. Never send the QR through a public channel.
4. Wait for WAHA status `WORKING`, then check application `/ready`.
5. The inbound replay cutoff quarantines retained messages from downtime.
   Review logs before accepting new live traffic.

## 4. Model outage or quota exhaustion

1. Confirm whether logs show provider failure or the finite daily AI budget.
2. Do not increase or disable limits during an incident without owner approval.
3. Accepted messages remain in the durable inbound queue. AI-budget deferrals
   retain their attempt allowance and resume after the configured Karachi-day
   reset.
4. Watch queue depth and oldest pending time using authenticated metrics.
5. If customer communication is necessary, use an approved manual channel;
   never mark queued work completed by hand without processing/reconciliation.

## 5. Stuck, failed, or saturated inbound queue

1. Inspect authenticated queue counts and structured job logs. Never inspect or
   publish raw message bodies unless incident access is explicitly authorized.
2. A processing lease is recovered after restart; transient failures use
   exponential backoff; final failures remain retained and inspectable.
3. Queue saturation returns HTTP 503 so the provider can retry and sends only
   the finite, consent/pacing-controlled busy response where allowed.
4. Requeue a failed job only after identifying the cause. Reusing the same
   provider event preserves idempotency; do not create a new fake event key.

## 6. Uncertain or failed outbound delivery

1. Ask the owner assistant for outbound delivery issues, or inspect the
   authenticated metrics count.
2. `failed` means the provider definitively rejected the request; a controlled
   retry can be safe after the cause is corrected.
3. `uncertain` means the provider may already have accepted the message. Never
   retry automatically or send a differently worded copy. Check the WhatsApp
   chat/provider record first, then record a human decision in the incident
   notes. The current tool is deliberately read-only.
4. Owner alerts with uncertain delivery remain pending rather than being
   falsely marked sent.

## 7. Database corruption or foreign-key failure

1. Stop the worker immediately and preserve the database plus WAL/SHM files as
   an incident snapshot.
2. Do not run ad-hoc repair or delete rows from the only copy.
3. Verify recent backups newest-first. Select the newest backup that passes
   both integrity and foreign-key checks.
4. Follow the restore procedure above, then reconcile every business table and
   provider-side message state created after the backup timestamp.

## 8. Credential expiry or suspected secret exposure

1. Stop external traffic if the webhook HMAC, WAHA key, model key, or operations
   key may be exposed.
2. Rotate the affected credential at its provider and in the deployment secret
   store; never commit it to Git or place it in the runbook.
3. Restart, verify `/ready`, test one authenticated webhook, and review logs for
   rejected old credentials.
4. Record who rotated the key and when, without recording the secret value.

## 9. Rollback and customer communication

- Roll back code only to a commit known to understand the current database
  schema. A code rollback does not automatically roll back provider messages or
  business facts.
- Before rollback, take and verify a fresh database backup.
- After rollback, run typecheck/tests where possible, verify health/readiness,
  reconcile queues and uncertain sends, then reopen traffic.
- Customer-facing incident wording must be factual: say service is delayed or
  a message's delivery is being checked. Never claim an order, payment, refund,
  human review, or message delivery occurred without authoritative evidence.

## 10. Remaining production decisions

The following are intentionally not invented by this implementation:

- encrypted off-host backup provider, encryption key owner, and backup expiry;
- uptime/error/cost notification provider and escalation recipients;
- production host persistent-volume layout for SQLite and WAHA sessions;
- staff incident roles, response targets, maintenance window, and customer
  support channel;
- provider-supported reconciliation for sends whose acceptance response was
  lost.

These decisions must be approved and tested before the system is described as
ready for unattended commercial operation.
