import type { ProposedAction } from '../types.js';
import { extractAmount } from '../safety/numberWords.js';

export type Control = Extract<ProposedAction, { kind: 'control' }>['command'];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const CONTROLS: [RegExp, Control][] = [
  [/^(yes|yeah|yep|yup|confirm|correct|go ahead|do it|send it|that is right|that s right)$/, 'yes'],
  [/^(no|nope|nah)$/, 'no'],
  [/^(cancel|abort|never ?mind|forget it|hold on|wait|cancel that|cancel it)$/, 'cancel'],
  [/^(stop|be quiet|quiet|shut up|stop talking)$/, 'stop'],
  [/^(repeat|repeat that|say that again|say again|again|what|pardon|come again)$/, 'repeat'],
  [/^(help|what can you do|what can i say)$/, 'help'],
  [/^(slower|slow down|speak slower|talk slower)$/, 'slower'],
  [/^(faster|speed up|speak faster|talk faster)$/, 'faster'],
];

/**
 * Words that add emphasis or politeness to a yes but carry no payment information. An utterance
 * built only from these plus an affirmative is still a bare yes: "yes go ahead", "yes please".
 */
const AFFIRM_CORE = new Set(['yes', 'yeah', 'yep', 'yup', 'confirm', 'confirmed', 'correct', 'affirmative']);
const AFFIRM_FILLER = new Set([
  'ok', 'okay', 'okey', 'sure', 'please', 'go', 'ahead', 'do', 'it', 'send', 'that', 'is', 's',
  'right', 'now', 'just', 'and', 'then', 'fine', 'alright', 'good', 'thanks', 'thank', 'you', 'all',
]);
/** Anything negative or hesitant in the utterance means we ask again rather than read it as a yes. */
const NEGATIVE = new Set(['no', 'nope', 'nah', 'not', 'dont', 'don', 't', 'cancel', 'stop', 'wait', 'hold', 'never', 'abort']);

/**
 * Whole-utterance match only. "yes send five hundred dollars" is NOT a yes: confirmations must be
 * bare, so extra content can never ride in on one. An utterance made purely of affirmative and
 * filler words is bare in that sense -- there is nothing in it to smuggle.
 */
export function parseControl(text: string): Control | null {
  const t = norm(text);
  for (const [re, cmd] of CONTROLS) if (re.test(t)) return cmd;

  const words = t.split(' ').filter(Boolean);
  if (words.length > 1 && words.length <= 6 && !words.some((w) => NEGATIVE.has(w))
      && words.some((w) => AFFIRM_CORE.has(w))
      && words.every((w) => AFFIRM_CORE.has(w) || AFFIRM_FILLER.has(w))) {
    return 'yes';
  }
  return null;
}

const SEND_VERB = /\b(send|pay|give|transfer|wire|venmo|zelle)\b/;

/** Offline fallback when Gemini is absent or fails. Deliberately conservative: when unsure, say unknown. */
export function ruleParse(text: string): ProposedAction {
  const ctl = parseControl(text);
  if (ctl) return { kind: 'control', command: ctl };

  const t = norm(text);
  const amount = extractAmount(text);

  if (/\bsplit\b/.test(t) && amount) {
    const m = t.match(/\b(?:with|between|among)\s+(.*)$/);
    const payees = (m?.[1] ?? '').replace(/^(me|myself|i)\s+/, '').split(/\s*(?:,|\band\b)\s*/).map((p) => p.trim()).filter((p) => p && !/^(me|myself|i)$/.test(p));
    if (payees.length) return { kind: 'split_bill', total: amount.value, currency: 'USD', payeesSpoken: payees, includeSelf: true };
  }

  // Two payments in one breath: never guess which name goes with which amount.
  if (SEND_VERB.test(t) && (t.match(/\bto\b/g) ?? []).length >= 2 && /\b(and|then|also)\b/.test(t)) {
    return { kind: 'unknown', reason: 'multiple payments' };
  }

  if (SEND_VERB.test(t) && amount) {
    const toIdx = t.search(/\bto\b/);
    const payeeSpoken = toIdx >= 0 ? t.slice(toIdx + 2).replace(/\bfor\b.*$/, '').trim() : t.replace(SEND_VERB, '').trim();
    const forMatch = t.match(/\bfor\s+(.{3,60})$/);
    if (payeeSpoken) return { kind: 'send_money', payeeSpoken, amount: amount.value, currency: 'USD', note: forMatch?.[1] };
  }

  if (/\b(balance|funds|how much (money|cash)?.{0,20}\b(have|got|left|available)|spent|spend|spending|recent|last|latest|history|transactions?|activity)\b/.test(t)) {
    return { kind: 'query', question: text };
  }
  if (/\b(audit|why (was|did)|blocked|what did you (do|block))\b/.test(t)) return { kind: 'review_audit', question: text };

  return { kind: 'unknown', reason: 'no rule matched' };
}
