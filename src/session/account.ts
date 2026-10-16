import type { RecentSend } from '../safety/behavioral.js';
import type { Balance, Contact, PayPalAdapter, Transaction } from '../types.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface Snapshot { contacts: Contact[]; history: Transaction[]; balances: Balance[]; balance?: number;
  /** Of the balance above, how much is money we sent that PayPal has not reported yet. */
  pendingOut: number }

const YEAR = 365 * 86_400_000;
const CACHE_MS = 30_000;
/**
 * How long we keep covering for a send PayPal has not reported. Sandbox reporting can lag hours and
 * sometimes never catches up at all, so without this a payment we just made is invisible: the balance
 * still reads high and the money looks unspent. Past this window we defer to PayPal, so a send we
 * somehow failed to match can never inflate spending forever.
 */
const REPORTING_LAG_MS = 24 * 3_600_000;

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
    const reported = txns.map((x) => x.contactId || !x.counterpartyEmail ? x : { ...x, contactId: byEmail.get(x.counterpartyEmail.toLowerCase()) });

    // Fold in what we have sent but PayPal has not reported yet, so every answer and every risk
    // check sees the same money. Each send is matched against reported transactions first, so a
    // payment that has come through is never counted twice.
    const unreported = this.unreported(reported, t);
    const owed = unreported.reduce((a, r) => a + r.amount, 0);
    const primary = balances.find((b) => b.currency === 'USD') ?? balances[0];
    const currency = primary?.currency ?? 'USD';
    const pending: Transaction[] = unreported.map((r, i) => ({
      id: `local-${r.at}-${i}`,
      date: new Date(r.at).toISOString(),
      direction: 'out',
      amount: r.amount,
      currency,
      counterpartyName: contacts.find((c) => c.id === r.contactId)?.name ?? 'someone',
      contactId: r.contactId,
      description: 'Sent by Clario, not yet in PayPal reporting',
      status: 'completed',
    }));

    const history = [...pending, ...reported].sort((a, b) => b.date.localeCompare(a.date));
    // Lower the balance by what is already committed: drains_balance is scored against this, so an
    // over-reported balance would make that protection under-fire.
    const adjusted = balances.map((b) => b.currency === currency ? { ...b, available: round2(Math.max(0, b.available - owed)) } : b);
    const snap: Snapshot = { contacts, history, balances: adjusted,
      balance: adjusted.find((b) => b.currency === currency)?.available, pendingOut: round2(owed) };
    this.cache = { at: t, snap };
    return snap;
  }

  /**
   * Sends PayPal has not accounted for yet. A reported transaction claims at most one send, matched
   * on payee and amount near the time we sent it, so a repeated payment of the same amount does not
   * let one report cancel both.
   */
  private unreported(reported: Transaction[], t: number): RecentSend[] {
    const claimed = new Set<number>();
    const out: RecentSend[] = [];
    for (const r of this.recentSends) {
      if (t - r.at > REPORTING_LAG_MS) continue;
      const hit = reported.findIndex((x, i) => !claimed.has(i) && x.direction === 'out'
        && Math.abs(x.amount - r.amount) < 0.005
        && (r.contactId === undefined || x.contactId === r.contactId)
        && Math.abs(Date.parse(x.date) - r.at) <= REPORTING_LAG_MS);
      if (hit >= 0) claimed.add(hit); else out.push(r);
    }
    return out;
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
