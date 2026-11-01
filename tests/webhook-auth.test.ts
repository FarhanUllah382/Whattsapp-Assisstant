import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { verifyWahaWebhook } from '../src/webhook-auth';

const secret = 'test-only-secret-that-is-long-and-random-enough';
const body = Buffer.from('{"event":"message","payload":{"body":"hello"}}');
const signature = createHmac('sha512', secret).update(body).digest('hex');

assert.deepEqual(verifyWahaWebhook({ rawBody: body, signature, algorithm: 'sha512' }), {
  ok: false,
  reason: 'configuration_missing',
});
assert.deepEqual(verifyWahaWebhook({ signature, algorithm: 'sha512', secret }), {
  ok: false,
  reason: 'raw_body_missing',
});
assert.deepEqual(verifyWahaWebhook({ rawBody: body, algorithm: 'sha512', secret }), {
  ok: false,
  reason: 'signature_missing',
});
assert.deepEqual(verifyWahaWebhook({ rawBody: body, signature, algorithm: 'sha256', secret }), {
  ok: false,
  reason: 'algorithm_invalid',
});
assert.deepEqual(verifyWahaWebhook({ rawBody: body, signature: 'not-hex', algorithm: 'sha512', secret }), {
  ok: false,
  reason: 'signature_invalid',
});
assert.deepEqual(verifyWahaWebhook({ rawBody: body, signature, algorithm: 'SHA512', secret }), { ok: true });
assert.deepEqual(verifyWahaWebhook({ rawBody: body, signature: [signature], algorithm: ['sha512'], secret }), { ok: true });
assert.deepEqual(
  verifyWahaWebhook({
    rawBody: Buffer.from('{"event":"message","payload":{"body":"modified"}}'),
    signature,
    algorithm: 'sha512',
    secret,
  }),
  { ok: false, reason: 'signature_invalid' },
);

process.stdout.write('  ✔ WAHA webhook HMAC authentication fails closed and detects tampering\n');
