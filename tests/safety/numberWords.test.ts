import { describe, it, expect } from 'vitest';
import { extractAmount, numberToWords, moneyToWords, digitsSpelled, confusableAlternatives } from '../../src/safety/numberWords.js';

describe('numberToWords / moneyToWords', () => {
  it.each([[0,'zero'],[15,'fifteen'],[50,'fifty'],[99,'ninety-nine'],[120,'one hundred twenty'],[1500,'one thousand five hundred'],[2000000,'two million']])('%i', (n, w) => expect(numberToWords(n)).toBe(w));
  it('money with cents', () => expect(moneyToWords(15.5)).toBe('fifteen dollars and fifty cents'));
  it('singular dollar', () => expect(moneyToWords(1)).toBe('one dollar'));
  it('digits spelled', () => expect(digitsSpelled(1500)).toBe('one, five, zero, zero'));
});

describe('extractAmount', () => {
  it.each([
    ['send $40 to Maria', 40],
    ['send 40 dollars to Maria', 40],
    ['send $1,500 to Jon', 1500],
    ['send fifty dollars to Maria', 50],
    ['send fifteen bucks to Maria', 15],
    ['pay two hundred and fifty dollars', 250],
    ['send a hundred dollars to John', 100],
    ['send fifteen hundred to Jon', 1500],
    ['send twenty-five dollars', 25],
    ['send ten thousand dollars', 10000],
    ['send fifty dollars and twenty five cents', 50.25],
    ['send $15.50 to Priya', 15.5],
  ])('%s -> %d', (text, v) => expect(extractAmount(text)?.value).toBe(v));

  it('prefers the number tied to dollars over a head count', () => {
    expect(extractAmount('split four ways, a hundred and twenty dollars')?.value).toBe(120);
  });
  it('returns null when there is no amount', () => expect(extractAmount('what is my balance')).toBeNull());
  it('flags spoken multipliers', () => expect(extractAmount('send two thousand dollars')?.spokenMultiplier).toBe(true));
});

describe('confusableAlternatives', () => {
  it.each([[15,[50]],[50,[15]],[16,[60]],[60,[16]],[150,[115]],[115,[150]],[1115,[1150]],[13,[30]],[40,[14]]])('%i', (n, alts) => expect(confusableAlternatives(n)).toEqual(alts));
  it.each([25, 55, 100, 12, 20, 7, 1500])('%i has none', (n) => expect(confusableAlternatives(n)).toEqual([]));
});
