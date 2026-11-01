import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db';
import { selectProductMedia } from '../src/product-media';

interface ProductMediaRow {
  id: number;
  sku: string;
  image_filename: string | null;
}

const rows = db.prepare(`
  select id, sku, image_filename
    from products
   where active = 1
   order by sku
`).all() as ProductMediaRow[];

const mediaDirectory = path.resolve(__dirname, '..', 'assets', 'product-images');
const missing = rows.filter((row) =>
  !row.image_filename || !fs.existsSync(path.join(mediaDirectory, row.image_filename)));
const distinctImages = new Set(rows.map((row) => row.image_filename).filter(Boolean));
const representativeIds = [...distinctImages].map((filename) =>
  rows.find((row) => row.image_filename === filename)!.id);
const loadableCards = representativeIds.filter((id) => {
  const selected = selectProductMedia([id]);
  return selected.ok && selected.cards.length === 1 && selected.cards[0].image.data.length > 0;
}).length;

const report = {
  activeProducts: rows.length,
  configuredProducts: rows.filter((row) => Boolean(row.image_filename)).length,
  distinctImages: distinctImages.size,
  loadableCards,
  missing,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (missing.length > 0 || loadableCards !== distinctImages.size) process.exitCode = 1;
