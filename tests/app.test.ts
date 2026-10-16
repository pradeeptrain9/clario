import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ruleParse } from '../src/ai/ruleParser.js';
import { createApp } from '../src/app.js';
import { MockPayPal } from '../src/mock/adapter.js';
import { AuditLog } from '../src/safety/audit.js';
import { Account } from '../src/session/account.js';
import { hashPassphrase } from '../src/session/pin.js';

let base = '';
let close: () => void;

beforeAll(async () => {
  const app = createApp({ mode: 'mock', account: new Account(new MockPayPal()), understand: async (t) => ruleParse(t),
    audit: new AuditLog(), geminiEnabled: false, passphrase: hashPassphrase('blue harbor seven') });
  const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('HTTP API', () => {
  it('reports health without exposing secrets', async () => {
    const j = await (await fetch(`${base}/api/health`)).json();
    expect(j).toMatchObject({ ok: true, mode: 'mock', adapter: 'mock', passphraseSet: true });
    expect(JSON.stringify(j)).not.toMatch(/key|secret/i);
  });

  it('runs a session end to end', async () => {
    const s = await (await post('/api/session', {})).json();
    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const t = await (await post('/api/turn', { sessionId: s.sessionId, text: 'what is my balance', confidence: 1, isFinal: true })).json();
    expect(t.say).toMatch(/balance is/i);
    expect(t.band).toBe('read');
    expect(t.events).toEqual([]);
  });

  it('serves the page with a locked-down CSP', async () => {
    const r = await fetch(base + '/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await r.text()).toContain('<title>Clario</title>');
  });

  it('rejects unknown sessions, bad bodies, wrong content type and cross-origin posts', async () => {
    expect((await post('/api/turn', { sessionId: crypto.randomUUID(), text: 'hi' })).status).toBe(404);
    expect((await post('/api/turn', { sessionId: 'nope', text: '' })).status).toBe(400);
    expect((await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await post('/api/session', {}, { Origin: 'https://evil.example' })).status).toBe(403);
  });

  it('exposes a verifiable audit trail', async () => {
    const j = await (await fetch(`${base}/api/audit`)).json();
    expect(j.chain.ok).toBe(true);
  });
});
