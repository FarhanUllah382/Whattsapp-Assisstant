import { randomUUID } from 'node:crypto';
import { db } from './db';
import { getBalanceMinor, recordCreditMinor, recordDebitMinor } from './ledger';
import { minorToRupees } from './money';
import { getOrderPublicReference } from './order-access';
import { maskPhoneForDisplay } from './privacy';

export type PaymentDecision = 'approve' | 'reject' | 'reverse';

interface ClaimRow {
  id: number;
  customer_id: number;
  order_id: number | null;
  amount_minor: number;
  method: string | null;
  reference: string | null;
  status: 'pending' | 'approved' | 'rejected';
  approval_reversed_at: string | null;
  customer_phone: string;
}

interface ActionRow {
  id: string;
  owner_customer_id: number;
  claim_id: number;
  decision: PaymentDecision;
  verified_reference: string | null;
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired';
  source_event_key: string;
  confirm_event_key: string | null;
  expires_at: string;
}

export interface OwnerPaymentCommandResult {
  handled: boolean;
  response?: string;
  mutation?: 'none' | 'approved' | 'rejected' | 'reversed';
}

const APPROVE_PREPARE_COMMAND = /^APPROVE\s+CLAIM\s+#?(\d+)\s+REF(?:ERENCE)?\s+([A-Z0-9][A-Z0-9._\/-]{5,79})$/i;
const APPROVE_CONFIRM_COMMAND = /^CONFIRM\s+APPROVE\s+CLAIM\s+#?(\d+)\s+REF(?:ERENCE)?\s+([A-Z0-9][A-Z0-9._\/-]{5,79})$/i;
const NON_APPROVAL_PREPARE_COMMAND = /^(REJECT|REVERSE)\s+CLAIM\s+#?(\d+)$/i;
const NON_APPROVAL_CONFIRM_COMMAND = /^CONFIRM\s+(REJECT|REVERSE)\s+CLAIM\s+#?(\d+)$/i;
const APPROVE_WITHOUT_REFERENCE_COMMAND = /^(?:CONFIRM\s+)?APPROVE\s+CLAIM\s+#?(\d+)$/i;
const CANCEL_COMMAND = /^CANCEL\s+PAYMENT\s+ACTION$/i;

function normalizeVerifiedReference(value: string): string {
  return value.trim().toUpperCase();
}

function confirmationCommand(action: ActionRow): string {
  const base = `CONFIRM ${action.decision.toUpperCase()} CLAIM ${action.claim_id}`;
  return action.decision === 'approve' ? `${base} REF ${action.verified_reference}` : base;
}

function claimRow(claimId: number): ClaimRow | undefined {
  return db.prepare(`
    select pc.*, c.phone as customer_phone
      from payment_claims pc
      join customers c on c.id = pc.customer_id
     where pc.id = ?
  `).get(claimId) as ClaimRow | undefined;
}

function displayClaim(claim: ClaimRow): string {
  const orderReference = claim.order_id ? getOrderPublicReference(claim.order_id) : null;
  return [
    `CLAIM #${claim.id}`,
    `Rs ${minorToRupees(claim.amount_minor, 'payment action amount').toLocaleString('en-PK')}`,
    claim.method?.trim() || 'method not supplied',
    orderReference || 'not linked to an order',
    `customer ${maskPhoneForDisplay(claim.customer_phone)}`,
  ].join(' · ');
}

function insertEvent(input: {
  claim: ClaimRow;
  ownerCustomerId: number;
  actionId?: string;
  eventType: 'prepared' | 'approved' | 'rejected' | 'reversed' | 'blocked' | 'cancelled' | 'expired';
  sourceEventKey: string;
  detail: string;
}): void {
  db.prepare(`
    insert into payment_claim_events
      (claim_id, owner_customer_id, action_id, event_type, source_event_key, amount_minor, detail)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict(source_event_key, event_type) do nothing
  `).run(
    input.claim.id,
    input.ownerCustomerId,
    input.actionId ?? null,
    input.eventType,
    input.sourceEventKey,
    input.claim.amount_minor,
    input.detail.slice(0, 500),
  );
}

