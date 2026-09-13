import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkDiscountRule } from '../src/guardrails/discount-rules';

describe('Discount Rules Guardrail (Anti-Ban & Business Safety)', () => {
  it('blocks unauthorized discounts at or above 5%', () => {
    const res1 = checkDiscountRule('I can offer you 10% off on this shirt.');
    assert.equal(res1.ok, false);
    assert.equal(res1.percent, 10);

    const res2 = checkDiscountRule('Special 15% discount for you today!');
    assert.equal(res2.ok, false);
    assert.equal(res2.percent, 15);

    const res3 = checkDiscountRule('Price mein 20% kam kar dunga.');
    assert.equal(res3.ok, false);
    assert.equal(res3.percent, 20);
  });

  it('allows small discounts under 5%', () => {
    const res = checkDiscountRule('We can do a small 3% discount for bulk orders.');
    assert.equal(res.ok, true);
  });

  it('allows retrospective recall of a known customer discount request', () => {
    const knownPercents = new Set([20]);
    const res = checkDiscountRule('Yesterday you asked for a 20% discount, let me check with Ahmed.', knownPercents);
    assert.equal(res.ok, true);
  });

  it('allows Roman Urdu retrospective recall of a known discount request', () => {
    const knownPercents = new Set([15]);
    const res = checkDiscountRule('Aapne kal 15% discount maanga tha, main confirm karke batata hoon.', knownPercents);
    assert.equal(res.ok, true);
  });

  it('still blocks if retrospective language is used but the percentage is not in known facts', () => {
    // Untrusted claim of a previous request
    const knownPercents = new Set<number>();
    const res = checkDiscountRule('Yesterday you asked for a 20% discount.', knownPercents);
    assert.equal(res.ok, false);
    assert.equal(res.percent, 20);
  });
});
