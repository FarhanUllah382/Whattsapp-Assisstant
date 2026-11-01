import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../src/db';
import { rupeesToMinor } from '../src/money';
import { handleOwnerPaymentCommand, repairLegacyApprovedClaim } from '../src/payment-resolution';
import { createPaymentClaim, pendingPaymentClaims, resolvePaymentClaim } from '../src/payments';
import { inventoryOverviewTool, ownerTools } from '../src/tools';

let sequence = 0;
function setupClaim(options: {
  amount?: number;
  debit?: number;
  reference?: string | null;
  withOrder?: boolean;
} = {}) {
  sequence += 1;
  const amount = options.amount ?? 800;
  const debit = options.debit ?? 800;
  const ownerId = Number(db.prepare('insert into customers (phone) values (?)')
    .run(`9231200${String(sequence).padStart(4, '0')}`).lastInsertRowid);
  const customerId = Number(db.prepare('insert into customers (phone) values (?)')
    .run(`9230500${String(sequence).padStart(4, '0')}`).lastInsertRowid);
  let orderId: number | undefined;
  if (options.withOrder !== false) {
    orderId = Number(db.prepare(`
      insert into orders (customer_id, items_json, total_minor, status)
      values (?, '[]', ?, 'confirmed')
    `).run(customerId, rupeesToMinor(debit)).lastInsertRowid);
  }
  if (debit > 0) {
    db.prepare("insert into ledger (customer_id, order_id, kind, amount_minor) values (?, ?, 'debit', ?)")
      .run(customerId, orderId ?? null, rupeesToMinor(debit));
  }
  const claim = createPaymentClaim({
    customerId,
    orderId,
    amount,
    method: 'easypaisa',
    reference: Object.hasOwn(options, 'reference')
      ? options.reference ?? undefined
      : `EP-VALID-${sequence}-998877`,
    eventKey: `claim-create-${sequence}`,
  });
  return { ownerId, customerId, orderId, claim };
}

function command(ownerCustomerId: number, text: string, suffix: string) {
  return handleOwnerPaymentCommand({
    ownerCustomerId,
    text,
    eventKey: `owner-payment-${sequence}-${suffix}`,
  });
}

test('Gemini has no payment mutation tool and the legacy tool fails closed', () => {
  assert.equal(ownerTools.some((tool) => tool.name === 'resolve_payment_claim'), false);
  assert.deepEqual(resolvePaymentClaim.execute({}, { customerId: 1 }), {
    ok: false,
    error:
      'Direct model-controlled payment resolution is disabled. After independently checking the business payment account, use APPROVE CLAIM <id> REF <verified-reference>, or use REJECT CLAIM <id>, followed by the exact confirmation.',
  });
});

test('natural-language, list-position, and contradictory instructions never mutate money', () => {
  db.exec('begin');
  try {
    const { ownerId, claim, customerId } = setupClaim({ reference: null });
    for (const [index, text] of [
      'Yes claim 1 is approved',
      'Request 4 is not approved, bank transfer wala',
      'No 4, of bank transfer',
      'Approve and reject this payment claim',
    ].entries()) {
      const result = command(ownerId, text, `ambiguous-${index}`);
      assert.equal(result.handled, true);
      assert.equal(result.mutation, 'none');
    }
    assert.equal((db.prepare('select status from payment_claims where id = ?').get(claim.id) as any).status, 'pending');
    assert.equal((db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'credit'")
      .get(customerId) as any).n, 0);
  } finally {
    db.exec('rollback');
  }
});