function expireOldAction(ownerCustomerId: number): void {
  const expired = db.prepare(`
    select * from payment_claim_action_intents
     where owner_customer_id = ? and status = 'pending'
       and julianday(expires_at) <= julianday('now')
  `).get(ownerCustomerId) as ActionRow | undefined;
  if (!expired) return;
  db.prepare("update payment_claim_action_intents set status = 'expired' where id = ? and status = 'pending'")
    .run(expired.id);
  const claim = claimRow(expired.claim_id);
  if (claim) {
    insertEvent({
      claim,
      ownerCustomerId,
      actionId: expired.id,
      eventType: 'expired',
      sourceEventKey: `expire:${expired.id}`,
      detail: 'The unconfirmed owner payment action expired without changing financial state.',
    });
  }
}

function activeAction(ownerCustomerId: number): ActionRow | undefined {
  expireOldAction(ownerCustomerId);
  return db.prepare(`
    select * from payment_claim_action_intents
     where owner_customer_id = ? and status = 'pending'
     order by created_at desc limit 1
  `).get(ownerCustomerId) as ActionRow | undefined;
}

function weakPaymentEvidence(reference: string): boolean {
  if (reference.length < 6) return true;
  return /^(?:payment|paid|done|whatsapp payment claim)|payment kar|claimed by customer|without screenshot/i
    .test(reference);
}

function orderOutstandingMinor(claim: ClaimRow): number | null {
  if (!claim.order_id) return null;
  const row = db.prepare(`
    select coalesce(sum(case when kind = 'debit' then amount_minor else -amount_minor end), 0) as balance
      from ledger where customer_id = ? and order_id = ?
  `).get(claim.customer_id, claim.order_id) as { balance: number };
  return row.balance;
}

function approvalBlockReason(claim: ClaimRow, verifiedReference: string | null): string | null {
  if (!verifiedReference || weakPaymentEvidence(verifiedReference)) {
    return 'A valid transaction reference independently verified in the business payment account is required.';
  }
  const accountOutstanding = getBalanceMinor(claim.customer_id);
  if (accountOutstanding <= 0) {
    return 'The customer has no outstanding balance. Approval would create an unverified store credit.';
  }
  if (claim.amount_minor > accountOutstanding) {
    return `The claimed amount exceeds the customer’s outstanding balance of Rs ${minorToRupees(accountOutstanding, 'outstanding balance').toLocaleString('en-PK')}.`;
  }
  const orderOutstanding = orderOutstandingMinor(claim);
  if (orderOutstanding !== null && claim.amount_minor > orderOutstanding) {
    return `The claim exceeds the linked order’s outstanding balance of Rs ${minorToRupees(orderOutstanding, 'order outstanding balance').toLocaleString('en-PK')}.`;
  }
  const duplicateReference = db.prepare(`
    select claim_id as id from payment_claim_verifications
     where verified_reference = ? collate nocase and claim_id <> ?
    union all
    select id from payment_claims
     where id <> ? and status = 'approved' and approval_reversed_at is null
       and reference is not null and lower(trim(reference)) = lower(trim(?))
    limit 1
  `).get(verifiedReference, claim.id, claim.id, verifiedReference) as { id: number } | undefined;
  if (duplicateReference) {
    return `The same transaction reference is already attached to approved CLAIM #${duplicateReference.id}.`;
  }
  return null;
}

