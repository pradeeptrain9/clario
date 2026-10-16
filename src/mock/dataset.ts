import type { Contact, Transaction } from '../types.js';

/** Small deterministic PRNG so the demo history is identical on every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEMO_CONTACTS: Contact[] = [
  { id: 'c_maria', name: 'Maria', email: 'maria.sister@example.com', relationship: 'your sister' },
  { id: 'c_mariah', name: 'Mariah', email: 'mariah.coworker@example.com', relationship: 'a coworker' },
  { id: 'c_jon', name: 'Jon', email: 'jon.friend@example.com', relationship: 'your friend from book club' },
  { id: 'c_john', name: 'John', email: 'john.landlord@example.com', relationship: 'your landlord' },
  { id: 'c_priya', name: 'Priya', email: 'priya.friend@example.com', relationship: 'your friend' },
  { id: 'c_erin', name: 'Erin', email: 'erin.neighbor@example.com', relationship: 'your neighbor' },
  { id: 'c_aaron', name: 'Aaron', email: 'aaron.cousin@example.com', relationship: 'your cousin' },
];

const MERCHANTS = {
  groceries: ['Green Valley Market', 'Corner Fresh Foods', 'Harvest Grocery'],
  utilities: ['City Power & Light', 'Aqua Water Co'],
  transport: ['Metro Transit', 'RideNow'],
  dining: ['Luna Bistro', 'Noodle House'],
  health: ['Wellness Pharmacy'],
};

const iso = (d: Date) => d.toISOString();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Build ~12 months of history ending at `now`. */
export function buildHistory(now: Date, seed = 42): Transaction[] {
  const rnd = mulberry32(seed);
  const out: Transaction[] = [];
  let n = 0;
  const id = () => `mock_${String(++n).padStart(4, '0')}`;
  const daysAgo = (d: number, hour = 12) => {
    const t = new Date(now);
    t.setUTCDate(t.getUTCDate() - d);
    t.setUTCHours(hour, Math.floor(rnd() * 60), 0, 0);
    return t;
  };
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const contact = (cid: string) => DEMO_CONTACTS.find((c) => c.id === cid)!;

  for (let m = 0; m < 12; m++) {
    const base = m * 30 + 3;
    // Paycheck in, twice a month
    for (const off of [base, base + 15]) {
      out.push({ id: id(), date: iso(daysAgo(off, 9)), direction: 'in', amount: 1850, currency: 'USD',
        counterpartyName: 'Brightside Employer Inc', description: 'Payroll', category: 'income', status: 'completed' });
    }
    // Rent to the landlord
    const john = contact('c_john');
    out.push({ id: id(), date: iso(daysAgo(base + 2, 10)), direction: 'out', amount: 1200, currency: 'USD',
      counterpartyName: john.name, counterpartyEmail: john.email, contactId: john.id,
      description: 'Monthly rent', category: 'housing', status: 'completed' });
    // Groceries ~weekly
    for (let w = 0; w < 4; w++) {
      out.push({ id: id(), date: iso(daysAgo(base + w * 7 + 1, 17)), direction: 'out',
        amount: round2(38 + rnd() * 55), currency: 'USD', counterpartyName: pick(MERCHANTS.groceries),
        description: 'Groceries', category: 'groceries', status: 'completed' });
    }
    out.push({ id: id(), date: iso(daysAgo(base + 9, 11)), direction: 'out', amount: round2(70 + rnd() * 30),
      currency: 'USD', counterpartyName: MERCHANTS.utilities[0]!, description: 'Electric bill', category: 'utilities', status: 'completed' });
    out.push({ id: id(), date: iso(daysAgo(base + 10, 11)), direction: 'out', amount: round2(28 + rnd() * 10),
      currency: 'USD', counterpartyName: MERCHANTS.utilities[1]!, description: 'Water bill', category: 'utilities', status: 'completed' });
    for (let d = 0; d < 2; d++) {
      out.push({ id: id(), date: iso(daysAgo(base + 4 + d * 11, 19)), direction: 'out', amount: round2(24 + rnd() * 30),
        currency: 'USD', counterpartyName: pick(MERCHANTS.dining), description: 'Dinner', category: 'dining', status: 'completed' });
    }
    out.push({ id: id(), date: iso(daysAgo(base + 6, 8)), direction: 'out', amount: round2(30 + rnd() * 15),
      currency: 'USD', counterpartyName: MERCHANTS.transport[0]!, description: 'Transit pass top-up', category: 'transport', status: 'completed' });
    // Maria (sister): small, regular, ~$15. This is the plausibility anchor for fifty-vs-fifteen.
    const maria = contact('c_maria');
    for (let k = 0; k < 2; k++) {
      out.push({ id: id(), date: iso(daysAgo(base + 5 + k * 12, 14)), direction: 'out', amount: pick([15, 15, 14, 16, 15]),
        currency: 'USD', counterpartyName: maria.name, counterpartyEmail: maria.email, contactId: maria.id,
        description: 'Lunch money', category: 'friends', status: 'completed' });
    }
    // Jon: occasional, $20–45
    if (m % 2 === 0) {
      const jon = contact('c_jon');
      out.push({ id: id(), date: iso(daysAgo(base + 8, 20)), direction: 'out', amount: pick([20, 30, 45, 25]),
        currency: 'USD', counterpartyName: jon.name, counterpartyEmail: jon.email, contactId: jon.id,
        description: 'Book club snacks', category: 'friends', status: 'completed' });
    }
    // Priya: rare
    if (m % 4 === 1) {
      const p = contact('c_priya');
      out.push({ id: id(), date: iso(daysAgo(base + 13, 18)), direction: 'out', amount: 35, currency: 'USD',
        counterpartyName: p.name, counterpartyEmail: p.email, contactId: p.id, description: 'Concert tickets share',
        category: 'entertainment', status: 'completed' });
    }
    if (m % 3 === 0) {
      out.push({ id: id(), date: iso(daysAgo(base + 14, 15)), direction: 'out', amount: round2(12 + rnd() * 20),
        currency: 'USD', counterpartyName: MERCHANTS.health[0]!, description: 'Pharmacy', category: 'health', status: 'completed' });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)); // newest first
}
