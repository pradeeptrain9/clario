import { readFile } from 'node:fs/promises';
import { PayPalClient } from './client.js';
import { DEMO_CONTACTS } from '../mock/dataset.js';
import type { Balance, Contact, InvoiceRef, PayPalAdapter, PayoutResult, Transaction } from '../types.js';

const DAY = 86_400_000;
const WINDOW_DAYS = 31; // Transaction Search hard limit per request

interface RawTxn {
  transaction_info: {
    transaction_id: string; transaction_initiation_date: string; transaction_status?: string;
    transaction_amount: { currency_code: string; value: string }; transaction_subject?: string; transaction_note?: string;
  };
  payer_info?: { email_address?: string; payer_name?: { alternate_full_name?: string } };
}

export class SandboxPayPal implements PayPalAdapter {
  readonly kind = 'sandbox' as const;
  constructor(private c: PayPalClient, private contactsPath = 'data/contacts.json') {}

  async getBalances(): Promise<Balance[]> {
    const r = await this.c.request<{ balances?: { currency: string; total_balance?: { value: string }; available_balance?: { value: string } }[] }>(
      'GET', '/v1/reporting/balances', { query: { as_of_time: new Date().toISOString(), currency_code: 'ALL' } });
    return (r.balances ?? []).map((b) => ({ currency: b.currency, available: Number((b.available_balance ?? b.total_balance)?.value ?? 0) }));
  }

  /** Splits any range into <=31-day windows (a PayPal hard limit) and pages through each. */
  async listTransactions(fromISO: string, toISO: string): Promise<Transaction[]> {
    const out: Transaction[] = [];
    const end = Date.parse(toISO);
    for (let start = Date.parse(fromISO); start < end; start += WINDOW_DAYS * DAY) {
      const winEnd = Math.min(end, start + WINDOW_DAYS * DAY - 1000);
      for (let page = 1, pages = 1; page <= pages; page++) {
        const r = await this.c.request<{ transaction_details?: RawTxn[]; total_pages?: number }>('GET', '/v1/reporting/transactions', {
          query: { start_date: new Date(start).toISOString(), end_date: new Date(winEnd).toISOString(), fields: 'transaction_info,payer_info', page_size: 500, page },
        });
        pages = r.total_pages ?? 1;
        for (const d of r.transaction_details ?? []) out.push(mapTxn(d));
      }
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }

  /** PayPal has no contacts API. A local file maps spoken names to sandbox emails. */
  async getContacts(): Promise<Contact[]> {
    try { return JSON.parse(await readFile(this.contactsPath, 'utf8')) as Contact[]; } catch { return DEMO_CONTACTS; }
  }

  async sendPayout(a: { to: Contact; amount: number; currency: string; note: string; idempotencyKey: string }): Promise<PayoutResult> {
    const r = await this.c.request<{ batch_header: { payout_batch_id: string; batch_status: string } }>('POST', '/v1/payments/payouts', {
      requestId: a.idempotencyKey,
      body: {
        sender_batch_header: { sender_batch_id: a.idempotencyKey, email_subject: 'You received a payment', email_message: a.note },
        items: [{ recipient_type: 'EMAIL', receiver: a.to.email, amount: { value: a.amount.toFixed(2), currency: a.currency },
          note: a.note, sender_item_id: `${a.idempotencyKey}-1` }],
      },
    });
    return { batchId: r.batch_header.payout_batch_id, status: mapBatch(r.batch_header.batch_status) };
  }

  async getPayoutStatus(batchId: string): Promise<PayoutResult> {
    const r = await this.c.request<{ batch_header: { batch_status: string } }>('GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
    return { batchId, status: mapBatch(r.batch_header.batch_status) };
  }

  async createAndSendInvoice(a: { to: Contact; amount: number; currency: string; note: string; idempotencyKey: string }): Promise<InvoiceRef> {
    const num = await this.c.request<{ invoice_number: string }>('POST', '/v2/invoicing/generate-next-invoice-number');
    const draft = await this.c.request<{ href: string }>('POST', '/v2/invoicing/invoices', {
      requestId: a.idempotencyKey,
      body: {
        detail: { invoice_number: num.invoice_number, currency_code: a.currency, note: a.note, invoice_date: new Date().toISOString().slice(0, 10) },
        primary_recipients: [{ billing_info: { email_address: a.to.email } }],
        items: [{ name: a.note.slice(0, 100) || 'Shared expense', quantity: '1', unit_amount: { currency_code: a.currency, value: a.amount.toFixed(2) } }],
      },
    });
    const id = draft.href.split('/').pop()!;
    await this.c.request('POST', `/v2/invoicing/invoices/${id}/send`, { body: { send_to_recipient: true } });
    return { id, status: 'SENT', amount: a.amount, recipientEmail: a.to.email };
  }

  async cancelInvoice(invoiceId: string): Promise<void> {
    await this.c.request('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/cancel`, { body: { send_to_recipient: true, send_to_invoicer: false } });
  }
}

function mapBatch(s: string): PayoutResult['status'] {
  if (s === 'SUCCESS') return 'success';
  if (s === 'DENIED' || s === 'CANCELED') return 'denied';
  return 'pending';
}

function mapTxn(d: RawTxn): Transaction {
  const i = d.transaction_info;
  const value = Number(i.transaction_amount.value);
  const st = i.transaction_status;
  return {
    id: i.transaction_id, date: i.transaction_initiation_date,
    direction: value < 0 ? 'out' : 'in', amount: Math.abs(value), currency: i.transaction_amount.currency_code,
    counterpartyName: d.payer_info?.payer_name?.alternate_full_name ?? d.payer_info?.email_address ?? 'Unknown',
    counterpartyEmail: d.payer_info?.email_address,
    description: i.transaction_subject ?? i.transaction_note ?? '',
    status: st === 'S' ? 'completed' : st === 'P' ? 'pending' : st === 'V' ? 'cancelled' : 'failed',
  };
}