function applyConfirmedAction(action: ActionRow, confirmEventKey: string): OwnerPaymentCommandResult {
  return db.transaction((): OwnerPaymentCommandResult => {
    const freshAction = db.prepare('select * from payment_claim_action_intents where id = ?').get(action.id) as ActionRow;
    if (freshAction.status === 'confirmed') {
      return { handled: true, mutation: 'none', response: 'This exact payment action was already confirmed; no duplicate change was made.' };
    }
    if (freshAction.status !== 'pending' || freshAction.owner_customer_id !== action.owner_customer_id) {
      return { handled: true, mutation: 'none', response: 'That payment action is no longer pending. Nothing was changed.' };
    }
    if ((db.prepare("select julianday(expires_at) <= julianday('now') as expired from payment_claim_action_intents where id = ?")
      .get(action.id) as { expired: number }).expired === 1) {
      db.prepare("update payment_claim_action_intents set status = 'expired' where id = ?").run(action.id);
      const expiredClaim = claimRow(action.claim_id)!;
      insertEvent({
        claim: expiredClaim,
        ownerCustomerId: action.owner_customer_id,
        actionId: action.id,
        eventType: 'expired',
        sourceEventKey: confirmEventKey,
        detail: 'Confirmation arrived after expiry; no financial state changed.',
      });
      return { handled: true, mutation: 'none', response: 'That confirmation expired. Nothing was changed; prepare the action again.' };
    }

    const claim = claimRow(action.claim_id);
    if (!claim) return { handled: true, mutation: 'none', response: 'The payment claim no longer exists. Nothing was changed.' };

    let result: OwnerPaymentCommandResult;
    if (action.decision === 'approve') {
      if (claim.status !== 'pending') {
        result = { handled: true, mutation: 'none', response: `CLAIM #${claim.id} is already ${claim.status}. Nothing was changed.` };
      } else {
        const verifiedReference = freshAction.verified_reference;
        const blocked = approvalBlockReason(claim, verifiedReference);
        if (blocked) {
          result = { handled: true, mutation: 'none', response: `APPROVAL BLOCKED — ${blocked} Nothing was changed.` };
        } else {
          db.prepare(`
            insert into payment_claim_verifications
              (claim_id, action_id, owner_customer_id, verified_reference, method_snapshot, confirmed_event_key)
            values (?, ?, ?, ?, ?, ?)
          `).run(
            claim.id,
            action.id,
            action.owner_customer_id,
            verifiedReference,
            claim.method,
            confirmEventKey,
          );
          const ledgerId = recordCreditMinor(claim.customer_id, claim.amount_minor, claim.order_id);
          db.prepare("insert into payment_claim_ledger_links (claim_id, ledger_id, role) values (?, ?, 'credit')")
            .run(claim.id, ledgerId);
          db.prepare(`
            update payment_claims
               set status = 'approved', resolved_by_customer_id = ?, resolved_at = datetime('now')
             where id = ? and status = 'pending'
          `).run(action.owner_customer_id, claim.id);
          insertEvent({
            claim,
            ownerCustomerId: action.owner_customer_id,
            actionId: action.id,
            eventType: 'approved',
            sourceEventKey: confirmEventKey,
            detail: `Approved after exact two-step owner verification; verification recorded and ledger credit ${ledgerId} created.`,
          });
          result = {
            handled: true,
            mutation: 'approved',
            response: `APPROVED: ${displayClaim(claim)} · verified reference ${verifiedReference}. One ledger credit was created; order status was not changed.`,
          };
        }
      }
    } else if (action.decision === 'reject') {
      if (claim.status !== 'pending') {
        result = { handled: true, mutation: 'none', response: `CLAIM #${claim.id} is already ${claim.status}. Nothing was changed.` };
      } else {
        db.prepare(`
          update payment_claims
             set status = 'rejected', resolved_by_customer_id = ?, resolved_at = datetime('now')
           where id = ? and status = 'pending'
        `).run(action.owner_customer_id, claim.id);
        insertEvent({
          claim,
          ownerCustomerId: action.owner_customer_id,
          actionId: action.id,
          eventType: 'rejected',
          sourceEventKey: confirmEventKey,
          detail: 'Rejected after exact two-step confirmation; no ledger entry created.',
        });
        result = {
          handled: true,
          mutation: 'rejected',
          response: `REJECTED: ${displayClaim(claim)}. No ledger credit was created.`,
        };
      }
    } else {
      result = reverseApprovedClaim(claim, action.owner_customer_id, confirmEventKey, action.id);
    }

    if (result.mutation === 'none') {
      insertEvent({
        claim,
        ownerCustomerId: action.owner_customer_id,
        actionId: action.id,
        eventType: 'blocked',
        sourceEventKey: confirmEventKey,
        detail: result.response ?? 'The confirmed action was blocked without a financial change.',
      });
      db.prepare("update payment_claim_action_intents set status = 'cancelled', confirm_event_key = ? where id = ?")
        .run(confirmEventKey, action.id);
    } else {
      db.prepare(`
        update payment_claim_action_intents
           set status = 'confirmed', confirm_event_key = ?, confirmed_at = datetime('now')
         where id = ?
      `).run(confirmEventKey, action.id);
    }
    return result;
  }).immediate();
}

