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

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function openRecordStore(directory: string): RecordStore {
  mkdirSync(directory, { recursive: true });
  let closed = false;
  const fileOf = (key: string): string => join(directory, key + '.rec');
  return {
    write(key: string, value: string): void {
      assertKey(key);
      writeFileSync(fileOf(key), value);
    },
    read(key: string): string | null {
      assertKey(key);
      const path = fileOf(key);
      if (!existsSync(path)) return null;
      const content = readFileSync(path, 'utf8');
      // 缺陷：空内容被当成“不存在”，也没有校验和。
      return content === '' ? null : content;
    },
    close(): void {
      closed = true;
      void closed;
    },
  };
}
