import { db } from '../src/db';
import { getBalanceMinor } from '../src/ledger';
import { minorToRupees } from '../src/money';
import { repairLegacyApprovedClaim } from '../src/payment-resolution';

function requiredPositiveInteger(flag: string): number {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`Missing or invalid ${flag}.`);
  }
  return Number(value);
}

const claimId = requiredPositiveInteger('--claim');
const ledgerId = requiredPositiveInteger('--ledger');
const ownerCustomerId = requiredPositiveInteger('--owner-customer');
const apply = process.argv.includes('--apply');

const claim = db.prepare(`
  select pc.id, pc.customer_id, pc.order_id, pc.amount_minor, pc.status,
         pc.reference, pc.approval_reversed_at, c.phone
    from payment_claims pc join customers c on c.id = pc.customer_id
   where pc.id = ?
`).get(claimId) as {
  id: number;
  customer_id: number;
  order_id: number | null;
  amount_minor: number;
  status: string;
  reference: string | null;
  approval_reversed_at: string | null;
  phone: string;
} | undefined;
const ledger = db.prepare(`
  select id, customer_id, order_id, kind, amount_minor from ledger where id = ?
`).get(ledgerId) as {
  id: number;
  customer_id: number;
  order_id: number | null;
  kind: string;
  amount_minor: number;
} | undefined;
const owner = db.prepare('select id from customers where id = ?').get(ownerCustomerId) as { id: number } | undefined;

if (!claim) throw new Error(`Claim #${claimId} does not exist.`);
if (!ledger) throw new Error(`Ledger row #${ledgerId} does not exist.`);
if (!owner) throw new Error(`Owner customer #${ownerCustomerId} does not exist.`);

const exactMatch = claim.status === 'approved' && !claim.approval_reversed_at &&
  ledger.kind === 'credit' && ledger.customer_id === claim.customer_id &&
  ledger.order_id === claim.order_id && ledger.amount_minor === claim.amount_minor;
const preview = {
  mode: apply ? 'apply' : 'preview-only',
  claim_id: claim.id,
  claim_status: claim.status,
  customer_phone_last4: claim.phone.slice(-4),
  order_id: claim.order_id,
  amount_rupees: minorToRupees(claim.amount_minor, 'repair amount'),
  reference: claim.reference,
  credit_ledger_id: ledger.id,
  exact_claim_credit_match: exactMatch,
  balance_before_rupees: minorToRupees(getBalanceMinor(claim.customer_id), 'balance before repair'),
};
console.log(JSON.stringify(preview, null, 2));

if (!exactMatch) throw new Error('Repair stopped: claim and ledger credit are not an exact active match.');
if (!apply) {
  console.log('Preview only. Re-run with --apply after a verified database backup.');
} else {
  const result = repairLegacyApprovedClaim({
    claimId,
    ledgerId,
    ownerCustomerId,
    sourceEventKey: `admin-repair:claim-${claimId}:ledger-${ledgerId}`,
  });
  if (result.mutation !== 'reversed') throw new Error(result.response ?? 'Repair did not complete.');
  console.log(JSON.stringify({
    repaired: true,
    claim_id: claimId,
    credit_ledger_id: ledgerId,
    balance_after_rupees: minorToRupees(getBalanceMinor(claim.customer_id), 'balance after repair'),
    result: result.response,
  }, null, 2));
}
