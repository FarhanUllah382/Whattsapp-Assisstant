// In-process Prometheus metrics, written by hand (no new runtime dependency).
//
// Privacy rule: every label value here is a member of a small fixed set
// (turn kind, outcome, tool name, guard check id, send status). Never pass a
// customer id, phone number, message text or provider error text as a label.
// `safeLabel` additionally clamps any unexpected value to a short
// [a-z0-9_] token so a coding mistake cannot leak free text into /metrics.

export type MetricLabels = Record<string, string>;

const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120];
const COUNT_BUCKETS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 15];
const TOKEN_BUCKETS = [1_000, 2_000, 4_000, 8_000, 12_000, 16_000, 24_000, 32_000, 48_000, 64_000, 128_000];

interface MetricDef {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  buckets?: number[];
}

interface HistogramValue {
  counts: number[];
  sum: number;
  count: number;
}

const DEFS: Record<string, MetricDef> = {};
const counters = new Map<string, Map<string, number>>();
const gauges = new Map<string, Map<string, number>>();
const histograms = new Map<string, Map<string, HistogramValue>>();

function define(def: MetricDef): string {
  DEFS[def.name] = def;
  return def.name;
}

export const METRIC = {
  inboundMessages: define({ name: 'wa_inbound_messages_total', help: 'Inbound WhatsApp messages accepted into the durable queue.', type: 'counter' }),
  turns: define({ name: 'wa_turns_total', help: 'Finished turns by kind and outcome.', type: 'counter' }),
  turnDuration: define({ name: 'wa_turn_duration_seconds', help: 'Wall time of one turn (job start to finish).', type: 'histogram', buckets: DURATION_BUCKETS }),
  modelCalls: define({ name: 'wa_model_calls_total', help: 'Gemini calls by status.', type: 'counter' }),
  modelCallDuration: define({ name: 'wa_model_call_duration_seconds', help: 'Gemini call latency.', type: 'histogram', buckets: DURATION_BUCKETS }),
  modelTokens: define({ name: 'wa_model_tokens_total', help: 'Gemini tokens by type (prompt|output).', type: 'counter' }),
  modelCallsPerTurn: define({ name: 'wa_model_calls_per_turn', help: 'Gemini calls made by one turn.', type: 'histogram', buckets: COUNT_BUCKETS }),
  promptTokensPerTurn: define({ name: 'wa_prompt_tokens_per_turn', help: 'Prompt tokens sent by one turn.', type: 'histogram', buckets: TOKEN_BUCKETS }),
  toolCalls: define({ name: 'wa_tool_calls_total', help: 'Tool executions by tool name and ok.', type: 'counter' }),
  guardBlocks: define({ name: 'wa_guard_blocks_total', help: 'send_message vetoes by stable guard check id.', type: 'counter' }),
  fallbackReplies: define({ name: 'wa_fallback_replies_total', help: 'Last-resort fallback replies attempted.', type: 'counter' }),
  sends: define({ name: 'wa_sends_total', help: 'Outbound WhatsApp send attempts by recipient kind and final status.', type: 'counter' }),
  sendDuration: define({ name: 'wa_send_duration_seconds', help: 'Provider send latency.', type: 'histogram', buckets: DURATION_BUCKETS }),
  queueJobs: define({ name: 'wa_queue_jobs', help: 'Durable inbound jobs by status.', type: 'gauge' }),
  jobEvents: define({ name: 'wa_job_events_total', help: 'Inbound job lifecycle events (queued, started, completed, deferred, retry, failed).', type: 'counter' }),
  aiBudgetUsed: define({ name: 'wa_ai_budget_used_ratio', help: 'Share of today\'s AI budget used (max of calls and tokens), 0..1.', type: 'gauge' }),
  whatsappUp: define({ name: 'wa_whatsapp_session_up', help: '1 when the WAHA session status is WORKING, else 0.', type: 'gauge' }),
  whatsappDownSeconds: define({ name: 'wa_whatsapp_down_seconds', help: 'Seconds the current WhatsApp outage has lasted (0 when working).', type: 'gauge' }),
  ownerAlertsPending: define({ name: 'wa_owner_alerts_pending', help: 'Owner alerts not yet delivered.', type: 'gauge' }),
  traceWriteFailures: define({ name: 'wa_trace_write_failures_total', help: 'Trace table writes that failed (the turn continued).', type: 'counter' }),
  estimatedCost: define({ name: 'wa_estimated_cost_usd_total', help: 'Estimated Gemini cost from configured per-million-token prices.', type: 'counter' }),
} as const;

