import fs from 'node:fs';
import path from 'node:path';
import { importInventoryCsv } from '../src/inventory';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const fileArg = args.find((arg) => arg !== '--apply');

if (!fileArg) {
  throw new Error('Usage: npx tsx scripts/import-inventory.ts <inventory.csv> [--apply]');
}

const csvPath = path.resolve(fileArg);
const csv = fs.readFileSync(csvPath, 'utf8');
const result = importInventoryCsv(csv, apply);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!apply) {
  process.stdout.write('Preview only: no database changes were made. Re-run with --apply after reviewing this report.\n');
}
