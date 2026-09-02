-- Everything Ahmed's assistant needs to remember. On purpose: no organization_id,
-- no multi-tenant scoping — this whole database belongs to one business.

create table if not exists customers (
  id integer primary key autoincrement,
  phone text not null unique,          -- WhatsApp number, our lookup key
  name text,                            -- filled in once the AI learns it
  balance_owed real not null default 0, -- running total of unpaid orders
  disclosure_sent_at text,              -- set once the "I'm a virtual assistant" notice has gone out
  created_at text not null default (datetime('now'))
);

create table if not exists products (
  id integer primary key autoincrement,
  name text not null,        -- e.g. "shirt"
  size text,                 -- e.g. "medium"
  color text,                -- e.g. "black"
  price real not null,
  stock integer not null default 0
);

create table if not exists orders (
  id integer primary key autoincrement,
  customer_id integer not null references customers(id),
  items_json text not null,   -- [{product_id, qty, price}], simple and flexible
  total real not null,
  status text not null default 'placed', -- placed | paid | cancelled
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
