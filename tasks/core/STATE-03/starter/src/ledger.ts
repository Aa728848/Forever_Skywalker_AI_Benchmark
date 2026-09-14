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

export class CheckpointStore {
  readonly #journal: Journal;
  #balance = 0;
  #checkpoint = 0;

  constructor(journal: Journal) {
    this.#journal = journal;
    this.recover();
  }

  get balance(): number {
    return this.#balance;
  }

  get checkpoint(): number {
    return this.#checkpoint;
  }

  apply(entries: readonly number[]): number {
    for (const amount of entries) {
      this.#journal.append(String(amount));
      this.#balance += amount;
      this.#checkpoint += 1;
    }
    return this.#balance;
  }

  recover(): number {
    const entries = this.#journal.read();
    // 缺陷：每次都从头重放整本日志，已入账的部分被重复计入。
    for (const entry of entries) {
      this.#balance += parseAmount(entry);
      this.#checkpoint += 1;
    }
    return this.#balance;
  }
}
