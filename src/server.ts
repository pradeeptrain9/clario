import { makeUnderstand } from './ai/understand.js';
import { createApp } from './app.js';
import { config, hasGemini } from './config.js';
import { MockPayPal } from './mock/adapter.js';
import { PayPalClient } from './paypal/client.js';
import { SandboxPayPal } from './paypal/adapter.js';
import { AuditLog } from './safety/audit.js';
import { Account } from './session/account.js';
import { hashPassphrase } from './session/pin.js';
import type { PayPalAdapter } from './types.js';

const DEMO_PASSPHRASE = 'blue harbor seven';

const adapter: PayPalAdapter = config.MODE === 'sandbox'
  ? new SandboxPayPal(new PayPalClient({ baseUrl: config.PAYPAL_API_BASE, clientId: config.PAYPAL_CLIENT_ID, clientSecret: config.PAYPAL_CLIENT_SECRET }))
  : new MockPayPal();

const spoken = config.CLARIO_PASSPHRASE || (config.MODE === 'mock' ? DEMO_PASSPHRASE : '');
const app = createApp({
  mode: config.MODE,
  account: new Account(adapter),
  understand: makeUnderstand(config),
  audit: new AuditLog('data/audit.jsonl'),
  geminiEnabled: hasGemini(),
  passphrase: spoken ? hashPassphrase(spoken) : undefined,
});

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`Clario listening on http://${config.HOST}:${config.PORT}`);
  console.log(`  mode:       ${config.MODE} (${adapter.kind} PayPal)`);
  console.log(`  language:   ${hasGemini() ? `Gemini (${config.GEMINI_FAST_MODEL})` : 'offline rule parser (no GEMINI_API_KEY)'}`);
  if (!spoken) console.log('  passphrase: NOT SET. Payments that need a passphrase will be refused. Set CLARIO_PASSPHRASE.');
  else if (!config.CLARIO_PASSPHRASE) console.log(`  passphrase: demo phrase "${DEMO_PASSPHRASE}" (mock mode only)`);
  else console.log('  passphrase: set');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)));
