import { describe, it, expect } from 'vitest';
import { scoreBehavior } from '../../src/safety/behavioral.js';
import { buildHistory, DEMO_CONTACTS } from '../../src/mock/dataset.js';

const NOW = new Date('2026-10-16T15:00:00Z'); // 15:00 UTC
const history = buildHistory(NOW);
const c = (id: string) => DEMO_CONTACTS.find((x) => x.id === id)!;
const run = (amount: number, id: string | undefined, extra: Partial<Parameters<typeof scoreBehavior>[0]> = {}) =>
  scoreBehavior({ amount, payee: id ? c(id) : undefined, history, now: NOW, recentSends: [], balance: 2480, ...extra });
const codes = (r: ReturnType<typeof run>) => r.signals.map((s) => s.code);
const pts = (r: ReturnType<typeof run>) => r.signals.reduce((a, s) => a + s.points, 0);

describe('scoreBehavior', () => {
  it('the usual $15 to Maria is unremarkable', () => { const r = run(15, 'c_maria'); expect(pts(r)).toBe(0); expect(r.typicalForPayee).toBeCloseTo(15, 0); });
  it('$50 to Maria is a strong outlier against her own history', () => {
    const r = run(50, 'c_maria'); expect(codes(r)).toContain('amount_outlier'); expect(r.zPayee!).toBeGreaterThan(3.5);
  });
  it('rent to John is normal for John even though it dwarfs other payments', () => {
    expect(codes(run(1200, 'c_john'))).not.toContain('amount_outlier');
  });
  it('$1,500 to Jon is an outlier for Jon', () => expect(codes(run(1500, 'c_jon'))).toContain('amount_outlier'));
  it('$1,200 to a payee with no history (the same amount as rent) is flagged as new + high', () => {
    const r = run(1200, 'c_erin'); expect(codes(r)).toEqual(expect.arrayContaining(['new_payee', 'new_payee_high_amount']));
    expect(r.signals.find((s) => s.code === 'new_payee_high_amount')!.minBand).toBe('high');
  });
  it('a small first payment to a new person is only mildly flagged', () => {
    const r = run(20, 'c_erin'); expect(codes(r)).toContain('new_payee'); expect(codes(r)).not.toContain('new_payee_high_amount');
  });
  it('cold start adds friction instead of removing it', () => {
    const r = run(600, 'c_erin', { history: [] });
    expect(codes(r)).toEqual(expect.arrayContaining(['thin_history', 'thin_history_large', 'new_payee_high_amount']));
  });
  it('velocity: a fourth payment in ten minutes', () => {
    const recent = [1, 3, 5].map((m) => ({ at: NOW.getTime() - m * 60_000, amount: 15, contactId: 'c_maria' }));
    expect(codes(run(15, 'c_maria', { recentSends: recent }))).toContain('velocity_burst');
  });
  it('escalation to the same person', () => {
    const recent = [{ at: NOW.getTime() - 9 * 60_000, amount: 20, contactId: 'c_jon' }, { at: NOW.getTime() - 4 * 60_000, amount: 40, contactId: 'c_jon' }];
    expect(codes(run(90, 'c_jon', { recentSends: recent }))).toContain('escalating_amounts');
  });
  it('night-time in the user’s own timezone', () => {
    const night = new Date('2026-10-16T08:00:00Z'); // 03:00 at UTC-5
    expect(codes(run(15, 'c_maria', { now: night, utcOffsetMinutes: -300 }))).toContain('unusual_hour');
    expect(codes(run(15, 'c_maria', { now: night, utcOffsetMinutes: 0 }))).not.toContain('unusual_hour');
  });
  it('draining the account', () => expect(codes(run(2300, 'c_john', { balance: 2480 }))).toContain('drains_balance'));
});
