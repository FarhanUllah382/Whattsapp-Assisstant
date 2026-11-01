const PHONE_LIKE = /\+?\d(?:[\s().-]*\d){9,14}/g;
const EMAIL_LIKE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LABELED_PERSONAL_DETAIL = new RegExp(
  String.raw`\b(?:customer(?:'s)?\s+name|recipient(?:\s+name)?|full\s+name|name|contact(?:\s+number)?|` +
    String.raw`phone(?:\s+number)?|mobile(?:\s+number)?|whatsapp(?:\s+number)?|delivery\s+address|address|` +
    String.raw`postal\s+code|landmark|account\s+number|iban|transaction\s+(?:id|reference)|payment\s+reference)` +
    String.raw`\s*(?::|=|-|\bis\b)\s*[^.;\n]+`,
  'gi',
);
const ADDRESS_SENTENCE = /\b(?:house|flat|apartment|street|road|sector|block|phase|village|mohalla|gali)\b/i;
const DIGIT = /\d/;

export function maskPhoneForDisplay(value: unknown): string {
  if (typeof value !== 'string') return '[redacted phone]';
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '[redacted phone]';
  return `${'*'.repeat(Math.min(8, Math.max(4, digits.length - 4)))}${digits.slice(-4)}`;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(EMAIL_LIKE, '[redacted email]')
    .replace(PHONE_LIKE, (candidate) => {
      const digits = candidate.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 15 ? `[phone ending ${digits.slice(-4)}]` : candidate;
    });
}

/**
 * Durable conversational memory should remember business meaning, not a
 * reusable copy of someone's contact, address, or payment identifiers.
 */
export function sanitizeMemoryText(value: string): string {
  const labeled = value.replace(LABELED_PERSONAL_DETAIL, (match) => {
    const label = match.split(/:|=|-|\bis\b/i, 1)[0]?.trim() || 'Personal detail';
    return `${label}: [redacted]`;
  });
  const withoutAddressSentences = labeled
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => (ADDRESS_SENTENCE.test(sentence) && DIGIT.test(sentence) ? '[redacted address].' : sentence))
    .join(' ');
  return redactSensitiveText(withoutAddressSentences).trim();
}

const PRIVATE_FIELD = /(?:^|_)(?:body|text|message|address|recipient|contact|reference|token|secret|password|authorization|api[_-]?key)(?:$|_)/i;
const PHONE_FIELD = /(?:^|_)(?:phone|mobile|whatsapp)(?:$|_)/i;
const NAME_FIELD = /(?:^|_)(?:customer_name|recipient_name)(?:$|_)/i;

function sanitizeLogValue(value: unknown, key = ''): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (PHONE_FIELD.test(key)) return maskPhoneForDisplay(value);
    if (PRIVATE_FIELD.test(key) || NAME_FIELD.test(key)) return '[REDACTED]';
    return sanitizeMemoryText(value);
  }
  if (value instanceof Error) {
    return { name: value.name, message: sanitizeMemoryText(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        sanitizeLogValue(childValue, childKey),
      ]),
    );
  }
  return String(value);
}

export function sanitizeLogFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  return sanitizeLogValue(fields) as Record<string, unknown>;
}
