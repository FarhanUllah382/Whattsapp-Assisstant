import { db } from './db';
import { ChannelSendError } from './channel/types';
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
      select id, status, created_at, updated_at
        from send_ledger
       where recipient_kind = ? and event_key = ?
       limit 1
    `).get(input.recipientKind, input.eventKey) as StoredAttempt | undefined;
    if (sameEvent && sameEvent.id !== input.id) {
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
}

export function markOutboundFailure(id: string, error: unknown): OutboundAttemptStatus {
  const definitive = error instanceof ChannelSendError && !error.deliveryUncertain;
  const status: OutboundAttemptStatus = definitive ? 'failed' : 'uncertain';
  db.prepare(`
    update send_ledger
       set status = ?, last_error_code = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
     where id = ? and status = 'pending'
  `).run(status, definitive ? 'provider_rejected' : 'delivery_outcome_unknown', id);
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
