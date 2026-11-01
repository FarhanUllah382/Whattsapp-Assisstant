import type { ToolContext, ToolDef } from './types';

export const PAYMENT_METHODS = ['cod', 'bank_transfer', 'easypaisa', 'jazzcash'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type ExplicitPaymentMethodSelection =
  | { status: 'none'; methods: [] }
  | { status: 'selected'; method: PaymentMethod; methods: [PaymentMethod] }
  | { status: 'ambiguous'; methods: PaymentMethod[] };

type PaymentEnvironment = Record<string, string | undefined>;

export type PaymentInstructionResult =
  | { ok: true; method: PaymentMethod; body: string }
  | { ok: false; method: PaymentMethod; error: string };

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cod: 'Cash on Delivery (COD)',
  bank_transfer: 'bank transfer',
  easypaisa: 'Easypaisa',
  jazzcash: 'JazzCash',
};

const PAYMENT_METHOD_MENTION_PATTERNS: Record<PaymentMethod, RegExp> = {
  cod: /\b(?:cod|cash\s+on\s+delivery)\b/i,
  bank_transfer: /\bbank\s+transfer\b/i,
  easypaisa: /\beasy\s*paisa\b/i,
  jazzcash: /\bjazz\s*cash\b/i,
};

/**
 * Read only an explicit method mention from the customer's own current text.
 * More than one method is deliberately ambiguous: the model must ask the
 * customer to choose instead of selecting one on their behalf.
 */
export function detectExplicitPaymentMethodSelection(text: unknown): ExplicitPaymentMethodSelection {
  if (typeof text !== 'string' || text.trim() === '') return { status: 'none', methods: [] };
  const methods = PAYMENT_METHODS.filter((method) => PAYMENT_METHOD_MENTION_PATTERNS[method].test(text));
  if (methods.length === 0) return { status: 'none', methods: [] };
  if (methods.length === 1) return { status: 'selected', method: methods[0], methods: [methods[0]] };
  return { status: 'ambiguous', methods };
}

export function paymentMethodLabel(method: PaymentMethod): string {
  return METHOD_LABELS[method];
}

function cleanSingleLine(value: string | undefined, min: number, max: number): string | null {
  if (!value) return null;
  const clean = value.trim().replace(/\s+/g, ' ');
  if (clean.length < min || clean.length > max || /[\r\n\u0000-\u001f\u007f]/.test(clean)) return null;
  return clean;
}

function normalizePakistaniWalletNumber(value: string | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (/^03\d{9}$/.test(digits)) return digits;
  if (/^923\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  return null;
}

function normalizePakistanIban(value: string | undefined): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, '').toUpperCase();
  return /^PK\d{2}[A-Z0-9]{20}$/.test(compact) ? compact : null;
}

function spacedIban(iban: string): string {
  return iban.match(/.{1,4}/g)?.join(' ') ?? iban;
}

export function parsePaymentMethod(value: unknown): PaymentMethod | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, PaymentMethod> = {
    cod: 'cod',
    cash: 'cod',
    cash_on_delivery: 'cod',
    bank: 'bank_transfer',
    bank_transfer: 'bank_transfer',
    easypaisa: 'easypaisa',
    easy_paisa: 'easypaisa',
    jazzcash: 'jazzcash',
    jazz_cash: 'jazzcash',
  };
  return aliases[normalized] ?? null;
}

/** Build exact customer-visible instructions from owner-controlled config. */
export function getPaymentInstructions(
  method: PaymentMethod,
  env: PaymentEnvironment = process.env,
): PaymentInstructionResult {
  if (method === 'cod') {
    return {
      ok: true,
      method,
      body:
        'Cash on Delivery (COD) is available. No advance account number is needed; payment is collected on delivery.',
    };
  }

  if (method === 'easypaisa' || method === 'jazzcash') {
    const prefix = method === 'easypaisa' ? 'PAYMENT_EASYPAISA' : 'PAYMENT_JAZZCASH';
    const accountName = cleanSingleLine(env[`${prefix}_ACCOUNT_NAME`], 2, 100);
    const number = normalizePakistaniWalletNumber(env[`${prefix}_NUMBER`]);
    if (!accountName || !number) {
      return {
        ok: false,
        method,
        error:
          `${METHOD_LABELS[method]} is unavailable because its owner-approved account name and Pakistani mobile number are not fully configured. ` +
          'Do not invent or use placeholder payment details; offer another available method or notify the owner.',
      };
    }
    return {
      ok: true,
      method,
      body: [
        `${METHOD_LABELS[method]} payment details`,
        `Account title: ${accountName}`,
        `Mobile number: ${number}`,
        'Use your order number as the payment reference. A payment claim remains pending until the owner verifies it.',
      ].join('\n'),
    };
  }

  const bankName = cleanSingleLine(env.PAYMENT_BANK_NAME, 2, 100);
  const accountTitle = cleanSingleLine(env.PAYMENT_BANK_ACCOUNT_TITLE, 2, 100);
  const iban = normalizePakistanIban(env.PAYMENT_BANK_IBAN);
  if (!bankName || !accountTitle || !iban) {
    return {
      ok: false,
      method,
      error:
        'Bank transfer is unavailable because its owner-approved bank name, account title, and Pakistani IBAN are not fully configured. ' +
        'Do not invent or use placeholder payment details; offer another available method or notify the owner.',
    };
  }
  return {
    ok: true,
    method,
    body: [
      'Bank transfer payment details',
      `Bank: ${bankName}`,
      `Account title: ${accountTitle}`,
      `IBAN: ${spacedIban(iban)}`,
      'Use your order number as the payment reference. A payment claim remains pending until the owner verifies it.',
    ].join('\n'),
  };
}