const UNLABELLED_COUNTERS = new Set<string>([
  METRIC.fallbackReplies,
  METRIC.traceWriteFailures,
  METRIC.estimatedCost,
]);

export function safeLabel(value: unknown): string {
  const text = String(value ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return text.slice(0, 48) || 'unknown';
}

function labelKey(labels: MetricLabels = {}): string {
  const keys = Object.keys(labels).sort();
  return keys.map((key) => `${key}="${safeLabel(labels[key])}"`).join(',');
}

export function incCounter(name: string, labels?: MetricLabels, by = 1): void {
  if (!Number.isFinite(by) || by < 0) return;
  let series = counters.get(name);
  if (!series) {
    series = new Map();
    counters.set(name, series);
  }
  const key = labelKey(labels);
  series.set(key, (series.get(key) ?? 0) + by);
}

export function setGauge(name: string, value: number, labels?: MetricLabels): void {
  if (!Number.isFinite(value)) return;
  let series = gauges.get(name);
  if (!series) {
    series = new Map();
    gauges.set(name, series);
  }
  series.set(labelKey(labels), value);
}

export function observeHistogram(name: string, value: number, labels?: MetricLabels): void {
  if (!Number.isFinite(value) || value < 0) return;
  const buckets = DEFS[name]?.buckets ?? DURATION_BUCKETS;
  let series = histograms.get(name);
  if (!series) {
    series = new Map();
    histograms.set(name, series);
  }
  const key = labelKey(labels);
  let entry = series.get(key);
  if (!entry) {
    entry = { counts: buckets.map(() => 0), sum: 0, count: 0 };
    series.set(key, entry);
  }
  buckets.forEach((bound, index) => {
    if (value <= bound) entry!.counts[index] += 1;
  });
  entry.sum += value;
  entry.count += 1;
}

/** Test/diagnostic accessor for one counter series. */
export function readCounter(name: string, labels?: MetricLabels): number {
  return counters.get(name)?.get(labelKey(labels)) ?? 0;
}

// ── Domain helpers (the only calls instrumentation sites need) ───────────────

export function readModelPrices(env: NodeJS.ProcessEnv = process.env): { input: number; output: number } | null {
  const parse = (value: string | undefined): number | null => {
    const text = value?.trim() ?? '';
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed >= 0 && parsed < 1_000 ? parsed : null;
  };
  const input = parse(env.GEMINI_PRICE_INPUT_PER_MTOK);
  const output = parse(env.GEMINI_PRICE_OUTPUT_PER_MTOK);
  return input === null || output === null ? null : { input, output };
}

export function recordModelCallMetric(input: {
  ok: boolean;
  status: string;
  durationMs: number;
  promptTokens: number;
  outputTokens: number;
}): void {
  incCounter(METRIC.modelCalls, { status: input.status });
  observeHistogram(METRIC.modelCallDuration, input.durationMs / 1_000);
  if (input.promptTokens > 0) incCounter(METRIC.modelTokens, { type: 'prompt' }, input.promptTokens);
  if (input.outputTokens > 0) incCounter(METRIC.modelTokens, { type: 'output' }, input.outputTokens);
  const prices = readModelPrices();
  if (prices) {
    const cost = (input.promptTokens / 1_000_000) * prices.input + (input.outputTokens / 1_000_000) * prices.output;
    incCounter(METRIC.estimatedCost, undefined, cost);
  }
}

// Every tool a customer or owner turn can execute. A model-invented name is
// never a label value (it would be attacker-chosen text and unbounded
// cardinality); it is counted as "unknown". tests/verifier-fixes.test.ts
// checks this list against the real tool lists.
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'check_stock', 'search_catalog', 'get_customer_balance', 'get_customer_note', 'get_my_order_status',
  'prepare_order', 'confirm_order', 'show_pending_order', 'update_order_status', 'claim_payment',
  'request_refund', 'get_my_refund_status', 'notify_owner', 'get_payment_options',
  'send_payment_instructions', 'send_handoff_status', 'send_message', 'show_product_images',
  'inventory_overview', 'sales_today', 'unpaid_customers', 'top_selling_product', 'pending_followups',
  'pending_payment_claims', 'pending_refund_requests', 'resolve_refund_request', 'resolve_payment_claim',
  'outbound_delivery_issues',
]);

