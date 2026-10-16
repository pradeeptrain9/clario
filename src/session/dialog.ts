import type { Understand } from '../ai/understand.js';
import { parseControl, type Control } from '../ai/ruleParser.js';
import type { AuditLog } from '../safety/audit.js';
import { assessSend, type Assessment, type SendInput } from '../safety/index.js';
import { promptFor, DEFAULT_POLICY, type Policy, type Step } from '../safety/ladder.js';
import { moneyToWords } from '../safety/numberWords.js';
import { pickDisambiguated, resolvePayee, hasConfusableChars, type PayeeResolution } from '../safety/payeeMatch.js';
import { scanUntrusted } from '../safety/injection.js';
import type { ActionFacts, TokenMint } from '../safety/token.js';
import type { TranscriptMeta } from '../safety/transcription.js';
import type { Contact, ProposedAction, RiskBand, Transaction } from '../types.js';
import type { Account } from './account.js';
import type { GuardedExecutor } from './executor.js';
import { Attempts, verifyPassphrase, type PassphraseRecord } from './pin.js';

export interface TurnInput extends TranscriptMeta { utcOffsetMinutes?: number }
export type Awaiting = 'command' | 'yes_no' | 'choice' | 'amount_choice' | 'passphrase' | 'cooling';
export interface TurnOutput {
  say: string;
  awaiting: Awaiting;
  band?: RiskBand;
  /** Client speech-rate hint. */
  rate?: 'slower' | 'faster';
  /** Epoch ms when a cooling-off hold will release. */
  holdUntil?: number;
}

export interface DialogDeps {
  account: Account;
  executor: GuardedExecutor;
  mint: TokenMint;
  audit: AuditLog;
  understand: Understand;
  passphrase?: PassphraseRecord;
  policy?: Policy;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

type Ready = Extract<Awaited<ReturnType<typeof assessSend>>, { outcome: 'ready' }>;

type State =
  | { k: 'idle' }
  | { k: 'clarify'; base: SendInput; note?: string; res: PayeeResolution; mode: 'ambiguous' | 'suggest'; tries: number }
  | { k: 'confirm'; base: SendInput; note: string; a: Ready; facts: ActionFacts; steps: Step[]; i: number; done: string[]; tries: Attempts; amountPending: boolean }
  | { k: 'confirm_split'; shares: { to: Contact; amount: number }[]; currency: string; note: string; total: number }
  | { k: 'cooling'; id: string; timer: unknown; until: number; payee: Contact; facts: ActionFacts; a: Ready; note: string; done: string[]; steps: Step[] };

const HELP = 'You can say things like: send twenty dollars to Maria. Split ninety dollars with Jon and Priya. What is my balance? What did I spend this week? Or say repeat, slower, faster, or cancel.';
const money = (n: number, c: string) => moneyToWords(n, c);
const round2 = (n: number) => Math.round(n * 100) / 100;

export class Dialog {
  private s: State = { k: 'idle' };
  private outbox: string[] = [];
  private lastSay = '';

  constructor(private d: DialogDeps) {}

  private now() { return (this.d.now ?? (() => new Date()))(); }
  private policy() { return this.d.policy ?? DEFAULT_POLICY; }
  private timer(fn: () => void, ms: number) { return (this.d.setTimer ?? setTimeout)(fn, ms); }
  private untimer(h: unknown) { (this.d.clearTimer ?? ((x) => clearTimeout(x as NodeJS.Timeout)))(h); }

  get state() { return this.s.k; }
  /** A session with money in a cooling-off hold must not be evicted. */
  get busy() { return this.s.k === 'cooling'; }
  /** Messages produced outside a turn (a held payment finally sending). */
  drain(): string[] { const o = this.outbox; this.outbox = []; return o; }

  async turn(input: TurnInput): Promise<TurnOutput> {
    try {
      const out = await this.route(input);
      this.lastSay = out.say;
      return out;
    } catch (e) {
      this.d.audit.append('error', { message: e instanceof Error ? e.message.slice(0, 200) : 'error', state: this.s.k });
      this.s = this.s.k === 'cooling' ? this.s : { k: 'idle' };
      return this.reply('Something went wrong and I stopped. Nothing was sent unless I told you it was. Please try again.', 'command');
    }
  }

  // ───────────────────────── routing ─────────────────────────

