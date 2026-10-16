import { GoogleGenAI } from '@google/genai';
import { config } from '../src/config.js';

if (!config.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
const names: string[] = [];
for await (const m of await ai.models.list({ config: { pageSize: 100 } })) {
  if (m.name && (m.supportedActions ?? []).includes('generateContent')) names.push(m.name.replace(/^models\//, ''));
}

console.log(`${names.length} models support generateContent with this key.\n`);
for (const [label, id] of [['GEMINI_FAST_MODEL', config.GEMINI_FAST_MODEL], ['GEMINI_REVIEW_MODEL', config.GEMINI_REVIEW_MODEL]] as const) {
  console.log(`${names.includes(id) ? 'OK     ' : 'MISSING'}  ${label}=${id}`);
}
console.log('\nGemini text models:');
for (const n of names.filter((x) => x.startsWith('gemini')).sort()) console.log(`  ${n}`);
