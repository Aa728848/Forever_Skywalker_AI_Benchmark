export interface RecordStore {
  write(key: string, value: string): void;
  read(key: string): string | null;
  close(): void;
}

export class CorruptRecordError extends Error {
  readonly key: string;
  constructor(key: string) {
    super('记录损坏：' + key);
    this.name = 'CorruptRecordError';
    this.key = key;
  }
}

export class StoreClosedError extends Error {
  constructor() {
    super('存储已关闭');
    this.name = 'StoreClosedError';
  }
}

const keyPattern = /^[A-Za-z0-9._-]+$/;

export function assertKey(key: string): void {
  if (!keyPattern.test(key)) throw new RangeError('非法记录键：' + key);
}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface StoredRecord { readonly checksum: string; readonly value: string }

function checksumOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function openRecordStore(directory: string): RecordStore {
  mkdirSync(directory, { recursive: true });
  let closed = false;
  const fileOf = (key: string): string => join(directory, key + '.rec');
  const assertOpen = (): void => {
    if (closed) throw new StoreClosedError();
  };
  return {
    write(key: string, value: string): void {
      assertKey(key);
      assertOpen();
      const temporary = fileOf(key) + '.staging';
      try {
        writeFileSync(temporary, JSON.stringify({ checksum: checksumOf(value), value }));
        renameSync(temporary, fileOf(key));
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    },
    read(key: string): string | null {
      assertKey(key);
      assertOpen();
      const path = fileOf(key);
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, 'utf8');
      let record: unknown;
      try {
        record = JSON.parse(raw);
      } catch {
        throw new CorruptRecordError(key);
      }
      if (typeof record !== 'object' || record === null) throw new CorruptRecordError(key);
      const value = (record as { value?: unknown }).value;
      const checksum = (record as { checksum?: unknown }).checksum;
      if (typeof value !== 'string' || checksum !== checksumOf(value)) throw new CorruptRecordError(key);
      return value;
    },
    close(): void {
      closed = true;
    },
  };
}
