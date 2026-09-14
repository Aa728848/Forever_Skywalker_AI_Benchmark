import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
    // 缺陷：重启不重建提交后尚未完成的缓存与界面投影。
  }
  #entries(): Entry[] { const file = join(this.#directory, 'journal.json'); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Entry[] : []; }
  #view(entries: readonly Entry[]): View { return { revision: entries.length, values: entries.map(entry => entry.value) }; }
  #write(name: string, value: unknown): void { const file = join(this.#directory, name); writeFileSync(file + '.tmp', JSON.stringify(value), { flush: true }); renameSync(file + '.tmp', file); }
  #projection(name: string): View { const file = join(this.#directory, name); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as View : { revision: 0, values: [] }; }
  snapshot(): Views { return { service: this.#view(this.#entries()), cache: this.#projection('cache.json'), ui: this.#projection('ui.json') }; }
  recover(): Views { const view = this.#view(this.#entries()); this.#write('cache.json', view); this.#write('ui.json', view); return this.snapshot(); }
  notify(revision: number): Views { const entries = this.#entries(); if (!Number.isSafeInteger(revision) || revision < 0 || revision > entries.length) throw new RangeError('通知版本非法'); const view = this.#view(entries.slice(0, revision)); this.#write('cache.json', view); this.#write('ui.json', view); return this.snapshot(); }
  async commit(key: string, value: string): Promise<View> {
    const entries = this.#entries(); const existing = entries.find(entry => entry.key === key);
    if (existing !== undefined) { if (existing.value !== value) throw new DurableConflictError(); return this.recover().service; }
    this.#checkpoint('before-commit'); entries.push({ key, value }); this.#write('journal.json', entries); this.#checkpoint('after-commit');
    const view = this.#view(entries); this.#write('cache.json', view); this.#checkpoint('after-cache'); this.#write('ui.json', view); this.#checkpoint('after-ui'); return view;
  }
}
