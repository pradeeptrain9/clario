import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RiskBand } from '../types.js';
import { bandRank } from './types.js';

export interface ActionFacts { kind: 'send' | 'invoice'; payeeId: string; amount: number; currency: string; note?: string }

/** Content hash of exactly what the user heard and confirmed. Any later change breaks the token. */
export function fingerprint(a: ActionFacts): string {
  return createHash('sha256').update(JSON.stringify([a.kind, a.payeeId, Math.round(a.amount * 100), a.currency, a.note ?? ''])).digest('hex');
}

export interface ExecutionToken {
  id: string; fp: string; band: RiskBand; stepsDone: string[]; exp: number; mac: string;
}
export class TokenError extends Error {}

/**
 * The policy engine is the only holder of the key. Executors refuse any write without a valid token,
 * so neither the model nor a route handler can move money by itself — they have no way to mint one.
 */
export class TokenMint {
  private used = new Set<string>();
  constructor(private key: Buffer = randomBytes(32), private now: () => number = Date.now, private ttlMs = 120_000) {}

  private mac(t: Omit<ExecutionToken, 'mac'>) {
    return createHmac('sha256', this.key).update(JSON.stringify([t.id, t.fp, t.band, t.stepsDone, t.exp])).digest('hex');
  }

  mint(a: ActionFacts, band: RiskBand, stepsDone: string[]): ExecutionToken {
    const base = { id: randomBytes(12).toString('hex'), fp: fingerprint(a), band, stepsDone, exp: this.now() + this.ttlMs };
    return { ...base, mac: this.mac(base) };
  }

  /** Throws unless the token is authentic, unexpired, unused and bound to exactly this action. */
  consume(token: ExecutionToken, a: ActionFacts, requiredSteps: string[]): void {
    const { mac, ...base } = token;
    const want = Buffer.from(this.mac(base), 'hex'), got = Buffer.from(mac, 'hex');
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new TokenError('invalid token');
    if (token.fp !== fingerprint(a)) throw new TokenError('token does not match this action');
    if (this.now() > token.exp) throw new TokenError('token expired');
    if (this.used.has(token.id)) throw new TokenError('token already used');
    const missing = requiredSteps.filter((s) => !token.stepsDone.includes(s));
    if (missing.length) throw new TokenError(`steps not completed: ${missing.join(', ')}`);
    if (bandRank(token.band) < 1) throw new TokenError('money cannot move at read-only band');
    this.used.add(token.id);
  }
}
