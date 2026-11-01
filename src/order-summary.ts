import { multiplyMinor } from './money';
import { paymentMethodLabel, type PaymentMethod } from './payment-instructions';

export interface DeterministicOrderSummaryItem {
  name: string;
  size: string | null;
  color: string | null;
  qty: number;
  unitPriceMinor: number;
}

export interface DeterministicOrderSummaryInput {
  items: DeterministicOrderSummaryItem[];
  subtotalMinor: number;
  deliveryMinor: number;
  recipientName: string;
  maskedContactPhone: string;
  deliveryAddress: string;
  city: string;
  postalCode: string | null;
  deliveryInstructions: string | null;
  paymentMethod: PaymentMethod;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function formatPkrMinor(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Order summary money must be a non-negative safe integer number of paisas.');
  }
  const rupees = Math.floor(value / 100).toLocaleString('en-PK');
  const paisas = value % 100;
  return `Rs ${rupees}${paisas === 0 ? '' : `.${String(paisas).padStart(2, '0')}`}`;
}

/** Customer-visible order review text built only from validated server/database fields. */
export function buildDeterministicOrderSummary(input: DeterministicOrderSummaryInput): string {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('An order summary requires at least one server-priced item.');
  }
  const itemLines = input.items.map((item, index) => {
    const variant = [item.color, item.size, item.name]
      .filter((value): value is string => Boolean(value?.trim()))
      .map(singleLine)
      .join(' / ');
    const lineTotal = multiplyMinor(item.unitPriceMinor, item.qty);
    return `${index + 1}. ${variant} — Qty ${item.qty} × ${formatPkrMinor(item.unitPriceMinor)} = ${formatPkrMinor(lineTotal)}`;
  });
  const totalMinor = input.subtotalMinor + input.deliveryMinor;
  if (!Number.isSafeInteger(totalMinor)) throw new Error('Order summary total exceeds the safe integer range.');

  const lines = [
    'ORDER SUMMARY — NOT BOOKED YET',
    '',
    ...itemLines,
    '',
    `Subtotal: ${formatPkrMinor(input.subtotalMinor)}`,
    `Delivery: ${input.deliveryMinor === 0 ? 'Free' : formatPkrMinor(input.deliveryMinor)}`,
    `Total: ${formatPkrMinor(totalMinor)}`,
    '',
    `Recipient: ${singleLine(input.recipientName)}`,
    `Contact: ${singleLine(input.maskedContactPhone)}`,
    `Address: ${singleLine(input.deliveryAddress)}`,
    `City: ${singleLine(input.city)}`,
    input.postalCode ? `Postal code: ${singleLine(input.postalCode)}` : null,
    input.deliveryInstructions
      ? `Delivery instructions: ${singleLine(input.deliveryInstructions)}`
      : null,
    `Payment method: ${paymentMethodLabel(input.paymentMethod)}`,
    '',
    'Please check every detail. To book this exact order, reply: confirm order',
    'A simple yes/okay will not confirm it.',
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

function looksLikeOrderSummary(body: string): boolean {
  const normalized = body.toLowerCase();
  const hasAmount = /\b(?:rs\.?|pkr|rupees?)\s*\d/i.test(body);
  const markers = [
    /\bsubtotal\b/,
    /\btotal\b/,
    /\bpayment\s+method\b/,
    /\brecipient\b/,
    /\baddress\b/,
    /\bdelivery\b/,
    /\bqty\b|\bquantity\b/,
  ].filter((pattern) => pattern.test(normalized)).length;
  return /\border\s+summary\b/.test(normalized) || (hasAmount && (/\border\b/.test(normalized) || markers >= 3));
}

/** Reject AI-written/reworded summaries while a server draft is awaiting confirmation. */
export function checkDeterministicOrderSummaryReply(
  body: string,
  hasPendingDraft: boolean,
  authorizedServerBody?: string,
): { ok: true } | { ok: false; error: string } {
  if (!hasPendingDraft || !looksLikeOrderSummary(body)) return { ok: true };
  if (authorizedServerBody !== undefined && body === authorizedServerBody) return { ok: true };
  return {
    ok: false,
    error:
      'A pending order summary may only be sent from the server-generated draft. ' +
      'Do not write, calculate, shorten, translate, or reformat the summary in send_message.',
  };
}
