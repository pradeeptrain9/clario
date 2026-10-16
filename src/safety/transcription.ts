import { distance } from 'fastest-levenshtein';
import type { Signal } from './types.js';
import { confusableAlternatives, extractAmount } from './numberWords.js';
import { logModifiedZ, type LogStats } from './stats.js';

export interface TranscriptMeta {
  text: string;
  confidence?: number;          // Web Speech 0..1
  isFinal?: boolean;
  duringPlayback?: boolean;     // mic opened while we were still speaking
  lastAssistantText?: string;
}
export interface TranscriptContext {
  llmAmount?: number;           // amount the model extracted
  /** Yardstick for "is this amount typical?" — the payee's own stats if usable, else global. */
  amountStats?: LogStats;
}
export interface TranscriptAssessment {
  signals: Signal[];
  /** Do not act on this at all: ask the user to say it again. Never guess. */
  reask?: string;
  heardAmount: number | null;
  alternatives: number[];
}

const DANGLING = /\b(to|the|and|for|a|of|hundred|thousand|million|point|plus|dollars?)\s*$/i;
const SEND_VERBS = /\b(send|pay|transfer|wire)\b/gi;
const similarity = (a: string, b: string) => 1 - distance(a, b) / Math.max(a.length, b.length, 1);

export function assessTranscript(m: TranscriptMeta, ctx: TranscriptContext = {}): TranscriptAssessment {
  const signals: Signal[] = [];
  const text = m.text.trim();
  const parsed = extractAmount(text);
  const heardAmount = parsed ? parsed.value : null;
  const out: TranscriptAssessment = { signals, heardAmount, alternatives: [] };

  if (m.isFinal === false || DANGLING.test(text)) {
    out.reask = 'I think I only caught part of that. Could you say the whole thing again?';
    return out;
  }
  if (m.confidence !== undefined && m.confidence < 0.5) {
    out.reask = 'I am not confident I heard that correctly. Could you say it again, a little slower?';
    return out;
  }
  if ((text.match(SEND_VERBS) ?? []).length >= 2) {
    out.reask = 'That sounded like more than one payment. Let us do them one at a time. What is the first?';
    return out;
  }
  // Mic picking up our own voice.
  if (m.lastAssistantText && text.length >= 12 && similarity(text.toLowerCase(), m.lastAssistantText.toLowerCase().slice(0, text.length)) > 0.75) {
    out.reask = 'I may have heard my own voice. Please say that again.';
    return out;
  }
  if (m.confidence !== undefined && m.confidence < 0.8) {
    signals.push({ code: 'low_confidence', points: 15, minBand: 'medium', digitReadback: true, detail: 'I was not completely sure I heard you correctly.' });
  }
  if (m.duringPlayback) {
    signals.push({ code: 'spoken_during_playback', points: 25, minBand: 'high', detail: 'That was said while I was still talking, so it may not have been you.' });
  }

  // The model and a plain parser must agree on the amount. If they do not, nothing is trusted.
  if (heardAmount !== null && ctx.llmAmount !== undefined && Math.abs(heardAmount - ctx.llmAmount) > 0.005) {
    out.reask = `I understood two different amounts, ${heardAmount} and ${ctx.llmAmount}. Please say the amount again.`;
    return out;
  }

  if (heardAmount !== null) {
    if (heardAmount >= 1000) {
      signals.push({ code: 'large_amount', points: 10, digitReadback: true, minBand: heardAmount >= 10_000 ? 'high' : 'medium',
        detail: 'This is a large amount, so I will spell it out digit by digit.' });
    }
    if (parsed?.spokenMultiplier && heardAmount >= 1000) {
      signals.push({ code: 'magnitude_words', points: 5, digitReadback: true, detail: 'Hundred and thousand are easy to mishear.' });
    }

    const whole = Math.round(heardAmount);
    const alts = Number.isInteger(heardAmount) ? confusableAlternatives(whole) : [];
    out.alternatives = alts;
    if (alts.length) {
      const s = ctx.amountStats;
      const z = (a: number) => (s && s.n ? Math.abs(logModifiedZ(a, s)) : null);
      const zHeard = z(heardAmount);
      const altTypical = alts.find((a) => (z(a) ?? Infinity) < 1.5);
      if (zHeard !== null && zHeard >= 2.5 && altTypical !== undefined) {
        const dir = altTypical < heardAmount ? 'more' : 'less';
        signals.push({ code: 'amount_homophone_suspected', points: 10, minBand: 'medium', digitReadback: true,
          detail: `You said ${heardAmount}, which is ${dir} than usual. It sounds a lot like ${altTypical}, which is what you normally send.` });
      } else {
        signals.push({ code: 'amount_homophone_possible', points: 5, digitReadback: true,
          detail: `${heardAmount} sounds like ${alts[0]}, so I will spell it out.` });
      }
    }
  }
  return out;
}
