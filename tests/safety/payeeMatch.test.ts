import { describe, it, expect } from 'vitest';
import { resolvePayee, disambiguationQuestion, pickDisambiguated, hasConfusableChars } from '../../src/safety/payeeMatch.js';
import { DEMO_CONTACTS } from '../../src/mock/dataset.js';

const r = (s: string) => resolvePayee(s, DEMO_CONTACTS);

describe('resolvePayee', () => {
  it('resolves a name with no sound-alike', () => {
    const x = r('Priya'); expect(x.status).toBe('resolved'); expect(x.chosen?.id).toBe('c_priya'); expect(x.phoneticNeighbour).toBe(false);
  });
  it.each([['Jon'], ['John'], ['Joan']])('%s is ambiguous between Jon and John', (n) => {
    const x = r(n); expect(x.status).toBe('ambiguous');
    expect(x.candidates.map((c) => c.contact.id)).toEqual(expect.arrayContaining(['c_jon', 'c_john']));
  });
  it('Maria vs Mariah is ambiguous', () => expect(r('Maria').status).toBe('ambiguous'));
  it('Erin vs Aaron is ambiguous', () => expect(r('Erin').status).toBe('ambiguous'));
  it('the relationship word resolves the ambiguity', () => {
    expect(r('John my landlord').chosen?.id).toBe('c_john');
    expect(r('Jon from book club').chosen?.id).toBe('c_jon');
    expect(r('my sister').chosen?.id).toBe('c_maria');
  });
  it('a sound-alike resolved by relationship still reports a phonetic neighbour', () => {
    expect(r('John my landlord').phoneticNeighbour).toBe(true);
  });
  it('never invents a payee for an unknown name', () => {
    expect(r('Zachariah').status).toBe('unknown');
    expect(r('Zachariah').chosen).toBeUndefined();
  });
  it.each([['Priyah'], ['Pria']])('sound-alike %s is only a suggestion, never auto-resolved', (n) => {
    const x = r(n);
    expect(x.status).toBe('suggest');
    expect(x.chosen).toBeUndefined();
    expect(x.candidates[0]?.contact.id).toBe('c_priya');
  });
  it('a near-miss with weak evidence is a suggestion', () => expect(r('Johan').status).toBe('suggest'));
  it('the question names who each candidate is', () => {
    const q = disambiguationQuestion(r('Jon'), []);
    expect(q).toMatch(/landlord/); expect(q).toMatch(/book club/);
  });
});

describe('disambiguation by distant answer tokens', () => {
  const res = resolvePayee('Jon', DEMO_CONTACTS);
  it('offers numbered options, not names to repeat', () => {
    const q = disambiguationQuestion(res, []);
    expect(q).toMatch(/One:/); expect(q).toMatch(/Two:/); expect(q).toMatch(/neither/i);
  });
  it('maps one / two / neither', () => {
    expect(pickDisambiguated('one', res)).toBe(res.candidates[0]!.contact);
    expect(pickDisambiguated('number two please', res)).toBe(res.candidates[1]!.contact);
    expect(pickDisambiguated('neither', res)).toBe('neither');
  });
  it('an unclear or contradictory answer is never guessed', () => {
    expect(pickDisambiguated('mmm', res)).toBeNull();
    expect(pickDisambiguated('one or two', res)).toBeNull();
    expect(pickDisambiguated('three', res)).toBeNull();
  });
});

describe('hasConfusableChars', () => {
  it.each([['PayPaI Support'], ['Mаria'], ['Jo\u200Bn']])('flags %j', (n) => expect(hasConfusableChars(n)).toBe(true));
  it.each([['Maria'], ['Jon'], ['Priya Sharma'], ['Ilya']])('allows %j', (n) => expect(hasConfusableChars(n)).toBe(false));
  it('known, deliberate false positive: McIntosh (safe direction)', () => expect(hasConfusableChars('McIntosh')).toBe(true));
});

