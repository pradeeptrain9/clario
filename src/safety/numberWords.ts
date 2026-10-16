const UNITS = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const TENS = ['', '', 'twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];

const WORD_VALUE = new Map<string, number>();
UNITS.forEach((w, i) => WORD_VALUE.set(w, i));
TENS.forEach((w, i) => { if (w) WORD_VALUE.set(w, i * 10); });

export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('numberToWords expects a non-negative integer');
  if (n < 20) return UNITS[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${UNITS[n % 10]}` : '');
  if (n < 1000) return `${UNITS[Math.floor(n / 100)]} hundred${n % 100 ? ' ' + numberToWords(n % 100) : ''}`;
  if (n < 1_000_000) return `${numberToWords(Math.floor(n / 1000))} thousand${n % 1000 ? ' ' + numberToWords(n % 1000) : ''}`;
  return `${numberToWords(Math.floor(n / 1_000_000))} million${n % 1_000_000 ? ' ' + numberToWords(n % 1_000_000) : ''}`;
}

/** "$15.50" -> "fifteen dollars and fifty cents" */
export function moneyToWords(amount: number, currency = 'USD'): string {
  const cents = Math.round(amount * 100);
  const d = Math.floor(cents / 100), c = cents % 100;
  const unit = currency === 'USD' ? ['dollar', 'dollars'] : [currency, currency];
  const dw = `${numberToWords(d)} ${d === 1 ? unit[0] : unit[1]}`;
  return c ? `${dw} and ${numberToWords(c)} ${c === 1 ? 'cent' : 'cents'}` : dw;
}

/** Spell digits for unambiguous listening: 1500 -> "one, five, zero, zero". */
export function digitsSpelled(n: number): string {
  return String(n).split('').map((ch) => UNITS[Number(ch)]).join(', ');
}

const MULTIPLIERS = new Set(['hundred', 'thousand', 'million']);
const isNumWord = (w: string) => WORD_VALUE.has(w) || MULTIPLIERS.has(w);

/** Parse a run of number words starting at tokens[i]. Returns value and tokens consumed. */
function parseRun(tokens: string[], i: number): { value: number; used: number } | null {
  let total = 0, current = 0, used = 0, any = false;
  for (let j = i; j < tokens.length; j++) {
    let w = tokens[j]!;
    if (w === 'a' && tokens[j + 1] === 'hundred' ) { current = 1; used++; continue; }
    if (w === 'and' && any && isNumWord(tokens[j + 1] ?? '')) { used++; continue; }
    if (!isNumWord(w)) break;
    any = true; used++;
    if (w === 'hundred') current = (current || 1) * 100;
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; }
    else if (w === 'million') { total += (current || 1) * 1_000_000; current = 0; }
    else current += WORD_VALUE.get(w)!;
  }
  return any ? { value: total + current, used } : null;
}

export interface ParsedAmount {
  value: number;               // dollars, possibly with cents
  source: 'digits' | 'words';
  spokenMultiplier: boolean;   // utterance used 'hundred'/'thousand'/'million'
}

/**
 * Deterministic amount extraction from a raw transcript. Deliberately independent of the LLM so the
 * two can be cross-checked. Prefers a number tied to '$' / 'dollars' / 'bucks'.
 */
export function extractAmount(text: string): ParsedAmount | null {
  const t = text.toLowerCase().replace(/(\d),(\d{3})/g, '$1$2');

  const dig = t.match(/\$\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks|usd)\b/);
  if (dig) {
    const v = Number(dig[1] ?? dig[2]);
    if (Number.isFinite(v)) return { value: v, source: 'digits', spokenMultiplier: false };
  }

  const tokens = t.replace(/-/g, ' ').replace(/[^a-z0-9.$ ]/g, ' ').split(/\s+/).filter(Boolean);
  const runs: { value: number; at: number; used: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const r = parseRun(tokens, i);
    if (r) { runs.push({ ...r, at: i }); i += r.used - 1; }
  }
  if (!runs.length) {
    const bare = t.match(/\b(\d+(?:\.\d{1,2})?)\b/);
    return bare ? { value: Number(bare[1]), source: 'digits', spokenMultiplier: false } : null;
  }
  const money = runs.find((r) => /^(dollars?|bucks|usd)$/.test(tokens[r.at + r.used] ?? ''));
  const pick = money ?? runs[0]!;
  let value = pick.value;
  // "fifty dollars and twenty five cents"
  const after = pick.at + pick.used;
  if (/^dollars?$/.test(tokens[after] ?? '')) {
    const k = tokens[after + 1] === 'and' ? after + 2 : after + 1;
    const c = parseRun(tokens, k);
    if (c && /^cents?$/.test(tokens[k + c.used] ?? '')) value += c.value / 100;
  }
  const span = tokens.slice(pick.at, pick.at + pick.used);
  return { value, source: 'words', spokenMultiplier: span.some((w) => MULTIPLIERS.has(w)) };
}

/**
 * Amounts a recognizer could plausibly have confused with `dollars` (teen <-> ty pairs:
 * fifteen/fifty, sixteen/sixty, ...). Applies to the last two digits, e.g. 150 <-> 115.
 */
export function confusableAlternatives(dollars: number): number[] {
  if (!Number.isInteger(dollars) || dollars <= 0) return [];
  const lo = dollars % 100, hi = dollars - lo;
  const alts = new Set<number>();
  if (lo >= 13 && lo <= 19) alts.add(hi + (lo - 10) * 10);          // fifteen -> fifty
  if (lo >= 30 && lo <= 90 && lo % 10 === 0) alts.add(hi + lo / 10 + 10); // fifty -> fifteen
  alts.delete(dollars);
  return [...alts];
}
