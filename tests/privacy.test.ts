import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { db } from '../src/db';
import { claimInboundEvent, failInboundEvent } from '../src/inbound-events';
import { createLogger } from '../src/obs/logger';
import { maskPhoneForDisplay, sanitizeMemoryText } from '../src/privacy';
import { prepareOrder } from '../src/tools';

test('phone masking keeps only the final four digits', () => {
  const masked = maskPhoneForDisplay('+92 300 0002409');
  assert.equal(masked.endsWith('2409'), true);
  assert.equal(masked.includes('923000002409'), false);
  assert.match(masked, /^\*+2409$/);
});

test('durable-memory sanitization removes contact, address, email, and payment identifiers', () => {
  const source =
    'Customer prefers black hoodies. Name: Ayesha Noor. Contact: +92 300 0002409. ' +
    'Address: House 17, Street 4, F-10 Islamabad. Email: ayesha@example.com. ' +
    'IBAN: PK36SCBL0000001123456702. Payment reference: TXN-889912. Owes Rs 800.';
  const safe = sanitizeMemoryText(source);

  assert.match(safe, /prefers black hoodies/i);
  assert.match(safe, /owes Rs 800/i);
  for (const secret of [
    'Ayesha Noor',
    '923000002409',
    'House 17',
    'ayesha@example.com',
    'PK36SCBL0000001123456702',
    'TXN-889912',
  ]) {
    assert.equal(safe.includes(secret), false, `derived memory retained ${secret}`);
  }
});

test('structured logger redacts PII recursively at its final output boundary', () => {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const log = createLogger(stream);
  log.error('Failure for +923000002409', {
    phone: '+923000002409',
    body: 'Deliver to House 17, call +923000002409',
    nested: {
      email: 'ayesha@example.com',
      apiKey: 'do-not-log-this',
      error: 'Failed for Address: House 17, Street 4, Islamabad.',
    },
  });

  assert.equal(output.includes('+923000002409'), false);
  assert.equal(output.includes('House 17'), false);
  assert.equal(output.includes('ayesha@example.com'), false);
  assert.equal(output.includes('do-not-log-this'), false);
  const parsed = JSON.parse(output) as Record<string, any>;
  assert.match(parsed.phone, /^\*+2409$/);
  assert.equal(parsed.body, '[REDACTED]');
  assert.equal(parsed.nested.email, '[redacted email]');
  assert.equal(parsed.nested.apiKey, '[REDACTED]');
  assert.equal(String(parsed.nested.error).includes('House 17'), false);
});

test('historical derived-memory migration is recorded and leaves every row sanitized', () => {
  const migration = db.prepare(`
    select checkpoint_rows_redacted, note_rows_redacted
    from privacy_migrations
    where migration_key = '2026-10-03-derived-memory-pii-minimization-v1'
  `).get() as { checkpoint_rows_redacted: number; note_rows_redacted: number } | undefined;
  assert.ok(migration);
  assert.equal(Number.isInteger(migration.checkpoint_rows_redacted), true);
  assert.equal(Number.isInteger(migration.note_rows_redacted), true);

  const checkpoints = db.prepare('select summary from checkpoints').all() as Array<{ summary: string }>;
  const notes = db.prepare('select headline, body from customer_notes').all() as Array<{
    headline: string;
    body: string;
  }>;
  for (const row of checkpoints) assert.equal(row.summary, sanitizeMemoryText(row.summary));
  for (const row of notes) {
    assert.equal(row.headline, sanitizeMemoryText(row.headline));
    assert.equal(row.body, sanitizeMemoryText(row.body));
  }
});

test('persisted inbound failures do not retain PII from exception text', () => {
  db.exec('begin');
  try {
    const now = new Date();
    const claim = claimInboundEvent({
      channel: 'privacy-test',
      messageId: `privacy-error-${Date.now()}`,
      occurredAt: now,
      acceptAfter: new Date(now.getTime() - 1_000),
      now,
    });
    assert.equal(claim.action, 'process');
    if (claim.action !== 'process') return;
    failInboundEvent(
      claim.eventKey,
      new Error('Address: House 17, Street 4. Call +923000002409 or ayesha@example.com'),
      now,
    );
    const row = db.prepare('select last_error from inbound_events where event_key = ?').get(claim.eventKey) as {
      last_error: string;
    };
    assert.equal(row.last_error.includes('House 17'), false);
    assert.equal(row.last_error.includes('923000002409'), false);
    assert.equal(row.last_error.includes('ayesha@example.com'), false);
  } finally {
    db.exec('rollback');
  }
});

test('order preparation retains authoritative delivery data but exposes only a masked contact to the model', () => {
  db.exec('begin');
  try {
    const customerId = Number(
      db.prepare('insert into customers (phone) values (?)').run(`privacy-test-${Date.now()}`).lastInsertRowid,
    );
    const product = {
      id: Number(db.prepare(
        'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
      ).run(`privacy-product-${Date.now()}`, 'medium', 'black', 180000, 5).lastInsertRowid),
    };

    const result = prepareOrder.execute(
      {
        items: [{ product_id: product.id, qty: 1 }],
        recipient_name: 'Ayesha Noor',
        contact_phone: '+92 300 0002409',
        delivery_address: 'House 17, Street 4, F-10',
        city: 'Islamabad',
        payment_method: 'cod',
      },
      { customerId, idempotencyKey: `privacy-${Date.now()}` },
    ) as Record<string, unknown>;

    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result, 'contact_phone'), false);
    assert.match(String(result.contact_phone_masked), /^\*+2409$/);

    const stored = db.prepare(
      'select contact_phone, delivery_address from order_drafts where customer_id = ?',
    ).get(customerId) as { contact_phone: string; delivery_address: string };
    assert.equal(stored.contact_phone, '+923000002409');
    assert.equal(stored.delivery_address, 'House 17, Street 4, F-10');
  } finally {
    db.exec('rollback');
  }
});
