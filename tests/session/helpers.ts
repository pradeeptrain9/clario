import { ruleParse } from '../../src/ai/ruleParser.js';
import { MockPayPal } from '../../src/mock/adapter.js';
import { AuditLog } from '../../src/safety/audit.js';
import { TokenMint } from '../../src/safety/token.js';
import { Account } from '../../src/session/account.js';
import { Dialog, type TurnInput } from '../../src/session/dialog.js';
import { GuardedExecutor } from '../../src/session/executor.js';
import { hashPassphrase } from '../../src/session/pin.js';

export const PASS = 'blue harbor seven';
export const NOW = new Date('2026-10-16T15:00:00Z');

export function setup(opts: { passphrase?: boolean; adapter?: MockPayPal } = {}) {
  const adapter = opts.adapter ?? new MockPayPal(() => NOW);
  const account = new Account(adapter, () => NOW);
  const audit = new AuditLog();
  const mint = new TokenMint();
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const dialog = new Dialog({
    account, mint, audit, executor: new GuardedExecutor(account, mint, audit),
    understand: async (t) => ruleParse(t),
    passphrase: opts.passphrase === false ? undefined : hashPassphrase(PASS),
    now: () => NOW,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
  });
  const say = (text: string, extra: Partial<TurnInput> = {}) => dialog.turn({ text, confidence: 0.95, isFinal: true, duringPlayback: false, ...extra });
  const balance = async () => (await adapter.getBalances())[0]!.available;
  const mint2 = mint;
  return { mint: mint2, adapter, account, audit, dialog, say, balance, timers };
}
