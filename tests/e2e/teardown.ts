import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export default function teardown() {
  const root = process.env.BENCH_E2E_ROOT;
  if (!root || dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('fsa-e2e-')) throw new Error('端到端测试临时目录越界。');
  rmSync(root, { recursive: true, force: true });
}
