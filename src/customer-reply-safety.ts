const DEVANAGARI = /[\u0900-\u097f]/u;
const LATIN = /[A-Za-z]/;

const ORDER_INTENT = /\b(?:order|book|buy|purchase|kharid|khareed|mangwa|mangwana)\b/i;
const PAYMENT_METHOD =
  /\b(?:payment|cod|cash\s+on\s+delivery|easy\s*paisa|jazz\s*cash|bank\s+transfer)\b/i;
const CHECKOUT_FIELDS = [
  /\b(?:full|pura|poora)?\s*(?:name|naam)\b/i,
  /\b(?:contact|phone|mobile)\s*(?:number|no\.?|num)?\b/i,
  /\b(?:delivery\s+)?(?:address|pata)\b/i,
  /\b(?:city|shehar)\b/i,
];

/**
 * When the customer asks to book and the reply starts collecting checkout
 * details, payment choice must be collected in that same checklist. The
 * model may not leave it implicit and choose a method later.
 */
export function checkCheckoutCollectionReply(
  inboundText: unknown,
  body: string,
): { ok: true } | { ok: false; error: string } {
  if (typeof inboundText !== 'string' || !ORDER_INTENT.test(inboundText)) return { ok: true };
  const fieldsRequested = CHECKOUT_FIELDS.filter((pattern) => pattern.test(body)).length;
  if (fieldsRequested < 2 || PAYMENT_METHOD.test(body)) return { ok: true };
  return {
    ok: false,
    error:
      'This reply starts collecting order details but omits the payment method. ' +
      'Call get_payment_options, then ask the customer to choose exactly one available payment method in the same checkout checklist.',
  };
}

/**
 * A Roman-Urdu/English customer should not receive accidental Devanagari
 * fragments such as "d\u0947\u0902". Customers who actually write in Devanagari
 * remain supported.
 */
export function checkCustomerReplyScript(
  inboundText: unknown,
  body: string,
): { ok: true } | { ok: false; error: string } {
  const inbound = typeof inboundText === 'string' ? inboundText : '';
  if (!DEVANAGARI.test(body) || DEVANAGARI.test(inbound) || !LATIN.test(inbound)) return { ok: true };
  return {
    ok: false,
    error:
      'The customer wrote in Roman Urdu/English, but this reply contains Devanagari characters. Rewrite using only the customer’s Latin/Roman-Urdu script.',
  };
}
