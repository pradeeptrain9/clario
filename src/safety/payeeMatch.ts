import { doubleMetaphone } from 'double-metaphone';
import { distance } from 'fastest-levenshtein';
import type { Contact, Transaction } from '../types.js';

export interface PayeeCandidate { contact: Contact; score: number; reasons: string[] }
export interface PayeeResolution {
  status: 'resolved' | 'ambiguous' | 'suggest' | 'unknown';
  chosen?: Contact;
  candidates: PayeeCandidate[];
  /** True when the chosen contact has a sound-alike neighbour (even if we could tell them apart). */
  phoneticNeighbour: boolean;
}

const STOP = new Set(['my', 'the', 'a', 'to', 'for', 'and', 'send', 'pay', 'money', 'please', 'dollars', 'bucks', 'from', 'of', 'm', 'is']);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** Score one spoken token against a contact's name. Phonetic collisions score flat, not by edit distance. */
function nameScore(token: string, name: string): { score: number; reason: string } {
  const n = norm(name);
  if (token === n) return { score: 1.0, reason: 'exact name' };
  const [tp, ts] = doubleMetaphone(token);
  const [np, ns] = doubleMetaphone(n);
  if (tp && tp === np) return { score: 0.8, reason: 'sounds the same' };
  if ((ts && (ts === np || ts === ns)) || (tp && tp === ns)) return { score: 0.7, reason: 'sounds similar' };
  const d = distance(token, n);
  if (d <= 2 && Math.max(token.length, n.length) >= 4) return { score: 0.6 - 0.1 * d, reason: 'spelled similarly' };
  return { score: 0, reason: '' };
}

export function resolvePayee(spoken: string, contacts: Contact[]): PayeeResolution {
  const tokens = norm(spoken).split(' ').filter((t) => t && !STOP.has(t));
  const scored: PayeeCandidate[] = contacts.map((contact) => {
    let best = { score: 0, reason: '' };
    for (const t of tokens) {
      const s = nameScore(t, contact.name);
      if (s.score > best.score) best = s;
    }
    const reasons = best.reason ? [best.reason] : [];
    const relWords = norm(contact.relationship ?? '').split(' ').filter((w) => w && !STOP.has(w));
    const relHit = tokens.some((t) => relWords.includes(t));
    let score = best.score;
    if (relHit) { score = Math.min(1.25, (score || 0.9) + 0.25); reasons.push('relationship matches'); }
    return { contact, score, reasons };
  }).filter((c) => c.score >= 0.4).sort((a, b) => b.score - a.score);

  if (!scored.length) return { status: 'unknown', candidates: [], phoneticNeighbour: false };

  const [top, second] = scored;
  const ambiguous = !!second && second.score >= 0.7 && top!.score - second.score < 0.3;
  const phoneticNeighbour = !!second && second.score >= 0.7;

  if (ambiguous) return { status: 'ambiguous', candidates: scored.slice(0, 3), phoneticNeighbour: true };
  // Only an exact name (or a relationship match) may resolve. A sound-alike alone is a question, not a decision.
  if (top!.score < 0.95) return { status: 'suggest', candidates: scored.slice(0, 2), phoneticNeighbour };
  return { status: 'resolved', chosen: top!.contact, candidates: scored.slice(0, 3), phoneticNeighbour };
}

/** A spoken fact that tells two similar-sounding contacts apart by something other than their name. */
export function describeContact(c: Contact, history: Transaction[]): string {
  const paid = history.filter((t) => t.contactId === c.id && t.direction === 'out' && t.status === 'completed');
  const bits: string[] = [];
  if (c.relationship) bits.push(c.relationship);
  const last = paid[0];
  if (last) {
    const days = Math.max(0, Math.round((Date.now() - Date.parse(last.date)) / 86_400_000));
    bits.push(`last paid ${Math.round(last.amount)} dollars ${days <= 1 ? 'recently' : `${days} days ago`}`);
  } else bits.push('you have never paid them');
  return bits.join(', ');
}

export function disambiguationQuestion(res: PayeeResolution, history: Transaction[]): string {
  const opts = res.candidates.filter((c) => c.score >= 0.7).slice(0, 3);
  const ordinals = ['One', 'Two', 'Three'];
  const lines = opts.map((c, i) => `${ordinals[i]}: ${c.contact.name}, ${describeContact(c.contact, history)}.`);
  // Answers are "one"/"two"/"neither" — sounds that cannot be confused with each other the way
  // Jon/John can. Repeating a name back through the same lossy channel would prove nothing.
  return `Two people sound alike. ${lines.join(' ')} Say ${opts.map((_, i) => ordinals[i]!.toLowerCase()).join(', ')}, or neither.`;
}

/** Map a spoken answer to a disambiguation prompt onto one of the offered candidates. */
export function pickDisambiguated(answer: string, res: PayeeResolution): Contact | 'neither' | null {
  const a = norm(answer);
  if (/\b(neither|none|no one|nobody|cancel)\b/.test(a)) return 'neither';
  const words: [RegExp, number][] = [[/\b(one|1|first)\b/, 0], [/\b(two|2|to|too|second)\b/, 1], [/\b(three|3|third)\b/, 2]];
  const hits = words.filter(([re]) => re.test(a)).map(([, i]) => i);
  if (hits.length === 1 && res.candidates[hits[0]!]) return res.candidates[hits[0]!]!.contact;
  return null; // unclear or contradictory: ask again, never guess
}

/** Names containing look-alike characters ("PayPaI", Cyrillic "а") sound identical but are different strings. */
export function hasConfusableChars(name: string): boolean {
  const hasNonAscii = /[^\x00-\x7F]/.test(name);
  const hasAsciiLetter = /[A-Za-z]/.test(name);
  // Capital I inside a word reads aloud exactly like lowercase l ("PayPaI"). Real names like "McIntosh" also trip
  // this; that false positive only costs extra caution about a counterparty name, which is the safe direction.
  const mixedCaseI = /[a-z]I/.test(name) || /[a-z]l[A-Z]/.test(name);
  return (hasNonAscii && hasAsciiLetter) || mixedCaseI || /[\u200B-\u200F\u202A-\u202E\uFEFF]/.test(name);
}
