import express from 'express';
import path from 'node:path';
import { getSalesToday, getTopSellingProduct, getUnpaidCustomers } from './src/analytics';
import { getPendingFollowups } from './src/followups';
import { db } from './src/db';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/health', (_req, res) => {
  const check = db.prepare('select 1 as ok').get() as { ok: number };
  res.json({ ok: check.ok === 1, data: 'synthetic-demo-only', mode: 'read-only' });
});

app.get('/api/summary', (_req, res) => {
  const unpaid = getUnpaidCustomers();
  const topProduct = getTopSellingProduct();
  const pending = getPendingFollowups();
  res.json({
    salesToday: getSalesToday(),
    unpaidCustomers: {
      count: unpaid.length,
      total: unpaid.reduce((sum, customer) => sum + customer.balance_owed, 0),
    },
    topProduct,
    pendingFollowups: pending.length,
  });
});

app.get('/api/orders', (_req, res) => {
  const rows = db
    .prepare(
      `select o.id, c.name as customer, o.items_json, o.total, o.status, o.created_at
       from orders o join customers c on c.id = o.customer_id
       order by o.created_at desc, o.id desc`,
    )
    .all() as Array<{
      id: number;
      customer: string;
      items_json: string;
      total: number;
      status: string;
      created_at: string;
    }>;
  const productNames = new Map(
    (db.prepare('select id, name from products').all() as Array<{ id: number; name: string }>).map((p) => [p.id, p.name]),
  );
  res.json(
    rows.map(({ items_json, ...row }) => ({
      ...row,
      items: (JSON.parse(items_json) as Array<{ product_id: number; qty: number }>).map((item) => ({
        name: productNames.get(item.product_id) ?? 'Product',
        quantity: item.qty,
      })),
    })),
  );
});

app.get('/api/conversations', (_req, res) => {
  const customers = db
    .prepare(
      `select c.id, c.name, cp.summary,
        (select max(m.created_at) from messages m where m.customer_id = c.id) as last_message_at
       from customers c
       join checkpoints cp on cp.customer_id = c.id
       where c.phone like 'DEMO-CUSTOMER-%'
       order by c.id`,
    )
    .all() as Array<{ id: number; name: string; summary: string; last_message_at: string }>;
  res.json(customers);
});

app.get('/api/conversations/:customerId/messages', (req, res) => {
  const customerId = Number(req.params.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    res.status(400).json({ error: 'Invalid demo conversation.' });
    return;
  }
  const customer = db
    .prepare("select id, name from customers where id = ? and phone like 'DEMO-CUSTOMER-%'")
    .get(customerId) as { id: number; name: string } | undefined;
  if (!customer) {
    res.status(404).json({ error: 'Demo conversation not found.' });
    return;
  }
  const messages = db
    .prepare(
      'select id, direction, body, created_at from messages where customer_id = ? order by created_at, id',
    )
    .all(customerId);
  res.json({ customer, messages });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Read-only endpoint not found.' }));

app.listen(port, '0.0.0.0', () => {
  process.stdout.write(`Portfolio demo listening on port ${port}\n`);
});
