import type { Contact, RiskBand, Transaction } from '../types.js';
import { scoreBehavior, type RecentSend } from './behavioral.js';
import { DEFAULT_POLICY, bandFromScore, buildReadback, challengeFor, type Challenge, type Policy, type Readback } from './ladder.js';
import { describeContact, disambiguationQuestion, hasConfusableChars, resolvePayee, type PayeeResolution } from './payeeMatch.js';
import { scanUntrusted } from './injection.js';
import { logStats } from './stats.js';
import { assessTranscript, type TranscriptMeta } from './transcription.js';
import { maxBand, type Signal } from './types.js';

export interface SendInput {
  transcript: TranscriptMeta;
  payeeSpoken: string;
  amount: number;
  currency: string;
  contacts: Contact[];
  history: Transaction[];
  balance?: number;
  now: Date;
  utcOffsetMinutes?: number;
  /** Payments executed through us recently (survives PayPal's ~3h reporting delay). */
  recentSends: RecentSend[];
  /** Total already held in cooling-off but not yet dispatched. */
  pendingTotal?: number;
  policy?: Policy;
  /** Text from the network (memos, names) that rides along with this action. */
  untrusted?: string[];
  /** Set after the user answered "one / two" to a disambiguation prompt. */
  resolvedContactId?: string;
}

export type Assessment =
  | { outcome: 'reask'; say: string }
  | { outcome: 'clarify'; reason: 'ambiguous' | 'suggest' | 'unknown'; say: string; resolution: PayeeResolution }
  | { outcome: 'blocked'; say: string; score: number; signals: Signal[] }
  | {
      outcome: 'ready';
      band: RiskBand; score: number; signals: Signal[];
      payee: Contact; amount: number; currency: string;
      readback: Readback; challenge: Challenge;
      explanation: string;
      /** When the amount may be a sound-alike, ask "lower or higher" rather than "yes or no". */
      amountChoice?: { lower: number; higher: number };
    };

