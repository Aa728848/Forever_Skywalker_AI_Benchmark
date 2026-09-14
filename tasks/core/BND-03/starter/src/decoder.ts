export class InvalidUtf8Error extends Error {
  readonly offset: number;
  constructor(offset: number) {
    super('非法 UTF-8 字节序列，起始偏移 ' + offset);
    this.name = 'InvalidUtf8Error';
    this.offset = offset;
  }
}

export class IncompleteSequenceError extends Error {
  constructor(message = '流结束时仍有未完成的多字节序列') {
    super(message);
    this.name = 'IncompleteSequenceError';
  }
}

export class StreamDecoder {
  #offset = 0;

  push(bytes: Uint8Array): string {
    const start = this.#offset;
    this.#offset += bytes.length;
    try {
      // 缺陷：每块独立解码，不保留跨块状态——被拆开的多字节字符直接报错。
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new InvalidUtf8Error(start);
    }
  }

  end(): string {
    return '';
  }

  get offset(): number {
    return this.#offset;
  }
}
