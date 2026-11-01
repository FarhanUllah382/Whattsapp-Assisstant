import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import { minorToRupees } from './money';
import { publicStockStatus, type PublicStockStatus } from './inventory-visibility';
import type { ChannelImageMessage } from './channel/types';

export const MAX_PRODUCT_IMAGES_PER_REPLY = 3;
const PRODUCT_IMAGE_DIRECTORY = path.resolve(__dirname, '..', 'assets', 'product-images');
const SAFE_IMAGE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,123}\.(?:png|jpe?g)$/i;

interface ProductMediaRow {
  id: number;
  sku: string | null;
  name: string;
  size: string | null;
  color: string | null;
  price_minor: number;
  stock: number;
  image_filename: string | null;
}

export interface ProductMediaCard {
  productIds: number[];
  image: ChannelImageMessage;
}

export type ProductMediaSelection =
  | { ok: true; cards: ProductMediaCard[] }
  | { ok: false; error: string };

export function productMediaIdsAreAuthorized(
  productIds: unknown,
  authorizedIds: ReadonlySet<number>,
): boolean {
  return Array.isArray(productIds) &&
    productIds.length > 0 &&
    productIds.every((id) => Number.isInteger(id) && authorizedIds.has(id as number));
}

export function customerRequestedProductPictures(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  const explicitMedia = /\b(?:photo|photos|picture|pictures|pic|pics|image|images|tasveer|tasweeren)\b/.test(normalized);
  const visualVerb = /\b(?:show|dikhao|dekhao|dikhaye|dikhain|dekhna|see)\b/.test(normalized);
  return explicitMedia || visualVerb;
}

function availabilityLabel(status: PublicStockStatus): string {
  if (status === 'in_stock') return 'In stock';
  if (status === 'low_stock') return 'Low stock';
  return 'Out of stock';
}

function displaySize(size: string): string {
  const labels: Record<string, string> = {
    small: 'S',
    medium: 'M',
    large: 'L',
    'extra large': 'XL',
  };
  return labels[size.toLowerCase()] ?? size;
}

function buildCaption(rows: ProductMediaRow[]): string {
  const first = rows[0];
  const sizes = [...new Set(rows.map((row) => row.size).filter((value): value is string => Boolean(value)).map(displaySize))];
  const colors = [...new Set(rows.map((row) => row.color).filter((value): value is string => Boolean(value)))];
  const prices = [...new Set(rows.map((row) => row.price_minor))].sort((a, b) => a - b);
  const totalStock = rows.reduce((sum, row) => sum + row.stock, 0);
  const priceLabel = prices.length === 1
    ? `Rs ${minorToRupees(prices[0], 'product media price').toLocaleString('en-PK')}`
    : `Rs ${minorToRupees(prices[0], 'product media price').toLocaleString('en-PK')}–${minorToRupees(prices.at(-1)!, 'product media price').toLocaleString('en-PK')}`;
  const variant = [colors.join(', '), sizes.length ? `Sizes: ${sizes.join(', ')}` : ''].filter(Boolean).join(' · ');
  const replyHint = [colors[0], sizes[0], first.name].filter(Boolean).join(' ');
  return [
    first.name,
    priceLabel,
    variant,
    `Availability: ${availabilityLabel(publicStockStatus(totalStock))}`,
    `Reply “${replyHint}” to continue.`,
  ].filter(Boolean).join('\n');
}

function readApprovedImage(filename: string, caption: string): ChannelImageMessage {
  if (!SAFE_IMAGE_FILENAME.test(filename) || path.basename(filename) !== filename) {
    throw new Error('The product image filename is not approved.');
  }
  const absolutePath = path.resolve(PRODUCT_IMAGE_DIRECTORY, filename);
  if (path.dirname(absolutePath) !== PRODUCT_IMAGE_DIRECTORY) {
    throw new Error('The product image path is outside the approved catalog directory.');
  }
  const bytes = fs.readFileSync(absolutePath);
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
    throw new Error('The product image file size is invalid.');
  }
  const lower = filename.toLowerCase();
  return {
    data: bytes.toString('base64'),
    mimetype: lower.endsWith('.png') ? 'image/png' : 'image/jpeg',
    filename,
    caption,
  };
}

export function selectProductMedia(productIds: unknown): ProductMediaSelection {
  if (!Array.isArray(productIds) || productIds.length === 0 || productIds.length > 20) {
    return { ok: false, error: 'Choose between 1 and 20 product IDs returned by check_stock.' };
  }
  if (productIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { ok: false, error: 'Every product ID must be a positive whole number.' };
  }
  const uniqueIds = [...new Set(productIds as number[])];
  const placeholders = uniqueIds.map(() => '?').join(',');
  const selected = db.prepare(`
    select id, sku, name, size, color, price_minor, stock, image_filename
      from products
     where active = 1 and id in (${placeholders})
  `).all(...uniqueIds) as ProductMediaRow[];
  if (selected.length !== uniqueIds.length) {
    return { ok: false, error: 'One or more selected products are not in the active catalog.' };
  }
  if (selected.some((row) => !row.image_filename)) {
    return { ok: false, error: 'One or more selected products do not have an approved catalog image.' };
  }

  const chosenFilenames = [...new Set(uniqueIds.map((id) => selected.find((row) => row.id === id)!.image_filename!))]
    .slice(0, MAX_PRODUCT_IMAGES_PER_REPLY);
  try {
    const cards = chosenFilenames.map((filename) => {
      const variants = db.prepare(`
        select id, sku, name, size, color, price_minor, stock, image_filename
          from products
         where active = 1 and image_filename = ?
         order by price_minor, id
      `).all(filename) as ProductMediaRow[];
      return {
        productIds: variants.map((row) => row.id),
        image: readApprovedImage(filename, buildCaption(variants)),
      };
    });
    return { ok: true, cards };
  } catch {
    return { ok: false, error: 'An approved product image is missing or invalid. Ask the owner to correct the catalog media.' };
  }
}
