/**
 * Defaults CONSERVADORES do motor anti-ban (F2-11) — a FONTE ÚNICA dos números
 * de pacing do daemon (blueprint 5.2: números anti-ban são fonte única e
 * inconsistente → knobs, nunca constantes). `scripts/lint-pacing.ts` reprova
 * literal de pacing em qualquer outro arquivo de daemon/src.
 *
 * Override por número/sessão: linha em `channel_knobs` (0010) — coluna NULL cai
 * aqui. O CAP DIÁRIO ABSOLUTO não mora aqui nem em channel_knobs: a fonte única
 * é `channel_sessions.daily_message_limit` (regra dura nº 3) — mesmo banco agora,
 * a cadeia de envio lê por query direta e injeta em `decidePacing` (`crmDailyLimit`).
 */

/** Degrau de warm-up: a partir de `minAgeDays` de idade do número vale `cap` envios/dia; `cap: null` = formado (sem cap de warm-up — resta só o limite do CRM). */
export interface WarmupStep {
  minAgeDays: number;
  cap: number | null;
}

export interface PacingKnobs {
  /** Intervalo mínimo entre envios do MESMO número (ms). */
  throttleMs: number;
  /** Teto do jitter randômico somado ao throttle e ao next_allowed_at (ms) — intervalo fixo é assinatura de bot. */
  jitterMaxMs: number;
  /** Janela horária de envio [start, end) na hora local do tenant. */
  windowStartHour: number;
  windowEndHour: number;
  /**
   * Enviar aos domingos. **Ligado por default** — a janela horária cala à noite,
   * e o domingo inteiro mudo era cortesia demais: num CRM de atendimento, quem
   * escreve no domingo espera resposta no domingo.
   *
   * Continua sendo knob por canal (`AntiBanSheet` → `POST /api/v1/ai/pacing`):
   * quem faz prospecção ativa e prefere não incomodar no fim de semana desliga.
   */
  allowSunday: boolean;
  /** IANA timezone do tenant — a janela é avaliada NELA. */
  timezone: string;
  /** Degraus de warm-up ordenados por minAgeDays crescente (o primeiro cobre idade 0). */
  warmupDailyCaps: WarmupStep[];
}

/**
 * Limites de SANIDADE da edição de knobs no Console (FU-14) — validação de entrada do
 * operador, não defaults de comportamento. Moram aqui porque a doutrina proíbe número de
 * pacing fora deste módulo (scripts/lint-pacing.ts); o Console os importa em vez de
 * cravar literais.
 */
export const KNOB_BOUNDS = {
  /** teto de intervalo/jitter aceito na UI (ms). */
  intervalMaxMs: 600_000,
  /** maior hora aceita como INÍCIO de janela (fim vai até 24). */
  hourLastStart: 23,
  /** fim de janela é exclusivo e pode chegar à meia-noite seguinte. */
  hourEnd: 24,
} as const;

/**
 * Optional shop-hours override. Invalid values deliberately fall back to the
 * established 22:00 cutoff rather than widening the sending window by
 * accident. The fixed start remains 07:00 and the end is exclusive. Values
 * 01:00-06:00 represent a window that continues across midnight.
 */
export function parsePacingWindowEndHour(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return 22;
  const hour = Number(value);
  const isOvernightEnd = hour >= 1 && hour <= 6;
  const isSameDayEnd = hour >= 8 && hour <= 24;
  return Number.isInteger(hour) && (isOvernightEnd || isSameDayEnd) ? hour : 22;
}

/**
 * Opening hour of the sending window (inclusive, shop timezone). Default 7.
 * Testing: PACING_WINDOW_START_HOUR=0 with PACING_WINDOW_END_HOUR=24 keeps the
 * window open all day. Missing or invalid values safely use 7.
 */
export function parsePacingWindowStartHour(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return 7;
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 7;
}

export const PACING_DEFAULTS: PacingKnobs = {
  throttleMs: 1200, // 1 msg / 1,2s
  jitterMaxMs: 800,
  windowStartHour: parsePacingWindowStartHour(process.env.PACING_WINDOW_START_HOUR), // janela 7h-22h by default
  windowEndHour: parsePacingWindowEndHour(process.env.PACING_WINDOW_END_HOUR),
  allowSunday: true,
  // Ahmed's shop is in Pakistan — confirmed 2026-09-05. Still overridable
  // via PACING_TIMEZONE (an IANA zone) for any future shop in another zone;
  // this is just the correct default now that the real one is known.
  timezone: process.env.PACING_TIMEZONE ?? 'Asia/Karachi',
  // Missing/invalid PACING_NUMBER_ACTIVATED_ON is treated as age 0 (the most
  // conservative stage); parsing lives beside the pacing engine.
  warmupDailyCaps: [
    { minAgeDays: 0, cap: 20 },
    { minAgeDays: 4, cap: 50 },
    { minAgeDays: 8, cap: 100 },
    { minAgeDays: 15, cap: 200 },
    { minAgeDays: 31, cap: null },
  ],
};
