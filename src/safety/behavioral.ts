import type { Contact, Transaction } from '../types.js';
import type { Signal } from './types.js';
import { logModifiedZ, logStats, typicalAmount, type LogStats } from './stats.js';

export interface RecentSend { at: number; amount: number; contactId?: string }
export interface BehaviorInput {
  amount: number;
  payee?: Contact;
  history: Transaction[];
  balance?: number;
  now: Date;
  utcOffsetMinutes?: number;
  recentSends: RecentSend[];
}
export interface BehaviorResult {
  signals: Signal[];
  payee: LogStats; global: LogStats;
  zPayee: number | null; zGlobal: number | null;
  typicalForPayee: number | null;
  newPayee: boolean;
}

export const THIN_HISTORY = 8;      // below this we don't trust our own statistics
export const PAYEE_MIN = 3;         // payments to a payee before its own history is usable

const p2p = (h: Transaction[]) => h.filter((t) => t.direction === 'out' && t.status === 'completed' && t.contactId);

export function scoreBehavior(i: BehaviorInput): BehaviorResult {
  const signals: Signal[] = [];
  const sent = p2p(i.history);
  const toPayee = i.payee ? sent.filter((t) => t.contactId === i.payee!.id) : [];
  const global = logStats(sent.map((t) => t.amount));
  const payee = logStats(toPayee.map((t) => t.amount));
  const newPayee = !!i.payee && toPayee.length === 0;
  const thin = sent.length < THIN_HISTORY;

  // Which yardstick applies: the payee's own history if usable, else the user's global one.
  const zPayee = payee.n >= PAYEE_MIN ? logModifiedZ(i.amount, payee) : null;
  const zGlobal = !thin ? logModifiedZ(i.amount, global) : null;
  const z = zPayee ?? zGlobal;

  if (newPayee) signals.push({ code: 'new_payee', points: 20, minBand: 'medium', detail: 'You have never paid this person before.' });

  if (z !== null && z > 1.5) {
    const ref = zPayee !== null ? `what you usually send ${i.payee!.name}` : 'what you usually send people';
    const typ = zPayee !== null ? typicalAmount(payee) : typicalAmount(global);
    const detail = `That is much more than ${ref}, which is around ${Math.round(typ)} dollars.`;
    if (z >= 3.5) signals.push({ code: 'amount_outlier', points: 30, minBand: 'medium', detail });
    else if (z >= 2.5) signals.push({ code: 'amount_unusual', points: 20, detail });
    else signals.push({ code: 'amount_elevated', points: 8, detail });
  }

  // The classic account-takeover / scam shape: someone new, and a lot.
  if (newPayee && ((zGlobal ?? 0) >= 2.5 || (thin && i.amount >= 100))) {
    signals.push({ code: 'new_payee_high_amount', points: 25, minBand: 'high', detail: 'A first payment to a new person, for more than you normally send.' });
  }

  // Cold start: with little history we cannot call anything normal, so we add friction, not remove it.
  if (thin) {
    signals.push({ code: 'thin_history', points: 15, detail: 'I do not know your spending habits well yet, so I am being extra careful.' });
    if (i.amount >= 500) signals.push({ code: 'thin_history_large', points: 25, minBand: 'high', detail: 'This is a large amount and I have little history to compare it to.' });
    else if (i.amount >= 100) signals.push({ code: 'thin_history_sizeable', points: 10, minBand: 'medium', detail: 'This is a sizeable amount and I have little history to compare it to.' });
  }

  // Velocity: bursts of sends are how takeover drains an account.
  const t = i.now.getTime();
  const within = (ms: number) => i.recentSends.filter((r) => t - r.at <= ms).length;
  if (within(10 * 60_000) >= 3) signals.push({ code: 'velocity_burst', points: 30, minBand: 'high', detail: 'That would be your fourth payment in ten minutes.' });
  else if (within(2 * 60_000) >= 2) signals.push({ code: 'velocity_fast', points: 15, detail: 'You have sent several payments in the last two minutes.' });

  // Escalation to the same person: 20 -> 40 -> 90.
  const same = i.payee ? i.recentSends.filter((r) => r.contactId === i.payee!.id).slice(-2) : [];
  if (same.length === 2 && same[1]!.amount >= same[0]!.amount * 1.5 && i.amount >= same[1]!.amount * 1.5) {
    signals.push({ code: 'escalating_amounts', points: 25, minBand: 'high', detail: 'Each payment to this person has been larger than the last.' });
  }

  // Unusual hour (user-local).
  const localHour = (((i.now.getUTCHours() * 60 + i.now.getUTCMinutes() + (i.utcOffsetMinutes ?? 0)) / 60) % 24 + 24) % 24;
  if (localHour >= 1 && localHour < 5) signals.push({ code: 'unusual_hour', points: 10, detail: 'It is the middle of the night, when you rarely make payments.' });

  if (i.amount >= 500 && i.amount % 100 === 0 && ((z ?? 0) > 1.5 || newPayee)) {
    signals.push({ code: 'round_number_spike', points: 10, detail: 'A large round number is a common pattern in scams.' });
  }

  if (i.balance && i.balance > 0) {
    const frac = i.amount / i.balance;
    if (frac >= 0.9) signals.push({ code: 'drains_balance', points: 30, minBand: 'high', detail: 'This would take almost everything in your account.' });
    else if (frac >= 0.5) signals.push({ code: 'large_share_of_balance', points: 15, detail: 'This is more than half of your balance.' });
  }

  return { signals, payee, global, zPayee, zGlobal, newPayee,
    typicalForPayee: payee.n >= PAYEE_MIN ? typicalAmount(payee) : null };
}
