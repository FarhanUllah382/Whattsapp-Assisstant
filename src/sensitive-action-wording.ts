import { allLocalizedTexts, localizedText, type CustomerLanguage } from './customer-language';

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

// Roman Urdu renderings of the exact status texts above (FIX4, live
// 2026-11-02: Roman Urdu customers received English-only status texts). Each
// keeps the same facts: what is pending, and what was NOT changed. They must
// not contain a human promise or a completion claim; tests run every variant
// through the full send_message guard chain.
export const PAYMENT_CLAIM_PENDING_MESSAGE_ROMAN_URDU =
  'Aapka payment claim record ho gaya hai aur owner ki tasdeeq (verification) ka intezar hai. ' +
  'Payment abhi verify nahi hui, ledger mein koi credit add nahi hua, aur order ko paid mark nahi kiya gaya.';

export const REFUND_REQUEST_PENDING_MESSAGE_ROMAN_URDU =
  'Aapki refund request record ho gayi hai aur owner ke review ka intezar hai. ' +
  'Abhi tak koi refund approve, process ya pay nahi kiya gaya.';

export const REFUND_APPROVED_PENDING_EXECUTION_MESSAGE_ROMAN_URDU =
  'Owner ne aapki refund request approve kar di hai, lekin refund abhi process ya pay nahi kiya gaya. ' +
  'Refund ki external adaigi abhi baqi hai.';

export const REFUND_REJECTED_MESSAGE_ROMAN_URDU =
  'Aapki refund request reject kar di gayi hai. Koi refund process ya pay nahi kiya gaya.';

// Last-resort reply when every send was vetoed (moved here from
// agent/customer-turn.ts so all fixed customer texts live together). No
// promise about a person, no number.
export const GENERIC_FALLBACK_MESSAGE =
  "Sorry, I couldn't answer that properly just now. Please send your question again in a slightly different way.";
export const GENERIC_FALLBACK_MESSAGE_ROMAN_URDU =
  'Maazrat, abhi is ka sahi jawab nahi de saka. Meherbani karke apna sawal thore mukhtalif alfaaz mein dobara bhej dein.';

type LocalizedVariants = { en: string; roman_ur: string };

const PAYMENT_PENDING_VARIANTS: LocalizedVariants = {
  en: PAYMENT_CLAIM_PENDING_MESSAGE,
  roman_ur: PAYMENT_CLAIM_PENDING_MESSAGE_ROMAN_URDU,
};
const REFUND_VARIANTS: Readonly<Record<RefundCustomerStatus, LocalizedVariants>> = {
  requested: { en: REFUND_REQUEST_PENDING_MESSAGE, roman_ur: REFUND_REQUEST_PENDING_MESSAGE_ROMAN_URDU },
  approved_pending_execution: {
    en: REFUND_APPROVED_PENDING_EXECUTION_MESSAGE,
    roman_ur: REFUND_APPROVED_PENDING_EXECUTION_MESSAGE_ROMAN_URDU,
  },
  rejected: { en: REFUND_REJECTED_MESSAGE, roman_ur: REFUND_REJECTED_MESSAGE_ROMAN_URDU },
};
const GENERIC_FALLBACK_VARIANTS: LocalizedVariants = {
  en: GENERIC_FALLBACK_MESSAGE,
  roman_ur: GENERIC_FALLBACK_MESSAGE_ROMAN_URDU,
};

export function paymentClaimPendingMessage(language: CustomerLanguage = 'en'): string {
  return localizedText(PAYMENT_PENDING_VARIANTS, language);
}

export function refundCustomerStatusMessage(
  status: RefundCustomerStatus,
  language: CustomerLanguage = 'en',
): string {
  return localizedText(REFUND_VARIANTS[status], language);
}

/**
 * The fixed last-resort reply, in the customer's language ('mixed' = English
 * then Roman Urdu). After a claim or refund action the wording backstop
 * accepts only the exact server status text, so the fallback is that text
 * (live test 2026-11-01, payment claim #7).
 */
export function fixedFallbackReply(
  facts: Readonly<SensitiveActionFacts>,
  language: CustomerLanguage,
): string {
  if (facts.paymentClaimPending) return paymentClaimPendingMessage(language);
  if (facts.refundStatus) return refundCustomerStatusMessage(facts.refundStatus, language);
  return localizedText(GENERIC_FALLBACK_VARIANTS, language);
}

const PAYMENT_PENDING_TEXTS: ReadonlySet<string> = new Set(allLocalizedTexts(PAYMENT_PENDING_VARIANTS));
const REFUND_TEXTS: Readonly<Record<RefundCustomerStatus, ReadonlySet<string>>> = {
  requested: new Set(allLocalizedTexts(REFUND_VARIANTS.requested)),
  approved_pending_execution: new Set(allLocalizedTexts(REFUND_VARIANTS.approved_pending_execution)),
  rejected: new Set(allLocalizedTexts(REFUND_VARIANTS.rejected)),
};
const ALL_SERVER_STATUS_TEXTS: ReadonlySet<string> = new Set([
  ...PAYMENT_PENDING_TEXTS,
  ...REFUND_TEXTS.requested,
  ...REFUND_TEXTS.approved_pending_execution,
  ...REFUND_TEXTS.rejected,
]);

/** True for an exact server-authored payment/refund status text, in any supported language. */
export function isServerStatusMessage(body: string): boolean {
  return ALL_SERVER_STATUS_TEXTS.has(body.trim());
}

function instructionFor(variants: LocalizedVariants): string {
  return (
    `Use this exact customer-facing status wording: "${variants.en}" ` +
    `If the customer writes Roman Urdu, use exactly this instead: "${variants.roman_ur}"`
  );
}

export function paymentClaimInstruction(): string {
  return instructionFor(PAYMENT_PENDING_VARIANTS);
}

export function refundStatusInstruction(status: RefundCustomerStatus): string {
  return instructionFor(REFUND_VARIANTS[status]);
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
    // An exact server status text (any language) is accepted as-is.
    if (!PAYMENT_PENDING_TEXTS.has(body.trim()) && (!PAYMENT_PENDING.test(body) || !PAYMENT_NOT_VERIFIED.test(body))) {
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

  if (facts.refundStatus && !REFUND_TEXTS[facts.refundStatus].has(body.trim())) {
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
