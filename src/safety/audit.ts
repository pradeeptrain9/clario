import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuditEntry {
  seq: number;
  ts: string;
  type: string;                    // 'assessment' | 'confirmed' | 'cancelled' | 'executed' | 'blocked' | ...
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}
const GENESIS = '0'.repeat(64);
const digest = (e: Omit<AuditEntry, 'hash'>) =>
  createHash('sha256').update(JSON.stringify([e.seq, e.ts, e.type, e.data, e.prevHash])).digest('hex');

/** Append-only, hash-chained decision log: editing or deleting any past entry breaks every later hash. */
export class AuditLog {
  private entries: AuditEntry[] = [];
  constructor(private file?: string, private now: () => Date = () => new Date()) {
    if (file && existsSync(file)) {
      this.entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEntry);
    }
  }

  append(type: string, data: Record<string, unknown>): AuditEntry {
    const prev = this.entries.at(-1);
    const base = { seq: (prev?.seq ?? 0) + 1, ts: this.now().toISOString(), type, data, prevHash: prev?.hash ?? GENESIS };
    const entry: AuditEntry = { ...base, hash: digest(base) };
    this.entries.push(entry);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(entry) + '\n');
    }
    return entry;
  }

  all(): readonly AuditEntry[] { return this.entries; }

  recent(opts: { sinceMs?: number; types?: string[]; limit?: number } = {}): AuditEntry[] {
    const cutoff = opts.sinceMs ? this.now().getTime() - opts.sinceMs : 0;
    return this.entries
      .filter((e) => Date.parse(e.ts) >= cutoff && (!opts.types || opts.types.includes(e.type)))
      .slice(-(opts.limit ?? 20)).reverse();
  }

  verify(): { ok: true } | { ok: false; brokenAt: number } { return verifyChain(this.entries); }
}

export function verifyChain(entries: readonly AuditEntry[]): { ok: true } | { ok: false; brokenAt: number } {
  let prev = GENESIS;
  for (const e of entries) {
    const { hash, ...rest } = e;
    if (e.prevHash !== prev || digest(rest) !== hash) return { ok: false, brokenAt: e.seq };
    prev = hash;
  }
  return { ok: true };
}