  private async route(input: TurnInput): Promise<TurnOutput> {
    const ctl = parseControl(input.text);

    // Controls that are safe in every state.
    if (ctl === 'repeat') return this.reply(this.lastSay || 'There is nothing to repeat yet.', this.awaitingNow());
    if (ctl === 'help') return this.reply(HELP, this.awaitingNow());
    if (ctl === 'slower' || ctl === 'faster') return { ...this.reply(ctl === 'slower' ? 'Okay, slower.' : 'Okay, faster.', this.awaitingNow()), rate: ctl };

    switch (this.s.k) {
      case 'idle': return this.idle(input);
      case 'clarify': return this.clarify(input, ctl);
      case 'confirm': return this.confirm(input, ctl);
      case 'confirm_split': return this.confirmSplit(input, ctl);
      case 'cooling': return this.cooling(ctl);
    }
  }

  private reply(say: string, awaiting: Awaiting, extra: Partial<TurnOutput> = {}): TurnOutput { return { say, awaiting, ...extra }; }

  private awaitingNow(): Awaiting {
    switch (this.s.k) {
      case 'idle': return 'command';
      case 'clarify': return this.s.mode === 'ambiguous' ? 'choice' : 'yes_no';
      case 'confirm': return this.s.amountPending ? 'amount_choice' : this.s.steps[this.s.i]?.kind === 'passphrase' ? 'passphrase' : 'yes_no';
      case 'confirm_split': return 'yes_no';
      case 'cooling': return 'cooling';
    }
  }

  /**
   * An answer to a question only counts if it was clearly heard from the user, not our own voice or a murmur.
   *
   * `bareAffirmative` relaxes the confidence floor, and only that. Web Speech scores single short
   * words poorly and inconsistently, which left users unable to confirm at all while "no" -- checked
   * before this gate, since cancelling needs no evidence -- always worked. The affirmative vocabulary
   * is small and phonetically distinct, so a low-confidence "yes" is unlikely to be a misheard
   * sentence. duringPlayback still applies either way: that guards against the microphone picking up
   * our own prompt saying the word "yes", which is a different risk from mishearing the user.
   */
  private heardClearly(i: TurnInput, bareAffirmative = false): boolean {
    if (i.duringPlayback || i.isFinal === false) return false;
    return bareAffirmative || i.confidence === undefined || i.confidence >= 0.6;
  }

  private cancelAll(why: string, say = 'Okay. I have cancelled that. Nothing was sent.'): TurnOutput {
    this.d.audit.append('cancelled', { why, state: this.s.k });
    this.s = { k: 'idle' };
    return this.reply(say, 'command');
  }

  // ───────────────────────── idle ─────────────────────────

  private async idle(input: TurnInput): Promise<TurnOutput> {
    const action = await this.d.understand(input.text);
    switch (action.kind) {
      case 'send_money': return this.beginSend(input, action);
      case 'split_bill': return this.beginSplit(input, action);
      case 'query': return this.query(action.question || input.text);
      case 'review_audit': return this.reviewAudit();
      case 'control': return this.idleControl(action.command);
      case 'unknown': return this.reply(`I did not understand that. ${HELP}`, 'command');
    }
  }

  private idleControl(c: Control): TurnOutput {
    if (c === 'stop') return this.reply('Okay.', 'command');
    return this.reply('There is nothing waiting for an answer right now. What would you like to do?', 'command');
  }

  // ───────────────────────── send ─────────────────────────

  private async beginSend(input: TurnInput, a: Extract<ProposedAction, { kind: 'send_money' }>): Promise<TurnOutput> {
    const snap = await this.d.account.snapshot();
    const base: SendInput = {
      transcript: input, payeeSpoken: a.payeeSpoken, amount: a.amount, currency: a.currency,
      contacts: snap.contacts, history: snap.history, balance: snap.balance, now: this.now(),
      utcOffsetMinutes: input.utcOffsetMinutes, recentSends: this.d.account.recentSends,
      pendingTotal: this.d.account.pendingTotal, policy: this.policy(),
    };
    return this.applyAssessment(base, a.note?.trim() || 'Payment sent with Clario');
  }

