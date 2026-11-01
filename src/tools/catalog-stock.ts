// Customer catalog tools: structured live-stock search (check_stock) and the
// owner-approved policy/FAQ lookup (search_catalog). Split out of tools.ts;
// tools.ts remains the public barrel that assembles baseTools.

import { findBestMatch, loadApprovedCatalogSections } from '../catalog';
import { customerSafeProductRecord, normalizeRequiredFeatures } from '../business-grounding';
import { db } from '../db';
import { normalizeSize } from '../inventory';
import { publicInventoryFields } from '../inventory-visibility';
import { minorToRupees } from '../money';
import type { ToolDef } from '../types';

export const checkStock: ToolDef = {
  name: 'check_stock',
  description:
    'Search the current active product catalog using structured filters. Exact stock counts are private. ' +
    'Pass every requested feature that is not name/category/size/color/budget in required_features; ' +
    'the server will require owner confirmation instead of guessing.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'product name, e.g. "shirt"' },
      category: { type: 'string', description: 'product category, e.g. "hoodie" (optional)' },
      size: { type: 'string', description: 'e.g. "medium" (optional)' },
      color: { type: 'string', description: 'e.g. "black" (optional)' },
      max_price: { type: 'number', description: 'optional maximum customer budget in rupees' },
      requested_qty: {
        type: 'number',
        description: 'optional positive whole quantity the customer wants',
      },
      required_features: {
        type: 'array',
        items: { type: 'string' },
        description: 'features not represented by structured fields, e.g. waterproof or cotton',
      },
    },
  },
  execute: ({ name, category, size, color, max_price, requested_qty, required_features }) => {
    if ((typeof name !== 'string' || name.trim() === '') &&
        (typeof category !== 'string' || category.trim() === '')) {
      return { ok: false, error: 'Please provide a product name or category.' };
    }
    if (name !== undefined && typeof name !== 'string') return { ok: false, error: 'Product name must be plain text.' };
    if (category !== undefined && typeof category !== 'string') return { ok: false, error: 'Category must be plain text.' };
    if (size !== undefined && typeof size !== 'string') {
      return { ok: false, error: 'Size must be plain text, like "medium".' };
    }
    if (color !== undefined && typeof color !== 'string') {
      return { ok: false, error: 'Color must be plain text, like "black".' };
    }
    if (requested_qty !== undefined && (!Number.isInteger(requested_qty) || requested_qty <= 0)) {
      return { ok: false, error: 'requested_qty must be a positive whole number.' };
    }
    if (max_price !== undefined &&
        (typeof max_price !== 'number' || !Number.isFinite(max_price) || max_price < 0)) {
      return { ok: false, error: 'max_price must be a non-negative rupee amount.' };
    }
    let maxPriceMinor: number | undefined;
    if (max_price !== undefined) {
      try {
        maxPriceMinor = Math.round(max_price * 100);
        if (!Number.isSafeInteger(maxPriceMinor) || Math.abs(max_price * 100 - maxPriceMinor) > 1e-8) {
          return { ok: false, error: 'max_price may contain at most two decimal places.' };
        }
      } catch {
        return { ok: false, error: 'max_price is invalid.' };
      }
    }
    const features = normalizeRequiredFeatures(required_features);
    if (!Array.isArray(features)) return { ok: false, error: features.error };
    if (features.length > 0) {
      return {
        ok: true,
        found: false,
        needs_owner_confirmation: true,
        unsupported_attributes: features,
        instruction:
          'These attributes are not present in the approved product schema. Do not answer yes or no; notify the owner and report the real handoff state.',
      };
    }

    const escapeLike = (value: string) => value.toLowerCase().replace(/[\\%_]/g, '\\$&');
    const filters: string[] = ['active = 1'];
    const params: unknown[] = [];
    if (typeof name === 'string' && name.trim()) {
      const rawName = name.trim().toLowerCase();
      const singularName = rawName.replace(/s$/, '');
      const namePatterns = [...new Set([rawName, singularName])].map((value) => `%${escapeLike(value)}%`);
      filters.push(`(${namePatterns.map(() => `(
        lower(name) like ? escape '\\'
        or exists (
          select 1 from json_each(products.aliases_json)
          where lower(cast(json_each.value as text)) like ? escape '\\'
        )
      )`).join(' or ')})`);
      for (const pattern of namePatterns) params.push(pattern, pattern);
    }
    if (typeof category === 'string' && category.trim()) {
      const rawCategory = category.trim().toLowerCase();
      const singularCategory = rawCategory.replace(/s$/, '');
      filters.push('lower(category) in (?, ?)');
      params.push(rawCategory, singularCategory);
    }
    let sql = `select id, sku, name, category, size, color, price_minor, stock
      from products
      where ${filters.join(' and ')}`;
    if (size) {
      sql += ' and lower(size) = ?';
      params.push(normalizeSize(size));
    }
    if (color) {
      sql += ' and lower(color) = ?';
      params.push(color.trim().toLowerCase());
    }
    if (maxPriceMinor !== undefined) {
      sql += ' and price_minor <= ?';
      params.push(maxPriceMinor);
    }
    sql += ' order by price_minor, name, id limit 20';
    const rows = db.prepare(sql).all(...params) as Array<
      Record<string, unknown> & {
        name: string;
        sku: string | null;
        category: string | null;
        price_minor: number;
        stock: number;
      }
    >;
    for (const row of rows) {
      const safe = customerSafeProductRecord(row);
      if (!safe.ok) {
        return {
          ok: false,
          configuration_error: true,
          error: 'A matching product is not approved for customer display. Ask the owner to correct the catalog record.',
        };
      }
    }
    return rows.length > 0
      ? {
          ok: true,
          found: true,
          scope: 'current_active_catalog',
          products: rows.map(({ price_minor, stock, id, name, category, size, color }) => ({
            product_id: id,
            name,
            category,
            size,
            color,
            price: minorToRupees(price_minor, 'product price'),
            ...publicInventoryFields(stock, requested_qty),
          })),
        }
      : {
          ok: true,
          found: false,
          scope: 'current_active_catalog',
          message: 'No matching product was found in the current active catalog for these filters.',
          instruction: 'Do not claim Ahmed never sells this item; report only that it was not found in the current catalog.',
        };
  },
};

export const searchCatalog: ToolDef = {
  name: 'search_catalog',
  description:
    "Search Ahmed's catalog/FAQ document for general questions — what he sells, return policy, " +
    'delivery info, etc. This does NOT check live availability or exact prices — use check_stock for ' +
    "that. If this returns found:false, do NOT guess an answer — tell the customer you'll " +
    'confirm and get back to them.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'what the customer is asking about' },
    },
    required: ['query'],
  },
  execute: ({ query }) => {
    if (typeof query !== 'string' || query.trim() === '') {
      return { ok: false, error: 'Please say what you want to look up in the catalog.' };
    }
    const approved = loadApprovedCatalogSections();
    if (!approved.ok) {
      return {
        found: false,
        configuration_error: true,
        instruction:
          'The business-policy catalog is not owner-approved or has changed since approval. Do not answer from memory; notify the owner.',
      };
    }
    const match = findBestMatch(approved.sections, query);
    if (!match) {
      return {
        found: false,
        instruction:
          "Nothing in the catalog answers this — do not guess. Tell the customer you'll " +
          'confirm and get back to them.',
      };
    }
    return {
      found: true,
      title: match.title.slice(0, 120),
      content: match.body.slice(0, 3_000),
    };
  },
};
