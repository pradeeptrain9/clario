import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const DIGIT_WORDS: Record<string, string> = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

/** Spoken passphrases come back from speech recognition as "Blue Harbor 7" or "blue harbor seven". */
export function normalizePassphrase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).map((w) => DIGIT_WORDS[w] ?? w).join(' ');
}

export interface PassphraseRecord { salt: string; hash: string }

export function hashPassphrase(spoken: string, salt = randomBytes(16).toString('hex')): PassphraseRecord {
  return { salt, hash: scryptSync(normalizePassphrase(spoken), salt, 32).toString('hex') };
}

export function verifyPassphrase(spoken: string, rec: PassphraseRecord): boolean {
  const got = scryptSync(normalizePassphrase(spoken), rec.salt, 32);
  const want = Buffer.from(rec.hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Lock a challenge after repeated wrong answers. A bystander gets three guesses, not unlimited ones. */
export class Attempts {
  private n = 0;
  constructor(private max = 3) {}
  fail(): { locked: boolean; remaining: number } { this.n++; return { locked: this.n >= this.max, remaining: Math.max(0, this.max - this.n) }; }
  get locked() { return this.n >= this.max; }
}