const DAY = 86_400_000;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function assessSend(i: SendInput): Assessment {
  const policy = i.policy ?? DEFAULT_POLICY;
  const t = i.now.getTime();

  // 0. Basic sanity: money must be positive, finite and in whole cents.
  if (!Number.isFinite(i.amount) || i.amount <= 0 || Math.abs(i.amount * 100 - Math.round(i.amount * 100)) > 1e-6) {
    return { outcome: 'reask', say: 'I did not catch a valid amount. Please tell me how much, for example, forty dollars.' };
  }

  // 1. Who? A sound-alike alone never resolves. We ask, using answers that cannot be confused.
  let payee: Contact | undefined;
  let phoneticNeighbour = false;
  let res = resolvePayee(i.payeeSpoken, i.contacts);
  if (i.resolvedContactId) {
    payee = i.contacts.find((c) => c.id === i.resolvedContactId);
    phoneticNeighbour = true;
  } else {
    phoneticNeighbour = res.phoneticNeighbour;
    if (res.status === 'resolved') payee = res.chosen;
    else if (res.status === 'ambiguous') return { outcome: 'clarify', reason: 'ambiguous', resolution: res, say: disambiguationQuestion(res, i.history) };
    else if (res.status === 'suggest') {
      const top = res.candidates[0]!.contact;
      return { outcome: 'clarify', reason: 'suggest', resolution: res,
        say: `I heard ${i.payeeSpoken}. Did you mean ${top.name}, ${describeContact(top, i.history)}? Say yes or no.` };
    } else {
      return { outcome: 'clarify', reason: 'unknown', resolution: res,
        say: `I do not have a saved contact called ${i.payeeSpoken}. For your safety I can only send to saved contacts. Who else could you mean?` };
    }
  }
  if (!payee) return { outcome: 'reask', say: 'I lost track of who that was for. Please start again.' };

  // 2. Hard stop on look-alike characters in the counterparty's name.
  if (hasConfusableChars(payee.name)) {
    return { outcome: 'blocked', score: 100, signals: [],
      say: 'The name on this contact contains look-alike characters, which is a common trick. I will not send to it.' };
  }

  // 3. Transcript risk, judged against what is normal for *this* payee.
  const toPayee = i.history.filter((h) => h.contactId === payee!.id && h.direction === 'out' && h.status === 'completed');
  const payeeStats = logStats(toPayee.map((h) => h.amount));
  const globalStats = logStats(i.history.filter((h) => h.contactId && h.direction === 'out').map((h) => h.amount));
  const tx = assessTranscript(i.transcript, { llmAmount: i.amount, amountStats: payeeStats.n >= 3 ? payeeStats : globalStats });
  if (tx.reask) return { outcome: 'reask', say: tx.reask };

  // 4. Behaviour against history.
  const beh = scoreBehavior({ amount: i.amount, payee, history: i.history, balance: i.balance, now: i.now,
    utcOffsetMinutes: i.utcOffsetMinutes, recentSends: i.recentSends });

  const signals: Signal[] = [...tx.signals, ...beh.signals];
  if (phoneticNeighbour) {
    signals.push({ code: 'sound_alike_contact', points: 5, minBand: 'medium', digitReadback: true,
      detail: `${payee.name} sounds like another of your contacts, so I will say who they are.` });
  }

  // 5. Untrusted text riding along (memos etc.) can only ever add friction.
  const flagged = (i.untrusted ?? []).map(scanUntrusted).filter((s) => s.suspicious);
  if (flagged.length) {
    signals.push({ code: 'suspicious_text', points: 30, minBand: 'high',
      detail: 'A note attached to this contained text that looks like instructions.' });
  }

  // 6. Hard limits. These are vetoes, not weights.
  const historySum = sum(i.history.filter((h) => h.direction === 'out' && h.contactId && t - Date.parse(h.date) <= DAY).map((h) => h.amount));
  const recentSum = sum(i.recentSends.filter((r) => t - r.at <= DAY).map((r) => r.amount));
  const dailyTotal = Math.max(historySum, recentSum) + (i.pendingTotal ?? 0);
  if (i.amount > policy.maxSingle) {
    return { outcome: 'blocked', score: 100, signals,
      say: `That is above your safety limit of ${policy.maxSingle} dollars for a single payment. I have not sent anything.` };
  }
  if (dailyTotal + i.amount > policy.dailyLimit) {
    return { outcome: 'blocked', score: 100, signals,
      say: `That would take you past your daily safety limit of ${policy.dailyLimit} dollars. I have not sent anything.` };
  }

  // 7. Score and band. Floors can raise friction; nothing here can lower it.
  const score = Math.min(100, signals.reduce((a, s) => a + s.points, 0));
  const band = maxBand(bandFromScore(score), 'low', ...signals.flatMap((s) => (s.minBand ? [s.minBand] : [])));
  if (band === 'blocked') {
    return { outcome: 'blocked', score, signals, say: `I am not going to send this. ${explain(signals)} Nothing has been sent.` };
  }

  const digit = signals.some((s) => s.digitReadback) || band === 'medium' || band === 'high' || band === 'severe';
  const readback = buildReadback({ kind: 'send', amount: i.amount, currency: i.currency, payeeName: payee.name,
    payeeDescription: payee.relationship ? payee.relationship : undefined, digit, alternatives: tx.alternatives });

  const suspected = signals.some((s) => s.code === 'amount_homophone_suspected');
  const alt = tx.alternatives[0];
  const amountChoice = suspected && alt !== undefined
    ? { lower: Math.min(i.amount, alt), higher: Math.max(i.amount, alt) } : undefined;

  return { outcome: 'ready', band, score, signals, payee, amount: i.amount, currency: i.currency,
    readback, challenge: challengeFor(band, policy), explanation: explain(signals), amountChoice };
}

/** Top reasons, in plain speech, strongest first. Only deterministic facts. */
export function explain(signals: Signal[]): string {
  const top = [...signals].filter((s) => s.points > 0 || s.minBand).sort((a, b) => b.points - a.points).slice(0, 2);
  return top.map((s) => s.detail).join(' ');
}
