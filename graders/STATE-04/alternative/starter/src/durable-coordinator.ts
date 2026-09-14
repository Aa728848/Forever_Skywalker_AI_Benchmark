import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export type CrashPoint = 'before-commit' | 'after-commit' | 'after-cache' | 'after-ui';
export interface View { readonly revision: number; readonly values: readonly string[] }
export interface Views { readonly service: View; readonly cache: View; readonly ui: View }
interface Entry { readonly key: string; readonly value: string }
export class DurableConflictError extends Error { constructor() { super('同一事务键对应不同内容'); } }
export class DurableCoordinator {
  #directory: string;
  #checkpoint: (point: CrashPoint) => void;
  constructor(directory: string, checkpoint: (point: CrashPoint) => void = () => {}) {
    this.#directory = directory; this.#checkpoint = checkpoint; mkdirSync(directory, { recursive: true });
    this.recover();
  }
  #entries(): Entry[] { const file = join(this.#directory, 'transactions.jsonl'); return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Entry) : []; }
  #view(entries: readonly Entry[]): View { return { revision: entries.length, values: entries.map(entry => entry.value) }; }
  #write(name: string, value: unknown): void { const file = join(this.#directory, name); writeFileSync(file + '.tmp', JSON.stringify(value), { flush: true }); renameSync(file + '.tmp', file); }
  #projection(name: string): View { const file = join(this.#directory, name); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as View : { revision: 0, values: [] }; }
  snapshot(): Views { return { service: this.#view(this.#entries()), cache: this.#projection('cache.json'), ui: this.#projection('ui.json') }; }
  recover(): Views { const view = this.#view(this.#entries()); this.#write('cache.json', view); this.#write('ui.json', view); return this.snapshot(); }
  notify(revision: number): Views { const entries = this.#entries(); if (!Number.isSafeInteger(revision) || revision < 0 || revision > entries.length) throw new RangeError('通知版本非法'); return this.recover(); }
  async commit(key: string, value: string): Promise<View> {
    const entries = this.#entries(); const existing = new Map(entries.map(entry => [entry.key, entry])).get(key);
    if (existing !== undefined) { if (existing.value !== value) throw new DurableConflictError(); return this.recover().service; }
    this.#checkpoint('before-commit'); const entry = { key, value }; appendFileSync(join(this.#directory, 'transactions.jsonl'), JSON.stringify(entry) + '\n', { flush: true }); entries.push(entry); this.#checkpoint('after-commit');
    const view = this.#view(entries); this.#write('cache.json', view); this.#checkpoint('after-cache'); this.#write('ui.json', view); this.#checkpoint('after-ui'); return view;
  }
}
