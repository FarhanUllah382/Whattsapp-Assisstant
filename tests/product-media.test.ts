import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { WahaAdapter } from '../src/channel/waha';
import { db } from '../src/db';
import {
  customerRequestedProductPictures,
  MAX_PRODUCT_IMAGES_PER_REPLY,
  productMediaIdsAreAuthorized,
  selectProductMedia,
} from '../src/product-media';

const imageDirectory = path.resolve(__dirname, '..', 'assets', 'product-images');
const fixtureFilename = `test-product-${process.pid}.png`;
const fixturePath = path.join(imageDirectory, fixtureFilename);
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test.before(() => {
  fs.mkdirSync(imageDirectory, { recursive: true });
  fs.writeFileSync(fixturePath, onePixelPng);
});

test.after(() => {
  fs.rmSync(fixturePath, { force: true });
});

test('product-picture intent is explicit and conservative', () => {
  assert.equal(customerRequestedProductPictures('Black hoodies ki pictures dikhao'), true);
  assert.equal(customerRequestedProductPictures('Show me shirts'), true);
  assert.equal(customerRequestedProductPictures('Do you have black hoodies?'), false);
  assert.equal(customerRequestedProductPictures(undefined), false);
});

test('product media accepts only IDs grounded by check_stock in the same turn', () => {
  const authorized = new Set([4, 7]);
  assert.equal(productMediaIdsAreAuthorized([4], authorized), true);
  assert.equal(productMediaIdsAreAuthorized([4, 7], authorized), true);
  assert.equal(productMediaIdsAreAuthorized([4, 9], authorized), false);
  assert.equal(productMediaIdsAreAuthorized([], authorized), false);
  assert.equal(productMediaIdsAreAuthorized(['4'], authorized), false);
});

test('approved variants share one image card with server-built public details', () => {
  db.exec('begin');
  try {
    const first = Number(db.prepare(`
      insert into products
        (sku, name, category, size, color, price_minor, stock, image_filename)
      values (?, 'Media Shirt', 'shirt', 'small', 'navy', 220000, 4, ?)
    `).run(`MEDIA-S-${Date.now()}`, fixtureFilename).lastInsertRowid);
    const second = Number(db.prepare(`
      insert into products
        (sku, name, category, size, color, price_minor, stock, image_filename)
      values (?, 'Media Shirt', 'shirt', 'medium', 'navy', 220000, 7, ?)
    `).run(`MEDIA-M-${Date.now()}`, fixtureFilename).lastInsertRowid);

    const selected = selectProductMedia([first, second]);
    assert.equal(selected.ok, true);
    if (!selected.ok) return;
    assert.equal(selected.cards.length, 1);
    assert.deepEqual(selected.cards[0].productIds, [first, second]);
    assert.match(selected.cards[0].image.caption, /Media Shirt/);
    assert.match(selected.cards[0].image.caption, /Rs 2,200/);
    assert.match(selected.cards[0].image.caption, /Sizes: S, M/);
    assert.match(selected.cards[0].image.caption, /Availability: In stock/);
    assert.doesNotMatch(selected.cards[0].image.caption, /stock:\s*11|11\s+(?:items|pieces)/i);
    assert.equal(selected.cards[0].image.filename, fixtureFilename);
    assert.equal(selected.cards[0].image.mimetype, 'image/png');
    assert.equal(selected.cards[0].image.data, onePixelPng.toString('base64'));
  } finally {
    db.exec('rollback');
  }
});

test('media selection fails closed for invalid, inactive, missing, or unconfigured products', () => {
  assert.equal(selectProductMedia([]).ok, false);
  assert.equal(selectProductMedia([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]).ok, false);
  assert.equal(selectProductMedia(['1']).ok, false);
  assert.equal(MAX_PRODUCT_IMAGES_PER_REPLY, 3);

  db.exec('begin');
  try {
    const withoutImage = Number(db.prepare(`
      insert into products (sku, name, price_minor, stock)
      values (?, 'No Image Product', 10000, 1)
    `).run(`NO-IMAGE-${Date.now()}`).lastInsertRowid);
    assert.equal(selectProductMedia([withoutImage]).ok, false);
    assert.equal(selectProductMedia([999999999]).ok, false);
  } finally {
    db.exec('rollback');
  }
});

test('WAHA image delivery sends approved base64 media and caption to sendImage', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedBody: any;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: 'provider-media-1' }), { status: 200 });
  };
  try {
    const adapter = new WahaAdapter({ baseUrl: 'http://waha.test', session: 'demo', apiKey: 'test-key' });
    const result = await adapter.sendImage('923001234567', {
      data: onePixelPng.toString('base64'),
      mimetype: 'image/png',
      filename: fixtureFilename,
      caption: 'Approved product caption',
    });
    assert.equal(capturedUrl, 'http://waha.test/api/sendImage');
    assert.equal(capturedBody.session, 'demo');
    assert.equal(capturedBody.chatId, '923001234567@c.us');
    assert.equal(capturedBody.file.filename, fixtureFilename);
    assert.equal(capturedBody.file.data, onePixelPng.toString('base64'));
    assert.equal(capturedBody.caption, 'Approved product caption');
    assert.equal(result.providerMessageId, 'provider-media-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
