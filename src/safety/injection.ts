/**
 * Text that arrives from PayPal — invoice memos, payer names, transaction subjects — is written by
 * whoever sent it, i.e. potentially an attacker. It is data, never instructions.
 */
const PATTERNS: [string, RegExp][] = [
  ['override_instructions', /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all|your)\b/i],
  ['role_hijack', /\b(you are now|act as|pretend to be|new instructions?|system prompt|developer mode)\b/i],
  ['fake_role_marker', /(^|\n)\s*(system|assistant|user|human)\s*:|<\s*\/?\s*(system|instructions?)\s*>|\[\/?inst\]/i],
  ['payment_command', /\b(send|transfer|pay|wire)\b[^.]{0,40}(\$|\bdollars?\b|\busd\b|\d{2,})/i],
  ['secrecy', /\b(do not|don't|never)\b[^.]{0,30}\b(tell|inform|mention|alert|warn|ask)\b/i],
  ['skip_confirmation', /\b(without|skip|no need)\b[^.]{0,20}\b(confirm|confirmation|verif|asking|passphrase)\w*/i],
  ['credential_request', /\b(passphrase|password|pin|otp|one[- ]time code|verification code)\b/i],
];
// Zero-width, bidi-override and other invisible control characters.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤﻿]/g;

export interface Scan { suspicious: boolean; matches: string[]; sanitized: string }

export function scanUntrusted(raw: string): Scan {
  const matches = PATTERNS.filter(([, re]) => re.test(raw)).map(([name]) => name);
  if (INVISIBLE.test(raw)) matches.push('hidden_characters');
  if (raw.length > 400) matches.push('unusually_long');
  const sanitized = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return { suspicious: matches.length > 0, matches, sanitized };
}

/** Fence untrusted text for inclusion in an LLM prompt. The fence cannot be closed from inside. */
export function fenceUntrusted(source: string, text: string): string {
  const safe = scanUntrusted(text).sanitized.replace(/[<>]/g, '');
  return `<untrusted_data source="${source.replace(/[^a-z _-]/gi, '')}">${safe}</untrusted_data>`;
}

/** How memo text may be spoken to the user: always attributed, never as the assistant's own words. */
export function speakableMemo(raw: string): string {
  const s = scanUntrusted(raw);
  if (s.suspicious) return 'The note on this contains text that looks like instructions, so I will not read it out.';
  return s.sanitized ? `The sender's note says: ${s.sanitized}` : '';
}
