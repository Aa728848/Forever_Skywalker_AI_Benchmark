import { PassThrough, Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { createTerminalIO } from './terminal.ts';

it('终端令牌输入及退格修正不回显，下一普通输入恢复显示', async () => {
  const input = new PassThrough(); let displayed = '';
  const output = new Writable({ write(chunk, _encoding, done) { displayed += chunk.toString(); done(); } });
  const terminal = createTerminalIO(input, output, true);
  try {
    const reading = terminal.secret('输入测试令牌');
    input.write('private-test-keY'); input.write('\u007f'); input.write('y\r');
    expect(await reading).toBe('private-test-key');
    expect(displayed).not.toContain('private-test');
    const next = terminal.ask('普通模型 ID：'); input.write('\u001b[A');
    expect(displayed).not.toContain('private-test');
    input.write('visible-model\r');
    expect(await next).toBe('visible-model'); expect(displayed).toContain('visible-model');
  } finally { terminal.close(); input.destroy(); output.end(); }
});

it('隐藏输入时Ctrl+C或输入结束返回取消，不输出已输入内容', async () => {
  for (const cancel of ['\u0003', null]) {
    const input = new PassThrough(); let displayed = '';
    const output = new Writable({ write(chunk, _encoding, done) { displayed += chunk.toString(); done(); } });
    const terminal = createTerminalIO(input, output, true);
    try {
      const reading = terminal.secret('密钥');
      if (cancel === null) input.end(); else { input.write('private-pending'); input.write(cancel); }
      expect(await reading).toBeNull(); expect(displayed).not.toContain('private-pending');
    } finally { terminal.close(); input.destroy(); output.end(); }
  }
});
