import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findBestMatch, loadCatalogSections, parseCatalog } from '../src/catalog';

describe('Catalog & FAQ Grounding Engine', () => {
  it('correctly parses markdown into distinct sections by ## headings', () => {
    const rawMarkdown = `
# Store FAQ

Text before headings is ignored.

## Delivery
We deliver all over Pakistan within 3-5 days.

## Return Policy
Returns accepted within 7 days.
    `.trim();

    const sections = parseCatalog(rawMarkdown);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].title, 'Delivery');
    assert.match(sections[0].body, /3-5 days/);
    assert.equal(sections[1].title, 'Return Policy');
    assert.match(sections[1].body, /7 days/);
  });

  it('matches customer questions to the correct section with title weighting', () => {
    const sections = loadCatalogSections();

    const returnMatch = findBestMatch(sections, 'How can I return an item?');
    assert.ok(returnMatch);
    assert.equal(returnMatch?.title, 'Return Policy');

    const exchangeMatch = findBestMatch(sections, 'Can I exchange for a different size?');
    assert.ok(exchangeMatch);
    assert.equal(exchangeMatch?.title, 'Exchange Policy');

    const deliveryMatch = findBestMatch(sections, 'How long does delivery take all over Pakistan?');
    assert.ok(deliveryMatch);
    assert.equal(deliveryMatch?.title, 'Delivery');

    const paymentMatch = findBestMatch(sections, 'Do you accept Easypaisa or JazzCash?');
    assert.ok(paymentMatch);
    assert.equal(paymentMatch?.title, 'Payment Methods');
  });

  it('returns null when the customer query is completely ungrounded', () => {
    const sections = loadCatalogSections();
    const match = findBestMatch(sections, 'Where is the nearest spaceship repair workshop?');
    assert.equal(match, null);
  });
});