test('approval requires exact prepare and exact confirmation and is replay-safe', () => {
  db.exec('begin');
  try {
    const { ownerId, claim, customerId } = setupClaim({ reference: null });
    const reference = `EP-OWNER-${sequence}-998877`;
    const missingReference = command(ownerId, `APPROVE CLAIM ${claim.id}`, 'missing-reference');
    assert.equal(missingReference.mutation, 'none');
    assert.match(missingReference.response ?? '', /independently checked/i);
    assert.equal((db.prepare("select count(*) n from payment_claim_action_intents where claim_id = ?").get(claim.id) as any).n, 0);

    const prepared = command(ownerId, `APPROVE CLAIM ${claim.id} REF ${reference}`, 'prepare-approve');
    assert.equal(prepared.mutation, 'none');
    assert.match(prepared.response ?? '', new RegExp(`CONFIRM APPROVE CLAIM ${claim.id} REF ${reference}`));
    assert.equal((db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'credit'")
      .get(customerId) as any).n, 0);

    const vague = command(ownerId, 'yes approve it', 'vague-confirm');
    assert.equal(vague.mutation, 'none');
    assert.equal((db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'credit'")
      .get(customerId) as any).n, 0);

    const changedReference = command(ownerId, `CONFIRM APPROVE CLAIM ${claim.id} REF EP-ALTERED-998877`, 'changed-reference');
    assert.equal(changedReference.mutation, 'none');
    assert.equal((db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'credit'")
      .get(customerId) as any).n, 0);

    const confirmed = command(ownerId, `CONFIRM APPROVE CLAIM ${claim.id} REF ${reference}`, 'confirm-approve');
    assert.equal(confirmed.mutation, 'approved');
    assert.equal((db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'credit'")
      .get(customerId) as any).n, 1);
    assert.equal((db.prepare("select count(*) n from payment_claim_ledger_links where claim_id = ? and role = 'credit'")
      .get(claim.id) as any).n, 1);
    const verification = db.prepare(`
      select verified_reference from payment_claim_verifications where claim_id = ?
    `).get(claim.id) as { verified_reference: string };
    assert.equal(verification.verified_reference, reference);
    assert.throws(
      () => db.prepare('update payment_claim_verifications set verified_reference = ? where claim_id = ?')
        .run('EP-TAMPER-998877', claim.id),
      /append-only/,
    );

    const replay = command(ownerId, `CONFIRM APPROVE CLAIM ${claim.id} REF ${reference}`, 'confirm-replay');
    assert.equal(replay.mutation, 'none');
    assert.equal((db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'credit'")
      .get(customerId) as any).n, 1);
  } finally {
    db.exec('rollback');
  }
});

test('rejection is two-step and creates no ledger entry', () => {
  db.exec('begin');
  try {
    const { ownerId, claim, customerId } = setupClaim();
    command(ownerId, `REJECT CLAIM ${claim.id}`, 'prepare-reject');
    const confirmed = command(ownerId, `CONFIRM REJECT CLAIM ${claim.id}`, 'confirm-reject');
    assert.equal(confirmed.mutation, 'rejected');
    assert.equal((db.prepare('select status from payment_claims where id = ?').get(claim.id) as any).status, 'rejected');
    assert.equal((db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'credit'")
      .get(customerId) as any).n, 0);
  } finally {
    db.exec('rollback');
  }
});

