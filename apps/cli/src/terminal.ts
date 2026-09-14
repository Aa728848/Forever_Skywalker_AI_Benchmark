import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';

/** 密钥通过交互 stdin 输入，不作为 argv、命令历史或普通输出的一部分。 */
export function createTerminalIO(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, terminal = Boolean((input as ReadStream).isTTY)) {
  let hidden = false;
  const echo = new Writable({ write(chunk, encoding, callback) {
    if (!hidden) output.write(chunk, encoding);
    callback();
  } });
  Object.defineProperty(echo, 'columns', { get: () => (output as WriteStream).columns });
  const reader = createInterface({ input, output: echo, terminal, crlfDelay: Infinity, historySize: 0 });
  const lines = reader[Symbol.asyncIterator]();
  reader.on('SIGINT', () => reader.close());
  async function ask(prompt: string, secret = false): Promise<string | null> {
    hidden = secret;
    reader.setPrompt(prompt);
    output.write(prompt);
    try {
      const line = await lines.next();
      return line.done ? null : line.value;
    } finally {
      if (secret && terminal) output.write('\n');
      hidden = false;
    }
  }
  return {
    ask: (prompt: string) => ask(prompt),
    secret: (prompt: string) => ask(`${prompt}（输入不回显）：`, true),
    say: (message: string) => { output.write(message + '\n'); },
    close: () => { reader.close(); echo.end(); },
  };
}
