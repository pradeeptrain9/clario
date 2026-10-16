import { describe, it, expect } from 'vitest';
import { MockPayPal } from '../../src/mock/adapter.js';

const NOW = new Date('2026-10-16T12:00:00Z');
const maria = { id: 'c_maria', name: 'Maria', email: 'maria.sister@example.com' };

describe('MockPayPal', () => {
  it('is deterministic across instances', async () => {
    const a = await new MockPayPal(() => NOW).listTransactions('2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
    const b = await new MockPayPal(() => NOW).listTransactions('2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(150);
  });

  it('payout is idempotent on the key and debits once', async () => {
    const pp = new MockPayPal(() => NOW);
    const before = (await pp.getBalances())[0]!.available;
    const r1 = await pp.sendPayout({ to: maria, amount: 15, currency: 'USD', note: 'x', idempotencyKey: 'k' });
    const r2 = await pp.sendPayout({ to: maria, amount: 15, currency: 'USD', note: 'x', idempotencyKey: 'k' });
    expect(r2).toEqual(r1);
    expect((await pp.getBalances())[0]!.available).toBe(before - 15);
  });

  it('denies a payout larger than the balance', async () => {
    const pp = new MockPayPal(() => NOW);
    const r = await pp.sendPayout({ to: maria, amount: 999999, currency: 'USD', note: 'x', idempotencyKey: 'big' });
    expect(r.status).toBe('denied');
  });

  it('can cancel an invoice', async () => {
    const pp = new MockPayPal(() => NOW);
    const inv = await pp.createAndSendInvoice({ to: maria, amount: 30, currency: 'USD', note: 'dinner', idempotencyKey: 'i1' });
    await pp.cancelInvoice(inv.id);
    await expect(pp.cancelInvoice('nope')).rejects.toThrow();
  });
});