test('weak owner reference, duplicate reference, zero balance, and expired confirmations fail closed', () => {
  db.exec('begin');
  try {
    const weak = setupClaim({ reference: undefined });
    const weakPrepare = command(weak.ownerId, `APPROVE CLAIM ${weak.claim.id} REF PAYMENT`, 'prepare-weak');
    assert.equal(weakPrepare.mutation, 'none');
    assert.match(weakPrepare.response ?? '', /CANNOT BE PREPARED/);

    const zero = setupClaim({ debit: 0, withOrder: false, reference: 'EP-ZERO-998877' });
    const zeroPrepare = command(zero.ownerId, `APPROVE CLAIM ${zero.claim.id} REF EP-ZERO-OWNER-998877`, 'prepare-zero');
    assert.equal(zeroPrepare.mutation, 'none');
    assert.match(zeroPrepare.response ?? '', /no outstanding balance/i);

    const expired = setupClaim();
    const expiredReference = `EP-EXPIRED-${sequence}-998877`;
    command(expired.ownerId, `APPROVE CLAIM ${expired.claim.id} REF ${expiredReference}`, 'prepare-expired');
    db.prepare("update payment_claim_action_intents set expires_at = datetime('now', '-1 minute') where owner_customer_id = ?")
      .run(expired.ownerId);
    const expiredConfirm = command(expired.ownerId, `CONFIRM APPROVE CLAIM ${expired.claim.id} REF ${expiredReference}`, 'confirm-expired');
    assert.equal(expiredConfirm.mutation, 'none');
    assert.match(expiredConfirm.response ?? '', /No matching prepared action|expired/);

    const first = setupClaim();
    const reusedReference = `EP-REUSED-${sequence}-998877`;
    command(first.ownerId, `APPROVE CLAIM ${first.claim.id} REF ${reusedReference}`, 'prepare-reused-first');
    command(first.ownerId, `CONFIRM APPROVE CLAIM ${first.claim.id} REF ${reusedReference}`, 'confirm-reused-first');
    const second = setupClaim();
    const duplicate = command(second.ownerId, `APPROVE CLAIM ${second.claim.id} REF ${reusedReference}`, 'prepare-reused-second');
    assert.equal(duplicate.mutation, 'none');
    assert.match(duplicate.response ?? '', /already attached/i);
  } finally {
    db.exec('rollback');
  }
});

test('approved claim reversal adds exactly one compensating debit and preserves history', () => {
  db.exec('begin');
  try {
    const { ownerId, claim, customerId } = setupClaim();
    const reference = `EP-REVERSE-${sequence}-998877`;
    command(ownerId, `APPROVE CLAIM ${claim.id} REF ${reference}`, 'prepare-for-reversal');
    command(ownerId, `CONFIRM APPROVE CLAIM ${claim.id} REF ${reference}`, 'confirm-for-reversal');
    command(ownerId, `REVERSE CLAIM ${claim.id}`, 'prepare-reversal');
    const reversed = command(ownerId, `CONFIRM REVERSE CLAIM ${claim.id}`, 'confirm-reversal');
    assert.equal(reversed.mutation, 'reversed');
    const counts = db.prepare(`
      select sum(case when kind = 'credit' then 1 else 0 end) credits,
             sum(case when kind = 'debit' then 1 else 0 end) debits
        from ledger where customer_id = ?
    `).get(customerId) as { credits: number; debits: number };
    assert.deepEqual(counts, { credits: 1, debits: 2 });
    assert.equal((db.prepare('select approval_reversed_at is not null reversed from payment_claims where id = ?')
      .get(claim.id) as any).reversed, 1);
    const replay = command(ownerId, `CONFIRM REVERSE CLAIM ${claim.id}`, 'confirm-reversal-replay');
    assert.equal(replay.mutation, 'none');
    assert.equal((db.prepare("select count(*) n from payment_claim_ledger_links where claim_id = ? and role = 'reversal'")
      .get(claim.id) as any).n, 1);
    const eventId = (db.prepare("select id from payment_claim_events where claim_id = ? and event_type = 'reversed'")
      .get(claim.id) as { id: number }).id;
    assert.throws(
      () => db.prepare('update payment_claim_events set detail = ? where id = ?').run('tampered', eventId),
      /append-only/,
    );
    assert.throws(
      () => db.prepare('delete from payment_claim_events where id = ?').run(eventId),
      /append-only/,
    );
  } finally {
    db.exec('rollback');
  }
});

