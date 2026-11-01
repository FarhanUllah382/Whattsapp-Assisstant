-- Everything Ahmed's assistant needs to remember. On purpose: no organization_id,
-- no multi-tenant scoping — this whole database belongs to one business.

create table if not exists customers (
  id integer primary key autoincrement,
  phone text not null unique,          -- WhatsApp number, our lookup key
  name text,                            -- filled in once the AI learns it
  disclosure_sent_at text,              -- set once the "I'm a virtual assistant" notice has gone out
  automation_opted_out integer not null default 0 check (automation_opted_out in (0, 1)),
  opted_out_at text,
  opted_in_at text,
  created_at text not null default (datetime('now'))
  -- No balance_owed column (Version 2.1) — a single mutable field couldn't
  -- be reconstructed or audited. What a customer owes is now derived by
  -- summing the `ledger` table below, never trusted as a standalone number.
);

-- Deterministic customer consent history. These commands are handled before
-- the model is called. One pending acknowledgement per real state change is
-- retried through the guarded send path until it is recorded as sent.
create table if not exists customer_consent_events (
  id integer primary key autoincrement,
  customer_id integer not null references customers(id),
  event_key text not null unique,
  action text not null check (action in ('opt_out', 'opt_in')),
  normalized_command text not null check (length(normalized_command) between 1 and 100),
  confirmation_status text not null
    check (confirmation_status in ('pending', 'sent', 'not_required')),
  created_at text not null default (datetime('now')),
  confirmation_sent_at text
);

create index if not exists customer_consent_pending_idx
  on customer_consent_events(confirmation_status, id);