  private applyAssessment(base: SendInput, note: string, tries = 0): TurnOutput {
    const a: Assessment = assessSend(base);
    switch (a.outcome) {
      case 'reask':
        this.s = { k: 'idle' };
        return this.reply(a.say, 'command');

      case 'clarify':
        this.d.audit.append('clarify', { reason: a.reason, candidates: a.resolution.candidates.map((c) => c.contact.id) });
        if (a.reason === 'unknown') { this.s = { k: 'idle' }; return this.reply(a.say, 'command'); }
        this.s = { k: 'clarify', base, note, res: a.resolution, mode: a.reason, tries };
        return this.reply(a.say, a.reason === 'ambiguous' ? 'choice' : 'yes_no');

      case 'blocked':
        this.d.audit.append('blocked', { amount: base.amount, score: a.score, signals: a.signals.map((s) => s.code) });
        this.s = { k: 'idle' };
        return this.reply(a.say, 'command', { band: 'blocked' });

      case 'ready': {
        const steps = a.challenge.steps;
        if (steps.some((s) => s.kind === 'passphrase') && !this.d.passphrase) {
          this.d.audit.append('blocked', { amount: a.amount, payeeId: a.payee.id, band: a.band, why: 'no passphrase configured' });
          this.s = { k: 'idle' };
          return this.reply(`${a.explanation} This payment needs your passphrase, and none is set up, so I have not sent it.`, 'command', { band: a.band });
        }
        this.d.audit.append('assessment', { payeeId: a.payee.id, amount: a.amount, currency: a.currency, band: a.band,
          score: a.score, signals: a.signals.map((s) => s.code), steps: steps.map((s) => s.kind) });
        const facts: ActionFacts = { kind: 'send', payeeId: a.payee.id, amount: a.amount, currency: a.currency, note };
        const amountPending = !!a.amountChoice;
        this.s = { k: 'confirm', base, note, a, facts, steps, i: 0, done: [], tries: new Attempts(3), amountPending };
        return this.reply(this.confirmPrompt(), this.awaitingNow(), { band: a.band });
      }
    }
  }

  private confirmPrompt(): string {
    const s = this.s;
    if (s.k !== 'confirm') return '';
    const { a } = s;
    if (s.amountPending && a.amountChoice) {
      const { lower, higher } = a.amountChoice;
      return `${a.explanation} Did you mean ${money(lower, a.currency)}, or ${money(higher, a.currency)}? Say lower, or higher.`;
    }
    const step = s.steps[s.i]!;
    const lead = s.i === 0 ? `${a.readback.full} ${a.band === 'low' ? '' : a.explanation}` : '';
    return `${lead} ${promptFor(step)}`.replace(/\s+/g, ' ').trim();
  }

  private async clarify(input: TurnInput, ctl: Control | null): Promise<TurnOutput> {
    const s = this.s;
    if (s.k !== 'clarify') return this.idle(input);
    if (ctl === 'cancel' || ctl === 'stop') return this.cancelAll('clarify cancelled');
    if (!this.heardClearly(input, ctl === 'yes')) return this.reply('I did not catch that clearly. Please say it again.', this.awaitingNow());

    let pick: Contact | 'neither' | null = null;
    if (s.mode === 'ambiguous') pick = pickDisambiguated(input.text, s.res);
    else if (ctl === 'yes') pick = s.res.candidates[0]!.contact;
    else if (ctl === 'no') pick = 'neither';

    if (pick === 'neither') return this.cancelAll('payee rejected', 'Okay, I will not send that. Nothing was sent. Who did you mean?');
    if (!pick) {
      if (s.tries >= 2) return this.cancelAll('clarify failed', 'I still could not tell who you meant, so I have stopped. Nothing was sent.');
      this.s = { ...s, tries: s.tries + 1 };
      return this.reply(s.mode === 'ambiguous' ? 'Please say one, two, or neither.' : 'Please say yes or no.', this.awaitingNow());
    }
    return this.applyAssessment({ ...s.base, resolvedContactId: pick.id }, s.note ?? 'Payment sent with Clario', s.tries);
  }

  // ───────────────────────── confirmation ladder ─────────────────────────

