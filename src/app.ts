import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { z } from 'zod';
import type { Understand } from './ai/understand.js';
import { AuditLog } from './safety/audit.js';
import type { Policy } from './safety/ladder.js';
import { TokenMint } from './safety/token.js';
import { Account } from './session/account.js';
import { Dialog } from './session/dialog.js';
import { GuardedExecutor } from './session/executor.js';
import type { PassphraseRecord } from './session/pin.js';

export interface AppDeps {
  mode: 'mock' | 'sandbox';
  account: Account;
  understand: Understand;
  audit: AuditLog;
  geminiEnabled: boolean;
  passphrase?: PassphraseRecord;
  policy?: Policy;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 50;
const TURNS_PER_MINUTE = 60;

const turnBody = z.object({
  sessionId: z.string().uuid(),
  text: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1).optional(),
  isFinal: z.boolean().optional(),
  duringPlayback: z.boolean().optional(),
  lastAssistantText: z.string().max(2000).optional(),
  utcOffsetMinutes: z.number().int().min(-840).max(840).optional(),
});

interface Entry { dialog: Dialog; touched: number; turns: number[] }

export function createApp(deps: AppDeps) {
  const mint = new TokenMint();
  const executor = new GuardedExecutor(deps.account, mint, deps.audit);
  const sessions = new Map<string, Entry>();
  const nowMs = () => (deps.now ?? (() => new Date()))().getTime();

  const sweep = () => {
    for (const [id, e] of sessions) if (!e.dialog.busy && nowMs() - e.touched > SESSION_TTL_MS) sessions.delete(id);
  };
  const get = (id: string) => sessions.get(id);

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; media-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Permissions-Policy': 'microphone=(self)',
    });
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  // State-changing routes must come from our own page: JSON content type (forces a CORS preflight for
  // other origins) plus an Origin that matches Host.
  app.use('/api', (req: Request, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) return void res.status(403).json({ error: 'cross-origin request refused' });
    if (!req.is('application/json')) return void res.status(415).json({ error: 'application/json required' });
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, mode: deps.mode, adapter: deps.account.adapter.kind, gemini: deps.geminiEnabled, passphraseSet: !!deps.passphrase });
  });

  app.post('/api/session', (_req, res) => {
    sweep();
    if (sessions.size >= MAX_SESSIONS) return void res.status(503).json({ error: 'too many active sessions' });
    const id = randomUUID();
    const dialog = new Dialog({ account: deps.account, executor, mint, audit: deps.audit, understand: deps.understand,
      passphrase: deps.passphrase, policy: deps.policy, now: deps.now, setTimer: deps.setTimer, clearTimer: deps.clearTimer });
    sessions.set(id, { dialog, touched: nowMs(), turns: [] });
    const tag = deps.mode === 'sandbox' ? 'PayPal sandbox' : 'demo mode with sample data';
    res.status(201).json({
      sessionId: id, mode: deps.mode,
      say: `Hello, I am Clario. I am connected to ${tag}. Say help to hear what I can do, or tell me what you would like.`,
    });
  });

  app.post('/api/turn', async (req, res) => {
    const body = turnBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'invalid request' });
    const { sessionId, ...input } = body.data;
    const entry = get(sessionId);
    if (!entry) return void res.status(404).json({ error: 'unknown session', say: 'This conversation has expired. Please reload the page.' });

    const t = nowMs();
    entry.turns = entry.turns.filter((x) => t - x < 60_000);
    if (entry.turns.length >= TURNS_PER_MINUTE) return void res.status(429).json({ error: 'slow down', say: 'You are going very fast. Please wait a moment.' });
    entry.turns.push(t);
    entry.touched = t;

    const out = await entry.dialog.turn(input);
    res.json({ ...out, events: entry.dialog.drain() });
  });

  // Held payments finish after the request that started them, so the page polls for their outcome.
  app.get('/api/session/:id/events', (req, res) => {
    const entry = get(String(req.params.id));
    if (!entry) return void res.status(404).json({ error: 'unknown session' });
    entry.touched = nowMs();
    res.json({ events: entry.dialog.drain(), state: entry.dialog.state });
  });

  app.get('/api/audit', (_req, res) => {
    res.json({ chain: deps.audit.verify(), entries: deps.audit.recent({ limit: 50 }) });
  });

  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { index: 'index.html' }));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return void res.status(400).json({ error: 'invalid request' });
    console.error('[server]', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'internal error', say: 'Something went wrong. Nothing was sent.' });
  };
  app.use(onError);

  return app;
}