create table if not exists products (
  id integer primary key autoincrement,
  sku text collate nocase
    check (sku is null or length(trim(sku)) between 2 and 64),
  name text not null,        -- e.g. "shirt"
  category text,
  size text,                 -- e.g. "medium"
  color text,                -- e.g. "black"
  price_minor integer not null
    check (typeof(price_minor) = 'integer' and price_minor >= 0), -- Pakistani paisas
  stock integer not null default 0,
  active integer not null default 1 check (active in (0, 1)),
  image_filename text
    check (
      image_filename is null or (
        length(image_filename) between 5 and 128
        and image_filename not like '%/%'
        and image_filename not like '%\%'
      )
    ),
  aliases_json text not null default '[]'
    check (json_valid(aliases_json) and json_type(aliases_json) = 'array'),
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

-- SQLite cannot add a CHECK constraint to an existing table in place. These
-- triggers provide the same database-level backstop for both new and existing
-- installations while the reviewed exact-money/order-items migration remains
-- separate work. Application code must still use conditional reservation.
create trigger if not exists products_stock_nonnegative_insert
before insert on products
when new.stock < 0
begin
  select raise(abort, 'product stock cannot be negative');
end;

create trigger if not exists products_stock_nonnegative_update
before update of stock on products
when new.stock < 0
begin
  select raise(abort, 'product stock cannot be negative');
end;

-- Status is a forward-only state machine (Version 2.1), enforced in
-- src/orders.ts, not just this constraint — the constraint is a backstop
-- against a bad direct UPDATE, not the primary gate. Retail vocabulary only:
-- placed -> confirmed -> paid -> shipped -> delivered, or cancelled (only
-- before shipped — see ALLOWED_TRANSITIONS in orders.ts). Never the B2B
-- funnel vocabulary (new/contacted/qualifying/...) — permanently excluded,
-- see CLAUDE.md §6.
create table if not exists orders (
  id integer primary key autoincrement,
  public_ref text collate nocase unique
    check (public_ref is null or (
      length(public_ref) = 24 and upper(substr(public_ref, 1, 4)) = 'ORD-' and
      upper(substr(public_ref, 5)) not glob '*[^0-9A-F]*'
    )),
  customer_id integer not null references customers(id),
  items_json text not null,   -- [{product_id, qty, price_minor}], price snapshot
  total_minor integer not null
    check (typeof(total_minor) = 'integer' and total_minor >= 0), -- Pakistani paisas
  shipping_minor integer not null default 0
    check (typeof(shipping_minor) = 'integer' and shipping_minor >= 0),
  recipient_name text,
  contact_phone text,
  delivery_address text,
  city text,
  postal_code text,
  delivery_instructions text,
  payment_method text
    check (payment_method is null or payment_method in ('cod', 'bank_transfer', 'easypaisa', 'jazzcash')),
  status text not null default 'placed'
    check (status in ('placed', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled')),
  created_at text not null default (datetime('now'))
);

-- Security audit correction: customer-facing lookups use a high-entropy
-- public reference, never the sequential internal primary key. The insert
-- trigger and existing-row backfill are installed in src/db.ts after legacy
-- databases have received the additive public_ref column.

create table if not exists order_lookup_attempts (
  id integer primary key autoincrement,
  customer_id integer not null references customers(id),
  reference_hash text not null,
  outcome text not null check (outcome in ('success', 'not_found', 'rate_limited')),
  created_at text not null default (datetime('now'))
);

create index if not exists order_lookup_attempts_customer_time_idx
  on order_lookup_attempts(customer_id, created_at);

-- A fulfillment draft is deliberately not an order. It holds the complete,
-- server-priced delivery summary while the assistant waits for a later,
-- explicit confirmation message from the same customer. Only confirm_order
-- may convert an awaiting draft into an orders row.
create table if not exists order_drafts (
  id integer primary key autoincrement,
  customer_id integer not null references customers(id),
  items_json text not null,
  total_minor integer not null
    check (typeof(total_minor) = 'integer' and total_minor >= 0),
  shipping_minor integer not null default 0
    check (typeof(shipping_minor) = 'integer' and shipping_minor >= 0),
  recipient_name text not null,
  contact_phone text not null,
  delivery_address text not null,
  city text not null,
  postal_code text,
  delivery_instructions text,
  payment_method text not null
    check (payment_method in ('cod', 'bank_transfer', 'easypaisa', 'jazzcash')),
  status text not null default 'awaiting_confirmation'
    check (status in ('awaiting_confirmation', 'confirmed', 'superseded')),
  prepared_event_key text unique,
  confirmed_event_key text unique,
  order_id integer references orders(id),
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  confirmed_at text
);

create unique index if not exists order_drafts_one_awaiting_per_customer
  on order_drafts(customer_id) where status = 'awaiting_confirmation';

create index if not exists order_drafts_customer_status_idx
  on order_drafts(customer_id, status, id);

-- Append-only audit history for every order creation/status transition made
-- after this table is introduced. Existing orders are deliberately not
-- backfilled: their historical actor/evidence cannot be reconstructed safely.
-- Application code writes an event in the same transaction as the status,
-- stock, and ledger effects; there is no update/delete API for these rows.
create table if not exists order_status_events (
  id integer primary key autoincrement,
  order_id integer not null references orders(id),
  from_status text
    check (from_status is null or from_status in ('placed', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled')),
  to_status text not null
    check (to_status in ('placed', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled')),
  actor_type text not null
    check (actor_type in ('customer', 'owner', 'payment_provider', 'courier', 'system')),
  actor_customer_id integer references customers(id),
  source text not null check (length(trim(source)) between 1 and 80),
  source_event_key text,
  evidence text not null check (length(trim(evidence)) between 1 and 500),
  created_at text not null default (datetime('now'))
);

create index if not exists order_status_events_order_idx
  on order_status_events(order_id, id);

-- One row per debit (an order placed — customer now owes more) or credit
-- (a payment — customer owes less) event. `customers`' balance is always
-- this table's running sum, never a mutated standalone field (Version 2.1)
-- — reconstructable from history, auditable, and never silently drifts out
-- of sync with what actually happened.
create table if not exists ledger (
  id integer primary key autoincrement,
  customer_id integer not null references customers(id),
  order_id integer references orders(id), -- null for a payment not tied to one specific order
  kind text not null check (kind in ('debit', 'credit')),
  amount_minor integer not null
    check (typeof(amount_minor) = 'integer' and amount_minor >= 0), -- Pakistani paisas; direction comes from `kind`
  created_at text not null default (datetime('now'))
);

-- Raw conversation log. This is the "scroll up in old chats" Ahmed used to do himself.
create table if not exists messages (
  id integer primary key autoincrement,
  customer_id integer not null references customers(id),
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null,
  source_event_key text
    check (source_event_key is null or direction = 'inbound'),
  created_at text not null default (datetime('now'))
);

-- The "memory" that survives between conversations, so the AI doesn't need to
-- re-read hundreds of raw messages every single turn. One row per customer,
-- we just overwrite it each turn (see agent.ts). This is the tiny cousin of
-- `lead_checkpoints` in the big reference system.
create table if not exists checkpoints (
  customer_id integer primary key references customers(id),
  summary text not null,      -- free-text: "ordered 20 black M shirts, owes 4000, promised payment Friday"
  updated_at text not null default (datetime('now'))
);

-- Durable outbound-attempt ledger shared by customer and owner conversational
-- replies. It deliberately stores a body hash rather than another plaintext
-- copy of the message. `uncertain` means the provider may have accepted the
-- send but the process could not prove it; such attempts are never retried
-- automatically because doing so could create a duplicate visible message.
create table if not exists send_ledger (
  id text primary key,
  customer_id integer not null references customers(id),
  recipient_kind text not null default 'customer'
    check (recipient_kind in ('customer', 'owner')),
  event_key text,
  body_hash text,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'uncertain')),
  attempt_count integer not null default 1 check (attempt_count >= 1),
  provider_message_id text,
  last_error_code text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

-- Atomic receipts for bookkeeping side effects triggered by one provider
-- message. If WAHA retries the same webhook after a process crash, the tool
-- returns its original result instead of inserting a second order/payment.
create table if not exists bookkeeping_receipts (
  id text primary key,
  customer_id integer not null references customers(id),
  effect text not null,
  result_json text not null,
  created_at text not null default (datetime('now'))
);

-- Production hardening: a customer's statement that they paid is evidence to
-- review, never authority to change the ledger. Only the authenticated owner
-- path may resolve a pending claim; approval and its ledger credit commit in
-- one transaction. Order status deliberately remains unchanged on approval.
create table if not exists payment_claims (
  id integer primary key autoincrement,
  customer_id integer not null references customers(id),
  order_id integer references orders(id),
  amount_minor integer not null
    check (typeof(amount_minor) = 'integer' and amount_minor > 0), -- Pakistani paisas
  method text,
  reference text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  event_key text unique,
  resolved_by_customer_id integer references customers(id),
  approval_reversed_at text,
  approval_reversed_by_customer_id integer references customers(id),
  created_at text not null default (datetime('now')),
  resolved_at text,
  check (
    (approval_reversed_at is null and approval_reversed_by_customer_id is null) or
    (approval_reversed_at is not null and approval_reversed_by_customer_id is not null)
  )
);

create index if not exists payment_claims_pending_idx
  on payment_claims(status, created_at);

-- High-risk owner payment decisions never execute directly from model tool
-- output. The deterministic owner command path first creates one short-lived
-- intent, then requires an exact confirmation bound to that intent and the
-- provider event. One owner may have only one pending financial action.
create table if not exists payment_claim_action_intents (
  id text primary key,
  owner_customer_id integer not null references customers(id),
  claim_id integer not null references payment_claims(id),
  decision text not null check (decision in ('approve', 'reject', 'reverse')),
  verified_reference text
    check (verified_reference is null or (
      length(verified_reference) between 6 and 80 and
      trim(verified_reference) = verified_reference and
      instr(verified_reference, ' ') = 0
    )),
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'cancelled', 'expired')),
  source_event_key text not null unique,
  confirm_event_key text unique,
  expires_at text not null,
  created_at text not null default (datetime('now')),
  confirmed_at text
);

create unique index if not exists payment_claim_one_pending_action_per_owner
  on payment_claim_action_intents(owner_customer_id)
  where status = 'pending';

-- Owner-supplied transaction references are separate from untrusted customer
-- claims. One independently verified reference can authorize one claim only.
-- The row is created in the same transaction as the approval and ledger credit.
create table if not exists payment_claim_verifications (
  claim_id integer primary key references payment_claims(id),
  action_id text not null unique references payment_claim_action_intents(id),
  owner_customer_id integer not null references customers(id),
  verified_reference text not null collate nocase unique
    check (
      length(verified_reference) between 6 and 80 and
      trim(verified_reference) = verified_reference and
      instr(verified_reference, ' ') = 0
    ),
  method_snapshot text,
  confirmed_event_key text not null unique,
  created_at text not null default (datetime('now'))
);

create trigger if not exists payment_claim_verifications_no_update
before update on payment_claim_verifications
begin
  select raise(abort, 'payment claim verification records are append-only');
end;

create trigger if not exists payment_claim_verifications_no_delete
before delete on payment_claim_verifications
begin
  select raise(abort, 'payment claim verification records are append-only');
end;

-- Append-only evidence for every prepared, completed, blocked, cancelled, or
-- reversed claim action. Nothing in application code updates or deletes it.
create table if not exists payment_claim_events (
  id integer primary key autoincrement,
  claim_id integer not null references payment_claims(id),
  owner_customer_id integer not null references customers(id),
  action_id text references payment_claim_action_intents(id),
  event_type text not null
    check (event_type in ('prepared', 'approved', 'rejected', 'reversed', 'blocked', 'cancelled', 'expired')),
  source_event_key text not null,
  amount_minor integer not null
    check (typeof(amount_minor) = 'integer' and amount_minor > 0),
  detail text not null check (length(trim(detail)) between 1 and 500),
  created_at text not null default (datetime('now'))
);

create unique index if not exists payment_claim_events_source_type_unique
  on payment_claim_events(source_event_key, event_type);

create trigger if not exists payment_claim_events_no_update
before update on payment_claim_events
begin
  select raise(abort, 'payment claim audit events are append-only');
end;

create trigger if not exists payment_claim_events_no_delete
before delete on payment_claim_events
begin
  select raise(abort, 'payment claim audit events are append-only');
end;

-- Explicitly connects a claim approval/reversal to its immutable ledger row.
-- This makes replay protection and later audit/reversal deterministic.
create table if not exists payment_claim_ledger_links (
  claim_id integer not null references payment_claims(id),
  ledger_id integer not null references ledger(id),
  role text not null check (role in ('credit', 'reversal')),
  created_at text not null default (datetime('now')),
  primary key (claim_id, role),
  unique (ledger_id)
);

-- Cross-table financial backstops: even direct SQL cannot attach the wrong
-- customer, order, amount, or ledger direction to a claim. Links are immutable
-- after insertion, and a pending claim cannot become approved without its
-- exact credit link already existing.
create trigger if not exists payment_claim_ledger_links_validate
before insert on payment_claim_ledger_links
when not exists (
  select 1
    from payment_claims pc
    join ledger l on l.id = new.ledger_id
   where pc.id = new.claim_id
     and l.customer_id = pc.customer_id
     and l.order_id is pc.order_id
     and l.amount_minor = pc.amount_minor
     and (
       (new.role = 'credit' and l.kind = 'credit') or
       (new.role = 'reversal' and l.kind = 'debit')
     )
)
begin
  select raise(abort, 'payment claim ledger link does not exactly match');
end;

create trigger if not exists payment_claim_ledger_links_no_update
before update on payment_claim_ledger_links
begin
  select raise(abort, 'payment claim ledger links are immutable');
end;

create trigger if not exists payment_claim_ledger_links_no_delete
before delete on payment_claim_ledger_links
begin
  select raise(abort, 'payment claim ledger links are immutable');
end;

create trigger if not exists payment_claim_approval_requires_credit_link
before update of status on payment_claims
when new.status = 'approved' and old.status <> 'approved'
  and not exists (
    select 1 from payment_claim_ledger_links
     where claim_id = new.id and role = 'credit'
  )
begin
  select raise(abort, 'payment claim approval requires an exact linked credit');
end;

create trigger if not exists payment_claim_resolution_is_final
before update of status on payment_claims
when old.status <> 'pending' and new.status <> old.status
begin
  select raise(abort, 'resolved payment claim status is final; use an audited reversal');
end;

-- Refund requests are cases, never money movement. Customers may create a
-- request for their own delivered order; only the authenticated owner path may
-- approve/reject it, and even approval remains pending external execution.
create table if not exists refund_requests (
  id integer primary key autoincrement,
  public_ref text not null collate nocase unique
    check (
      length(public_ref) = 24 and upper(substr(public_ref, 1, 4)) = 'RFD-' and
      upper(substr(public_ref, 5)) not glob '*[^0-9A-F]*'
    ),
  customer_id integer not null references customers(id),
  order_id integer not null references orders(id),
  reason text not null check (length(trim(reason)) between 5 and 500),
  eligibility text not null check (eligibility in ('eligible', 'manual_review')),
  status text not null default 'requested'
    check (status in ('requested', 'approved_pending_execution', 'rejected')),
  event_key text unique,
  resolved_by_customer_id integer references customers(id),
  created_at text not null default (datetime('now')),
  resolved_at text
);

create unique index if not exists refund_requests_one_active_per_order
  on refund_requests(order_id)
  where status in ('requested', 'approved_pending_execution');

create index if not exists refund_requests_status_idx
  on refund_requests(status, created_at);

-- Webhook entrance idempotency and retained-history quarantine. This ledger
-- sits BEFORE both the customer and owner agent paths, so a provider retry or
-- reconnect replay cannot create another AI turn, conversation row, reply, or
-- business side effect. The singleton cutoff advances on every application
-- start, preventing WAHA's offline backlog from entering either agent path.
create table if not exists inbound_guard_state (
  id integer primary key check (id = 1),
  accept_after text not null,
  created_at text not null default (datetime('now'))
);

create table if not exists inbound_events (
  event_key text primary key,
  channel text not null,
  message_id text not null,
  occurred_at text not null,
  status text not null check (status in ('processing', 'completed', 'failed', 'ignored_historical', 'ignored_invalid_timestamp')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  processing_started_at text,
  completed_at text,
  last_error text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  unique (channel, message_id)
);

create index if not exists inbound_events_status_idx on inbound_events(status);

-- Durable inbound work queue. Message text exists here only while work is
-- pending/processing/failed; successful completion clears it. The customer
-- reference avoids another raw-phone copy, while event_key keeps provider
-- retries tied to one durable job.
create table if not exists inbound_jobs (
  id integer primary key autoincrement,
  event_key text not null unique references inbound_events(event_key),
  customer_id integer not null references customers(id),
  turn_kind text not null check (turn_kind in ('customer', 'owner')),
  body text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at text not null default (datetime('now')),
  lease_expires_at text,
  last_error text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  completed_at text,
  check (
    (status = 'completed' and body is null) or
    (status != 'completed' and body is not null and length(body) between 1 and 65536)
  )
);

create index if not exists inbound_jobs_ready_idx
  on inbound_jobs(status, available_at, lease_expires_at, id);

-- Durable inbound abuse decisions. The event key makes admission idempotent;
-- the sender is stored only as a SHA-256 lookup key, not as another raw phone
-- copy. This gate limits model-backed turns, not deterministic STOP/START
-- commands, which remain available before the model is called.
create table if not exists inbound_abuse_events (
  event_key text primary key,
  sender_hash text not null check (length(sender_hash) = 64),
  actor_kind text not null check (actor_kind in ('customer', 'owner')),
  decision text not null check (decision in ('admitted', 'rate_limited')),
  created_at text not null
);

create index if not exists inbound_abuse_sender_window_idx
  on inbound_abuse_events(sender_hash, actor_kind, decision, created_at);

-- Global Gemini usage budget shared by customer and owner turns. A row is
-- reserved before the network request, so concurrent calls cannot bypass the
-- daily call ceiling. Returned provider usage is stored for the daily token
-- ceiling and operational review. Failed provider calls still consume the
-- call allowance because they can consume quota/capacity too.
create table if not exists ai_model_calls (
  id text primary key,
  day_key text not null check (day_key glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  model text not null check (length(trim(model)) between 1 and 120),
  status text not null check (status in ('reserved', 'succeeded', 'failed')),
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  total_tokens integer not null default 0 check (total_tokens >= 0),
  started_at text not null,
  finished_at text
);

create index if not exists ai_model_calls_day_idx
  on ai_model_calls(day_key, status);

-- Durable, standalone facts about a customer (e.g. "prefers black"),
-- distinct from `checkpoints.summary` which is the rolling state of the
-- CURRENT conversation and gets overwritten every turn. Notes accumulate.
-- `headline` is cheap enough to inject into every turn's opening context;
-- `body` is the fuller detail, fetched on demand via the get_customer_note
-- tool. `superseded_by` is nullable and unused for now — it exists so a
-- future note can replace an older one without deleting history.
create table if not exists customer_notes (
  id integer primary key autoincrement,
  customer_id integer not null references customers(id),
  headline text not null,
  body text not null,
  superseded_by integer references customer_notes(id),
  created_at text not null default (datetime('now'))
);

-- Idempotent record of one-time privacy cleanups applied to derived memory.
-- Raw messages and authoritative order/draft fulfilment fields are deliberately
-- excluded: those remain the business record. Only model-written summaries and
-- notes are minimized by the migration in src/db.ts.
create table if not exists privacy_migrations (
  migration_key text primary key,
  checkpoint_rows_redacted integer not null default 0,
  note_rows_redacted integer not null default 0,
  applied_at text not null default (datetime('now'))
);

-- Logs every time the AI hands a conversation off to Ahmed directly (see
-- notify_owner in tools.ts). Serves two purposes: it's the actual handoff
-- record itself, and it's what the human-promise guardrail in agent.ts
-- checks before allowing a "someone will follow up with you" reply to
-- actually send — a promise like that is only valid alongside a real
-- handoff, never as an empty reassurance the model invents on its own.
create table if not exists handoff_ledger (
  id integer primary key autoincrement,
  customer_id integer not null references customers(id),
  reason text not null,
  created_at text not null default (datetime('now'))
);

-- Version 3.3: durable owner alerts. `owner_alert_events` gives every source
-- event a stable idempotency key, while the partial unique index permits only
-- one pending alert of each kind. If several matching conditions happen while
-- delivery is pending, they accumulate on that one alert instead of flooding
-- Ahmed with parallel duplicates. Successfully delivered alerts remain as an
-- audit trail; a later, genuinely new source event may create a new alert.
create table if not exists owner_alerts (
  id integer primary key autoincrement,
  kind text not null,
  status text not null default 'pending' check (status in ('pending', 'sent')),
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  first_customer_id integer not null references customers(id),
  latest_customer_id integer not null references customers(id),
  latest_reason text not null,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  sent_at text
);

create unique index if not exists owner_alerts_one_pending_per_kind
  on owner_alerts(kind) where status = 'pending';

create table if not exists owner_alert_events (
  event_key text primary key,
  alert_id integer not null references owner_alerts(id),
  created_at text not null default (datetime('now'))
);