  private async confirm(input: TurnInput, ctl: Control | null): Promise<TurnOutput> {
    const s = this.s;
    if (s.k !== 'confirm') return this.idle(input);
    if (ctl === 'cancel' || ctl === 'stop' || ctl === 'no') return this.cancelAll('declined at confirmation');

    // Answering the "lower or higher" sound-alike question: re-assess the chosen amount from scratch.
    if (s.amountPending && s.a.amountChoice) {
      if (!this.heardClearly(input)) return this.reply('I did not catch that. Please say lower, or higher.', 'amount_choice');
      const t = input.text.toLowerCase();
      const wantsLow = /\b(lower|less|smaller|first)\b/.test(t), wantsHigh = /\b(higher|more|bigger|larger|second)\b/.test(t);
      if (wantsLow === wantsHigh) return this.reply('Please say lower, or higher.', 'amount_choice');
      const amount = wantsLow ? s.a.amountChoice.lower : s.a.amountChoice.higher;
      const text = `send ${amount} dollars to ${s.a.payee.name}`;
      this.d.audit.append('amount_resolved', { payeeId: s.a.payee.id, chosen: amount });
      return this.applyAssessment({ ...s.base, amount, transcript: { text, confidence: 1, isFinal: true }, resolvedContactId: s.a.payee.id }, s.note);
    }

    if (!this.heardClearly(input, ctl === 'yes')) {
      return this.reply(`I did not catch that clearly. ${promptFor(s.steps[s.i]!)}`, this.awaitingNow(), { band: s.a.band });
    }

    const step = s.steps[s.i]!;
    if (step.kind === 'confirm_yes') {
      if (ctl !== 'yes') return this.reply(`Please say just yes, or no. ${promptFor(step)}`, 'yes_no', { band: s.a.band });
      return this.advance(s, 'confirm_yes');
    }
    if (step.kind === 'passphrase') {
      if (verifyPassphrase(input.text, this.d.passphrase!)) return this.advance(s, 'passphrase');
      const r = s.tries.fail();
      this.d.audit.append('passphrase_failed', { payeeId: s.a.payee.id, remaining: r.remaining });
      if (r.locked) return this.cancelAll('passphrase locked', 'That passphrase was wrong too many times, so I have cancelled this payment. Nothing was sent.');
      return this.reply(`That was not right. ${r.remaining} ${r.remaining === 1 ? 'try' : 'tries'} left. Please say your passphrase, or say cancel.`, 'passphrase', { band: s.a.band });
    }
    // cooling_off is advanced automatically; nothing the user says answers it.
    return this.advance(s, 'cooling_off');
  }

  private async advance(s: Extract<State, { k: 'confirm' }>, finished: Step['kind']): Promise<TurnOutput> {
    const done = [...s.done, finished];
    const next = s.steps[s.i + 1];
    if (next?.kind === 'cooling_off') return this.startCooling({ ...s, done, i: s.i + 1 }, next.seconds);
    if (next) {
      this.s = { ...s, done, i: s.i + 1 };
      return this.reply(promptFor(next), this.awaitingNow(), { band: s.a.band });
    }
    this.s = { k: 'idle' };
    const say = await this.executeSend(s.a, s.facts, s.steps, done, s.note);
    return this.reply(say, 'command', { band: s.a.band });
  }

  private startCooling(s: Extract<State, { k: 'confirm' }>, seconds: number): TurnOutput {
    const id = `${s.facts.payeeId}-${this.now().getTime()}`;
    const until = this.now().getTime() + seconds * 1000;
    this.d.account.hold(id, s.facts.amount);
    this.d.audit.append('cooling_off_started', { payeeId: s.facts.payeeId, amount: s.facts.amount, seconds });
    const timer = this.timer(() => { void this.releaseHold(); }, seconds * 1000);
    this.s = { k: 'cooling', id, timer, until, payee: s.a.payee, facts: s.facts, a: s.a, note: s.note, done: s.done, steps: s.steps };
    return this.reply(`${promptFor({ kind: 'cooling_off', seconds })} I am holding ${money(s.facts.amount, s.facts.currency)} for ${s.a.payee.name}.`, 'cooling', { band: s.a.band, holdUntil: until });
  }

  private cooling(ctl: Control | null): TurnOutput {
    const s = this.s;
    if (s.k !== 'cooling') return this.reply('Nothing is on hold.', 'command');
    if (ctl === 'cancel' || ctl === 'stop' || ctl === 'no') {
      this.untimer(s.timer);
      this.d.account.release(s.id);
      return this.cancelAll('cancelled during cooling-off', 'Cancelled. The held payment was not sent.');
    }
    const left = Math.max(0, Math.ceil((s.until - this.now().getTime()) / 1000));
    return this.reply(`The payment to ${s.payee.name} is on hold for ${left} more seconds. Say cancel to stop it.`, 'cooling', { band: s.a.band, holdUntil: s.until });
  }