export function getAvailablePaymentMethods(env: PaymentEnvironment = process.env): PaymentMethod[] {
  return PAYMENT_METHODS.filter((method) => getPaymentInstructions(method, env).ok);
}

const PLACEHOLDER_PAYMENT_TEXT =
  /(?:placeholder|replace\s+(?:this|me)|(?:number|details?)\s+(?:goes?|comes?)\s+here|yahan\s+(?:aayega|ayega|likh)|\[(?:[^\]]{0,100})(?:number|account|iban|details?)(?:[^\]]{0,100})\])/i;
const PAYMENT_METHOD_TEXT = /\b(?:easypaisa|easy\s*paisa|jazzcash|jazz\s*cash|bank\s*transfer)\b/i;
const PAYMENT_DESTINATION_TEXT =
  /(?:account\s*(?:number|no\.?)|mobile\s*(?:number|no\.?)|iban|(?:send|transfer|pay)(?:\s+(?:the|your|this))?(?:\s+payment)?\s+(?:to|on|at)|(?:is|this)\s+(?:number|account)\s+(?:par|pe))/i;
const PAYMENT_IDENTIFIER =
  /(?:\+?92[\s()-]*3(?:[\s()-]*\d){9}|0[\s()-]*3(?:[\s()-]*\d){9}|PK[\s-]*\d{2}(?:[\s-]*[A-Z0-9]){20}|(?:\d[\s-]*){10,16})/i;

/** Normal AI replies may discuss methods, but only the exact server body may carry a destination. */
export function checkPaymentInstructionReply(
  body: string,
  authorizedBody?: string,
): { ok: true } | { ok: false; error: string } {
  if (PLACEHOLDER_PAYMENT_TEXT.test(body)) {
    return {
      ok: false,
      error:
        'Payment placeholders are never allowed in customer messages. Use send_payment_instructions for owner-approved details.',
    };
  }

  const looksLikeDestination =
    PAYMENT_METHOD_TEXT.test(body) && PAYMENT_DESTINATION_TEXT.test(body) && PAYMENT_IDENTIFIER.test(body);
  if (!looksLikeDestination) return { ok: true };
  if (authorizedBody !== undefined && body === authorizedBody) return { ok: true };
  return {
    ok: false,
    error:
      'Payment destinations can only be sent by send_payment_instructions. Do not type, transform, or invent account details in send_message.',
  };
}

type AuthorizedSender = (body: string, ctx: ToolContext) => Promise<unknown> | unknown;

export function createSendPaymentInstructionsTool(
  sendAuthorized: AuthorizedSender,
  env: PaymentEnvironment = process.env,
): ToolDef {
  return {
    name: 'send_payment_instructions',
    description:
      'Send exact owner-approved payment instructions through the protected WhatsApp send path. ' +
      'Use this whenever a customer asks where or how to pay. Never copy account details into send_message.',
    input_schema: {
      type: 'object',
      properties: { method: { type: 'string', enum: PAYMENT_METHODS } },
      required: ['method'],
    },
    execute: async ({ method }, ctx) => {
      const parsed = parsePaymentMethod(method);
      if (!parsed) {
        return { ok: false, error: 'Payment method must be COD, bank transfer, Easypaisa, or JazzCash.' };
      }
      const instructions = getPaymentInstructions(parsed, env);
      if (!instructions.ok) return instructions;
      return sendAuthorized(instructions.body, ctx);
    },
  };
}

export const paymentOptions: ToolDef = {
  name: 'get_payment_options',
  description:
    'List payment methods that are actually configured and available. Use this before presenting payment choices.',
  input_schema: { type: 'object', properties: {} },
  execute: () => ({ available_methods: getAvailablePaymentMethods() }),
};