export function toolMetricLabel(tool: string): string {
  return KNOWN_TOOL_NAMES.has(tool) ? tool : 'unknown';
}

export function recordToolCallMetric(tool: string, ok: boolean): void {
  incCounter(METRIC.toolCalls, { tool: toolMetricLabel(tool), ok: ok ? 'true' : 'false' });
}

export function recordGuardBlockMetric(check: string): void {
  incCounter(METRIC.guardBlocks, { check });
}

export function recordFallbackMetric(): void {
  incCounter(METRIC.fallbackReplies);
}

export function recordSendMetric(recipientKind: string, status: string, durationMs?: number): void {
  incCounter(METRIC.sends, { recipient_kind: recipientKind, status });
  if (durationMs !== undefined) observeHistogram(METRIC.sendDuration, durationMs / 1_000);
}

export function recordInboundMessageMetric(turnKind: string): void {
  incCounter(METRIC.inboundMessages, { turn_kind: turnKind });
}

export function recordJobEventMetric(event: string): void {
  incCounter(METRIC.jobEvents, { event });
}

export function recordTurnMetric(input: {
  turnKind: string;
  outcome: string;
  durationMs: number;
  modelCalls: number;
  promptTokens: number;
}): void {
  incCounter(METRIC.turns, { turn_kind: input.turnKind, outcome: input.outcome });
  // A deferred job (session check, AI budget) is not a turn: keep it out of
  // every per-turn histogram, including duration (it would drag p50 to ~0).
  if (input.outcome !== 'deferred') {
    observeHistogram(METRIC.turnDuration, input.durationMs / 1_000, { turn_kind: input.turnKind });
    observeHistogram(METRIC.modelCallsPerTurn, input.modelCalls, { turn_kind: input.turnKind });
    observeHistogram(METRIC.promptTokensPerTurn, input.promptTokens, { turn_kind: input.turnKind });
  }
}

export function recordTraceWriteFailure(): void {
  incCounter(METRIC.traceWriteFailures);
}

/** Latest known WAHA session state; `null` until the first check. */
let whatsappSessionUp: boolean | null = null;

export function setWhatsappSessionUp(up: boolean): void {
  whatsappSessionUp = up;
  setGauge(METRIC.whatsappUp, up ? 1 : 0);
}

export function setWhatsappDownSeconds(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  setGauge(METRIC.whatsappDownSeconds, Math.round(seconds));
}

export function getWhatsappSessionUp(): boolean | null {
  return whatsappSessionUp;
}

// ── Exposition ───────────────────────────────────────────────────────────────

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return Number(value.toPrecision(12)).toString();
}

function line(name: string, key: string, value: number): string {
  return `${name}${key ? `{${key}}` : ''} ${formatNumber(value)}`;
}

/** Renders every registered metric in Prometheus text exposition format 0.0.4. */
export function renderPrometheus(): string {
  const out: string[] = [];
  for (const def of Object.values(DEFS)) {
    if (def.name === METRIC.estimatedCost && !readModelPrices()) continue; // only when prices are configured
    out.push(`# HELP ${def.name} ${def.help}`);
    out.push(`# TYPE ${def.name} ${def.type}`);
    if (def.type === 'counter') {
      const series = counters.get(def.name);
      if (!series || series.size === 0) {
        // Unlabelled counters start at 0 so rate()/increase() have a baseline.
        if (UNLABELLED_COUNTERS.has(def.name)) out.push(line(def.name, '', 0));
        continue;
      }
      for (const [key, value] of series) out.push(line(def.name, key, value));
    } else if (def.type === 'gauge') {
      for (const [key, value] of gauges.get(def.name) ?? []) out.push(line(def.name, key, value));
    } else {
      const buckets = def.buckets ?? DURATION_BUCKETS;
      for (const [key, entry] of histograms.get(def.name) ?? []) {
        const prefix = key ? `${key},` : '';
        buckets.forEach((bound, index) => {
          out.push(`${def.name}_bucket{${prefix}le="${formatNumber(bound)}"} ${entry.counts[index]}`);
        });
        out.push(`${def.name}_bucket{${prefix}le="+Inf"} ${entry.count}`);
        out.push(line(`${def.name}_sum`, key, entry.sum));
        out.push(line(`${def.name}_count`, key, entry.count));
      }
    }
  }
  return `${out.join('\n')}\n`;
}
