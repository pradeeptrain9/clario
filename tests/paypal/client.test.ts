import { describe, it, expect, vi } from 'vitest';
import { PayPalClient, PayPalError } from '../../src/paypal/client.js';
import { SandboxPayPal } from '../../src/paypal/adapter.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tokenRes = () => json(200, { access_token: 'tok', expires_in: 3600 });

function setup(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    if (url.pathname === '/v1/oauth2/token') return tokenRes();
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  const client = new PayPalClient({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'id', clientSecret: 'sec', fetchImpl, sleep: async () => {} });
  return { client, calls };
}
const authCalls = (calls: { url: URL }[]) => calls.filter((c) => c.url.pathname === '/v1/oauth2/token').length;

describe('PayPalClient', () => {
  it('caches the OAuth token across requests', async () => {
    const { client, calls } = setup(() => json(200, { ok: true }));
    await client.request('GET', '/a'); await client.request('GET', '/b');
    expect(authCalls(calls)).toBe(1);
  });

  it('sends Basic auth built from client id and secret', async () => {
    const { client, calls } = setup(() => json(200, {}));
    await client.request('GET', '/a');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Basic ${Buffer.from('id:sec').toString('base64')}`);
  });

  it('refreshes the token once on a 401 then succeeds', async () => {
    let n = 0;
    const { client, calls } = setup(() => (++n === 1 ? json(401, {}) : json(200, { ok: 1 })));
    await expect(client.request('GET', '/a')).resolves.toEqual({ ok: 1 });
    expect(authCalls(calls)).toBe(2);
  });

  it('retries GET on 429 with backoff', async () => {
    let n = 0;
    const { client } = setup(() => (++n < 3 ? json(429, {}) : json(200, { ok: 1 })));
    await expect(client.request('GET', '/a')).resolves.toEqual({ ok: 1 });
    expect(n).toBe(3);
  });

  it('does NOT retry a POST that has no idempotency key', async () => {
    let n = 0;
    const { client } = setup(() => { n++; return json(500, {}); });
    await expect(client.request('POST', '/pay', { body: {} })).rejects.toBeInstanceOf(PayPalError);
    expect(n).toBe(1);
  });

  it('retries a POST when PayPal-Request-Id makes it idempotent', async () => {
    let n = 0;
    const { client, calls } = setup(() => (++n < 2 ? json(503, {}) : json(201, { ok: 1 })));
    await client.request('POST', '/pay', { body: {}, requestId: 'req-1' });
    expect(n).toBe(2);
    expect((calls.at(-1)!.init.headers as Record<string, string>)['PayPal-Request-Id']).toBe('req-1');
  });

  it('gives an actionable message on 403 (Transaction Search not enabled)', async () => {
    const { client } = setup(() => json(403, { name: 'NOT_AUTHORIZED' }));
    await expect(client.request('GET', '/v1/reporting/balances')).rejects.toThrow(/Transaction Search/);
  });
});

describe('SandboxPayPal', () => {
  it('splits a 70-day range into <=31-day windows', async () => {
    const windows: [string, string][] = [];
    const { client } = setup((url) => {
      windows.push([url.searchParams.get('start_date')!, url.searchParams.get('end_date')!]);
      return json(200, { transaction_details: [], total_pages: 1 });
    });
    const pp = new SandboxPayPal(client);
    await pp.listTransactions('2026-01-01T00:00:00.000Z', '2026-03-12T00:00:00.000Z');
    expect(windows.length).toBe(3);
    for (const [s, e] of windows) expect((Date.parse(e) - Date.parse(s)) / 86_400_000).toBeLessThanOrEqual(31);
  });

  it('pages through multi-page results and maps sign to direction', async () => {
    const { client } = setup((url) => {
      const page = Number(url.searchParams.get('page'));
      return json(200, { total_pages: 2, transaction_details: [{
        transaction_info: { transaction_id: `t${page}`, transaction_initiation_date: '2026-02-01T00:00:00Z', transaction_status: 'S',
          transaction_amount: { currency_code: 'USD', value: page === 1 ? '-40.00' : '25.00' } },
        payer_info: { email_address: 'x@example.com' } }] });
    });
    const tx = await new SandboxPayPal(client).listTransactions('2026-02-01T00:00:00.000Z', '2026-02-10T00:00:00.000Z');
    expect(tx.map((t) => [t.id, t.direction, t.amount]).sort()).toEqual([['t1', 'out', 40], ['t2', 'in', 25]]);
  });

  it('builds a Payouts request with EMAIL recipient, 2dp amount and idempotency header', async () => {
    let body: any; let reqId: string | undefined;
    const { client } = setup((_u, init) => {
      body = JSON.parse(String(init.body)); reqId = (init.headers as Record<string, string>)['PayPal-Request-Id'];
      return json(201, { batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING' } });
    });
    const r = await new SandboxPayPal(client).sendPayout({ to: { id: 'c', name: 'Maria', email: 'm@example.com' }, amount: 40, currency: 'USD', note: 'hi', idempotencyKey: 'k1' });
    expect(r).toEqual({ batchId: 'B1', status: 'pending' });
    expect(reqId).toBe('k1');
    expect(body.items[0]).toMatchObject({ recipient_type: 'EMAIL', receiver: 'm@example.com', amount: { value: '40.00', currency: 'USD' } });
  });
});
