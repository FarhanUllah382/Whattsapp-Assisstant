import { db } from './db';
import { ChannelSendError } from './channel/types';
import { traceSendFinished, traceSendStarted } from './obs/trace';
import type { ToolDef } from './types';

export type OutboundRecipientKind = 'customer' | 'owner';
export type OutboundAttemptStatus = 'pending' | 'sent' | 'failed' | 'uncertain';

interface StoredAttempt {
  id: string;
  status: OutboundAttemptStatus;
  created_at: string;
  updated_at: string;
}

function sqlTimeMs(value: string): number {
  return new Date(value.replace(' ', 'T') + 'Z').getTime();
}

export function inspectOutboundAttempt(
  id: string,
  resendAfterMs?: number,
  now = new Date(),
): 'new' | 'retryable' | 'already_sent' | 'uncertain' {
  const row = db.prepare(`
    select id, status, created_at, updated_at from send_ledger where id = ?
  `).get(id) as StoredAttempt | undefined;
  if (!row) return 'new';
  if (row.status === 'failed') return 'retryable';
  if (row.status === 'pending' || row.status === 'uncertain') return 'uncertain';
  if (resendAfterMs !== undefined && now.getTime() - sqlTimeMs(row.updated_at) >= resendAfterMs) {
    return 'retryable';
  }
  return 'already_sent';
}

export function beginOutboundAttempt(input: {
  id: string;
  customerId: number;
  recipientKind: OutboundRecipientKind;
  eventKey: string;
  bodyHash: string;
  resendAfterMs?: number;
  now?: Date;
}): 'send' | 'already_sent' | 'uncertain' {
  const now = input.now ?? new Date();
  return db.transaction(() => {
    const sameEvent = db.prepare(`
      select id, status, created_at, updated_at, last_error_code
        from send_ledger
       where recipient_kind = ? and event_key = ?
       limit 1
    `).get(input.recipientKind, input.eventKey) as
      | (StoredAttempt & { last_error_code: string | null })
      | undefined;
    if (sameEvent && sameEvent.id !== input.id) {
      if (sameEvent.status === 'failed' && sameEvent.last_error_code === 'channel_unavailable') {
        // The earlier attempt never reached WhatsApp (session down / gateway
        // refused), so it was not the event's visible reply. A rerun after
        // the session returns may phrase the reply differently; take over the
        // event's single ledger row (unique per recipient+event) so the
        // one-reply-per-event rule still holds for every later attempt.
        db.prepare(`
          update send_ledger
             set id = ?, body_hash = ?, status = 'pending', attempt_count = attempt_count + 1,
                 provider_message_id = null, last_error_code = null, updated_at = ?
           where id = ? and status = 'failed' and last_error_code = 'channel_unavailable'
        `).run(
          input.id,
          input.bodyHash,
          now.toISOString().slice(0, 23).replace('T', ' '),
          sameEvent.id,
        );
        return 'send' as const;
      }
      // One inbound event may produce at most one visible reply. A model that
      // rephrases after an uncertain outcome cannot escape idempotency by
      // changing the body hash.
      return sameEvent.status === 'sent' ? 'already_sent' as const : 'uncertain' as const;
    }
    const existing = db.prepare(`
      select id, status, created_at, updated_at from send_ledger where id = ?
    `).get(input.id) as StoredAttempt | undefined;
    if (!existing) {
      db.prepare(`
        insert into send_ledger
          (id, customer_id, recipient_kind, event_key, body_hash, status, attempt_count, created_at, updated_at)
        values (?, ?, ?, ?, ?, 'pending', 1, ?, ?)
      `).run(
        input.id,
        input.customerId,
        input.recipientKind,
        input.eventKey,
        input.bodyHash,
        now.toISOString().slice(0, 23).replace('T', ' '),
        now.toISOString().slice(0, 23).replace('T', ' '),
      );
      traceSendStarted(input.id, input.recipientKind);
      return 'send' as const;
    }
    if (existing.status === 'pending' || existing.status === 'uncertain') {
      if (existing.status === 'pending') {
        db.prepare(`
          update send_ledger
             set status = 'uncertain', last_error_code = 'interrupted_after_attempt_started',
                 updated_at = ?
           where id = ? and status = 'pending'
        `).run(now.toISOString().slice(0, 23).replace('T', ' '), input.id);
      }
      return 'uncertain' as const;
    }
    const mayRepeat = existing.status === 'failed' || (
      input.resendAfterMs !== undefined &&
      now.getTime() - sqlTimeMs(existing.updated_at) >= input.resendAfterMs
    );
    if (!mayRepeat) return 'already_sent' as const;
    db.prepare(`
      update send_ledger
         set status = 'pending', attempt_count = attempt_count + 1,
             provider_message_id = null, last_error_code = null, updated_at = ?
       where id = ?
    `).run(now.toISOString().slice(0, 23).replace('T', ' '), input.id);
    traceSendStarted(input.id, input.recipientKind);
    return 'send' as const;
  }).immediate();
}

export function markOutboundSent(id: string, providerMessageId?: string): void {
  db.prepare(`
    update send_ledger
       set status = 'sent', provider_message_id = ?, last_error_code = null,
           updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
     where id = ?
  `).run(providerMessageId ?? null, id);
  traceSendFinished(id, 'sent');
}

/**
 * Records a failed send. Only a definitive ChannelSendError is 'failed'
 * (retryable); everything else — timeouts, resets, unknown errors — stays
 * 'uncertain' and is never resent automatically. A channel_unavailable
 * failure (WAHA 422 session not working / gateway refused) is recorded with
 * that code so it can be retried once the session is back.
 */
export function markOutboundFailure(id: string, error: unknown): OutboundAttemptStatus {
  const definitive = error instanceof ChannelSendError && !error.deliveryUncertain;
  const status: OutboundAttemptStatus = definitive ? 'failed' : 'uncertain';
  const code = !definitive
    ? 'delivery_outcome_unknown'
    : (error as ChannelSendError).code === 'channel_unavailable'
      ? 'channel_unavailable'
      : 'provider_rejected';
  db.prepare(`
    update send_ledger
       set status = ?, last_error_code = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
     where id = ? and status = 'pending'
  `).run(status, code, id);
  traceSendFinished(id, status);
  return status;
}

export const outboundDeliveryIssuesTool: ToolDef = {
  name: 'outbound_delivery_issues',
  description:
    'List recent outbound replies whose delivery is failed or uncertain. Read-only; never retry automatically.',
  input_schema: { type: 'object', properties: {} },
  execute: () => ({
    ok: true,
    issues: db.prepare(`
      select substr(id, 1, 12) as attempt_reference, recipient_kind, status,
             attempt_count, last_error_code, created_at, updated_at
        from send_ledger
       where status in ('failed', 'uncertain')
       order by updated_at desc
       limit 20
    `).all(),
  }),
};
