import { createHmac, timingSafeEqual } from 'node:crypto';

const WAHA_HMAC_ALGORITHM = 'sha512';
const SHA512_HEX_LENGTH = 128;

export type WebhookAuthFailure =
  | 'configuration_missing'
  | 'raw_body_missing'
  | 'signature_missing'
  | 'algorithm_invalid'
  | 'signature_invalid';

export type WebhookAuthResult =
  | { ok: true }
  | { ok: false; reason: WebhookAuthFailure };

export interface WahaWebhookAuthInput {
  rawBody?: Buffer;
  signature?: string | string[];
  algorithm?: string | string[];
  secret?: string;
}

function oneHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Authenticate one WAHA webhook against the exact bytes received over HTTP.
 * The request must be rejected before its claimed sender or payload is used.
 */
export function verifyWahaWebhook(input: WahaWebhookAuthInput): WebhookAuthResult {
  if (!input.secret || input.secret.trim() === '') {
    return { ok: false, reason: 'configuration_missing' };
  }
  if (!input.rawBody) {
    return { ok: false, reason: 'raw_body_missing' };
  }

  const signature = oneHeader(input.signature)?.trim();
  if (!signature) {
    return { ok: false, reason: 'signature_missing' };
  }

  const algorithm = oneHeader(input.algorithm)?.trim().toLowerCase();
  if (algorithm !== WAHA_HMAC_ALGORITHM) {
    return { ok: false, reason: 'algorithm_invalid' };
  }
  if (signature.length !== SHA512_HEX_LENGTH || !/^[a-f0-9]+$/i.test(signature)) {
    return { ok: false, reason: 'signature_invalid' };
  }

  const supplied = Buffer.from(signature, 'hex');
  const expected = createHmac(WAHA_HMAC_ALGORITHM, input.secret)
    .update(input.rawBody)
    .digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: 'signature_invalid' };
  }

  return { ok: true };
}
