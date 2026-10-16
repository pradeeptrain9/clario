import { TokenError, type ActionFacts, type ExecutionToken, type TokenMint } from '../safety/token.js';
import type { AuditLog } from '../safety/audit.js';
import type { Contact, InvoiceRef, PayoutResult } from '../types.js';
import type { Account } from './account.js';

/**
 * The only code path that writes to PayPal. It demands a token minted by the policy engine for exactly
 * this action, with exactly the steps this risk band requires, so neither the model nor a route
 * handler can move money on its own.
 */
export class GuardedExecutor {
  constructor(private account: Account, private mint: TokenMint, private audit: AuditLog) {}

  async send(token: ExecutionToken, facts: ActionFacts, required: string[], to: Contact, note: string): Promise<PayoutResult> {
    this.consume(token, facts, required);
    const res = await this.account.adapter.sendPayout({
      to, amount: facts.amount, currency: facts.currency, note, idempotencyKey: `clario-${token.id}` });
    if (res.status !== 'denied') this.account.recordSend(facts.amount, to.id);
    this.audit.append('executed', { kind: 'send', payeeId: to.id, amount: facts.amount, currency: facts.currency,
      band: token.band, status: res.status, batchId: res.batchId });
    return res;
  }

  async invoice(token: ExecutionToken, facts: ActionFacts, required: string[], to: Contact, note: string): Promise<InvoiceRef> {
    this.consume(token, facts, required);
    const inv = await this.account.adapter.createAndSendInvoice({
      to, amount: facts.amount, currency: facts.currency, note, idempotencyKey: `clario-${token.id}` });
    this.audit.append('executed', { kind: 'invoice', payeeId: to.id, amount: facts.amount, currency: facts.currency,
      band: token.band, invoiceId: inv.id });
    return inv;
  }

  private consume(token: ExecutionToken, facts: ActionFacts, required: string[]) {
    try { this.mint.consume(token, facts, required); }
    catch (e) {
      this.audit.append('refused', { kind: facts.kind, payeeId: facts.payeeId, reason: e instanceof TokenError ? e.message : 'error' });
      throw e;
    }
  }
}
