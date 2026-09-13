import { db } from '../src/db';

interface InitialProduct {
  name: string;
  size: string;
  color: string;
  price: number;
  stock: number;
}

const INITIAL_PRODUCTS: InitialProduct[] = [
  { name: 'shirt', size: 'medium', color: 'black', price: 2500, stock: 15 },
  { name: 'shirt', size: 'large', color: 'black', price: 2500, stock: 12 },
  { name: 'shirt', size: 'medium', color: 'white', price: 2500, stock: 10 },
  { name: 'shirt', size: 'large', color: 'white', price: 2500, stock: 8 },
  { name: 'shirt', size: 'medium', color: 'blue', price: 2500, stock: 10 },

  { name: 'kurta', size: 'medium', color: 'white', price: 3000, stock: 10 },
  { name: 'kurta', size: 'large', color: 'white', price: 3000, stock: 10 },
  { name: 'kurta', size: 'medium', color: 'black', price: 3000, stock: 8 },
  { name: 'kurta', size: 'large', color: 'black', price: 3000, stock: 8 },

  { name: 'trouser', size: 'medium', color: 'black', price: 4000, stock: 10 },
  { name: 'trouser', size: 'large', color: 'black', price: 4000, stock: 10 },
  { name: 'trouser', size: 'medium', color: 'grey', price: 4000, stock: 10 },
  { name: 'trouser', size: 'large', color: 'grey', price: 4000, stock: 10 },
];

export function seedProducts(): void {
  const insert = db.prepare(
    'insert into products (name, size, color, price, stock) values (?, ?, ?, ?, ?)',
  );

  const existingCount = (
    db.prepare('select count(*) as c from products').get() as { c: number }
  ).c;

  if (existingCount > 0) {
    console.log(`Products table already has ${existingCount} items. Skipping seed.`);
    return;
  }

  const insertMany = db.transaction((products: InitialProduct[]) => {
    for (const p of products) {
      insert.run(p.name, p.size, p.color, p.price, p.stock);
    }
  });

  insertMany(INITIAL_PRODUCTS);
  console.log(`Successfully seeded ${INITIAL_PRODUCTS.length} products into ahmed.db.`);
}

if (require.main === module) {
  seedProducts();
}
