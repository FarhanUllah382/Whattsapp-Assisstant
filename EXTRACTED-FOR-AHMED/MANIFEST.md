**Current state (check this section, not the per-file rows below, for what's
actually still here):** 6 of the 21 originally-extracted files have since been
wired into the running app and moved out of this folder into `src/`. Their
rows in Part 1 below are kept only for the original extraction
history/reasoning — treat them as historical, not as a live file listing.

| File | Moved to | Version |
|---|---|---|
| `pacing/defaults.ts` | `src/guardrails/pacing/` | 1.3 |
| `pacing/engine.ts` | `src/guardrails/pacing/` | 1.3 |
| `spinning/defaults.ts` | `src/guardrails/spinning/` | 1.3 |
| `spinning/engine.ts` | `src/guardrails/spinning/` | 1.3 |
| `guardrails/messaging-window.ts` | `src/guardrails/` | 1.3 |
| `obs/logger.ts` | `src/obs/` | 1.3 |

**15 files remain in this folder now** (verified by direct count, not
computed from the table above) — see the Summary section at the bottom for
the itemized list.

# Extraction manifest — every file in `lib/agent-engine/`

Full sweep, not just the original candidate list. All 90 non-test `.ts` files
in `lib/agent-engine/` were considered. `*.test.ts` files were excluded from
consideration (they're tests, not code to extract). `lib/agent-engine/`
itself was never modified — read only. Every extracted file was verified
byte-identical to its source via `diff`.

**Method:** first, every file was grepped for direct `pg`/`Queryable` imports
— an unambiguous signal of real database coupling. 55 files matched and were
excluded on that basis alone (listed in Part 2 below, grouped by directory —
the reason is identical for all of them, so they're not given individual
prose). The remaining 35 files were each opened and read in full. Of those,
21 qualify and are extracted below; 14 do not, each for a specific,
individually-explained reason (dangling imports, Supabase Storage coupling,
external CRM-app coupling, a Supabase-specific env schema, or — for 3 files
with zero DB coupling — existing solely to serve a feature already ruled out
of scope: the Operator/Conversador split and the flywheel system).

---

## Part 1 — Qualifies, extracted unchanged (21 files)

Every file below compiles standalone with **zero edits**, including import
paths — directory structure was preserved 1:1, so any local import that
exists resolves against another file also present in this extraction.

### Fully self-contained (zero local imports)

| File | Content note |
|---|---|
| `agent/split-message.ts` | — |
| `agent/janela-de-atendimento.ts` | Business-hours gating, timezone-aware. Directly useful for Ahmed, no caveat. |
| `cron/schedule.ts` | Explicitly documented as "no I/O" in its own header. |
| `pacing/defaults.ts` | **Content note:** default `timezone: 'America/Sao_Paulo'` is a value to change, not a coupling issue. |
| `spinning/defaults.ts` | — |
| `channel-adapter.ts` | Pure interfaces only, no implementation. |
| `edge/llm/pricing.ts` | **Content note:** pricing table only has Anthropic prices as of its header's date — a data update, not a logic change. |
| `edge/llm/capabilities.ts` | — |
| `edge/llm/stable-prefix.ts` | Only imports `node:crypto` and the `ai` npm package. |
| `edge/llm/orcamento.ts` | The pure decision logic (`decidirOrcamento`, `normalizarChaveDeOrcamento`, `normalizarModoDeOrcamento`, `corpoDoBloqueio`, and all exported constants) is 100% portable and directly useful for a budget cap in Ahmed's project. **Edited before extraction:** the original file also exported `SQL_ORCAMENTO`, a raw SQL string referencing DeskcommCRM-specific tables (`ai_budgets`, `agent_inbox_items`, `fn_gasto_de_ia_do_mes`, org-scoped). It was never executed by this file — no `pg`/`Queryable` import, no `.query()` call, just inert text — but it was org-scoped DB text sitting in a file otherwise presented as pure, so it's been deleted from this copy rather than left for Ahmed to remove. |
| `obs/logger.ts` | Uses `process.stdout` (Node built-in), nothing repo-specific. |
| `health/defaults.ts` | Same shape as `pacing/defaults.ts`/`spinning/defaults.ts`. |
| `guardrails/human-promise.ts` | **Content flag:** the regex patterns are Portuguese-specific ("encaminhar", "verificar com", "equipe/time/setor"). Ahmed's customers write Roman Urdu/Hindi-English per his own spec examples — the *detector shape* (regex-based, no LLM, conservative-by-design) is worth copying, but the actual patterns need to be rewritten for his customers' language, not just dropped in. |
| `guardrails/messaging-window.ts` | Pure function of `(now, lastInboundAt)` — the caller supplies the timestamp; this file itself never touches a database. |

### Depend only on other files in this extraction (import paths need zero edits — directory structure preserved)

| File | Depends on (also extracted) |
|---|---|
| `pacing/engine.ts` | `pacing/defaults.ts`. Its own header claims "no I/O here" — verified true, not just trusted. |
| `spinning/engine.ts` | `spinning/defaults.ts`, plus `node:crypto`. |
| `queue/loop.ts` | `obs/logger.ts` (type only). Generic "ask the DB when the next job is due, sleep exactly that long" pattern — takes all DB access as injected callbacks, never touches Postgres itself. |
| `edge/egress.ts` | `obs/logger.ts` (type only). The allowlisted-fetch security pattern — worth keeping even for a single-shop project once you're calling any LLM provider's API directly. |
| `edge/llm/count-tokens.ts` | `edge/egress.ts`, `obs/logger.ts` (type only), plus the `ai` npm package. |
| `edge/llm/embed.ts` | `edge/egress.ts`, `obs/logger.ts` (type only). |
| `edge/llm/providers.ts` | `edge/egress.ts`, plus `@ai-sdk/anthropic`/`@ai-sdk/google`/`@ai-sdk/openai`/`ai` (npm packages). |

---

## Part 2 — Does not qualify: direct database coupling (55 files)

Every file below imports `pg` and/or `Queryable` (the repo's shared
`pg.Pool`/`pg.PoolClient` interface from `queue/queue.ts`) directly, and runs
`organization_id`-scoped SQL against this repo's specific tables. Same
disqualifying reason for all 55 — grouped by directory rather than repeated
55 times.

**agent/** — `abordagem-de-formulario.ts`, `agent-config.ts`,
`aviso-de-escalacao.ts`, `case-reply-turn.ts`, `compaction.ts`,
`draft-reply.ts`, `followup-flow-classify.ts`, `followup-turn.ts`,
`human-cases.ts`, `human-handoff.ts`, `inbound-turn.ts`, `intent-classifier.ts`,
`lead-notes.ts`, `lead-notes-recall.ts`, `lead-state.ts`, `operator-turn.ts`,
`org-memory.ts`, `playbook.ts`, `playbook-seed.ts`, `reentry-knobs.ts`,
`reentry-template.ts`, `resolve-turn-agent.ts`, `router-config.ts`,
`schedule-followup.ts`, `search-knowledge.ts`, `skills.ts`,
`stage-classifier.ts`

**cron/** — `scheduler.ts`

**db/** — `pool.ts`, `repository.ts`, `request-pool.ts`

**edge/channel/** — `waha-adapter.ts`

**edge/crm/** — `drain.ts`, `get-lead-context.ts`, `move-lead-stage.ts`,
`send-message.ts`, `session-reconciler.ts`, `session-watchdog.ts`

**edge/llm/** — `binding-do-ponto.ts`, `credentials.ts`, `run-model-call.ts`,
`test-model.ts`

**flywheel/** — `live.ts`

**guardrails/** — `before-send.ts`, `camadas-da-org.ts`,
`disclosure/template.ts`, `jailbreak/classifier.ts`, `lgpd/legal-basis.ts`,
`promise/semantic.ts`, `promise/table.ts`

**health/** — `circuit.ts`

**obs/** — `metrics.ts`

**pacing/** — `store.ts`

**queue/** — `queue.ts`

**spinning/** — `store.ts`

---

## Part 3 — Does not qualify: individual reasons (14 files)

### No DB coupling, but exists only to serve an out-of-scope feature

These compile clean standalone — no `pg`/`Queryable`, no Supabase Storage, no
dangling imports. They're excluded anyway because their entire reason for
existing is a feature already ruled out for Ahmed's project: the
Operator/Conversador split (spec 16) or the flywheel self-optimization system.
Including "compiles fine" code that only makes sense in service of a
ruled-out architecture would hand Ahmed dead scaffolding, not a building
block.

| File | Why it exists (and why that's out of scope) |
|---|---|
| `agent/declaracao.ts` | Its own header frames it as "a fronteira entre FALAR e OPERAR (spec 16 §5)" — the boundary between the Conversador (talks) and Operator (acts) roles. `promessasEmAberto`'s own doc comment says the real cross-check logic lands "Quando o Operador existir (spec 16, passo 4)" — i.e., this file is a stub waiting on a role split that isn't happening here. |
| `agent/entrega-de-capacidade.ts` | Governs which tools move from the Conversador to the Operator when the Operator role is enabled (`EQUIVALENTE_NO_OPERADOR`, `catalogoEntregueAoOperador`). With no Operator role in Ahmed's project, this file has nothing to hand off to. |
| `surrogates.ts` | Schema for the flywheel's proxy metrics (`lead_replied`, `stage_advanced`, `dropoff`, etc.), explicitly tied to `crm_leads`/`contacts`/`event_log`. Same flywheel system already ruled out — no near-term reason to keep it. |

### Pure own logic, disqualified only by a dangling import

### Pure own logic, disqualified only by a dangling import

The file's own code has zero DB/Supabase coupling — it's disqualified purely
because it imports something (even just a type) from a file in Part 2. Copy
it alone and the import won't resolve.

| File | What's actually pure | What blocks it |
|---|---|---|
| `guardrails/promise/engine.ts` | `extractPromises`, `decidePromise` — deterministic regex extraction, zero I/O. | `import('./table').PromiseTable` — a type-only reference to `guardrails/promise/table.ts` (Part 2). The type itself is trivial (3 optional numbers), but as literally written this is a dangling import. |
| `agent/aux-model-args.ts` | `auxModelArgs` — a small pure function picking between a configured model and an agent's model. | `type { LlmResolveOverride } from "../edge/llm/credentials"` — `edge/llm/credentials.ts` is in Part 2. |
| `agent/tool-breaker.ts` | The entire circuit-breaker (`wrapToolsWithBreaker`, `canonicalHash`) — deterministic, hash-based, no I/O beyond logging. | `type { ToolSet } from '../edge/llm/run-model-call'` — `run-model-call.ts` is in Part 2. (`ToolSet` itself actually originates from the `ai` npm package one hop further back — `run-model-call.ts` just re-exports it — so this one's easiest to unblock later: import `ToolSet` from `'ai'` directly instead.) |

### Pure own logic, but a *real* (non-type) runtime dependency on a Part-2 file

Worse than the dangling-type case above — these actually call a function
defined in a disqualified file, not just reference its type.

| File | What's actually pure | What blocks it |
|---|---|---|
| `agent/prune-tool-results.ts` | `pruneToolResults` — deterministic message-array pruning. | Calls `countPayloadTokens` from `edge/crm/get-lead-context.ts` (Part 2) at runtime, plus a type-only import from `run-model-call.ts`. (`countPayloadTokens` is itself a two-line pure function — `Math.ceil(s.length / 3.5)` — but it lives inside a disqualified file.) |
| `agent/projecao.ts` | `projetarContexto`, `projetarRetornoDeTool`, `traduzirErroCru` — allowlist-based field projection, all pure. | Calls `detectarVazamentoInterno` from `guardrails/vazamento-interno.ts` at runtime (see below — that file has real external coupling of its own), plus a type-only import from `edge/crm/get-lead-context.ts`. |

### Direct Supabase Storage coupling

Not Postgres/`pg` (which the Part 2 grep catches) — these import
`@supabase/supabase-js` directly and actually call `.storage.from(...).download(...)`.

| File | Why |
|---|---|
| `agent/media-parts.ts` | Downloads message media from the `whatsapp-media` Supabase Storage bucket. |
| `agent/skill-references.ts` | Downloads skill reference files from the `skill-assets` Supabase Storage bucket. Also has a type-only dependency on `agent/skills.ts` (Part 2). |
| `edge/crm/mcp-client.ts` | Constructs a Supabase admin client via `createClient(...)`. |

### Deep coupling to the CRM app outside `agent-engine` entirely

These import from parts of the DeskcommCRM codebase that aren't even inside
`lib/agent-engine/` — the RBAC/MCP-tool-catalog/channel-registry system that
belongs to the full CRM product, explicitly out of scope per `gap-analysis.md`.

| File | Why |
|---|---|
| `edge/crm/mcp-tools.ts` | Imports `@/lib/ai/runtime/tools`, `@/lib/ai/runtime/mcp_token`, `@/lib/mcp/auth`, `@/lib/mcp/types` — the CRM's generic MCP tool catalog and RBAC token system. |
| `guardrails/vazamento-interno.ts` | Imports `TOOL_CATALOG`/`catalogEntry` from `@/lib/mcp/tools/catalog` and `CHANNEL_CAPABILITIES` from `@/lib/channels/capabilities` — both real runtime dependencies (the detector's word lists are *built from* these catalogs at module load), not just types. |

### Repo-specific env schema

| File | Why |
|---|---|
| `env.ts` | The Zod schema itself validates `SUPABASE_DB_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — Supabase-specific by design, not incidentally. Also imports `@/lib/followup/janela`, outside `agent-engine` entirely. |

---

## Summary

- **90** non-test files considered.
- **21** qualify, extracted unchanged, verified byte-identical (one, `edge/llm/orcamento.ts`, had an inert org-scoped SQL string stripped before extraction — see its row above).
- **69** do not qualify: 55 by direct DB coupling (grouped), 14 individually explained above (11 by import/coupling reasons, 3 by out-of-scope-feature reasons).
- **File count now (verified by direct listing, current):** 15 files remain
  in this folder. 6 of the original 21 extracted files have been wired into
  the running app and moved to `src/` — see the table near the top of this
  file for which file moved where and in which version. The 15 remaining:
  `agent/janela-de-atendimento.ts`, `agent/split-message.ts`,
  `channel-adapter.ts`, `cron/schedule.ts`, `edge/egress.ts`,
  `edge/llm/capabilities.ts`, `edge/llm/count-tokens.ts`, `edge/llm/embed.ts`,
  `edge/llm/orcamento.ts`, `edge/llm/pricing.ts`, `edge/llm/providers.ts`,
  `edge/llm/stable-prefix.ts`, `guardrails/human-promise.ts`,
  `health/defaults.ts`, `queue/loop.ts`.
