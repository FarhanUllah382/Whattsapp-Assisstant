import { db } from './db';
import { createLogger } from './obs/logger';
import { sanitizeMemoryText } from './privacy';

const log = createLogger();

export interface OwnerAlertFloodConfig {
  windowMinutes: number;
  maxSendsPerWindow: number;
}

export const OWNER_ALERT_FLOOD_DEFAULTS: OwnerAlertFloodConfig = {
  windowMinutes: 10,
  maxSendsPerWindow: 6,
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

/** Invalid settings stay finite; owner-alert delivery never becomes unlimited. */
export function readOwnerAlertFloodConfig(
  env: NodeJS.ProcessEnv = process.env,
): OwnerAlertFloodConfig {
  return {
    windowMinutes: boundedInteger(
      env.OWNER_ALERT_WINDOW_MINUTES,
      OWNER_ALERT_FLOOD_DEFAULTS.windowMinutes,
      1,
      1_440,
    ),
    maxSendsPerWindow: boundedInteger(
      env.OWNER_ALERT_MAX_SENDS_PER_WINDOW,
      OWNER_ALERT_FLOOD_DEFAULTS.maxSendsPerWindow,
      1,
      1_000,
    ),
  };
}

export type OwnerAlertKind =
  | 'customer_handoff'
  | 'reply_failure'
  | 'unlogged_order'
  | 'unlogged_payment'
  | 'payment_claim'
  | 'refund_request';

interface OwnerAlertRow {
  id: number;
  kind: OwnerAlertKind;
  status: 'pending' | 'sent';
  occurrence_count: number;
  first_customer_id: number;
  latest_customer_id: number;
  latest_reason: string;
}

export interface DeliverOwnerAlertInput {
  kind: OwnerAlertKind;
  eventKey: string;
  customerId: number;
  reason: string;
  send: (body: string) => Promise<void>;
  floodConfig?: OwnerAlertFloodConfig;
  now?: Date;
}

export interface DeliverOwnerAlertResult {
  ok: boolean;
  status: 'sent' | 'already_sent' | 'pending';
  alertId: number;
  reason?: 'rate_limited' | 'delivery_failed';
  error?: string;
}

let alertDeliveryTail: Promise<unknown> = Promise.resolve();

function withAlertDeliveryLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = alertDeliveryTail.then(fn, fn);
  alertDeliveryTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function queueAlert(input: Omit<DeliverOwnerAlertInput, 'send'>): OwnerAlertRow {
  const safeReason = sanitizeMemoryText(input.reason).slice(0, 2000);
  return db.transaction(() => {
    const priorEvent = db
      .prepare(
        `select a.*
         from owner_alert_events e
         join owner_alerts a on a.id = e.alert_id
         where e.event_key = ?`,
      )
      .get(input.eventKey) as OwnerAlertRow | undefined;
    if (priorEvent) return priorEvent;

    let alert = db
      .prepare("select * from owner_alerts where kind = ? and status = 'pending'")
      .get(input.kind) as OwnerAlertRow | undefined;

    if (alert) {
      db.prepare(
        `update owner_alerts
         set occurrence_count = occurrence_count + 1,
             latest_customer_id = ?, latest_reason = ?, updated_at = datetime('now')
         where id = ?`,
      ).run(input.customerId, safeReason, alert.id);
    } else {
      const result = db.prepare(
        `insert into owner_alerts
           (kind, first_customer_id, latest_customer_id, latest_reason)
         values (?, ?, ?, ?)`,
      ).run(input.kind, input.customerId, input.customerId, safeReason);
      alert = db.prepare('select * from owner_alerts where id = ?').get(result.lastInsertRowid) as OwnerAlertRow;
    }

    db.prepare('insert into owner_alert_events (event_key, alert_id) values (?, ?)').run(
      input.eventKey,
      alert.id,
    );
    return db.prepare('select * from owner_alerts where id = ?').get(alert.id) as OwnerAlertRow;
  })();
}

function formatAlert(alert: OwnerAlertRow): string {
  const count = alert.occurrence_count > 1 ? `\nOccurrences grouped: ${alert.occurrence_count}` : '';
  return [
    'Ahmed — assistant alert',
    `Type: ${alert.kind.replace(/_/g, ' ')}`,
    `Customer record: #${alert.latest_customer_id}`,
    `Reason: ${alert.latest_reason}`,
    count,
  ].filter(Boolean).join('\n');
}

async function sendPendingAlert(
  alert: OwnerAlertRow,
  send: (body: string) => Promise<void>,
  floodConfig: OwnerAlertFloodConfig,
  now: Date,
): Promise<DeliverOwnerAlertResult> {
  const cutoff = new Date(now.getTime() - floodConfig.windowMinutes * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const sentInWindow = (db.prepare(`
    select count(*) as count
    from owner_alerts
    where status = 'sent' and sent_at >= ?
  `).get(cutoff) as { count: number }).count;
  if (sentInWindow >= floodConfig.maxSendsPerWindow) {
    log.warn('owner alert retained by flood limit', {
      alertId: alert.id,
      kind: alert.kind,
      sentInWindow,
      limit: floodConfig.maxSendsPerWindow,
      windowMinutes: floodConfig.windowMinutes,
    });
    return {
      ok: false,
      status: 'pending',
      alertId: alert.id,
      reason: 'rate_limited',
      error: 'The alert was recorded and grouped, but owner delivery is temporarily rate limited.',
    };
  }

  try {
    await send(formatAlert(alert));
    const sentAt = now.toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(
      `update owner_alerts
       set status = 'sent', sent_at = ?, updated_at = ?
       where id = ? and status = 'pending'`,
    ).run(sentAt, sentAt, alert.id);
    log.info('owner alert delivered', { alertId: alert.id, kind: alert.kind });
    return { ok: true, status: 'sent', alertId: alert.id };
  } catch (err) {
    log.error('owner alert delivery failed', {
      alertId: alert.id,
      kind: alert.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      status: 'pending',
      alertId: alert.id,
      reason: 'delivery_failed',
      error: 'The handoff was recorded, but its WhatsApp alert is still pending delivery.',
    };
  }
}

/**
 * Records an owner alert first, then attempts delivery exactly once for its
 * stable source event. A failed send stays pending and can be retried by the
 * same event; a successful send is never repeated for that event.
 */
export async function deliverOwnerAlert(
  input: DeliverOwnerAlertInput,
): Promise<DeliverOwnerAlertResult> {
  return withAlertDeliveryLock(async () => {
    const alert = queueAlert(input);
    if (alert.status === 'sent') {
      return { ok: true, status: 'already_sent', alertId: alert.id };
    }
    return sendPendingAlert(
      alert,
      input.send,
      input.floodConfig ?? readOwnerAlertFloodConfig(),
      input.now ?? new Date(),
    );
  });
}

/**
 * Retries durable alerts that a previous pacing decision or gateway failure
 * left pending. This is deliberately only the narrow Version 3.3 owner-alert
 * retry path, not a general-purpose async job queue.
 */
export async function retryPendingOwnerAlerts(
  send: (body: string) => Promise<void>,
  floodConfig: OwnerAlertFloodConfig = readOwnerAlertFloodConfig(),
  now: Date = new Date(),
): Promise<DeliverOwnerAlertResult[]> {
  return withAlertDeliveryLock(async () => {
    const pending = db
      .prepare("select * from owner_alerts where status = 'pending' order by id")
      .all() as OwnerAlertRow[];
    const results: DeliverOwnerAlertResult[] = [];
    for (const alert of pending) {
      results.push(await sendPendingAlert(alert, send, floodConfig, now));
    }
    return results;
  });
}
