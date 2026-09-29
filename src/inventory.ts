import fs from 'node:fs';
import path from 'node:path';
import { parseCatalog } from './catalog';
import { db } from './db';
import { rupeesToMinor } from './money';

const REQUIRED_HEADERS = ['sku', 'name', 'category', 'size', 'color', 'price', 'stock', 'active', 'aliases'] as const;
const NON_PRODUCT_CATALOG_SECTIONS = new Set([
  'product',
  'payment method',
  'delivery',
  'return policy',
  'exchange policy',
]);

export interface InventoryRow {
  sku: string;
  name: string;
  category: string;
  size: string | null;
  color: string | null;
  priceMinor: number;
  stock: number;
  active: boolean;
  aliases: string[];
}

export interface InventoryReconciliation {
  databaseOnlyCategories: string[];
  catalogOnlyCategories: string[];
  unclassifiedDatabaseProducts: string[];
}

export interface InventoryImportResult {
  applied: boolean;
  rows: number;
  inserted: number;
  updated: number;
  reconciliation: InventoryReconciliation;
}

function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (closedQuote) {
      if (char === ',') {
        row.push(field);
        field = '';
        closedQuote = false;
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && source[i + 1] === '\n') i++;
        row.push(field);
        if (row.some((value) => value.trim() !== '')) rows.push(row);
        row = [];
        field = '';
        closedQuote = false;
      } else if (!/\s/.test(char)) {
        throw new Error('Unexpected text after a closing quote in CSV.');
      }
      continue;
    }

    if (char === '"') {
      if (field.length > 0) throw new Error('A quoted CSV field must start with a quote.');
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('CSV ended inside a quoted field.');
  row.push(field);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

function normalizeCategory(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.endsWith('s') ? normalized.slice(0, -1) : normalized;
}

export function normalizeSize(value: string): string {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, string> = {
    s: 'small',
    sm: 'small',
    m: 'medium',
    md: 'medium',
    l: 'large',
    lg: 'large',
    xl: 'extra large',
    xlarge: 'extra large',
    'extra-large': 'extra large',
  };
  return aliases[normalized] ?? normalized;
}

function parseActive(value: string, rowNumber: number): boolean {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'active'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'inactive'].includes(normalized)) return false;
  throw new Error(`CSV row ${rowNumber}: active must be true/false, yes/no, or 1/0.`);
}

export function parseInventoryCsv(text: string): InventoryRow[] {
  const records = parseCsv(text);
  if (records.length < 2) throw new Error('Inventory CSV must contain a header and at least one product row.');

  const headers = records[0].map((header) => header.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('Inventory CSV contains duplicate headers.');
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  const unknown = headers.filter((header) => !(REQUIRED_HEADERS as readonly string[]).includes(header));
  if (missing.length || unknown.length) {
    throw new Error(`Inventory CSV headers are invalid. Missing: ${missing.join(', ') || 'none'}. Unknown: ${unknown.join(', ') || 'none'}.`);
  }
  const indexes = Object.fromEntries(headers.map((header, index) => [header, index])) as Record<string, number>;
  const seenSkus = new Set<string>();

  return records.slice(1).map((record, offset) => {
    const rowNumber = offset + 2;
    if (record.length !== headers.length) {
      throw new Error(`CSV row ${rowNumber}: expected ${headers.length} fields but received ${record.length}.`);
    }
    const value = (header: typeof REQUIRED_HEADERS[number]) => record[indexes[header]].trim();
    const sku = value('sku').toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(sku)) {
      throw new Error(`CSV row ${rowNumber}: sku must be 2-64 characters using letters, numbers, dot, underscore, or hyphen.`);
    }
    if (seenSkus.has(sku)) throw new Error(`CSV row ${rowNumber}: duplicate sku ${sku}.`);
    seenSkus.add(sku);

    const name = value('name');
    const category = value('category').toLowerCase();
    if (!name || name.length > 100) throw new Error(`CSV row ${rowNumber}: name must be 1-100 characters.`);
    if (!category || category.length > 80) throw new Error(`CSV row ${rowNumber}: category must be 1-80 characters.`);

    const priceText = value('price');
    if (!/^\d+(?:\.\d{1,2})?$/.test(priceText)) {
      throw new Error(`CSV row ${rowNumber}: price must be a non-negative rupee amount with at most two decimals.`);
    }
    const stockText = value('stock');
    if (!/^\d+$/.test(stockText)) throw new Error(`CSV row ${rowNumber}: stock must be a non-negative whole number.`);
    const stock = Number(stockText);
    if (!Number.isSafeInteger(stock)) throw new Error(`CSV row ${rowNumber}: stock is too large.`);

    const aliases = [...new Set(value('aliases').split('|').map((alias) => alias.trim().toLowerCase()).filter(Boolean))];
    if (aliases.length > 20 || aliases.some((alias) => alias.length > 80)) {
      throw new Error(`CSV row ${rowNumber}: aliases allow at most 20 values of 80 characters each.`);
    }

    return {
      sku,
      name,
      category,
      size: value('size') ? normalizeSize(value('size')) : null,
      color: value('color') ? value('color').toLowerCase() : null,
      priceMinor: rupeesToMinor(Number(priceText), `CSV row ${rowNumber} price`),
      stock,
      active: parseActive(value('active'), rowNumber),
      aliases,
    };
  });
}

