# Observability — Prometheus, Grafana and message traces

Status: **BUILT + LOCALLY VERIFIED** (unit/integration tests in
`tests/observability.test.ts`; config files parsed and cross-checked). The
Docker stack itself has **not** been started yet — first live start is the
owner's step below.

Two views of the same assistant:

1. **Totals and trends** — the app exposes `GET /metrics` (Prometheus text
   format). Prometheus scrapes it every 15 s; Grafana draws the
   **"Ahmed Assistant — Live"** dashboard and Prometheus evaluates the alerts.
2. **Per-message traces** — every processed message gets one row in
   `turn_traces` and an ordered list of steps in `turn_trace_events`
   (model calls, tool calls, guard blocks, sends, fallback, errors, job
   lifecycle). Grafana shows them through `GET /operations/traces`.

## Privacy rules (enforced by tests)

- Trace tables store **only** ids, tool names, stable guard check ids, status
  codes, durations, token counts, lengths and short SHA-256 prefixes. Never
  message bodies, phone numbers, names, addresses or payment destinations.
  `customer_id` is the internal row id, not the phone.
- Metric labels are low-cardinality fixed values (turn kind, outcome, tool
  name, guard check id, send status). No customer ids, phones or texts; any
  unexpected label value is clamped to a short `[a-z0-9_]` token.
- `tests/observability.test.ts` scans every trace row and the whole
  `/metrics` output for every customer phone and message body in the test
  database.

## Starting it (owner, Windows + Docker Desktop)

The app runs on the host as usual (`npm run dev` or `npm start`, port 3000).
Prometheus and Grafana run in Docker and reach it at
`host.docker.internal:3000`. This stack never includes or touches the WAHA
container or its session volume; it has its own named volumes
(`ahmed_prometheus_data`, `ahmed_grafana_data`).

1. Make sure `.env` has `OPERATIONS_API_KEY` (at least 24 characters). Without
   it `/metrics` and `/operations/traces` answer **401** (fail closed).
2. Create the two secret files in the gitignored folder
   `observability/secrets/` — in PowerShell from the repo root, without
   printing the values:

   ```powershell
   New-Item -ItemType Directory -Force observability\secrets | Out-Null
   $key = (Select-String -Path .env -Pattern '^OPERATIONS_API_KEY=(.*)$').Matches[0].Groups[1].Value.Trim()
   [System.IO.File]::WriteAllText("$PWD\observability\secrets\ops_key", $key)
   Remove-Variable key
   $pw = Read-Host -AsSecureString "Choose a Grafana admin password"
   [System.IO.File]::WriteAllText("$PWD\observability\secrets\grafana_admin_password", [System.Net.NetworkCredential]::new('', $pw).Password)
   Remove-Variable pw
   ```

   (Git Bash equivalent for the key:
   `mkdir -p observability/secrets && grep -E '^OPERATIONS_API_KEY=' .env | cut -d= -f2- | tr -d '\r\n' > observability/secrets/ops_key`.)
   The files must not end with a newline. If you change `OPERATIONS_API_KEY`,
   rewrite `ops_key` and run `npm run obs:down` then `npm run obs:up`.
3. `npm run obs:up` (= `docker compose -f observability/docker-compose.yml up -d`).
   The first start downloads `prom/prometheus:v2.53.2`, `grafana/grafana:11.2.0`
   and the Infinity plugin (`yesoreyeram-infinity-datasource`).
4. Start the app.
5. Open Grafana at <http://localhost:3002>, user `admin`, the password from
   step 2. The home dashboard is **Ahmed Assistant — Live** (folder
   "Ahmed Assistant"). Prometheus itself is at <http://localhost:9090>
   (Status → Targets should show `ahmed-assistant` **UP**).

`npm run obs:down` stops both containers and keeps the history volumes.
Both ports are bound to `127.0.0.1` only. Anonymous Grafana access is off.

