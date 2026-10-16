import type { Balance, Contact, InvoiceRef, PayPalAdapter, PayoutResult, Transaction } from '../types.js';
import { DEMO_CONTACTS, buildHistory } from './dataset.js';

/** Seeded, in-memory stand-in for PayPal. Clearly labelled `mock` everywhere it surfaces. */
export class MockPayPal implements PayPalAdapter {
  readonly kind = 'mock' as const;
  private txns: Transaction[];
  private balance = 2480.55;
  private invoices = new Map<string, InvoiceRef>();
  private payouts = new Map<string, PayoutResult>();
  private seenKeys = new Map<string, unknown>();
  private seq = 0;

  constructor(private now: () => Date = () => new Date()) {
    this.txns = buildHistory(this.now());
  }

  async getBalances(): Promise<Balance[]> { return [{ currency: 'USD', available: Math.round(this.balance * 100) / 100 }]; }
  async getContacts(): Promise<Contact[]> { return DEMO_CONTACTS; }

  async listTransactions(fromISO: string, toISO: string): Promise<Transaction[]> {
    return this.txns.filter((t) => t.date >= fromISO && t.date <= toISO);
  }

  async sendPayout(a: { to: Contact; amount: number; currency: string; note: string; idempotencyKey: string }): Promise<PayoutResult> {
    const prior = this.seenKeys.get(a.idempotencyKey) as PayoutResult | undefined;
    if (prior) return prior; // idempotent, like PayPal-Request-Id
    if (a.amount > this.balance) {
      const denied: PayoutResult = { batchId: `MOCKB${++this.seq}`, status: 'denied' };
      this.seenKeys.set(a.idempotencyKey, denied);
      return denied;
    }
    this.balance -= a.amount;
    const res: PayoutResult = { batchId: `MOCKB${++this.seq}`, status: 'success', itemId: `MOCKI${this.seq}` };
    this.payouts.set(res.batchId, res);
    this.seenKeys.set(a.idempotencyKey, res);
    this.txns.unshift({ id: `mock_new_${this.seq}`, date: this.now().toISOString(), direction: 'out', amount: a.amount,
      currency: a.currency, counterpartyName: a.to.name, counterpartyEmail: a.to.email, contactId: a.to.id,
      description: a.note, category: 'friends', status: 'completed' });
    return res;
  }

  async createAndSendInvoice(a: { to: Contact; amount: number; currency: string; note: string; idempotencyKey: string }): Promise<InvoiceRef> {
    const prior = this.seenKeys.get(a.idempotencyKey) as InvoiceRef | undefined;
    if (prior) return prior;
    const inv: InvoiceRef = { id: `MOCK-INV-${String(++this.seq).padStart(4, '0')}`, status: 'SENT',
      amount: a.amount, recipientEmail: a.to.email };
    this.invoices.set(inv.id, inv);
    this.seenKeys.set(a.idempotencyKey, inv);
    return inv;
  }

  async cancelInvoice(invoiceId: string): Promise<void> {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw new Error(`Unknown invoice ${invoiceId}`);
    inv.status = 'CANCELLED';
  }

  async getPayoutStatus(batchId: string): Promise<PayoutResult> {
    return this.payouts.get(batchId) ?? { batchId, status: 'denied' };
  }
}
