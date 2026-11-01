const INTERNAL_PRODUCT_MARKER =
  /\b(?:temporary|delete\s+after|placeholder|dummy|sample\s+only|do\s+not\s+(?:sell|show|use)|internal\s+only)\b/i;

const SUPPORT_INTENT =
  /\b(?:refund|return|exchange|payment|paid|receipt|screenshot|complaint|damaged|wrong\s+item|cancel|cancellation|tracking|track\s+(?:my|the)|order\s+status|late\s+delivery|missing\s+order)\b/i;

const UNSOLICITED_SALES_PUSH =
  /\b(?:would\s+you\s+like\s+to\s+(?:buy|order|add)|do\s+you\s+want\s+to\s+(?:buy|order|add)|also\s+(?:buy|order|try|check\s+out)|interested\s+in\s+(?:buying|ordering)|(?:buy|order)\s+(?:our|a|another)\s+\w+)\b/i;

export function customerSafeProductRecord(input: {
  name: unknown;
  sku?: unknown;
  category?: unknown;
}): { ok: true } | { ok: false; error: string } {
  const values = [input.name, input.sku, input.category]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return { ok: false, error: 'Product name is missing.' };
  }
  if (values.some((value) => INTERNAL_PRODUCT_MARKER.test(value))) {
    return { ok: false, error: 'Product record contains an internal or placeholder label.' };
  }
  return { ok: true };
}

export function normalizeRequiredFeatures(value: unknown): string[] | { error: string } {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    return { error: 'required_features must be a list of at most 8 short feature names.' };
  }
  const normalized: string[] = [];
  for (const feature of value) {
    if (typeof feature !== 'string') {
      return { error: 'Every required feature must be plain text.' };
    }
    const clean = feature.trim().replace(/\s+/g, ' ');
    if (clean.length < 2 || clean.length > 60) {
      return { error: 'Every required feature must contain 2-60 characters.' };
    }
    if (!normalized.some((existing) => existing.toLowerCase() === clean.toLowerCase())) {
      normalized.push(clean);
    }
  }
  return normalized;
}

export function checkSupportUpsellReply(
  inboundText: string | undefined,
  outboundBody: string,
): { ok: true } | { ok: false; error: string } {
  if (!inboundText || !SUPPORT_INTENT.test(inboundText) || !UNSOLICITED_SALES_PUSH.test(outboundBody)) {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      'Do not add an unrelated sales pitch during a payment, refund, complaint, cancellation, or tracking workflow. ' +
      'Resolve the customer\'s support request first.',
  };
}
