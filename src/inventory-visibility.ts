export type PublicStockStatus = 'out_of_stock' | 'low_stock' | 'in_stock';

// Customer-facing policy chosen for the real-business hardening pass:
// inventory counts are operational data, while customers need availability
// and whether their requested quantity can be fulfilled. Keep the threshold
// here at the backend boundary rather than relying on model instructions.
export const LOW_STOCK_MAX = 5;

export function publicStockStatus(stock: number): PublicStockStatus {
  if (!Number.isSafeInteger(stock) || stock < 0) {
    throw new Error('Internal stock must be a non-negative whole number.');
  }
  if (stock === 0) return 'out_of_stock';
  if (stock <= LOW_STOCK_MAX) return 'low_stock';
  return 'in_stock';
}

export function publicInventoryFields(stock: number, requestedQty?: number): {
  availability: PublicStockStatus;
  can_fulfill_requested_qty?: boolean;
} {
  const result: {
    availability: PublicStockStatus;
    can_fulfill_requested_qty?: boolean;
  } = { availability: publicStockStatus(stock) };
  if (requestedQty !== undefined) result.can_fulfill_requested_qty = stock >= requestedQty;
  return result;
}

const EXACT_STOCK_PATTERNS = [
  /\b(?:stock|available\s+quantity|quantity\s+available)\s*(?:is|hai|hain|:|=)?\s*\d+\b/i,
  /\b\d+\s*(?:pieces?|pcs?|units?|items?)?\s*(?:are\s+|is\s+)?(?:in\s+stock|available|left|remaining)\b/i,
  /\b\d+\s+(?:[a-z]+\s+){0,5}(?:available|in\s+stock|left|remaining|maujood)\b/i,
  /\bthere\s+(?:are|is)\s+\d+\s+(?:[a-z]+\s+){0,5}(?:hoodies?|shirts?|kurtas?|trousers?|pieces?|units?|items?)\b/i,
  /\b\d+\s+(?:[a-z]+\s+){0,4}(?:hoodies?|shirts?|kurtas?|trousers?)\s+(?:hain?|maujood)\b/i,
  /\b\d+\s*(?:pieces?|pcs?|units?|items?)\s*(?:stock\s+mein|maujood|hain?)\b/i,
];

/**
 * Final outbound backstop. Even if an old transcript or manipulated model
 * mentions a raw count, customer sends may describe only the public status or
 * whether the specifically requested quantity can be fulfilled.
 */
// Numbers that are clearly NOT stock counts. Live test 2026-11-01: replies such
// as "running shoes size 43 mein available hain" and "Rs 4,800, in stock" were
// vetoed as count disclosures, the model could not phrase around it, and the
// customer got no reply. The model never receives exact counts (check_stock
// returns bands only), so this backstop only needs to catch a bare quantity.
const SIZE_NUMBER = /\b(?:sizes?|size\s*(?:no\.?|number)|number|no\.)\s*[:#-]?\s*\d+(?:\s*(?:,|\/|and|or|aur|ya|-|to)\s*\d+)*/gi;
const PRICE_NUMBER = /(?:\b(?:rs|pkr|rupees?)\.?\s*\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:rs|pkr|rupees?|rupay|rupaye)\b)/gi;
const GROUPED_NUMBER = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g;

function numbersIn(text: string): Set<string> {
  return new Set((text.match(/\d+/g) ?? []).map((n) => String(Number(n))));
}

/** Masks sizes, prices and numbers the customer already used, so only a bare quantity remains checkable. */
export function maskNonStockNumbers(body: string, inboundText?: string): string {
  let masked = body
    .replace(SIZE_NUMBER, ' size-value ')
    .replace(PRICE_NUMBER, ' price-value ')
    .replace(GROUPED_NUMBER, ' price-value ');
  const customerNumbers = inboundText ? numbersIn(inboundText) : new Set<string>();
  if (customerNumbers.size > 0) {
    masked = masked.replace(/\b\d+\b/g, (n) => (customerNumbers.has(String(Number(n))) ? ' customer-value ' : n));
  }
  return masked;
}

export function checkInventoryDisclosureReply(
  body: string,
  inboundText?: string,
): { ok: true } | { ok: false; error: string } {
  const checkable = maskNonStockNumbers(body, inboundText);
  if (!EXACT_STOCK_PATTERNS.some((pattern) => pattern.test(checkable))) return { ok: true };
  return {
    ok: false,
    error:
      'Do not disclose an exact inventory count. Say in stock, low stock, or out of stock; ' +
      'for a requested quantity, report only whether that quantity can be fulfilled.',
  };
}