  private async releaseHold() {
    const s = this.s;
    if (s.k !== 'cooling') return;
    this.s = { k: 'idle' };
    let say: string;
    try { say = await this.executeSend(s.a, s.facts, s.steps, [...s.done, 'cooling_off'], s.note); }
    catch { say = 'The held payment could not be completed and nothing was sent.'; }
    finally { this.d.account.release(s.id); }
    this.outbox.push(say);
  }

  private async executeSend(a: Ready, facts: ActionFacts, steps: Step[], done: string[], note: string): Promise<string> {
    const required = steps.map((x) => x.kind);
    const token = this.d.mint.mint(facts, a.band, done);
    try {
      const res = await this.d.executor.send(token, facts, required, a.payee, note);
      const what = `${money(a.amount, a.currency)} to ${a.payee.name}`;
      if (res.status === 'denied') return `PayPal declined the payment of ${what}. Nothing was sent.`;
      return res.status === 'pending' ? `Done. ${what} is on its way.` : `Done. I sent ${what}.`;
    } catch (e) {
      this.d.audit.append('error', { stage: 'execute', message: e instanceof Error ? e.message.slice(0, 200) : 'error' });
      return 'I could not complete that payment, and I cannot confirm that money moved. Please check your PayPal activity before trying again.';
    }
  }

  // ───────────────────────── split bill ─────────────────────────

  private async beginSplit(input: TurnInput, a: Extract<ProposedAction, { kind: 'split_bill' }>): Promise<TurnOutput> {
    if (!this.heardClearly(input)) return this.reply('I did not catch that clearly. Could you say it again?', 'command');
    if (!(a.total > 0) || Math.abs(a.total * 100 - Math.round(a.total * 100)) > 1e-6) {
      return this.reply('I did not catch a valid total. Please say the amount again.', 'command');
    }
    const snap = await this.d.account.snapshot();
    const people: Contact[] = [];
    for (const spoken of a.payeesSpoken) {
      const r = resolvePayee(spoken, snap.contacts);
      if (r.status !== 'resolved' || r.phoneticNeighbour || !r.chosen) {
        return this.reply(`I could not match ${spoken} to exactly one saved contact. Please tell me the split again, or send them each a payment request one at a time.`, 'command');
      }
      if (hasConfusableChars(r.chosen.name)) return this.reply(`${r.chosen.name} has look-alike characters in their name, so I will not request money from them.`, 'command');
      if (!people.some((p) => p.id === r.chosen!.id)) people.push(r.chosen);
    }
    const parts = people.length + (a.includeSelf ? 1 : 0);
    const each = Math.floor((a.total / parts) * 100) / 100;
    if (each <= 0) return this.reply('That total is too small to split.', 'command');
    const note = (a.note ?? 'Shared expense').slice(0, 100);
    const shares = people.map((to) => ({ to, amount: round2(each) }));
    this.d.audit.append('assessment', { kind: 'split', total: a.total, parts, each, payees: people.map((p) => p.id) });
    this.s = { k: 'confirm_split', shares, currency: a.currency, note, total: a.total };
    return this.reply(`Split ${money(a.total, a.currency)} ${parts} ways, ${money(each, a.currency)} each. I will send a payment request to ${people.map((p) => p.name).join(' and ')}. Say yes to send the requests, or no to cancel.`, 'yes_no', { band: 'low' });
  }

  private async confirmSplit(input: TurnInput, ctl: Control | null): Promise<TurnOutput> {
    const s = this.s;
    if (s.k !== 'confirm_split') return this.idle(input);
    if (ctl === 'cancel' || ctl === 'stop' || ctl === 'no') return this.cancelAll('split declined', 'Okay, no requests were sent.');
    if (!this.heardClearly(input, ctl === 'yes')) return this.reply('I did not catch that clearly. Say yes to send the requests, or no to cancel.', 'yes_no');
    if (ctl !== 'yes') return this.reply('Please say just yes, or no.', 'yes_no');
    this.s = { k: 'idle' };
    const sent: string[] = [], failed: string[] = [];
    for (const { to, amount } of s.shares) {
      const facts: ActionFacts = { kind: 'invoice', payeeId: to.id, amount, currency: s.currency, note: s.note };
      const token = this.d.mint.mint(facts, 'low', ['confirm_yes']);
      try { await this.d.executor.invoice(token, facts, ['confirm_yes'], to, s.note); sent.push(to.name); }
      catch { failed.push(to.name); }
    }
    const ok = sent.length ? `Done. I sent payment requests to ${sent.join(' and ')}.` : '';
    const bad = failed.length ? ` I could not send the request to ${failed.join(' and ')}.` : '';
    return this.reply(`${ok}${bad}`.trim(), 'command');
  }

