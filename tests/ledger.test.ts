import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db';
import { getBalance, recordCredit, recordDebit } from '../src/ledger';

describe('Double-Entry Ledger Accounting', () => {
  let customerA: number;
  let customerB: number;
  let orderA: number;
  let orderB: number;

  before(() => {
    const custA = db.prepare('insert into customers (phone, name) values (?, ?)').run(`test-ledger-a-${Date.now()}`, 'Alice');
    customerA = custA.lastInsertRowid as number;

    const ordA = db.prepare('insert into orders (customer_id, items_json, total, status) values (?, ?, ?, ?)').run(customerA, '[]', 5000, 'placed');
    orderA = ordA.lastInsertRowid as number;

    const custB = db.prepare('insert into customers (phone, name) values (?, ?)').run(`test-ledger-b-${Date.now()}`, 'Bob');
    customerB = custB.lastInsertRowid as number;

    const ordB = db.prepare('insert into orders (customer_id, items_json, total, status) values (?, ?, ?, ?)').run(customerB, '[]', 10000, 'placed');
    orderB = ordB.lastInsertRowid as number;
  });

  after(() => {
    db.prepare('delete from ledger where customer_id in (?, ?)').run(customerA, customerB);
    db.prepare('delete from orders where id in (?, ?)').run(orderA, orderB);
    db.prepare('delete from customers where id in (?, ?)').run(customerA, customerB);
  });

  it('returns balance = 0 for a brand new customer', () => {
    assert.equal(getBalance(customerA), 0);
  });

  it('correctly increments balance upon recording a debit', () => {
    recordDebit(customerA, orderA, 5000);
    assert.equal(getBalance(customerA), 5000);
  });

  it('correctly decrements balance upon recording a credit (payment)', () => {
    recordCredit(customerA, 2000);
    assert.equal(getBalance(customerA), 3000);

    recordCredit(customerA, 3000);
    assert.equal(getBalance(customerA), 0);
  });

  it('supports negative balance if customer overpays (store credit)', () => {
    recordCredit(customerA, 500);
    assert.equal(getBalance(customerA), -500);
  });

  it('strictly isolates balances between different customers', () => {
    // Customer B has no debits yet
    assert.equal(getBalance(customerB), 0);

    recordDebit(customerB, orderB, 10000);
    assert.equal(getBalance(customerB), 10000);

    // Customer A remains at -500
    assert.equal(getBalance(customerA), -500);
  });
});
