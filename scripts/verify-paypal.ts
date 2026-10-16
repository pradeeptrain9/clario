import { config } from '../src/config.js';
import { PayPalClient, PayPalError } from '../src/paypal/client.js';
import { SandboxPayPal } from '../src/paypal/adapter.js';

// Read-only: authenticates, then reads balances and the last week of transactions. Moves no money.
if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) {
  console.error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set.');
  process.exit(1);
}
const paypal = new SandboxPayPal(new PayPalClient({ baseUrl: config.PAYPAL_API_BASE, clientId: config.PAYPAL_CLIENT_ID, clientSecret: config.PAYPAL_CLIENT_SECRET }));

let failed = false;
async function check(name: string, fn: () => Promise<string>) {
  try { console.log(`OK    ${name}: ${await fn()}`); }
  catch (e) {
    failed = true;
    const hint = e instanceof PayPalError && e.status === 403 ? ' (enable the feature on your sandbox REST app)' : '';
    console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : e}${hint}`);
  }
}

console.log(`Base URL: ${config.PAYPAL_API_BASE}\n`);
await check('authentication + balances', async () => {
  const b = await paypal.getBalances();
  return b.length ? b.map((x) => `${x.available.toFixed(2)} ${x.currency}`).join(', ') : 'no balances reported';
});
await check('Transaction Search (last 7 days)', async () => {
  const to = new Date(), from = new Date(to.getTime() - 7 * 86_400_000);
  return `${(await paypal.listTransactions(from.toISOString(), to.toISOString())).length} transactions`;
});
process.exit(failed ? 1 : 0);
