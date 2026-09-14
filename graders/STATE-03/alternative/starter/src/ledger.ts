export interface Journal {
  append(entry: string): void;
  read(): readonly string[];
}

export class LedgerError extends Error {
  readonly entry: string;
  constructor(entry: string) {
    super('日志条目非法：' + entry);
    this.name = 'LedgerError';
    this.entry = entry;
  }
}

export function parseAmount(entry: string): number {
  const value = Number(entry);
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new LedgerError(entry);
  return value;
}

/** 替代实现：缓存 journal 读取结果，用已见条目数判定重放范围。 */
export class CheckpointStore {
  readonly #journal: Journal;
  #balance = 0;
  #applied: string[] = [];
  #seen = 0;

  constructor(journal: Journal) {
    this.#journal = journal;
    this.recover();
  }

  get balance(): number {
    return this.#balance;
  }

  get checkpoint(): number {
    return this.#seen;
  }

  apply(entries: readonly number[]): number {
    const appended = entries.map(amount => String(amount));
    for (const entry of appended) this.#journal.append(entry);
    this.#applied = [...this.#applied, ...appended.map(parseAmount)];
    this.#seen += appended.length;
    this.#balance = this.#applied.reduce((sum, amount) => sum + amount, 0);
    return this.#balance;
  }

  recover(): number {
    const entries = this.#journal.read();
    for (const entry of entries.slice(this.#seen)) this.#applied = [...this.#applied, parseAmount(entry)];
    this.#seen = entries.length;
    this.#balance = this.#applied.reduce((sum, amount) => sum + amount, 0);
    return this.#balance;
  }
}
