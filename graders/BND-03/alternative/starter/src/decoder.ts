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

/** 替代实现：自己维护待续字节缓冲，按 UTF-8 首字节推断序列长度。 */
const sequenceLength = (lead: number): number => {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return -1;
};

export class StreamDecoder {
  #pending: number[] = [];
  #offset = 0;
  #open = false;

  push(bytes: Uint8Array): string {
    if (this.#open) throw new IncompleteSequenceError('解码器已经结束');
    let text = '';
    for (const byte of bytes) {
      this.#pending.push(byte);
      while (this.#pending.length > 0) {
        const lead = this.#pending[0] as number;
        const length = sequenceLength(lead);
        if (length < 0) {
          const at = this.#offset + this.#pending.length - 1;
          this.#pending = [];
          throw new InvalidUtf8Error(at);
        }
        if (this.#pending.length < length) break;
        const slice = this.#pending.slice(0, length);
        this.#pending = this.#pending.slice(length);
        text += new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(slice));
      }
    }
    const consumed = this.#offset;
    this.#offset += bytes.length;
    void consumed;
    return text;
  }

  end(): string {
    if (this.#open) return '';
    this.#open = true;
    if (this.#pending.length > 0) {
      this.#pending = [];
      throw new IncompleteSequenceError();
    }
    return '';
  }

  get offset(): number {
    return this.#offset;
  }
}
