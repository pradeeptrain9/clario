import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { DEMO_CONTACTS } from '../src/mock/dataset.js';
import { SandboxPayPal } from '../src/paypal/adapter.js';
import { PayPalClient } from '../src/paypal/client.js';

// Usage:
//   npm run seed-sandbox                 writes data/contacts.json (the voice-name -> sandbox email map)
//   npm run seed-sandbox -- --payouts    ALSO sends a few small payouts so spending history exists.
//                                        Sandbox money only; refuses to run against a non-sandbox host.
// Edit the contacts file afterwards to point names at your own sandbox personal accounts.
const withPayouts = process.argv.includes('--payouts');

const contactsFile = join(config.CLARIO_DATA_DIR, 'contacts.json');
await mkdir(config.CLARIO_DATA_DIR, { recursive: true });
await writeFile(contactsFile, JSON.stringify(DEMO_CONTACTS, null, 2) + '\n', { flag: 'wx' }).then(
  () => console.log(`Wrote ${contactsFile}`),
  (e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; console.log(`${contactsFile} already exists; left untouched.`); },
);

if (!withPayouts) process.exit(0);
if (!config.PAYPAL_API_BASE.includes('sandbox')) throw new Error('Refusing to send payouts to a non-sandbox host.');

const paypal = new SandboxPayPal(new PayPalClient({ baseUrl: config.PAYPAL_API_BASE, clientId: config.PAYPAL_CLIENT_ID, clientSecret: config.PAYPAL_CLIENT_SECRET }));
const contacts = await paypal.getContacts();
const plan: [string, number][] = [['c_maria', 15], ['c_maria', 15], ['c_jon', 20], ['c_john', 50]];
const stamp = Date.now();
for (const [i, [id, amount]] of plan.entries()) {
  const to = contacts.find((c) => c.id === id);
  if (!to) { console.log(`skip: no contact ${id}`); continue; }
  const r = await paypal.sendPayout({ to, amount, currency: 'USD', note: 'Clario sandbox seed', idempotencyKey: `seed-${stamp}-${i}` });
  console.log(`payout ${amount} USD -> ${to.name}: ${r.status} (${r.batchId})`);
}
console.log('Done. Sandbox reporting can lag up to ~3 hours before these appear in history.');
