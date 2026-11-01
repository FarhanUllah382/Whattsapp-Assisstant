import { randomUUID } from 'node:crypto';

import { db } from './db';

export interface AiBudgetConfig {
  timezone: string;
  dailyCallLimit: number;
  dailyTokenLimit: number;
}

export const AI_BUDGET_DEFAULTS: AiBudgetConfig = {
  timezone: 'Asia/Karachi',
  dailyCallLimit: 500,
  dailyTokenLimit: 500_000,
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function validTimezone(value: string | undefined): string {
  const candidate = value?.trim() || AI_BUDGET_DEFAULTS.timezone;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return AI_BUDGET_DEFAULTS.timezone;
  }
}

/** Missing or invalid settings always remain finite; there is no unlimited mode. */
export function readAiBudgetConfig(env: NodeJS.ProcessEnv = process.env): AiBudgetConfig {
  return {
    timezone: validTimezone(env.AI_BUDGET_TIMEZONE ?? env.PACING_TIMEZONE),
    dailyCallLimit: boundedInteger(
      env.AI_DAILY_CALL_LIMIT,
      AI_BUDGET_DEFAULTS.dailyCallLimit,
      1,
      100_000,
    ),
    dailyTokenLimit: boundedInteger(
      env.AI_DAILY_TOKEN_LIMIT,
      AI_BUDGET_DEFAULTS.dailyTokenLimit,
      1_000,
      1_000_000_000,
    ),
  };
}

export function budgetDayKey(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export class AiBudgetExceededError extends Error {
  constructor(
    public readonly reason: 'daily_call_limit' | 'daily_token_limit',
    public readonly dayKey: string,
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(
      reason === 'daily_call_limit'
        ? `Daily AI call limit reached for ${dayKey}.`
        : `Daily AI token limit reached for ${dayKey}.`,
    );
    this.name = 'AiBudgetExceededError';
  }
}

export interface AiCallReservation {
  id: string;
  dayKey: string;
  callsUsed: number;
  callLimit: number;
  tokensUsed: number;
  tokenLimit: number;
}

/** Atomically reserves one provider call before any network request is made. */
export function reserveAiModelCall(input: {
  model: string;
  now?: Date;
  config?: AiBudgetConfig;
  reservationId?: string;
}): AiCallReservation {
  const now = input.now ?? new Date();
  const config = input.config ?? readAiBudgetConfig();
  const dayKey = budgetDayKey(now, config.timezone);
  const id = input.reservationId ?? randomUUID();

  return db.transaction((): AiCallReservation => {
    const usage = db.prepare(`
      select count(*) as calls, coalesce(sum(total_tokens), 0) as tokens
      from ai_model_calls
      where day_key = ?
    `).get(dayKey) as { calls: number; tokens: number };
    if (usage.calls >= config.dailyCallLimit) {
      throw new AiBudgetExceededError('daily_call_limit', dayKey, usage.calls, config.dailyCallLimit);
    }
    if (usage.tokens >= config.dailyTokenLimit) {
      throw new AiBudgetExceededError('daily_token_limit', dayKey, usage.tokens, config.dailyTokenLimit);
    }
    db.prepare(`
      insert into ai_model_calls (id, day_key, model, status, started_at)
      values (?, ?, ?, 'reserved', ?)
    `).run(id, dayKey, input.model, now.toISOString());
    return {
      id,
      dayKey,
      callsUsed: usage.calls + 1,
      callLimit: config.dailyCallLimit,
      tokensUsed: usage.tokens,
      tokenLimit: config.dailyTokenLimit,
    };
  }).immediate();
}

function safeTokenCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

export function finishAiModelCall(input: {
  id: string;
  status: 'succeeded' | 'failed';
  promptTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  now?: Date;
}): void {
  const promptTokens = safeTokenCount(input.promptTokens);
  const outputTokens = safeTokenCount(input.outputTokens);
  const reportedTotal = safeTokenCount(input.totalTokens);
  const totalTokens = reportedTotal > 0 ? reportedTotal : promptTokens + outputTokens;
  db.prepare(`
    update ai_model_calls
    set status = ?, prompt_tokens = ?, output_tokens = ?, total_tokens = ?, finished_at = ?
    where id = ? and status = 'reserved'
  `).run(
    input.status,
    promptTokens,
    outputTokens,
    totalTokens,
    (input.now ?? new Date()).toISOString(),
    input.id,
  );
}

