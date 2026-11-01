import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkPaymentInstructionReply,
  createSendPaymentInstructionsTool,
  getAvailablePaymentMethods,
  getPaymentInstructions,
} from '../src/payment-instructions';

const empty = {};

test('missing payment configuration fails closed and leaves only COD available', () => {
  assert.deepEqual(getAvailablePaymentMethods(empty), ['cod']);
  assert.equal(getPaymentInstructions('easypaisa', empty).ok, false);
  assert.equal(getPaymentInstructions('jazzcash', empty).ok, false);
  assert.equal(getPaymentInstructions('bank_transfer', empty).ok, false);
});

test('valid Easypaisa configuration produces exact deterministic instructions', () => {
  const result = getPaymentInstructions('easypaisa', {
    PAYMENT_EASYPAISA_ACCOUNT_NAME: 'Ahmed Store',
    PAYMENT_EASYPAISA_NUMBER: '+92 300 1234567',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.body,
    [
      'Easypaisa payment details',
      'Account title: Ahmed Store',
      'Mobile number: 03001234567',
      'Use your order number as the payment reference. A payment claim remains pending until the owner verifies it.',
    ].join('\n'),
  );
});

test('malformed wallet number and incomplete bank configuration remain unavailable', () => {
  assert.equal(
    getPaymentInstructions('easypaisa', {
      PAYMENT_EASYPAISA_ACCOUNT_NAME: 'Ahmed Store',
      PAYMENT_EASYPAISA_NUMBER: '12345',
    }).ok,
    false,
  );
  assert.equal(
    getPaymentInstructions('bank_transfer', {
      PAYMENT_BANK_NAME: 'Example Bank',
      PAYMENT_BANK_ACCOUNT_TITLE: 'Ahmed Store',
    }).ok,
    false,
  );
});

test('normal send guard blocks placeholders and fabricated destinations', () => {
  assert.equal(
    checkPaymentInstructionReply(
      'Pay with Easypaisa here: [Ahmed ka Easypaisa number yahan aayega].',
    ).ok,
    false,
  );
  assert.equal(
    checkPaymentInstructionReply('Please send Easypaisa payment to mobile number 03001234567.').ok,
    false,
  );
  assert.equal(
    checkPaymentInstructionReply('Please send Easypaisa payment to mobile number +92 300 123 4567.').ok,
    false,
  );
  assert.equal(checkPaymentInstructionReply('We accept COD and Easypaisa when configured.').ok, true);
  assert.equal(
    checkPaymentInstructionReply(
      'Order summary\nPhone: 03001234567\nPayment method: Easypaisa\nTotal: Rs 800',
    ).ok,
    true,
  );
});

test('only the exact server-rendered body is authorized', () => {
  const configured = getPaymentInstructions('easypaisa', {
    PAYMENT_EASYPAISA_ACCOUNT_NAME: 'Ahmed Store',
    PAYMENT_EASYPAISA_NUMBER: '03001234567',
  });
  assert.equal(configured.ok, true);
  if (!configured.ok) return;
  assert.equal(checkPaymentInstructionReply(configured.body, configured.body).ok, true);
  assert.equal(checkPaymentInstructionReply(`${configured.body}\nSend twice.`, configured.body).ok, false);
});

test('payment tool sends configured instructions and never sends when configuration is missing', async () => {
  const sent: string[] = [];
  const configuredTool = createSendPaymentInstructionsTool(
    async (body) => {
      sent.push(body);
      return { ok: true };
    },
    {
      PAYMENT_JAZZCASH_ACCOUNT_NAME: 'Ahmed Store',
      PAYMENT_JAZZCASH_NUMBER: '03001234567',
    },
  );
  const configuredResult = await configuredTool.execute({ method: 'jazzcash' }, { customerId: 1 });
  assert.deepEqual(configuredResult, { ok: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^JazzCash payment details/);

  const unavailableTool = createSendPaymentInstructionsTool(
    async (body) => {
      sent.push(body);
      return { ok: true };
    },
    empty,
  );
  const unavailableResult = await unavailableTool.execute({ method: 'easypaisa' }, { customerId: 1 }) as {
    ok: boolean;
  };
  assert.equal(unavailableResult.ok, false);
  assert.equal(sent.length, 1);
});
