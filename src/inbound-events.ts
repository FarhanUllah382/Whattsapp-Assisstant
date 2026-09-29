import { db } from './db';

const PROCESSING_LEASE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export type InboundClaim =
  | { action: 'process'; eventKey: string; reason: 'new' | 'retry' | 'stale_processing_lease' }
  | { action: 'duplicate'; eventKey: string; reason: 'completed' | 'processing' | 'ignored' }
  | { action: 'ignore'; eventKey?: string; reason: 'missing_message_id' | 'missing_timestamp' | 'historical' | 'invalid_timestamp' };

interface ExistingEvent {
  status: 'processing' | 'completed' | 'failed' | 'ignored_historical' | 'ignored_invalid_timestamp';
  processing_started_at: string | null;
}

/**
 * Parses an explicit rollout cutoff. Requiring a timezone suffix avoids the
 * exact UTC-vs-Asia/Karachi ambiguity that previously affected pacing.
 */
export function parseInboundAcceptAfter(value: string | undefined): Date | null {
  if (value === undefined || value.trim() === '') return null;
  const trimmed = value.trim();
  if (!ISO_WITH_ZONE.test(trimmed)) {
    throw new Error('INBOUND_ACCEPT_AFTER must be an ISO timestamp with Z or an explicit UTC offset');
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('INBOUND_ACCEPT_AFTER is not a valid timestamp');
  }
  return parsed;
}

/**
 * Advances the durable acceptance watermark on every application start.
 * WAHA can replay messages accumulated while this webhook consumer was
 * offline, so an installation-only cutoff is insufficient: only messages
 * created in or after the current startup second may enter either agent path.
 */
export function initializeInboundReplayGuard(
  processStartedAt: Date = new Date(),
  configuredValue: string | undefined = process.env.INBOUND_ACCEPT_AFTER,
): Date {
  const existing = db.prepare('select accept_after from inbound_guard_state where id = 1').get() as
    | { accept_after: string }
    | undefined;
  const configured = parseInboundAcceptAfter(configuredValue);
  // WAHA may provide only whole-second precision. Round the automatic cutoff
  // down so a message created during the same second as startup is accepted.
  const automaticCutoff = new Date(Math.floor(processStartedAt.getTime() / 1000) * 1000);
  let cutoff = configured && configured > automaticCutoff ? configured : automaticCutoff;
  if (existing) {
    const stored = new Date(existing.accept_after);
    if (Number.isNaN(stored.getTime())) {
      throw new Error('Stored inbound replay cutoff is invalid; refusing to start');
    }
    if (stored > cutoff) cutoff = stored;
  }
  if (Number.isNaN(cutoff.getTime())) throw new Error('Inbound replay cutoff is invalid');
  db.transaction(() => {
    db.prepare(`
      insert into inbound_guard_state (id, accept_after) values (1, ?)
      on conflict(id) do update set accept_after = excluded.accept_after
    `).run(cutoff.toISOString());
    // A previous process may have died while handling a now-historical event.
    // Do not let its failed/stale lease bypass the new startup watermark.
    db.prepare(`
      update inbound_events
         set status = 'ignored_historical',
             processing_started_at = null,
             last_error = null,
             updated_at = ?
       where status in ('processing', 'failed') and occurred_at < ?
    `).run(processStartedAt.toISOString(), cutoff.toISOString());
  })();
  return cutoff;
}

