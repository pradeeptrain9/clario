import type { RecentSend } from '../safety/behavioral.js';
import type { Balance, Contact, PayPalAdapter, Transaction } from '../types.js';

export interface Snapshot { contacts: Contact[]; history: Transaction[]; balances: Balance[]; balance?: number }

const YEAR = 365 * 86_400_000;
const CACHE_MS = 30_000;

/**
 * State that belongs to the PayPal account, not to one browser session: what we recently sent
 * (PayPal reporting lags ~3h) and what is sitting in a cooling-off hold. Shared by every session
 * so opening a second tab cannot dodge the daily limit.
 */
export class Account {
  readonly recentSends: RecentSend[] = [];
  private holds = new Map<string, number>();
  private cache: { at: number; snap: Snapshot } | null = null;

  constructor(readonly adapter: PayPalAdapter, private now: () => Date = () => new Date()) {}

  async snapshot(): Promise<Snapshot> {
    const t = this.now().getTime();
    if (this.cache && t - this.cache.at < CACHE_MS) return this.cache.snap;
    const [contacts, txns, balances] = await Promise.all([
      this.adapter.getContacts(),
      this.adapter.listTransactions(new Date(t - YEAR).toISOString(), new Date(t).toISOString()),
      this.adapter.getBalances(),
    ]);
    // PayPal's reporting API has no notion of our saved contacts: link by email so per-payee history works.
    const byEmail = new Map(contacts.map((c) => [c.email.toLowerCase(), c.id]));
    const history = txns.map((x) => x.contactId || !x.counterpartyEmail ? x : { ...x, contactId: byEmail.get(x.counterpartyEmail.toLowerCase()) });
    const usd = balances.find((b) => b.currency === 'USD') ?? balances[0];
    const snap: Snapshot = { contacts, history, balances, balance: usd?.available };
    this.cache = { at: t, snap };
    return snap;
  }

  invalidate() { this.cache = null; }

  recordSend(amount: number, contactId?: string) {
    this.recentSends.push({ at: this.now().getTime(), amount, contactId });
    this.invalidate();
  }

  hold(id: string, amount: number) { this.holds.set(id, amount); }
  release(id: string) { this.holds.delete(id); }
  get pendingTotal() { return [...this.holds.values()].reduce((a, b) => a + b, 0); }
  get hasHolds() { return this.holds.size > 0; }
}
