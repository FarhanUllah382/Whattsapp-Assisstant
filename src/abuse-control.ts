import { createHash } from 'node:crypto';

import { db } from './db';

export interface InboundAbuseConfig {
  windowMinutes: number;
  customerTurnsPerWindow: number;
  ownerTurnsPerWindow: number;
}

export const INBOUND_ABUSE_DEFAULTS: InboundAbuseConfig = {
  windowMinutes: 10,
  customerTurnsPerWindow: 20,
  ownerTurnsPerWindow: 60,
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

/** Invalid or missing values use finite conservative defaults, never unlimited. */
export function readInboundAbuseConfig(
  env: NodeJS.ProcessEnv = process.env,
): InboundAbuseConfig {
  return {
    windowMinutes: boundedInteger(
      env.INBOUND_RATE_WINDOW_MINUTES,
      INBOUND_ABUSE_DEFAULTS.windowMinutes,
      1,
      60,
    ),
    customerTurnsPerWindow: boundedInteger(
      env.INBOUND_CUSTOMER_TURNS_PER_WINDOW,
      INBOUND_ABUSE_DEFAULTS.customerTurnsPerWindow,
      1,
      200,
    ),
    ownerTurnsPerWindow: boundedInteger(
      env.INBOUND_OWNER_TURNS_PER_WINDOW,
      INBOUND_ABUSE_DEFAULTS.ownerTurnsPerWindow,
      1,
      500,
    ),
  };
}

export type InboundAdmission =
  | { allow: true; reason: 'admitted' | 'already_admitted'; used: number; limit: number }
  | { allow: false; reason: 'rate_limited'; used: number; limit: number; retryAfterSeconds: number };

function senderHash(phone: string): string {
  return createHash('sha256').update(phone.replace(/\D/g, '')).digest('hex');
}

/**
 * Admit one model-backed turn. The provider event key makes the decision
 * idempotent, while the hashed sender key avoids creating another raw-phone
 * store. Consent commands and opted-out messages are handled before this gate
 * and therefore remain available without an AI call.
 */
export function admitInboundTurn(input: {
  phone: string;
  eventKey: string;
  owner: boolean;
  now?: Date;
  config?: InboundAbuseConfig;
}): InboundAdmission {
  const now = input.now ?? new Date();
  const config = input.config ?? readInboundAbuseConfig();
  const limit = input.owner ? config.ownerTurnsPerWindow : config.customerTurnsPerWindow;
  const actorKind = input.owner ? 'owner' : 'customer';
  const hashedSender = senderHash(input.phone);
  const cutoff = new Date(now.getTime() - config.windowMinutes * 60_000).toISOString();
  const createdAt = now.toISOString();

  return db.transaction((): InboundAdmission => {
    const prior = db.prepare(
      'select decision from inbound_abuse_events where event_key = ?',
    ).get(input.eventKey) as { decision: 'admitted' | 'rate_limited' } | undefined;
    if (prior) {
      const used = (db.prepare(`
        select count(*) as count
        from inbound_abuse_events
        where sender_hash = ? and actor_kind = ? and decision = 'admitted' and created_at >= ?
      `).get(hashedSender, actorKind, cutoff) as { count: number }).count;
      return prior.decision === 'admitted'
        ? { allow: true, reason: 'already_admitted', used, limit }
        : {
            allow: false,
            reason: 'rate_limited',
            used,
            limit,
            retryAfterSeconds: config.windowMinutes * 60,
          };
    }

    const used = (db.prepare(`
      select count(*) as count
      from inbound_abuse_events
      where sender_hash = ? and actor_kind = ? and decision = 'admitted' and created_at >= ?
    `).get(hashedSender, actorKind, cutoff) as { count: number }).count;
    const decision = used >= limit ? 'rate_limited' : 'admitted';
    db.prepare(`
      insert into inbound_abuse_events
        (event_key, sender_hash, actor_kind, decision, created_at)
      values (?, ?, ?, ?, ?)
    `).run(input.eventKey, hashedSender, actorKind, decision, createdAt);

    if (decision === 'rate_limited') {
      return {
        allow: false,
        reason: 'rate_limited',
        used,
        limit,
        retryAfterSeconds: config.windowMinutes * 60,
      };
    }
    return { allow: true, reason: 'admitted', used: used + 1, limit };
  }).immediate();
}