function reverseApprovedClaim(
  claim: ClaimRow,
  ownerCustomerId: number,
  sourceEventKey: string,
  actionId?: string,
): OwnerPaymentCommandResult {
  if (claim.status !== 'approved') {
    return { handled: true, mutation: 'none', response: `CLAIM #${claim.id} is not approved, so there is no approval to reverse.` };
  }
  if (claim.approval_reversed_at) {
    return { handled: true, mutation: 'none', response: `CLAIM #${claim.id} was already reversed; no duplicate debit was created.` };
  }
  const creditLink = db.prepare(`
    select l.id, l.customer_id, l.order_id, l.amount_minor
      from payment_claim_ledger_links pcl
      join ledger l on l.id = pcl.ledger_id
     where pcl.claim_id = ? and pcl.role = 'credit' and l.kind = 'credit'
  `).get(claim.id) as { id: number; customer_id: number; order_id: number | null; amount_minor: number } | undefined;
  if (!creditLink || creditLink.customer_id !== claim.customer_id || creditLink.amount_minor !== claim.amount_minor) {
    return {
      handled: true,
      mutation: 'none',
      response: 'REVERSAL BLOCKED — the original credit is not uniquely linked to this claim. Nothing was changed.',
    };
  }
  const reversalLedgerId = recordDebitMinor(claim.customer_id, claim.order_id, claim.amount_minor);
  db.prepare("insert into payment_claim_ledger_links (claim_id, ledger_id, role) values (?, ?, 'reversal')")
    .run(claim.id, reversalLedgerId);
  db.prepare(`
    update payment_claims
       set approval_reversed_at = datetime('now'), approval_reversed_by_customer_id = ?
     where id = ? and approval_reversed_at is null
  `).run(ownerCustomerId, claim.id);
  insertEvent({
    claim,
    ownerCustomerId,
    actionId,
    eventType: 'reversed',
    sourceEventKey,
    detail: `Approval reversed with compensating ledger debit ${reversalLedgerId}; original history preserved.`,
  });
  return {
    handled: true,
    mutation: 'reversed',
    response: `REVERSED: ${displayClaim(claim)}. A matching compensating debit was recorded; the original audit history remains intact.`,
  };
}