  // ───────────────────────── read-only ─────────────────────────

  /** Names come from the network, so they are screened before being spoken. */
  private speakName(name: string): string {
    const scan = scanUntrusted(name);
    return scan.suspicious ? 'a sender whose name looks suspicious' : scan.sanitized;
  }

  private async query(q: string): Promise<TurnOutput> {
    const t = q.toLowerCase();
    const snap = await this.d.account.snapshot();
    const cur = snap.balances[0]?.currency ?? 'USD';

    if (/\b(balance|funds|how much (money|cash)?.{0,20}\b(have|got|left|available))\b/.test(t)) {
      if (!snap.balances.length) return this.reply('I could not find a balance on this account.', 'command');
      // Say when the figure already accounts for a payment PayPal has not caught up on, so it does
      // not look wrong against PayPal's own screens.
      const lag = snap.pendingOut > 0
        ? ` That already takes off ${money(snap.pendingOut, cur)} you sent recently, which PayPal has not finished recording.`
        : '';
      return this.reply(`Your PayPal balance is ${snap.balances.map((b) => money(b.available, b.currency)).join(', and ')}.${lag}`, 'command', { band: 'read' });
    }

    const days = /\btoday\b/.test(t) ? 1 : /\bweek\b/.test(t) ? 7 : /\byear\b/.test(t) ? 365 : 30;
    const label = days === 1 ? 'today' : days === 7 ? 'in the last week' : days === 365 ? 'in the last year' : 'in the last 30 days';

    if (/\b(spent|spend|spending)\b/.test(t)) {
      const cutoff = this.now().getTime() - days * 86_400_000;
      const out = snap.history.filter((x) => x.direction === 'out' && x.status === 'completed' && Date.parse(x.date) >= cutoff);
      const total = out.reduce((a, x) => a + x.amount, 0);
      if (!out.length) return this.reply(`I see no spending ${label}.`, 'command', { band: 'read' });
      const top = topPayees(out).slice(0, 3).map(([n, v]) => `${this.speakName(n)}, ${money(round2(v), cur)}`).join('; ');
      return this.reply(`You spent ${money(round2(total), cur)} ${label}, across ${out.length} ${out.length === 1 ? 'payment' : 'payments'}. Biggest: ${top}.`, 'command', { band: 'read' });
    }

    if (!/\b(recent|latest|last|history|transactions?|activity|payments?)\b/.test(t)) {
      return this.reply('I can tell you your balance, your recent activity, or what you spent. Which would you like?', 'command');
    }
    const recent = snap.history.filter((x) => x.status === 'completed').slice(0, 3);
    if (!recent.length) return this.reply('I do not see any recent activity.', 'command', { band: 'read' });
    const lines = recent.map((x) => `${x.direction === 'out' ? 'Paid' : 'Received'} ${money(x.amount, x.currency)} ${x.direction === 'out' ? 'to' : 'from'} ${this.speakName(x.counterpartyName)}`);
    return this.reply(`Your latest activity: ${lines.join('. ')}.`, 'command', { band: 'read' });
  }

  private reviewAudit(): TurnOutput {
    const rows = this.d.audit.recent({ sinceMs: 86_400_000, limit: 200 });
    const n = (t: string) => rows.filter((r) => r.type === t).length;
    const chain = this.d.audit.verify();
    const parts = [`${n('executed')} completed`, `${n('blocked')} blocked`, `${n('cancelled')} cancelled`];
    const last = rows.find((r) => r.type === 'blocked');
    const why = last && Array.isArray(last.data.signals) && last.data.signals.length ? ` The latest block was because of ${(last.data.signals as string[]).slice(0, 2).join(' and ').replace(/_/g, ' ')}.` : '';
    return this.reply(`In the last day: ${parts.join(', ')}.${why} The activity log ${chain.ok ? 'is intact' : 'has been tampered with'}.`, 'command', { band: 'read' });
  }
}

function topPayees(txns: Transaction[]): [string, number][] {
  const m = new Map<string, number>();
  for (const x of txns) m.set(x.counterpartyName, (m.get(x.counterpartyName) ?? 0) + x.amount);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
