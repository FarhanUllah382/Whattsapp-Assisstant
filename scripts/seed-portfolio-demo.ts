import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(__dirname, '..');
const demoDataDir = path.join(projectRoot, 'portfolio-demo', 'data');
const demoDbPath = path.join(demoDataDir, 'portfolio-demo.db');
const realDbPath = path.join(projectRoot, 'ahmed.db');

if (path.resolve(demoDbPath) === path.resolve(realDbPath)) {
  throw new Error('Refusing to seed the production database.');
}

fs.mkdirSync(demoDataDir, { recursive: true });
if (fs.existsSync(demoDbPath)) fs.rmSync(demoDbPath);

const db = new Database(demoDbPath);
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(projectRoot, 'db', 'schema.sql'), 'utf8'));

const sqlTimestamp = (date: Date): string => date.toISOString().slice(0, 19).replace('T', ' ');
const daysAgo = (days: number, hour = 9, minute = 0): string => {
  const now = new Date();
  const result = new Date(now.getTime() - days * 86_400_000);
  result.setUTCHours(hour, minute, 0, 0);
  return sqlTimestamp(result);
};

const todayAt = (hour: number, minute: number): string => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [year, month, day] = formatter.format(new Date()).split('-').map(Number);
  return sqlTimestamp(new Date(Date.UTC(year, month - 1, day, hour - 5, minute)));
};