export function handleOwnerPaymentCommand(input: {
  ownerCustomerId: number;
  text: string;
  eventKey: string;
}): OwnerPaymentCommandResult {
  const text = input.text.trim().replace(/\s+/g, ' ');
  const approveConfirm = APPROVE_CONFIRM_COMMAND.exec(text);
  const nonApprovalConfirm = NON_APPROVAL_CONFIRM_COMMAND.exec(text);
  if (approveConfirm || nonApprovalConfirm) {
    const decision: PaymentDecision = approveConfirm
      ? 'approve'
      : nonApprovalConfirm![1].toLowerCase() as PaymentDecision;
    const claimId = Number(approveConfirm?.[1] ?? nonApprovalConfirm![2]);
    const verifiedReference = approveConfirm ? normalizeVerifiedReference(approveConfirm[2]) : null;
    const action = activeAction(input.ownerCustomerId);
    if (
      !action || action.claim_id !== claimId || action.decision !== decision ||
      action.verified_reference !== verifiedReference
    ) {
      const startCommand = decision === 'approve'
        ? `APPROVE CLAIM ${claimId} REF ${verifiedReference ?? '<VERIFIED_TRANSACTION_REFERENCE>'}`
        : `${decision.toUpperCase()} CLAIM ${claimId}`;
      return {
        handled: true,
        mutation: 'none',
        response: `No matching prepared action exists for ${decision.toUpperCase()} CLAIM #${claimId}. Nothing was changed. Start with “${startCommand}”.`,
      };
    }
    return applyConfirmedAction(action, input.eventKey);
  }

  if (CANCEL_COMMAND.test(text)) {
    const action = activeAction(input.ownerCustomerId);
    if (!action) return { handled: true, mutation: 'none', response: 'No payment action is waiting for confirmation.' };
    return db.transaction((): OwnerPaymentCommandResult => {
      db.prepare("update payment_claim_action_intents set status = 'cancelled' where id = ? and status = 'pending'")
        .run(action.id);
      const claim = claimRow(action.claim_id)!;
      insertEvent({
        claim,
        ownerCustomerId: input.ownerCustomerId,
        actionId: action.id,
        eventType: 'cancelled',
        sourceEventKey: input.eventKey,
        detail: 'Owner cancelled the prepared payment action; no financial state changed.',
      });
      return { handled: true, mutation: 'none', response: 'The pending payment action was cancelled. Nothing was changed.' };
    }).immediate();
  }

  const approvalMissingReference = APPROVE_WITHOUT_REFERENCE_COMMAND.exec(text);
  if (approvalMissingReference) {
    const claimId = Number(approvalMissingReference[1]);
    const pending = activeAction(input.ownerCustomerId);
    const exact = pending?.decision === 'approve' && pending.claim_id === claimId
      ? confirmationCommand(pending)
      : `APPROVE CLAIM ${claimId} REF <VERIFIED_TRANSACTION_REFERENCE>`;
    return {
      handled: true,
      mutation: 'none',
      response: `CLAIM #${claimId} was not approved. A transaction reference independently checked in the business payment account is required. Use exactly: ${exact}`,
    };
  }

  const approvePrepare = APPROVE_PREPARE_COMMAND.exec(text);
  const nonApprovalPrepare = NON_APPROVAL_PREPARE_COMMAND.exec(text);
  if (approvePrepare || nonApprovalPrepare) {
    const decision: PaymentDecision = approvePrepare
      ? 'approve'
      : nonApprovalPrepare![1].toLowerCase() as PaymentDecision;
    const claimId = Number(approvePrepare?.[1] ?? nonApprovalPrepare![2]);
    const verifiedReference = approvePrepare ? normalizeVerifiedReference(approvePrepare[2]) : null;
    return db.transaction((): OwnerPaymentCommandResult => {
      const retried = db.prepare('select * from payment_claim_action_intents where source_event_key = ?')
        .get(input.eventKey) as ActionRow | undefined;
      if (retried) {
        const retryClaim = claimRow(retried.claim_id);
        return {
          handled: true,
          mutation: 'none',
          response: retryClaim
            ? `Payment action already prepared — nothing changed. Reply exactly: ${confirmationCommand(retried)}`
            : 'The previously prepared claim no longer exists. Nothing was changed.',
        };
      }
      expireOldAction(input.ownerCustomerId);
      const claim = claimRow(claimId);
      if (!claim) return { handled: true, mutation: 'none', response: `CLAIM #${claimId} does not exist. Nothing was changed.` };
      if ((decision === 'approve' || decision === 'reject') && claim.status !== 'pending') {
        const effective = claim.approval_reversed_at ? 'approval reversed' : claim.status;
        return { handled: true, mutation: 'none', response: `CLAIM #${claim.id} is already ${effective}. Nothing was changed.` };
      }
      if (decision === 'reverse' && (claim.status !== 'approved' || claim.approval_reversed_at)) {
        return { handled: true, mutation: 'none', response: `CLAIM #${claim.id} has no active approval to reverse. Nothing was changed.` };
      }
      if (decision === 'approve') {
        const blocked = approvalBlockReason(claim, verifiedReference);
        if (blocked) {
          return {
            handled: true,
            mutation: 'none',
            response: `APPROVAL CANNOT BE PREPARED — ${blocked} Nothing was changed.`,
          };
        }
      }
      const oldAction = activeAction(input.ownerCustomerId);
      if (oldAction) {
        db.prepare("update payment_claim_action_intents set status = 'cancelled' where id = ?").run(oldAction.id);
        const oldClaim = claimRow(oldAction.claim_id);
        if (oldClaim) insertEvent({
          claim: oldClaim,
          ownerCustomerId: input.ownerCustomerId,
          actionId: oldAction.id,
          eventType: 'cancelled',
          sourceEventKey: input.eventKey,
          detail: 'A new exact payment action replaced the older unconfirmed action.',
        });
      }
      const actionId = randomUUID();
      db.prepare(`
        insert into payment_claim_action_intents
          (id, owner_customer_id, claim_id, decision, verified_reference, source_event_key, expires_at)
        values (?, ?, ?, ?, ?, ?, datetime('now', '+10 minutes'))
      `).run(actionId, input.ownerCustomerId, claim.id, decision, verifiedReference, input.eventKey);
      insertEvent({
        claim,
        ownerCustomerId: input.ownerCustomerId,
        actionId,
        eventType: 'prepared',
        sourceEventKey: input.eventKey,
        detail: `${decision} prepared; financial state unchanged pending exact confirmation.`,
      });
      const effect = decision === 'approve'
        ? `Verified reference: ${verifiedReference}. This will create one Rs ${minorToRupees(claim.amount_minor, 'prepared approval amount').toLocaleString('en-PK')} ledger credit.`
        : decision === 'reverse'
          ? `This will create one matching Rs ${minorToRupees(claim.amount_minor, 'prepared reversal amount').toLocaleString('en-PK')} compensating debit.`
          : 'This will reject the claim without creating a ledger entry.';
      return {
        handled: true,
        mutation: 'none',
        response: [
          'PAYMENT ACTION PREPARED — nothing has changed yet.',
          `${decision.toUpperCase()}: ${displayClaim(claim)}.`,
          effect,
          `Reply exactly within 10 minutes: ${confirmationCommand({
            id: actionId,
            owner_customer_id: input.ownerCustomerId,
            claim_id: claim.id,
            decision,
            verified_reference: verifiedReference,
            status: 'pending',
            source_event_key: input.eventKey,
            confirm_event_key: null,
            expires_at: '',
          })}`,
          'Or reply exactly: CANCEL PAYMENT ACTION',
        ].join('\n'),
      };
    }).immediate();
  }

  const pending = activeAction(input.ownerCustomerId);
  if (pending) {
    return {
      handled: true,
      mutation: 'none',
      response: `A payment action is waiting, but your reply was not an exact confirmation. Nothing was changed. Reply exactly: ${confirmationCommand(pending)} — or CANCEL PAYMENT ACTION.`,
    };
  }

  const financialMutationLanguage = /\b(?:approve|approved|reject|rejected|reverse|reversed|not approved|no|cancel|manzoor|rad)\b/i.test(text) &&
    /\b(?:claim|payment|request|bank transfer|easypaisa|jazzcash)\b/i.test(text);
  if (financialMutationLanguage) {
    const mentionedClaim = /\bclaim\s+#?(\d+)\b/i.exec(text)?.[1];
    const claimLabel = mentionedClaim ?? '<ID>';
    return {
      handled: true,
      mutation: 'none',
      response: `For financial safety, natural-language approval or rejection never changes money. Nothing was changed. To approve after checking the business payment account, use APPROVE CLAIM ${claimLabel} REF <VERIFIED_TRANSACTION_REFERENCE>. To reject, use REJECT CLAIM ${claimLabel}.`,
    };
  }
  return { handled: false };
}