Optional settings in `.env` (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `TRACE_RETENTION_DAYS` | `14` | Traces older than this are deleted at startup and daily (1–365; invalid → 14). |
| `GEMINI_PRICE_INPUT_PER_MTOK` | unset | USD per 1M prompt tokens. |
| `GEMINI_PRICE_OUTPUT_PER_MTOK` | unset | USD per 1M output tokens. `wa_estimated_cost_usd_total` exists only when **both** are set. Prices are never hardcoded. |

## The dashboard, panel by panel

### 1. Health
- **WhatsApp session** — `wa_whatsapp_session_up`: UP when the WAHA session
  status is `WORKING`. Refreshed on each scrape (at most every 10 s) and on
  every `/ready` call.
- **App scraped** — Prometheus' own `up`: NO means the app is stopped, port
  3000 is unreachable from Docker, or `ops_key` is wrong (401).
- **Queue** — `wa_queue_jobs{status}` now: `pending` (waiting, including
  deferred jobs), `processing`, `failed` (gave up after retries).
- **AI budget used today** — `wa_ai_budget_used_ratio` × 100: the higher of
  calls used / `AI_DAILY_CALL_LIMIT` and tokens used / `AI_DAILY_TOKEN_LIMIT`
  for today's Karachi day. At 100% new AI work is deferred.
- **Owner alerts pending** — alerts to Ahmed recorded but not delivered yet.

### 2. Traffic
- **Messages per hour** — `wa_inbound_messages_total` by customer/owner
  (messages accepted into the durable queue; duplicates/replays excluded).
- **Turns by outcome** — `wa_turns_total{outcome}` per 15 min:
  - `replied` — a normal reply (or exact server text) was delivered;
  - `fallback` — every reply was vetoed and the fixed fallback text was sent;
  - `no_reply` — the customer got nothing unintentionally (every reply and
    the fallback were blocked or failed, or the reply was held by pacing —
    outside the send window or over a daily cap; a pacing-held reply is
    dropped, never resent later). Always worth a look;
  - `silenced` — intentional silence: the customer opted out (STOP). Metric
    label only; the trace row stores `no_reply` plus a `send` event named `silenced`;
  - `error` — the turn threw (model timeout, provider error, bug); the job
    retries with backoff;
  - `deferred` — postponed without using an attempt (AI budget exhausted, or
    WhatsApp down once Fix 6 is merged).
- **Fallback rate (30 min)** — fallback turns ÷ non-deferred turns.

### 3. Speed
- **Turn time p50/p95** — `wa_turn_duration_seconds`: job start → finish,
  including model calls, tools, pacing waits and sends.
- **Model call time** — `wa_model_call_duration_seconds` p95 and p50.
- **Send time** — `wa_send_duration_seconds`: WAHA `sendText` latency only.

### 4. Cost
- **Tokens per hour** — `wa_model_tokens_total{type="prompt|output"}` from
  Gemini `usageMetadata`.
- **Model calls per turn** — `wa_model_calls_per_turn` average and p95
  (Fix 5 target: ≤ 3).
- **Prompt tokens per turn** — `wa_prompt_tokens_per_turn` average and p95
  (Fix 5 target: ≤ 12k). Stubbed per-scenario numbers (calls, estimated
  prompt tokens, split into system / tool schemas / history / tool results)
  come from `npm run cost:measure` (isolated temp DB). Expect a CLOSE call
  (no tools in its request) only on turns with an order/payment/contact
  signal, a state-changing tool, no own reply, a new customer, or every
  `CHECKPOINT_EVERY_N_TURNS` (default 4) inbound messages.
- **Estimated cost today** — `increase(wa_estimated_cost_usd_total)` since
  local midnight; shows "prices not set" until both price variables are set.

### 5. Failures
- **Guard blocks by check** — `wa_guard_blocks_total{check}` per hour. A
  spike in one check usually means the prompt and that guard disagree.
- **Failed or uncertain sends** — `wa_sends_total{status!="sent"}`:
  `failed` = provider refused (safe to retry), `uncertain` = outcome unknown
  (never resent automatically). Fix 6 adds `channel_unavailable`.
- **Model errors** — `wa_model_calls_total{status!="ok"}` (`timeout`,
  `http_429`, `http_500`, `request_error`, `budget_exceeded`) plus
  `wa_trace_write_failures_total`.

### 6. Message traces
- **Last 50 message traces** — `GET /operations/traces?limit=50`. Outcome is
  colour-coded. **Click a Trace id** to load its steps on the right (sets the
  `trace_id` dashboard variable; you can also type one at the top).
- **Steps of trace N** — `GET /operations/traces/N`, events in order.

## How to read a trace

Columns of `turn_traces`: `job_id` (durable queue job), `customer_id`
(internal id), `turn_kind`, `started_at`/`finished_at` (UTC ISO),
`outcome`, `model_calls`, `prompt_tokens`, `output_tokens`, `total_ms`.
One trace = one job **attempt** (a retried job gets a new trace with the same
`job_id`).

Events (`seq` = order):

| kind | name | code | notes |
|---|---|---|---|
| `job` | `started`, `completed`, `deferred`, `retry`, `failed` | — | durable queue lifecycle (`queued` is only a metric) |
| `model_call` | `gemini` | `ok`, `timeout`, `http_<status>`, `request_error`, `budget_exceeded` | `duration_ms`, `prompt_tokens`, `output_tokens` |
| `tool_call` | tool name (`check_stock`, `send_message`, `prepare_order`, …) | — | `ok` = the tool did not return `ok:false`/`error` |
| `guard_block` | check id | check id | `detail` = `{body_length, body_sha256_12}` of the vetoed reply |
| `send` | `customer` / `owner` | send-ledger status: `sent`, `failed`, `uncertain` | `detail.send_ref` = first 12 hex of the send-ledger id |
| `fallback` | `fallback_reply` | — | `ok` = the fallback text was delivered |
| `error` | — | error class name (`Error`, `AiBudgetExceededError`, …) | never the message text |

Typical healthy customer trace: `job started → model_call → tool_call
check_stock → model_call → tool_call send_message → send customer sent →
model_call (closing summary) → job completed`, outcome `replied`.

A `guard_block` followed by another `model_call` means the model was told why
and tried again; several blocks then `fallback` means the guards and the
model kept disagreeing — the check id says which guard. To find the matching
conversation in the database, use `customer_id` and the trace time; the
`body_sha256_12` equals the first 12 hex characters of
`sha256(<reply text>)` if you need to prove which reply was blocked.

### Stable guard check ids

Returned as the optional `check` field next to the unchanged teaching text
(`src/agent/send-guards.ts`, type `SendGuardCheck`); renaming one breaks
dashboards — add new ids instead:

`empty_body`, `opted_out`, `holding_message`, `order_confirmation_claim`, `order_summary`,
`inventory_disclosure`, `refund_completion_claim`, `sensitive_action_wording`,
`support_upsell`, `checkout_collection`, `reply_script`,
`payment_instruction`, `unconfigured_payment_method`, `handoff_claim`, `internal_disclosure`, `pacing`,
`spinning`, `discount`.

## Alerts (`observability/prometheus/alerts.yml`)

Evaluated by Prometheus; visible in Grafana → Alerting → Alert rules and at
<http://localhost:9090/alerts>. No Alertmanager is configured, so they do not
send messages.

| Alert | Condition |
|---|---|
| `AssistantMetricsDown` | scrape failing for 2 min |
| `WhatsAppDown` | `wa_whatsapp_session_up == 0` for more than 2 min |
| `AiBudgetAbove80Percent` | `wa_ai_budget_used_ratio > 0.8` |
| `WhatsAppDownLong` | `wa_whatsapp_down_seconds > 300` (outage longer than 5 min) |
| `TurnWithNoReply` | any `no_reply` outcome in the last 10 min (`silenced` excluded) |
| `FallbackRateAbove20Percent` | fallback rate > 20% over 30 min |
| `QueueAbove50` | more than 50 pending jobs for 2 min |
| `TraceWritesFailing` | trace writes failing (turns still run) |

## HTTP endpoints

All require `Authorization: Bearer <OPERATIONS_API_KEY>`; 401 otherwise, and
always 401 when the key is unset or shorter than 24 characters.

- `GET /metrics` — Prometheus text format 0.0.4.
- `GET /operations/traces?limit=50&outcome=no_reply` — newest first;
  `limit` 1–500 (default 50); `outcome` one of the five outcomes.
- `GET /operations/traces/:id` — `{ trace, events[] }`, 404 if unknown.

## Metrics reference

Counters reset when the app restarts (Prometheus `increase()`/`rate()` handle
that). Gauges are read from SQLite at scrape time.

`wa_inbound_messages_total{turn_kind}`, `wa_turns_total{turn_kind,outcome}`,
`wa_turn_duration_seconds` (histogram), `wa_model_calls_total{status}`,
`wa_model_call_duration_seconds` (histogram),
`wa_model_tokens_total{type}`, `wa_model_calls_per_turn`,
`wa_prompt_tokens_per_turn` (histograms, deferred turns excluded),
`wa_tool_calls_total{tool,ok}`, `wa_guard_blocks_total{check}`,
`wa_fallback_replies_total`, `wa_sends_total{recipient_kind,status}`,
`wa_send_duration_seconds` (histogram), `wa_queue_jobs{status}`,
`wa_job_events_total{event}`, `wa_ai_budget_used_ratio`,
`wa_whatsapp_session_up`, `wa_owner_alerts_pending`,
`wa_trace_write_failures_total`, `wa_estimated_cost_usd_total` (only with
prices).

## Code map

- `src/obs/metrics.ts` — in-process registry + hand-written exposition;
  `setWhatsappSessionUp(boolean)` for the session gauge.
- `src/obs/trace.ts` — AsyncLocalStorage turn context, trace writes (every
  write in try/catch → `wa_trace_write_failures_total`), retention, read API.
- `src/obs/http.ts` — routes + scrape-time gauges + daily retention timer,
  mounted by one call in `src/server.ts`.
- Hooks (calls only, no behaviour change): `src/llm.ts` (every `callModel`),
  `src/agent/customer-turn.ts` / `owner-turn.ts` (turn scope, tool timing,
  outcome), `src/agent/send-guards.ts` / `owner-send.ts` (guard check ids),
  `src/outbound-delivery.ts` (send start/finish + ledger status),
  `src/inbound-jobs.ts` (queued metric, job trace lifecycle).
- Tables: `turn_traces`, `turn_trace_events` in `db/schema.sql` (additive,
  `create … if not exists`, no foreign keys so a trace can never block a
  business write).

## Troubleshooting

- *App scraped = NO, target shows 401*: `ops_key` differs from `.env` or has a
  trailing newline — recreate it (step 2) and restart the stack.
- *Target shows connection refused*: the app is not running on port 3000, or
  Docker Desktop cannot reach `host.docker.internal`.
- *Trace tables empty in Grafana but metrics fine*: the Infinity data source
  could not read `ops_key`; check Grafana → Connections → Data sources →
  "Assistant traces" → Save & test, and the container log
  (`docker logs ahmed-grafana`).
