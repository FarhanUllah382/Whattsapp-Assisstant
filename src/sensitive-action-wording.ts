export type RefundCustomerStatus = 'requested' | 'approved_pending_execution' | 'rejected';
export type RestrictedOrderStatus = 'paid' | 'shipped' | 'delivered';

export interface SensitiveActionFacts {
  paymentClaimPending?: boolean;
  paymentClaimHasOrder?: boolean;
  refundStatus?: RefundCustomerStatus;
  deniedOrderStatus?: RestrictedOrderStatus;
}

export const PAYMENT_CLAIM_PENDING_MESSAGE =
  'Your payment claim has been recorded and is pending owner verification. ' +
  'The payment is not verified yet, no ledger credit was added, and the order was not marked paid.';

export const REFUND_REQUEST_PENDING_MESSAGE =
  'Your refund request has been recorded and is pending owner review. ' +
  'No refund has been approved, processed, or paid.';

export const REFUND_APPROVED_PENDING_EXECUTION_MESSAGE =
  'The owner approved your refund request, but the refund has not been processed or paid yet. ' +
  'External refund execution is still pending.';

export const REFUND_REJECTED_MESSAGE =
  'Your refund request was rejected. No refund was processed or paid.';

export function refundCustomerStatusMessage(status: RefundCustomerStatus): string {
  if (status === 'approved_pending_execution') return REFUND_APPROVED_PENDING_EXECUTION_MESSAGE;
  if (status === 'rejected') return REFUND_REJECTED_MESSAGE;
  return REFUND_REQUEST_PENDING_MESSAGE;
}

function instructionFor(message: string): string {
  return `Use this exact customer-facing status wording: "${message}"`;
}

export function paymentClaimInstruction(): string {
  return instructionFor(PAYMENT_CLAIM_PENDING_MESSAGE);
}

export function refundStatusInstruction(status: RefundCustomerStatus): string {
  return instructionFor(refundCustomerStatusMessage(status));
}

function outputRecord(output: unknown): Record<string, unknown> | null {
  return output && typeof output === 'object' && !Array.isArray(output)
    ? output as Record<string, unknown>
    : null;
}

/**
 * Collect only facts returned by fixed server tools in this turn. Customer
 * text and remembered history can never populate this object.
 */
export function captureSensitiveActionFacts(
  toolName: string,
  input: unknown,
  output: unknown,
  facts: SensitiveActionFacts,
): void {
  const result = outputRecord(output);
  if (!result) return;

  if (toolName === 'claim_payment' && result.ok === true && result.status === 'pending') {
    facts.paymentClaimPending = true;
    facts.paymentClaimHasOrder = typeof result.order_reference === 'string';
    return;
  }

  if (
    (toolName === 'request_refund' || toolName === 'get_my_refund_status') &&
    result.ok === true &&
    (result.status === 'requested' ||
      result.status === 'approved_pending_execution' ||
      result.status === 'rejected')
  ) {
    facts.refundStatus = result.status;
    return;
  }

  if (toolName === 'update_order_status' && result.ok === false) {
    const requested = outputRecord(input)?.status;
    if (requested === 'paid' || requested === 'shipped' || requested === 'delivered') {
      facts.deniedOrderStatus = requested;
    }
  }
}

const PAYMENT_PENDING = /\b(?:pending|awaiting|review|verification|verify|tasdeeq|intezar)\b/i;
const PAYMENT_NOT_VERIFIED =
  /(?:\bnot\s+(?:yet\s+)?(?:verified|confirmed|approved|credited)\b|\bverification\s+(?:is\s+)?(?:pending|required)\b|\buntil\s+(?:the\s+)?owner\s+(?:verifies|confirms)\b)/i;
const PAYMENT_COMPLETION =
  /(?:\bpayment\b[^.!?\n]{0,35}\b(?:verified|confirmed|approved|received|credited|completed|successful)\b|\b(?:received|verified|confirmed|approved|credited)\b[^.!?\n]{0,25}\bpayment\b|\border\b[^.!?\n]{0,25}\bmarked\s+paid\b)/i;

const REFUND_PENDING = /\b(?:pending|review|awaiting|intezar)\b/i;
const REFUND_NOT_EXECUTED =
  /(?:\bno\s+refund\b[^.!?\n]{0,35}\b(?:approved|processed|paid|sent|issued|credited)\b|\brefund\b[^.!?\n]{0,30}\b(?:not|hasn't|has\s+not|isn't|is\s+not)\b[^.!?\n]{0,20}\b(?:processed|paid|sent|issued|credited)\b)/i;

function restrictedStatusNegated(body: string, status: RestrictedOrderStatus): boolean {
  return new RegExp(
    `\\b(?:not|hasn't|has\\s+not|isn't|is\\s+not)\\b[^.!?\\n]{0,25}\\b(?:marked\\s+)?${status}\\b`,
    'i',
  ).test(body);
}

export type SensitiveActionCheck = { ok: true } | { ok: false; error: string };

/**
 * Final outbound backstop for sensitive state. It is deliberately based on
 * current-turn server facts, never on the model's interpretation of chat text.
 */
export function checkSensitiveActionReply(
  body: string,
  facts: Readonly<SensitiveActionFacts> = {},
): SensitiveActionCheck {
  if (facts.paymentClaimPending) {
    if (!PAYMENT_PENDING.test(body) || !PAYMENT_NOT_VERIFIED.test(body)) {
      return {
        ok: false,
        error: paymentClaimInstruction(),
      };
    }
  } else if (PAYMENT_COMPLETION.test(body) && !PAYMENT_NOT_VERIFIED.test(body)) {
    return {
      ok: false,
      error:
        'Do not claim a customer payment is received, verified, confirmed, approved, credited, or complete. ' +
        'A customer statement is only a pending claim until trusted owner verification.',
    };
  }

  if (facts.refundStatus) {
    if (facts.refundStatus === 'requested') {
      if (!REFUND_PENDING.test(body) || !REFUND_NOT_EXECUTED.test(body)) {
        return { ok: false, error: refundStatusInstruction(facts.refundStatus) };
      }
    } else if (facts.refundStatus === 'approved_pending_execution') {
      if (!/\bapproved\b/i.test(body) || !REFUND_NOT_EXECUTED.test(body)) {
        return { ok: false, error: refundStatusInstruction(facts.refundStatus) };
      }
    } else if (!/\brejected\b/i.test(body) || !REFUND_NOT_EXECUTED.test(body)) {
      return { ok: false, error: refundStatusInstruction(facts.refundStatus) };
    }
  }

  if (facts.deniedOrderStatus) {
    const truthfullyNegated = restrictedStatusNegated(body, facts.deniedOrderStatus);
    const explainsVerification = /\btrusted\s+verification\s+(?:is\s+)?required\b/i.test(body);
    if (!truthfullyNegated || !explainsVerification) {
      return {
        ok: false,
        error:
          `Do not say the order is ${facts.deniedOrderStatus}. State that it was not marked ${facts.deniedOrderStatus} ` +
          'because trusted verification is required.',
      };
    }
  }

  return { ok: true };
}