export function linkLegacyApprovedClaimCredit(claimId: number, ledgerId: number): void {
  db.transaction(() => {
    const claim = claimRow(claimId);
    if (!claim || claim.status !== 'approved' || claim.approval_reversed_at) {
      throw new Error('The claim is not an active approved legacy claim.');
    }
    const ledger = db.prepare('select * from ledger where id = ?').get(ledgerId) as {
      id: number; customer_id: number; order_id: number | null; kind: string; amount_minor: number;
    } | undefined;
    if (!ledger || ledger.kind !== 'credit' || ledger.customer_id !== claim.customer_id ||
        ledger.order_id !== claim.order_id || ledger.amount_minor !== claim.amount_minor) {
      throw new Error('The ledger row does not exactly match the approved claim.');
    }
    db.prepare("insert into payment_claim_ledger_links (claim_id, ledger_id, role) values (?, ?, 'credit')")
      .run(claimId, ledgerId);
  }).immediate();
}

export function reverseLegacyApprovedClaim(input: {
  claimId: number;
  ownerCustomerId: number;
  sourceEventKey: string;
}): OwnerPaymentCommandResult {
  return db.transaction((): OwnerPaymentCommandResult => {
    const claim = claimRow(input.claimId);
    if (!claim) throw new Error('Payment claim does not exist.');
    return reverseApprovedClaim(claim, input.ownerCustomerId, input.sourceEventKey);
  }).immediate();
}

export function repairLegacyApprovedClaim(input: {
  claimId: number;
  ledgerId: number;
  ownerCustomerId: number;
  sourceEventKey: string;
}): OwnerPaymentCommandResult {
  return db.transaction((): OwnerPaymentCommandResult => {
    const existingLink = db.prepare(`
      select ledger_id from payment_claim_ledger_links
       where claim_id = ? and role = 'credit'
    `).get(input.claimId) as { ledger_id: number } | undefined;
    if (existingLink && existingLink.ledger_id !== input.ledgerId) {
      throw new Error('The claim is already linked to a different credit; repair stopped.');
    }
    if (!existingLink) linkLegacyApprovedClaimCredit(input.claimId, input.ledgerId);
    const claim = claimRow(input.claimId);
    if (!claim) throw new Error('Payment claim does not exist.');
    return reverseApprovedClaim(claim, input.ownerCustomerId, input.sourceEventKey);
  }).immediate();
}
