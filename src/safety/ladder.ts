import type { RiskBand } from '../types.js';
import { digitsSpelled, moneyToWords, numberToWords } from './numberWords.js';

export interface Policy {
  maxSingle: number;          // hard ceiling for one payment
  dailyLimit: number;         // hard ceiling for the rolling 24h total
  coolingOffSeconds: number;  // hold window for 'severe'
}
export const DEFAULT_POLICY: Policy = { maxSingle: 2500, dailyLimit: 5000, coolingOffSeconds: 60 };

/** Score → friction band for money leaving the account. Never below 'low': nothing leaves silently. */
export function bandFromScore(score: number): RiskBand {
  if (score < 20) return 'low';
  if (score < 45) return 'medium';
  if (score < 70) return 'high';
  if (score < 90) return 'severe';
  return 'blocked';
}

export type Step =
  | { kind: 'confirm_yes' }
  | { kind: 'passphrase' }
  | { kind: 'cooling_off'; seconds: number };

export interface Challenge { band: RiskBand; steps: Step[]; earcon: RiskBand }

export function challengeFor(band: RiskBand, policy: Policy = DEFAULT_POLICY): Challenge {
  const steps: Step[] =
    band === 'read' || band === 'blocked' ? [] :
    band === 'low' || band === 'medium' ? [{ kind: 'confirm_yes' }] :
    band === 'high' ? [{ kind: 'confirm_yes' }, { kind: 'passphrase' }] :
    [{ kind: 'confirm_yes' }, { kind: 'passphrase' }, { kind: 'cooling_off', seconds: policy.coolingOffSeconds }];
  return { band, steps, earcon: band };
}

export interface ReadbackInput {
  kind: 'send' | 'invoice';
  amount: number; currency: string;
  payeeName: string; payeeDescription?: string;
  digit: boolean;             // spell the amount digit by digit
  alternatives: number[];     // sound-alike amounts to explicitly rule out
}
export interface Readback { plain: string; spelled?: string; clarification?: string; full: string }

export function buildReadback(r: ReadbackInput): Readback {
  const words = moneyToWords(r.amount, r.currency);
  const who = r.payeeDescription ? `${r.payeeName}, ${r.payeeDescription}` : r.payeeName;
  const plain = r.kind === 'send' ? `Send ${words} to ${who}.` : `Request ${words} from ${who}.`;

  let spelled: string | undefined;
  if (r.digit) {
    const whole = Math.floor(r.amount), cents = Math.round((r.amount - whole) * 100);
    spelled = `That is ${digitsSpelled(whole)} dollars` + (cents ? ` and ${digitsSpelled(cents)} cents` : ', and no cents') + '.';
  }
  let clarification: string | undefined;
  if (r.alternatives.length) {
    const alt = r.alternatives[0]!;
    clarification = `Note: ${numberToWords(Math.floor(r.amount))}, not ${numberToWords(alt)}. ` +
      `${digitsSpelled(Math.floor(r.amount))}, not ${digitsSpelled(alt)}.`;
  }
  return { plain, spelled, clarification, full: [plain, spelled, clarification].filter(Boolean).join(' ') };
}

/** What we say after the readback, per step. */
export function promptFor(step: Step): string {
  switch (step.kind) {
    case 'confirm_yes': return 'Say yes to go ahead, or no to cancel.';
    case 'passphrase': return 'To protect you, please say your passphrase.';
    case 'cooling_off': return `I will hold this for ${step.seconds} seconds before sending. Say cancel at any time to stop it.`;
  }
}
