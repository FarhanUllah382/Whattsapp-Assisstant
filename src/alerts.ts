import { db } from './db';
import { createLogger } from './obs/logger';

const log = createLogger();

export type OwnerAlertKind =
  | 'customer_handoff'
  | 'reply_failure'
  | 'unlogged_order'
  | 'unlogged_payment';

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
}

export interface DeliverOwnerAlertResult {
  ok: boolean;
  status: 'sent' | 'already_sent' | 'pending';
  alertId: number;
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
      ).run(input.customerId, input.reason, alert.id);
    } else {
      const result = db.prepare(
        `insert into owner_alerts
           (kind, first_customer_id, latest_customer_id, latest_reason)
         values (?, ?, ?, ?)`,
      ).run(input.kind, input.customerId, input.customerId, input.reason);
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
): Promise<DeliverOwnerAlertResult> {
  try {
    await send(formatAlert(alert));
    db.prepare(
      `update owner_alerts
       set status = 'sent', sent_at = datetime('now'), updated_at = datetime('now')
       where id = ? and status = 'pending'`,
    ).run(alert.id);
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
    return sendPendingAlert(alert, input.send);
  });
}

/**
 * Retries durable alerts that a previous pacing decision or gateway failure
 * left pending. This is deliberately only the narrow Version 3.3 owner-alert
 * retry path, not a general-purpose async job queue.
 */
export async function retryPendingOwnerAlerts(
  send: (body: string) => Promise<void>,
): Promise<DeliverOwnerAlertResult[]> {
  return withAlertDeliveryLock(async () => {
    const pending = db
      .prepare("select * from owner_alerts where status = 'pending' order by id")
      .all() as OwnerAlertRow[];
    const results: DeliverOwnerAlertResult[] = [];
    for (const alert of pending) {
      results.push(await sendPendingAlert(alert, send));
    }
    return results;
  });
}
