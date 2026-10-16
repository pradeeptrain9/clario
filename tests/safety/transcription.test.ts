import { describe, it, expect } from 'vitest';
import { assessTranscript } from '../../src/safety/transcription.js';
import { logStats } from '../../src/safety/stats.js';

const mariaStats = logStats([15, 15, 14, 16, 15, 15, 15, 14, 15, 16]);
const codes = (a: ReturnType<typeof assessTranscript>) => a.signals.map((s) => s.code);

describe('assessTranscript — the voice-specific failure modes', () => {
  it('"fifty" to someone you always pay fifteen is a suspected mishearing', () => {
    const a = assessTranscript({ text: 'send fifty dollars to Maria', confidence: 0.95, isFinal: true }, { amountStats: mariaStats });
    expect(codes(a)).toContain('amount_homophone_suspected');
    const s = a.signals.find((x) => x.code === 'amount_homophone_suspected')!;
    expect(s.minBand).toBe('medium'); expect(s.digitReadback).toBe(true); expect(s.detail).toMatch(/fifteen|15/);
  });
  it('the usual fifteen is only a possible confusion (spelled out, no extra band)', () => {
    const a = assessTranscript({ text: 'send fifteen dollars to Maria', confidence: 0.95, isFinal: true }, { amountStats: mariaStats });
    expect(codes(a)).toEqual(['amount_homophone_possible']); expect(a.signals[0]!.minBand).toBeUndefined();
  });
  it('digits from the recognizer are checked just like words', () => {
    expect(codes(assessTranscript({ text: 'send $50 to Maria', confidence: 0.95, isFinal: true }, { amountStats: mariaStats }))).toContain('amount_homophone_suspected');
  });
  it('$50 is fine when $50 is what you normally send', () => {
    const fifties = logStats([50, 50, 45, 50, 55]);
    expect(codes(assessTranscript({ text: 'send fifty dollars to Priya', confidence: 0.95, isFinal: true }, { amountStats: fifties }))).toEqual(['amount_homophone_possible']);
  });
  it('a number with no teen/ty twin raises nothing', () => {
    expect(assessTranscript({ text: 'send twenty five dollars to Maria', confidence: 0.95, isFinal: true }, { amountStats: mariaStats }).signals).toEqual([]);
  });
  it('large amounts are read digit by digit', () => {
    const a = assessTranscript({ text: 'send fifteen hundred dollars to Jon', confidence: 0.95, isFinal: true });
    expect(a.signals.some((s) => s.code === 'large_amount' && s.digitReadback)).toBe(true);
  });
  it('$10,000+ is at least high', () => {
    expect(assessTranscript({ text: 'send ten thousand dollars to Jon', confidence: 0.95, isFinal: true }).signals.find((s) => s.code === 'large_amount')!.minBand).toBe('high');
  });

  describe('refuses to guess', () => {
    it.each([
      ['send fifty dollars to', 'dangling "to"'],
      ['send two hundred', 'dangling "hundred"'],
      ['send fifty dollars and', 'dangling "and"'],
    ])('truncated: %s (%s)', (text) => expect(assessTranscript({ text, confidence: 0.95, isFinal: true }).reask).toMatch(/part of that/));
    it('non-final result', () => expect(assessTranscript({ text: 'send fifty dollars to Maria', isFinal: false }).reask).toBeTruthy());
    it('very low confidence', () => expect(assessTranscript({ text: 'send fifty dollars to Maria', confidence: 0.4, isFinal: true }).reask).toMatch(/confident/));
    it('two payments in one breath', () => expect(assessTranscript({ text: 'send ten dollars to Maria and send twenty dollars to Jon', confidence: 0.9, isFinal: true }).reask).toMatch(/one at a time/));
    it('model and parser disagree on the amount', () => {
      const a = assessTranscript({ text: 'send fifty dollars to Maria', confidence: 0.95, isFinal: true }, { llmAmount: 15 });
      expect(a.reask).toMatch(/two different amounts/);
    });
    it('agreeing model and parser pass', () => expect(assessTranscript({ text: 'send fifty dollars to Maria', confidence: 0.95, isFinal: true }, { llmAmount: 50 }).reask).toBeUndefined());
    it('the mic hearing the assistant’s own voice', () => {
      const a = assessTranscript({ text: 'You are sending fifty dollars to Maria', confidence: 0.9, isFinal: true, lastAssistantText: 'You are sending fifty dollars to Maria. Say yes to confirm.' });
      expect(a.reask).toMatch(/own voice/);
    });
  });

  it('moderate confidence forces a spelled-out, medium-friction confirmation', () => {
    const a = assessTranscript({ text: 'send thirty dollars to Maria', confidence: 0.7, isFinal: true });
    expect(a.signals.find((s) => s.code === 'low_confidence')).toMatchObject({ minBand: 'medium', digitReadback: true });
  });
  it('speech that began while the assistant was talking is high risk', () => {
    expect(assessTranscript({ text: 'send thirty dollars to Maria', confidence: 0.9, isFinal: true, duringPlayback: true }).signals.find((s) => s.code === 'spoken_during_playback')!.minBand).toBe('high');
  });
});
