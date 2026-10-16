import { describe, expect, it } from 'vitest';
import { MockPayPal } from '../../src/mock/adapter.js';
import { AuditLog } from '../../src/safety/audit.js';
import { TokenMint } from '../../src/safety/token.js';
import { Account } from '../../src/session/account.js';
import { Dialog } from '../../src/session/dialog.js';
import { GuardedExecutor } from '../../src/session/executor.js';
import { hashPassphrase } from '../../src/session/pin.js';
import type { ProposedAction } from '../../src/types.js';

const NOW = new Date('2026-10-16T15:00:00Z');

/** A dialog whose model always returns the given reading, standing in for Gemini. */
function withAction(action: ProposedAction) {
  const adapter = new MockPayPal(() => NOW);
  const account = new Account(adapter, () => NOW);
  const audit = new AuditLog();
  const mint = new TokenMint();
  const dialog = new Dialog({
    account, mint, audit, executor: new GuardedExecutor(account, mint, audit),
    understand: async () => action, passphrase: hashPassphrase('x'), now: () => NOW,
    setTimer: (fn, ms) => ({ fn, ms, cleared: false }), clearTimer: () => {},
  });
  return (text: string) => dialog.turn({ text, confidence: 0.95, isFinal: true, duringPlayback: false });
}
const q = (over: Partial<Extract<ProposedAction, { kind: 'query' }>>): ProposedAction =>
  ({ kind: 'query', question: 'q', ...over });

describe('Queries: using the model’s reading of the question', () => {
  it('answers the balance from queryKind, with no balance words in the sentence', async () => {
    const out = await withAction(q({ queryKind: 'balance' }))('how much have I got left');
    expect(out.say).toMatch(/Your PayPal balance is/i);
  });

  // The old reading only had buckets of 1, 7, 30 and 365 days.
  it('honours a period the regexes had no bucket for', async () => {
    const out = await withAction(q({ queryKind: 'spending', days: 90 }))('over the past three months');
    expect(out.say).toMatch(/in the last 90 days/i);
  });

  it('combines a period and a person', async () => {
    const out = await withAction(q({ queryKind: 'spending', days: 90, payeeSpoken: 'Maria' }))('…');
    expect(out.say).toMatch(/You sent Maria/i);
    expect(out.say).toMatch(/in the last 90 days/i);
  });

  it('lists activity for the person the model heard', async () => {
    const out = await withAction(q({ queryKind: 'activity', payeeSpoken: 'John' }))('did I pay John lately');
    expect(out.say).toMatch(/with John/i);
  });

  // The boundary that matters: the model reads the question, it does not choose the person.
  it('will not let a name the model invented select a contact', async () => {
    const out = await withAction(q({ queryKind: 'activity', payeeSpoken: 'Mariah-Jon' }))('…');
    expect(out.say).toMatch(/which one did you mean/i);
  });

  it('ignores a name that matches nobody rather than answering globally', async () => {
    const out = await withAction(q({ queryKind: 'activity', payeeSpoken: 'Zebediah' }))('…');
    expect(out.say).toMatch(/latest activity/i);
    expect(out.say).not.toMatch(/with Zebediah/i);
  });

  // Offline there is no model, so the handler must still read the sentence itself.
  it('falls back to reading the sentence when the model gave nothing', async () => {
    const out = await withAction(q({}))('what did I spend last month');
    expect(out.say).toMatch(/You spent/i);
  });
});
