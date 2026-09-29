import { db } from './db';

export type ConsentAction = 'opt_out' | 'opt_in';

export interface ConsentEvent {
  id: number;
  customer_id: number;
  phone: string;
  event_key: string;
  action: ConsentAction;
  normalized_command: string;
  confirmation_status: 'pending' | 'sent' | 'not_required';
  created_at: string;
  confirmation_sent_at: string | null;
}

const OPT_OUT_COMMANDS = new Set([
  'stop',
  'unsubscribe',
  'stop messages',
  'stop messaging me',
  'do not message me',
  'dont message me',
  'no more messages',
  'message band karo',
  'messages band karo',
  'msg band karo',
  'mujhe message mat karo',
  'mujhe messages mat bhejo',
]);

const OPT_IN_COMMANDS = new Set([
  'start',
  'subscribe',
  'resume messages',
  'start messages',
  'message shuru karo',
  'messages shuru karo',
  'message dobara shuru karo',
  'messages dobara shuru karo',
]);

export function normalizeConsentCommand(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const normalized = text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return normalized.length > 0 && normalized.length <= 100 ? normalized : null;
}

export function detectConsentCommand(text: unknown): ConsentAction | null {
  const normalized = normalizeConsentCommand(text);
  if (!normalized) return null;
  const polite = normalized
    .replace(/^(please|pls|bhai|bro|ji)\s+/, '')
    .replace(/\s+(please|pls|bhai|bro|ji)$/, '');
  if (OPT_OUT_COMMANDS.has(polite)) return 'opt_out';
  if (OPT_IN_COMMANDS.has(polite)) return 'opt_in';
  return null;
}

function getOrCreateCustomer(phone: string): number {
  const normalized = phone.replace(/\D/g, '');
  if (!normalized) throw new Error('Cannot apply a consent command without a valid customer phone.');
  const existing = db.prepare('select id from customers where phone = ?').get(normalized) as { id: number } | undefined;
  if (existing) return existing.id;
  return db.prepare('insert into customers (phone) values (?)').run(normalized).lastInsertRowid as number;
}

export function isCustomerOptedOut(customerId: number): boolean {
  const row = db.prepare('select automation_opted_out from customers where id = ?').get(customerId) as
    | { automation_opted_out: number }
    | undefined;
  return row?.automation_opted_out === 1;
}

export function isPhoneOptedOut(phone: string): boolean {
  const normalized = phone.replace(/\D/g, '');
  const row = db.prepare('select automation_opted_out from customers where phone = ?').get(normalized) as
    | { automation_opted_out: number }
    | undefined;
  return row?.automation_opted_out === 1;
}

export function recordConsentCommand(input: {
  phone: string;
  eventKey: string;
  text: string;
  action: ConsentAction;
}): ConsentEvent {
  const normalizedCommand = normalizeConsentCommand(input.text);
  if (!normalizedCommand || detectConsentCommand(input.text) !== input.action) {
    throw new Error('Consent command did not pass deterministic validation.');
  }
  if (typeof input.eventKey !== 'string' || input.eventKey.trim() === '') {
    throw new Error('Consent changes require a stable inbound event key.');
  }

  return db.transaction(() => {
    const existing = db.prepare(`
      select e.*, c.phone
      from customer_consent_events e join customers c on c.id = e.customer_id
      where e.event_key = ?
    `).get(input.eventKey) as ConsentEvent | undefined;
    if (existing) return existing;

    const customerId = getOrCreateCustomer(input.phone);
    const currentlyOptedOut = isCustomerOptedOut(customerId);
    const changesState = input.action === 'opt_out' ? !currentlyOptedOut : currentlyOptedOut;
    if (changesState) {
      // A newer consent decision supersedes any undelivered acknowledgement
      // for the prior state. Never tell a customer messaging is active after
      // a later STOP (or stopped after a later START).
      db.prepare(`
        update customer_consent_events
        set confirmation_status = 'not_required'
        where customer_id = ? and confirmation_status = 'pending'
      `).run(customerId);
      if (input.action === 'opt_out') {
        db.prepare(`
          update customers
          set automation_opted_out = 1, opted_out_at = datetime('now')
          where id = ?
        `).run(customerId);
      } else {
        db.prepare(`
          update customers
          set automation_opted_out = 0, opted_in_at = datetime('now')
          where id = ?
        `).run(customerId);
      }
    }
    const inserted = db.prepare(`
      insert into customer_consent_events
        (customer_id, event_key, action, normalized_command, confirmation_status)
      values (?, ?, ?, ?, ?)
    `).run(
      customerId,
      input.eventKey.trim(),
      input.action,
      normalizedCommand,
      changesState ? 'pending' : 'not_required',
    );
    return db.prepare(`
      select e.*, c.phone
      from customer_consent_events e join customers c on c.id = e.customer_id
      where e.id = ?
    `).get(inserted.lastInsertRowid) as ConsentEvent;
  }).immediate();
}

export function getPendingConsentConfirmations(limit = 20): ConsentEvent[] {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error('Consent confirmation limit must be a whole number from 1 to 100.');
  }
  return db.prepare(`
    select e.*, c.phone
    from customer_consent_events e join customers c on c.id = e.customer_id
    where e.confirmation_status = 'pending'
    order by e.id
    limit ?
  `).all(limit) as ConsentEvent[];
}

export function markConsentConfirmationSent(eventKey: string): boolean {
  return db.prepare(`
    update customer_consent_events
    set confirmation_status = 'sent', confirmation_sent_at = datetime('now')
    where event_key = ? and confirmation_status = 'pending'
  `).run(eventKey).changes === 1;
}

export function consentConfirmationText(action: ConsentAction): string {
  return action === 'opt_out'
    ? 'Automated WhatsApp messages have been stopped. Send START whenever you want to enable them again.'
    : 'Automated WhatsApp messages are active again. You can continue chatting with the assistant.';
}
