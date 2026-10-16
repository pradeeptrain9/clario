import { describe, expect, it } from 'vitest';
import { MockPayPal } from '../../src/mock/adapter.js';
import { Account } from '../../src/session/account.js';
import { DEMO_CONTACTS } from '../../src/mock/dataset.js';
import type { Balance, Contact, PayPalAdapter, Transaction } from '../../src/types.js';

const NOW = new Date('2026-10-16T15:00:00Z');
const maria = DEMO_CONTACTS.find((c) => c.id === 'c_maria')!;

/** An adapter whose reporting we control, standing in for PayPal's lag. */
function stub(txns: Transaction[], available = 1000): PayPalAdapter {
  return {
    kind: 'sandbox',
    getBalances: async (): Promise<Balance[]> => [{ currency: 'USD', available }],
    listTransactions: async () => txns,
    getContacts: async (): Promise<Contact[]> => DEMO_CONTACTS,
    sendPayout: async () => ({ batchId: 'b', status: 'pending' as const }),
    getPayoutStatus: async () => ({ batchId: 'b', status: 'pending' as const }),
    createAndSendInvoice: async () => ({ id: 'i', status: 'SENT', amount: 1, recipientEmail: maria.email }),
  } as unknown as PayPalAdapter;
}

const reported = (over: Partial<Transaction> = {}): Transaction => ({
  id: 'r1', date: NOW.toISOString(), direction: 'out', amount: 30, currency: 'USD',
  counterpartyName: 'Maria', counterpartyEmail: maria.email, description: '', status: 'completed', ...over,
});

describe('Account: covering for PayPal reporting lag', () => {
  it('counts a send PayPal has not reported, in the balance and in history', async () => {
    const a = new Account(stub([]), () => NOW);
    a.recordSend(30, 'c_maria');
    const s = await a.snapshot();
    expect(s.balance).toBe(970);
    expect(s.pendingOut).toBe(30);
    expect(s.history.filter((x) => x.direction === 'out' && x.amount === 30)).toHaveLength(1);
  });

  // The failure that would matter: once PayPal reports the payment, our copy must drop out.
  it('does not count a send twice once PayPal reports it', async () => {
    const a = new Account(stub([reported()]), () => NOW);
    a.recordSend(30, 'c_maria');
    const s = await a.snapshot();
    expect(s.balance).toBe(1000);
    expect(s.pendingOut).toBe(0);
    expect(s.history.filter((x) => x.direction === 'out' && x.amount === 30)).toHaveLength(1);
  });

  it('keeps covering the second of two identical sends when only one is reported', async () => {
    const a = new Account(stub([reported()]), () => NOW);
    a.recordSend(30, 'c_maria');
    a.recordSend(30, 'c_maria');
    const s = await a.snapshot();
    expect(s.pendingOut).toBe(30);
    expect(s.balance).toBe(970);
  });

  it('does not match a report to a different payee', async () => {
    const a = new Account(stub([reported({ counterpartyEmail: 'someone.else@example.com' })]), () => NOW);
    a.recordSend(30, 'c_maria');
    const s = await a.snapshot();
    expect(s.pendingOut).toBe(30);
  });

  it('defers to PayPal for a send older than the lag window', async () => {
    const a = new Account(stub([]), () => NOW);
    a.recordSend(30, 'c_maria');
    a.recentSends[0]!.at = NOW.getTime() - 25 * 3_600_000;
    const s = await a.snapshot();
    expect(s.pendingOut).toBe(0);
    expect(s.balance).toBe(1000);
  });

  it('never reports a negative balance', async () => {
    const a = new Account(stub([], 20), () => NOW);
    a.recordSend(50, 'c_maria');
    const s = await a.snapshot();
    expect(s.balance).toBe(0);
  });

  it('leaves a clean account untouched', async () => {
    const a = new Account(new MockPayPal(() => NOW), () => NOW);
    const s = await a.snapshot();
    expect(s.pendingOut).toBe(0);
  });
});