function reconcile(rows: Array<{ name: string; category: string | null; active: number }>, catalogText: string): InventoryReconciliation {
  const activeRows = rows.filter((row) => row.active === 1);
  const databaseCategories = new Set(activeRows.map((row) => row.category).filter((value): value is string => Boolean(value)).map(normalizeCategory));
  const catalogCategories = new Set(
    parseCatalog(catalogText)
      .map((section) => normalizeCategory(section.title))
      .filter((title) => !NON_PRODUCT_CATALOG_SECTIONS.has(title)),
  );
  return {
    databaseOnlyCategories: [...databaseCategories].filter((category) => !catalogCategories.has(category)).sort(),
    catalogOnlyCategories: [...catalogCategories].filter((category) => !databaseCategories.has(category)).sort(),
    unclassifiedDatabaseProducts: activeRows.filter((row) => !row.category).map((row) => row.name).sort(),
  };
}

export function importInventoryCsv(text: string, apply: boolean, catalogText?: string): InventoryImportResult {
  const rows = parseInventoryCsv(text);
  const existing = db.prepare('select sku from products where sku is not null').all() as Array<{ sku: string }>;
  const existingSkus = new Set(existing.map((row) => row.sku.toUpperCase()));
  const inserted = rows.filter((row) => !existingSkus.has(row.sku)).length;
  const updated = rows.length - inserted;

  if (apply) {
    const upsert = db.prepare(`
      insert into products (sku, name, category, size, color, price_minor, stock, active, aliases_json, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      on conflict(sku) do update set
        name = excluded.name,
        category = excluded.category,
        size = excluded.size,
        color = excluded.color,
        price_minor = excluded.price_minor,
        stock = excluded.stock,
        active = excluded.active,
        aliases_json = excluded.aliases_json,
        updated_at = datetime('now')
    `);
    db.transaction(() => {
      for (const row of rows) {
        upsert.run(
          row.sku,
          row.name,
          row.category,
          row.size,
          row.color,
          row.priceMinor,
          row.stock,
          row.active ? 1 : 0,
          JSON.stringify(row.aliases),
        );
      }
    }).immediate();
  }

  const currentRows = db.prepare('select sku, name, category, active from products').all() as Array<{
    sku: string | null;
    name: string;
    category: string | null;
    active: number;
  }>;
  const simulatedRows = apply
    ? currentRows
    : [
        ...currentRows.filter((current) => !current.sku || !rows.some((row) => row.sku === current.sku?.toUpperCase())),
        ...rows.map((row) => ({ name: row.name, category: row.category, active: row.active ? 1 : 0 })),
      ];
  const catalog = catalogText ?? fs.readFileSync(path.join(__dirname, '..', 'catalog.md'), 'utf8');
  return { applied: apply, rows: rows.length, inserted, updated, reconciliation: reconcile(simulatedRows, catalog) };
}