export function claimInboundEvent(input: {
  channel: string;
  messageId?: string;
  occurredAt?: Date;
  acceptAfter: Date;
  now?: Date;
}): InboundClaim {
  const now = input.now ?? new Date();
  const messageId = input.messageId?.trim();
  if (!messageId || messageId.length > 1024) {
    return { action: 'ignore', reason: 'missing_message_id' };
  }
  const eventKey = `${input.channel}:${messageId}`;
  if (!input.occurredAt) return { action: 'ignore', eventKey, reason: 'missing_timestamp' };

  const occurredMs = input.occurredAt.getTime();
  if (!Number.isFinite(occurredMs) || occurredMs > now.getTime() + MAX_FUTURE_SKEW_MS) {
    insertIgnoredEvent(eventKey, input.channel, messageId, input.occurredAt, 'ignored_invalid_timestamp', now);
    return { action: 'ignore', eventKey, reason: 'invalid_timestamp' };
  }

  const transaction = db.transaction((): InboundClaim => {
    const existing = db.prepare(
      'select status, processing_started_at from inbound_events where event_key = ?',
    ).get(eventKey) as ExistingEvent | undefined;

    if (occurredMs < input.acceptAfter.getTime()) {
      if (existing) {
        if (existing.status === 'completed') {
          return { action: 'duplicate', eventKey, reason: 'completed' };
        }
        if (existing.status === 'ignored_historical' || existing.status === 'ignored_invalid_timestamp') {
          return { action: 'duplicate', eventKey, reason: 'ignored' };
        }
        db.prepare(`
          update inbound_events
             set status = 'ignored_historical', processing_started_at = null,
                 last_error = null, updated_at = ?
           where event_key = ?
        `).run(now.toISOString(), eventKey);
      } else {
        insertIgnoredEvent(eventKey, input.channel, messageId, input.occurredAt!, 'ignored_historical', now);
      }
      return { action: 'ignore', eventKey, reason: 'historical' };
    }

    if (existing) {
      if (existing.status === 'failed') {
        resetForRetry(eventKey, now);
        return { action: 'process', eventKey, reason: 'retry' };
      }
      if (existing.status === 'processing') {
        const startedMs = existing.processing_started_at
          ? new Date(existing.processing_started_at).getTime()
          : Number.NaN;
        if (!Number.isFinite(startedMs) || now.getTime() - startedMs >= PROCESSING_LEASE_MS) {
          resetForRetry(eventKey, now);
          return { action: 'process', eventKey, reason: 'stale_processing_lease' };
        }
        return { action: 'duplicate', eventKey, reason: 'processing' };
      }
      if (existing.status === 'completed') {
        return { action: 'duplicate', eventKey, reason: 'completed' };
      }
      return { action: 'duplicate', eventKey, reason: 'ignored' };
    }

    db.prepare(`
      insert into inbound_events
        (event_key, channel, message_id, occurred_at, status, processing_started_at, updated_at)
      values (?, ?, ?, ?, 'processing', ?, ?)
    `).run(
      eventKey,
      input.channel,
      messageId,
      input.occurredAt!.toISOString(),
      now.toISOString(),
      now.toISOString(),
    );
    return { action: 'process', eventKey, reason: 'new' };
  });

  return transaction();
}

function insertIgnoredEvent(
  eventKey: string,
  channel: string,
  messageId: string,
  occurredAt: Date,
  status: 'ignored_historical' | 'ignored_invalid_timestamp',
  now: Date,
): void {
  const occurredAtText = Number.isFinite(occurredAt.getTime()) ? occurredAt.toISOString() : 'invalid';
  db.prepare(`
    insert into inbound_events
      (event_key, channel, message_id, occurred_at, status, processing_started_at, updated_at)
    values (?, ?, ?, ?, ?, null, ?)
    on conflict(event_key) do nothing
  `).run(eventKey, channel, messageId, occurredAtText, status, now.toISOString());
}

function resetForRetry(eventKey: string, now: Date): void {
  db.prepare(`
    update inbound_events
       set status = 'processing',
           attempt_count = attempt_count + 1,
           processing_started_at = ?,
           completed_at = null,
           last_error = null,
           updated_at = ?
     where event_key = ?
  `).run(now.toISOString(), now.toISOString(), eventKey);
}

export function completeInboundEvent(eventKey: string, now: Date = new Date()): void {
  db.prepare(`
    update inbound_events
       set status = 'completed', completed_at = ?, last_error = null, updated_at = ?
     where event_key = ? and status = 'processing'
  `).run(now.toISOString(), now.toISOString(), eventKey);
}

export function failInboundEvent(eventKey: string, error: unknown, now: Date = new Date()): void {
  const detail = error instanceof Error ? error.message : String(error);
  db.prepare(`
    update inbound_events
       set status = 'failed', last_error = ?, updated_at = ?
     where event_key = ? and status = 'processing'
  `).run(detail.slice(0, 1000), now.toISOString(), eventKey);
}