const seed = db.transaction(() => {
  const insertCustomer = db.prepare(
    'insert into customers (phone, name, disclosure_sent_at, created_at) values (?, ?, ?, ?)',
  );
  const customers = [
    ['DEMO-CUSTOMER-001', 'Sara Khan', daysAgo(18), daysAgo(30)],
    ['DEMO-CUSTOMER-002', 'Hamza Ali', daysAgo(12), daysAgo(21)],
    ['DEMO-CUSTOMER-003', 'Ayesha Noor', daysAgo(7), daysAgo(14)],
  ] as const;
  for (const customer of customers) insertCustomer.run(...customer);

  const insertProduct = db.prepare(
    'insert into products (name, size, color, price, stock) values (?, ?, ?, ?, ?)',
  );
  const productIds = [
    insertProduct.run('Classic Cotton Kurta', 'M', 'Navy', 3200, 18).lastInsertRowid,
    insertProduct.run('Linen Summer Shirt', 'L', 'White', 2800, 11).lastInsertRowid,
    insertProduct.run('Premium Chinos', '32', 'Sand', 3600, 9).lastInsertRowid,
    insertProduct.run('Everyday Polo', 'M', 'Olive', 2200, 24).lastInsertRowid,
  ].map(Number);

  const insertOrder = db.prepare(
    'insert into orders (customer_id, items_json, total, status, created_at) values (?, ?, ?, ?, ?)',
  );
  const orderRows = [
    [1, [{ product_id: productIds[0], qty: 2, price: 3200 }], 6400, 'delivered', daysAgo(12, 8,)],
    [2, [{ product_id: productIds[1], qty: 1, price: 2800 }], 2800, 'cancelled', daysAgo(9, 10)],
    [3, [{ product_id: productIds[3], qty: 2, price: 2200 }], 4400, 'placed', daysAgo(8, 11)],
    [1, [{ product_id: productIds[0], qty: 1, price: 3200 }], 3200, 'confirmed', daysAgo(4, 9)],
    [2, [{ product_id: productIds[2], qty: 1, price: 3600 }], 3600, 'paid', daysAgo(3, 12)],
    [3, [{ product_id: productIds[3], qty: 1, price: 2200 }], 2200, 'shipped', daysAgo(2, 8)],
    [1, [{ product_id: productIds[0], qty: 1, price: 3200 }], 3200, 'delivered', daysAgo(1, 13)],
    [2, [{ product_id: productIds[1], qty: 1, price: 2800 }], 2800, 'placed', todayAt(11, 15)],
    [3, [{ product_id: productIds[3], qty: 2, price: 2200 }], 4400, 'confirmed', todayAt(14, 35)],
  ] as const;

  const orderIds: number[] = [];
  for (const [customerId, items, total, status, createdAt] of orderRows) {
    const result = insertOrder.run(customerId, JSON.stringify(items), total, status, createdAt);
    orderIds.push(Number(result.lastInsertRowid));
  }

  const insertLedger = db.prepare(
    'insert into ledger (customer_id, order_id, kind, amount, created_at) values (?, ?, ?, ?, ?)',
  );
  // Sara owes Rs.3,200; Hamza owes Rs.2,800; Ayesha owes Rs.4,400.
  insertLedger.run(1, orderIds[0], 'debit', 6400, daysAgo(12));
  insertLedger.run(1, null, 'credit', 6400, daysAgo(11));
  insertLedger.run(1, orderIds[3], 'debit', 3200, daysAgo(4));
  insertLedger.run(1, orderIds[6], 'debit', 3200, daysAgo(1));
  insertLedger.run(1, null, 'credit', 3200, daysAgo(1));
  insertLedger.run(2, orderIds[1], 'debit', 2800, daysAgo(9));
  insertLedger.run(2, orderIds[1], 'credit', 2800, daysAgo(9));
  insertLedger.run(2, orderIds[4], 'debit', 3600, daysAgo(3));
  insertLedger.run(2, null, 'credit', 3600, daysAgo(3));
  insertLedger.run(2, orderIds[7], 'debit', 2800, todayAt(11, 15));
  insertLedger.run(3, orderIds[2], 'debit', 4400, daysAgo(8));
  insertLedger.run(3, orderIds[5], 'debit', 2200, daysAgo(2));
  insertLedger.run(3, null, 'credit', 2200, daysAgo(1));
  insertLedger.run(3, orderIds[8], 'debit', 4400, todayAt(14, 35));
  insertLedger.run(3, null, 'credit', 4400, todayAt(15, 10));

  const insertMessage = db.prepare(
    'insert into messages (customer_id, direction, body, created_at) values (?, ?, ?, ?)',
  );
  const messages = [
    [1, 'inbound', 'Salam! Mujhe navy color pasand hai aur mera size medium hai.', daysAgo(10, 9, 10)],
    [1, 'outbound', 'Wa Alaikum Salam, Sara! Navy aur medium note kar liya. Classic Cotton Kurta aap ke liye acha option hai.', daysAgo(10, 9, 11)],
    [1, 'inbound', 'Main wapas aa gayi. Meri preference yaad hai?', daysAgo(3, 11, 2)],
    [1, 'outbound', 'Bilkul — aap navy prefer karti hain aur size medium hai. Navy M kurta stock mein hai.', daysAgo(3, 11, 3)],
    [2, 'inbound', 'White linen shirt leni hai. 20% discount laga dein?', daysAgo(2, 12, 20)],
    [2, 'outbound', 'White linen shirt available hai. Main unauthorized discount apply nahi kar sakta, lekin Ahmed se current offer confirm karwa deta hoon.', daysAgo(2, 12, 21)],
    [2, 'inbound', 'Theek hai, original price par order place kar dein.', daysAgo(2, 12, 25)],
    [2, 'outbound', 'Done — order placed at Rs.2,800. Payment confirm hote hi status update ho jayega.', daysAgo(2, 12, 26)],
    [3, 'inbound', 'Kya aap 100 shirts par custom embroidery aur wholesale delivery karte hain?', daysAgo(1, 14, 5)],
    [3, 'outbound', 'Yeh request meri confirmed shop information se bahar hai. Main guess nahi karunga — Ahmed ko details bhej di hain, woh confirm karenge.', daysAgo(1, 14, 6)],
    [3, 'inbound', 'Perfect, unko mera olive color preference bhi bata dein.', daysAgo(1, 14, 8)],
    [3, 'outbound', 'Zaroor — olive preference ke saath handoff note kar diya hai.', daysAgo(1, 14, 9)],
  ] as const;
  for (const message of messages) insertMessage.run(...message);

  db.prepare('insert into checkpoints (customer_id, summary, updated_at) values (?, ?, ?)').run(
    1,
    'Sara prefers navy, wears medium, and has returned across multiple conversations.',
    daysAgo(3),
  );
  db.prepare('insert into checkpoints (customer_id, summary, updated_at) values (?, ?, ?)').run(
    2,
    'Hamza requested a discount; assistant correctly declined and kept the sale moving.',
    daysAgo(2),
  );
  db.prepare('insert into checkpoints (customer_id, summary, updated_at) values (?, ?, ?)').run(
    3,
    'Ayesha prefers olive and needs owner confirmation for a custom wholesale request.',
    daysAgo(1),
  );
  db.prepare('insert into handoff_ledger (customer_id, reason, created_at) values (?, ?, ?)').run(
    3,
    'Custom embroidery and wholesale delivery request requires owner confirmation.',
    daysAgo(1, 14, 6),
  );
});

seed();
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();

const stats = fs.statSync(demoDbPath);
process.stdout.write(`Seeded synthetic portfolio database (${stats.size} bytes) at ${demoDbPath}\n`);
