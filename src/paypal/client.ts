export class PayPalError extends Error {
  constructor(public status: number, public body: unknown, message: string) { super(message); }
}

export interface ClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Single OAuth2 + retry path for every PayPal REST call. */
export class PayPalClient {
  private token: { value: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(private o: ClientOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.value;
    if (this.inflight) return this.inflight; // de-dupe concurrent refreshes
    this.inflight = (async () => {
      const basic = Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString('base64');
      const res = await this.f(`${this.o.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
      const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
      if (!res.ok || !json.access_token) throw new PayPalError(res.status, json, `PayPal auth failed (${res.status})`);
      this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 300) * 1000 };
      return this.token.value;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async request<T>(method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string | number>; body?: unknown; requestId?: string } = {}): Promise<T> {
    const url = new URL(this.o.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    // GETs are always safe to retry; POSTs only when PayPal-Request-Id makes them idempotent.
    const retriable = method === 'GET' || !!opts.requestId;
    const maxAttempts = retriable ? 4 : 1;

    for (let attempt = 1; ; attempt++) {
      const token = await this.getToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
      const res = await this.f(url, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });

      if (res.status === 401 && attempt === 1) { this.token = null; continue; } // token revoked: refresh once
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        await this.sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (!res.ok) throw new PayPalError(res.status, json, describe(res.status, json, path));
      return json as T;
    }
  }
}

function safeJson(t: string): unknown { try { return JSON.parse(t); } catch { return t; } }

function describe(status: number, body: unknown, path = ''): string {
  const b = body as { name?: string; message?: string } | undefined;
  if (status === 403) {
    // A 403 means the sandbox app lacks a feature; name the one this endpoint needs.
    const feature = path.includes('/reporting/') ? 'Transaction Search'
      : path.includes('/payouts') ? 'Payouts'
      : path.includes('/invoicing') ? 'Invoicing' : null;
    return feature
      ? `PayPal refused the request (403). Is ${feature} enabled on your sandbox REST app?`
      : 'PayPal refused the request (403). Check the features enabled on your sandbox REST app.';
  }
  return `PayPal ${status}${b?.name ? ` ${b.name}` : ''}${b?.message ? `: ${b.message}` : ''}`;
}
