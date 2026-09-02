# Ahmed's WhatsApp Assistant

**Start here, in this order:**

1. **`CLAUDE.md`** — if you're working in this repo with Claude Code, this
   governs how. Read it first, every session.
2. **`PROJECT-TRACKER-FINAL.md`** — the single source of truth for what's
   built, what's in progress, and what's next. Check this before starting
   any work.
3. **`EXTRACTED-FILES-EXPLAINED.md`** — plain-language description of every
   file in `EXTRACTED-FOR-AHMED/` and what it's for.
4. This README — the code tour below.

## Where things live

- **`src/`** — the actual, running chatbot: the conversation loop, memory
  (checkpoints), the 4 business tools, and the AI connection. This is the
  real engine, written fresh for this project.
- **`db/schema.sql`** — what the assistant remembers.
- **`EXTRACTED-FOR-AHMED/`** — verified, reusable utility files pulled
  directly from the DeskcommCRM reference repo (anti-ban pacing, a logger,
  follow-up scheduling math, etc.). **Staged, not yet wired into `src/`.**
  See `EXTRACTED-FILES-EXPLAINED.md` for what each one does and
  `EXTRACTED-FOR-AHMED/MANIFEST.md` for how each was verified safe to reuse.

## Code tour — the engine in `src/`, in reading order

1. `db/schema.sql`     — what we remember
2. `src/types.ts`       — the shapes we pass around
3. `src/llm.ts`         — the ONE place we talk to the AI (the "seam")
4. `src/tools.ts`       — the actions the AI is allowed to take
5. `src/agent.ts`       — the turn loop, chatbot + memory (this is the heart of the system)
6. `src/server.ts`      — where a WhatsApp message enters the system

## The one loop everything is built around

```
WhatsApp message arrives
        │
        ▼
runTurn(customerId, incomingText)      <-- src/agent.ts
        │
        ├─ 1. load customer + recent messages + last checkpoint  (OPEN)
        ├─ 2. ask the AI, giving it tools it can call             (LOOP)
        │        - check_stock / get_customer_balance / record_order / record_payment
        │        - send_message  <-- the ONLY way it can talk to the customer
        ├─ 3. ask the AI to summarize what happened this turn     (CLOSE)
        └─ 4. save that summary as the new checkpoint
```

That's it. That's the whole system. Everything in the big reference file
(`inbound-turn.ts`, 1000+ lines) is this exact same loop, wrapped in years of
production armor. You don't need the armor yet.

## Mapping to the big reference codebase

| Big system concept | This skeleton | Why we simplified |
|---|---|---|
| `job_queue` + worker polling loop | `server.ts` calls `runTurn()` directly, inline | You have one Ahmed, not thousands of concurrent orgs. No queue needed until you have real concurrency problems. |
| `runModelCall` (seam, budget, multi-provider, cost tracking) | `llm.ts` — one function, one provider | You don't have per-org billing. Add budget checks later if you ever resell this. |
| `AGENT_TOOL_DEFS` (11 tools, MCP catalog, breaker-wrapped) | `tools.ts` — 4 tools | Start with only what Ahmed's business actually needs. Add tools when you feel the AI reaching for one that doesn't exist. |
| `lead_checkpoints` + `ritualBlocks` + compaction + notes | `checkpoints` table + a single summary string | No compaction needed until conversations get genuinely long (hundreds of messages). |
| `update_lead_state` (funnel stage machine, CRM mirror) | *omitted* | You don't have a sales funnel with stages yet — an order is either placed or it isn't. |
| `runBeforeSend` guardrail chain (7+ gates) | *omitted* | These all exist because a *chat bot promised something illegal* or *sent 8 messages in a row* in production. You'll add each one **after** you personally watch it happen once — not before. |
| Multi-tenant (`organization_id` everywhere) | *omitted* — everything is scoped to one Ahmed | Add a `business_id` column later if you resell this to other shop owners. |
| Operator/Conversador split, jailbreak classifier, promise-semantic gate | *omitted entirely* | Genuinely advanced, genuinely not needed at this stage. |

## What to build in what order (matches Phase 1–4 from our chat)

- **Phase 1 (this skeleton):** one tool-less-ish loop, checkpoint memory, 4 basic tools.
- **Phase 2:** wire up a real WhatsApp provider (WAHA self-hosted, or Cloud API) in `server.ts`.
- **Phase 3:** once you *personally* hit a problem (bot spams messages, forgets a promise,
  mixes up two customers), add exactly the guardrail that fixes *that* problem — copy the
  pattern from the big file, not the whole file.
- **Phase 4:** if you ever sell this to other shop owners, revisit multi-tenancy, budget
  enforcement, and the job queue.

## Setup

```bash
npm install better-sqlite3 express
npm install -D typescript @types/express @types/better-sqlite3 tsx
export ANTHROPIC_API_KEY=sk-ant-...
npx tsx src/server.ts
```
