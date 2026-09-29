-- Everything Ahmed's assistant needs to remember. On purpose: no organization_id,
-- no multi-tenant scoping — this whole database belongs to one business.

create table if not exists customers (
  id integer primary key autoincrement,
  phone text not null unique,          -- WhatsApp number, our lookup key
  name text,                            -- filled in once the AI learns it
  disclosure_sent_at text,              -- set once the "I'm a virtual assistant" notice has gone out
  created_at text not null default (datetime('now'))
  -- No balance_owed column (Version 2.1) — a single mutable field couldn't
  -- be reconstructed or audited. What a customer owes is now derived by
  -- summing the `ledger` table below, never trusted as a standalone number.
);

create table if not exists products (
  id integer primary key autoincrement,
  name text not null,        -- e.g. "shirt"
  size text,                 -- e.g. "medium"
  color text,                -- e.g. "black"
  price real not null,
  stock integer not null default 0
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
  customer_id integer not null references customers(id),
  items_json text not null,   -- [{product_id, qty, price}], simple and flexible
  total real not null,
  status text not null default 'placed'
    check (status in ('placed', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled')),
  created_at text not null default (datetime('now'))
);

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
  amount real not null check (amount >= 0), -- direction comes from `kind`; a free (0-total) order is a valid debit
  created_at text not null default (datetime('now'))
);

-- Raw conversation log. This is the "scroll up in old chats" Ahmed used to do himself.
create table if not exists messages (
  id integer primary key autoincrement,
  customer_id integer not null references customers(id),
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null,
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

-- Idempotency ledger for send_message (see agent.ts). `id` is a deterministic
-- hash of (customer, inbound text, outbound body), so a crash-and-retry that
-- re-runs the same turn and regenerates the same reply collides with its own
-- prior attempt instead of sending twice.
create table if not exists send_ledger (
  id text primary key,
  customer_id integer not null references customers(id),
  status text not null default 'pending', -- pending | sent
  created_at text not null default (datetime('now'))
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
  amount real not null check (amount > 0),
  method text,
  reference text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  event_key text unique,
  resolved_by_customer_id integer references customers(id),
  created_at text not null default (datetime('now')),
  resolved_at text
);

create index if not exists payment_claims_pending_idx
  on payment_claims(status, created_at);

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
