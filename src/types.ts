export type Money = { currency: string; value: number }; // value in major units, e.g. 40.00

export interface Contact {
  id: string;
  name: string;           // as the user says it
  email: string;          // PayPal receiver
  relationship?: string;  // "landlord", "sister" — used to disambiguate by voice
}

export type TxnDirection = 'out' | 'in';

export interface Transaction {
  id: string;
  date: string;           // ISO 8601
  direction: TxnDirection;
  amount: number;         // positive major units
  currency: string;
  counterpartyName: string;
  counterpartyEmail?: string;
  contactId?: string;
  description: string;    // UNTRUSTED: comes from the counterparty
  category?: string;
  status: 'completed' | 'pending' | 'failed' | 'cancelled';
}

export interface Balance { currency: string; available: number }

export interface PayoutResult { batchId: string; status: 'pending' | 'success' | 'denied'; itemId?: string }
export interface InvoiceRef { id: string; status: string; amount: number; recipientEmail: string; url?: string }

/** Everything the assistant needs from PayPal. Real client and mock both implement this. */
export interface PayPalAdapter {
  readonly kind: 'sandbox' | 'mock';
  getBalances(): Promise<Balance[]>;
  listTransactions(fromISO: string, toISO: string): Promise<Transaction[]>;
  getContacts(): Promise<Contact[]>;
  sendPayout(args: { to: Contact; amount: number; currency: string; note: string; idempotencyKey: string }): Promise<PayoutResult>;
  createAndSendInvoice(args: { to: Contact; amount: number; currency: string; note: string; idempotencyKey: string }): Promise<InvoiceRef>;
  cancelInvoice(invoiceId: string): Promise<void>;
  getPayoutStatus(batchId: string): Promise<PayoutResult>;
}

/** What the model is allowed to *propose*. It can never execute these. */
export type ProposedAction =
  | { kind: 'send_money'; payeeSpoken: string; amount: number; currency: string; note?: string }
  | { kind: 'split_bill'; total: number; currency: string; payeesSpoken: string[]; includeSelf: boolean; note?: string }
  | { kind: 'query'; question: string }       // balance / spending / status — read only
  | { kind: 'review_audit'; question: string }
  | { kind: 'control'; command: 'repeat' | 'stop' | 'slower' | 'faster' | 'help' | 'cancel' | 'yes' | 'no' }
  | { kind: 'unknown'; reason: string };

export type RiskBand = 'read' | 'low' | 'medium' | 'high' | 'severe' | 'blocked';
