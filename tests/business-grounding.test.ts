import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { checkSupportUpsellReply, customerSafeProductRecord } from '../src/business-grounding';
import { catalogFingerprint, verifyCatalogApproval } from '../src/catalog';
import { db } from '../src/db';
import { checkStock, searchCatalog } from '../src/tools';

test('business policy catalog requires the exact owner-approved SHA-256', () => {
  const text = '# Catalog\n\n## Delivery\nApproved policy.';
  const fingerprint = catalogFingerprint(text);
  assert.deepEqual(verifyCatalogApproval(text, undefined), {
    ok: false,
    fingerprint,
    reason: 'missing',
  });
  assert.equal(verifyCatalogApproval(text, 'bad').ok, false);
  assert.equal(verifyCatalogApproval(`${text}\nchanged`, fingerprint).ok, false);
  assert.deepEqual(verifyCatalogApproval(text, fingerprint), { ok: true, fingerprint });
});

test('search_catalog fails closed until the current catalog is explicitly approved', () => {
  const prior = process.env.APPROVED_CATALOG_SHA256;
  try {
    delete process.env.APPROVED_CATALOG_SHA256;
    const blocked = searchCatalog.execute({ query: 'What is the return policy?' }, { customerId: 1 }) as Record<string, unknown>;
    assert.equal(blocked.found, false);
    assert.equal(blocked.configuration_error, true);

    const catalog = fs.readFileSync(path.join(__dirname, '..', 'catalog.md'), 'utf8');
    process.env.APPROVED_CATALOG_SHA256 = catalogFingerprint(catalog);
    const approved = searchCatalog.execute({ query: 'What is the return policy?' }, { customerId: 1 }) as Record<string, unknown>;
    assert.equal(approved.found, true);
    assert.equal(approved.title, 'Return Policy');
  } finally {
    if (prior === undefined) delete process.env.APPROVED_CATALOG_SHA256;
    else process.env.APPROVED_CATALOG_SHA256 = prior;
  }
});

test('structured product search applies category, size, color, and budget together', () => {
  db.exec('begin');
  try {
    const suffix = Date.now();
    db.prepare(`
      insert into products (sku, name, category, size, color, price_minor, stock, active, aliases_json)
      values (?, 'Grounded Hoodie', 'hoodie', 'large', 'red', 45000, 3, 1, '["sweatshirt"]')
    `).run(`GROUND-${suffix}`);
    db.prepare(`
      insert into products (sku, name, category, size, color, price_minor, stock, active, aliases_json)
      values (?, 'Expensive Hoodie', 'hoodie', 'large', 'red', 90000, 3, 1, '[]')
    `).run(`GROUND-HIGH-${suffix}`);

    const result = checkStock.execute({
      category: 'hoodies',
      size: 'L',
      color: 'red',
      max_price: 500,
      requested_qty: 2,
    }, { customerId: 1 }) as any;
    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.equal(result.scope, 'current_active_catalog');
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].name, 'Grounded Hoodie');
    assert.equal(result.products[0].price, 450);
    assert.equal(result.products[0].can_fulfill_requested_qty, true);
    assert.equal(Object.hasOwn(result.products[0], 'stock'), false);
  } finally {
    db.exec('rollback');
  }
});

test('structured product search accepts plural customer wording', () => {
  db.exec('begin');
  try {
    db.prepare(`
      insert into products (sku, name, category, size, color, price_minor, stock, active, aliases_json)
      values (?, 'Plural Casual Shirt', 'shirt', 'medium', 'navy', 220000, 5, 1, '["shirt"]')
    `).run(`PLURAL-${Date.now()}`);
    const result = checkStock.execute({ name: 'shirts', size: 'M', color: 'navy' }, { customerId: 1 }) as any;
    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.equal(result.products.some((product: any) => product.name === 'Plural Casual Shirt'), true);
  } finally {
    db.exec('rollback');
  }
});

test('unknown product attributes require confirmation instead of a guessed conclusion', () => {
  const result = checkStock.execute({
    name: 'hoodie',
    required_features: ['waterproof', 'organic cotton'],
  }, { customerId: 1 }) as any;
  assert.equal(result.ok, true);
  assert.equal(result.found, false);
  assert.equal(result.needs_owner_confirmation, true);
  assert.deepEqual(result.unsupported_attributes, ['waterproof', 'organic cotton']);
});

test('product searches report current-catalog scope and reject internal placeholder labels', () => {
  assert.equal(customerSafeProductRecord({ name: 'Black Hoodie' }).ok, true);
  assert.equal(customerSafeProductRecord({ name: 'Hoodie (temporary - delete after testing)' }).ok, false);

  const notFound = checkStock.execute({ name: `missing-${Date.now()}` }, { customerId: 1 }) as any;
  assert.equal(notFound.ok, true);
  assert.equal(notFound.found, false);
  assert.equal(notFound.scope, 'current_active_catalog');
  assert.match(notFound.instruction, /do not claim Ahmed never sells/i);

  db.exec('begin');
  try {
    db.prepare(`
      insert into products (sku, name, category, size, color, price_minor, stock, active, aliases_json)
      values (?, 'Hoodie temporary - delete after testing', 'hoodie', 'large', 'blue', 90000, 2, 1, '[]')
    `).run(`UNSAFE-${Date.now()}`);
    const blocked = checkStock.execute({
      name: 'Hoodie temporary',
      size: 'large',
      color: 'blue',
    }, { customerId: 1 }) as any;
    assert.equal(blocked.ok, false);
    assert.equal(blocked.configuration_error, true);
  } finally {
    db.exec('rollback');
  }
});

test('support conversations reject unrelated upselling but allow issue-focused replies', () => {
  assert.equal(checkSupportUpsellReply(
    'I need a refund for my damaged order',
    'Your refund request was recorded. Would you like to buy our black hoodie?',
  ).ok, false);
  assert.equal(checkSupportUpsellReply(
    'Where is my order? It is late.',
    'I will help with the current order status first.',
  ).ok, true);
  assert.equal(checkSupportUpsellReply(
    'Show me hoodies',
    'Would you like to order a black hoodie?',
  ).ok, true);
});