test('legacy repair requires an exact credit match and reverses atomically', () => {
  db.exec('begin');
  try {
    const { ownerId, claim, customerId, orderId } = setupClaim();
    // Recreate the row in its historical pre-hardening shape. New approvals
    // cannot enter this state directly because the database trigger below now
    // requires an exact linked credit before a pending -> approved transition.
    db.prepare('delete from payment_claims where id = ?').run(claim.id);
    db.prepare(`
      insert into payment_claims
        (id, customer_id, order_id, amount_minor, method, reference, status,
         event_key, resolved_by_customer_id, resolved_at)
      values (?, ?, ?, ?, 'easypaisa', ?, 'approved', ?, ?, datetime('now'))
    `).run(
      claim.id,
      customerId,
      orderId ?? null,
      rupeesToMinor(800),
      `EP-LEGACY-${sequence}-998877`,
      `legacy-claim-${sequence}`,
      ownerId,
    );
    const wrongLedgerId = Number(db.prepare(
      "insert into ledger (customer_id, order_id, kind, amount_minor) values (?, ?, 'credit', ?)",
    ).run(customerId, orderId ?? null, rupeesToMinor(799)).lastInsertRowid);
    assert.throws(
      () => db.prepare("insert into payment_claim_ledger_links (claim_id, ledger_id, role) values (?, ?, 'credit')")
        .run(claim.id, wrongLedgerId),
      /does not exactly match/,
    );
    assert.throws(() => repairLegacyApprovedClaim({
      claimId: claim.id,
      ledgerId: wrongLedgerId,
      ownerCustomerId: ownerId,
      sourceEventKey: `legacy-wrong-${sequence}`,
    }), /does not exactly match/);
    assert.equal((db.prepare('select approval_reversed_at from payment_claims where id = ?').get(claim.id) as any)
      .approval_reversed_at, null);

    const creditLedgerId = Number(db.prepare(
      "insert into ledger (customer_id, order_id, kind, amount_minor) values (?, ?, 'credit', ?)",
    ).run(customerId, orderId ?? null, rupeesToMinor(800)).lastInsertRowid);
    const repaired = repairLegacyApprovedClaim({
      claimId: claim.id,
      ledgerId: creditLedgerId,
      ownerCustomerId: ownerId,
      sourceEventKey: `legacy-repair-${sequence}`,
    });
    assert.equal(repaired.mutation, 'reversed');
    assert.equal((db.prepare("select count(*) n from payment_claim_ledger_links where claim_id = ? and role = 'credit'")
      .get(claim.id) as any).n, 1);
    assert.equal((db.prepare("select count(*) n from payment_claim_ledger_links where claim_id = ? and role = 'reversal'")
      .get(claim.id) as any).n, 1);
    assert.throws(
      () => db.prepare("update payment_claims set status = 'rejected' where id = ?").run(claim.id),
      /status is final/,
    );
    assert.throws(
      () => db.prepare("delete from payment_claim_ledger_links where claim_id = ? and role = 'credit'").run(claim.id),
      /immutable/,
    );
  } finally {
    db.exec('rollback');
  }
});

test('pending-claim report is masked, read-only, unambiguous, and flags duplicates', () => {
  db.exec('begin');
  try {
    const { ownerId, claim } = setupClaim();
    const output = pendingPaymentClaims.execute({}, { customerId: ownerId }) as any;
    const row = output.claims.find((candidate: any) => candidate.claim_id === claim.id);
    assert.ok(row);
    assert.equal(row.verification_status, 'unverified');
    assert.match(row.customer_phone_masked, /^\*+\d{4}$/);
    assert.equal(Object.hasOwn(row, 'customer_phone'), false);
    assert.equal(Object.hasOwn(row, 'order_id'), false);
    assert.match(row.instruction, new RegExp(`APPROVE CLAIM ${claim.id} REF`));
  } finally {
    db.exec('rollback');
  }
});

test('authenticated owner has a read-only complete inventory report', () => {
  db.exec('begin');
  try {
    db.prepare(`
      insert into products (sku, name, category, size, color, price_minor, stock, active)
      values (?, 'Owner Inventory Shirt', 'shirt', 'medium', 'navy', 220000, 7, 1)
    `).run(`OWNER-INV-${Date.now()}`);
    assert.equal(ownerTools.some((tool) => tool.name === 'inventory_overview'), true);
    const output = inventoryOverviewTool.execute({}, { customerId: 1 }) as any;
    assert.equal(output.ok, true);
    assert.equal(output.active_sku_count >= 1, true);
    assert.equal(output.products.every((product: any) => Number.isInteger(product.stock)), true);
  } finally {
    db.exec('rollback');
  }
});
