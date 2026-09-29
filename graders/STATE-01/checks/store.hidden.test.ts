import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorruptRecordError, StoreClosedError, openRecordStore } from '../starter/src/store.ts';

function withStore(run: (directory: string, store: ReturnType<typeof openRecordStore>) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'state-01-'));
  const store = openRecordStore(directory);
  try {
    run(directory, store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

test('hidden/empty-string-is-a-value-not-a-missing-key', () => {
  withStore((directory, store) => {
    // 契约第 3 条：缺失返回 null，空字符串是合法值。两者必须可区分。
    assert.equal(store.read('absent'), null, '缺失键应返回 null');
    store.write('blank', '');
    assert.equal(store.read('blank'), '', '空字符串被当成了不存在');
    // 磁盘上必须是带校验和的完整记录，而不是零字节文件。
    const record = JSON.parse(readFileSync(join(directory, 'blank.rec'), 'utf8')) as { checksum: string; value: string };
    assert.equal(record.value, '');
    assert.equal(record.checksum, sha256(''), '空值的校验和不是 sha256("")');
    assert.equal(readFileSync(join(directory, 'blank.rec'), 'utf8').length > 0, true, '空值写出了零字节文件');
    store.write('spaces', '   \t\n  ');
    assert.equal(store.read('spaces'), '   \t\n  ');
  });
});

test('hidden/checksum-must-match-exact-bytes', () => {
  withStore((directory, store) => {
    store.write('target', 'original');
    const path = join(directory, 'target.rec');
    // 契约第 2 条：checksum 与 sha256(value) 不一致即损坏。
    const real = sha256('original');
    for (const bad of [real.toUpperCase(), ' ' + real, real.slice(0, -1), '', '0'.repeat(64)]) {
      writeFileSync(path, JSON.stringify({ checksum: bad, value: 'original' }));
      assert.throws(() => store.read('target'),
        (error: unknown) => error instanceof CorruptRecordError && error.key === 'target',
        'checksum=' + JSON.stringify(bad));
    }
    // 只有精确匹配才通过。
    writeFileSync(path, JSON.stringify({ checksum: real, value: 'original' }));
    assert.equal(store.read('target'), 'original');
  });
});

test('hidden/overwrite-keeps-only-the-latest-record', () => {
  withStore((directory, store) => {
    store.write('key', 'v1');
    store.write('key', 'v2');
    store.write('key', 'v3');
    assert.equal(store.read('key'), 'v3');
    // 多次覆盖不得留下任何暂存或中间文件。
    assert.deepEqual(readdirSync(directory), ['key.rec'], '覆盖写留下了额外文件');
    const record = JSON.parse(readFileSync(join(directory, 'key.rec'), 'utf8')) as { checksum: string; value: string };
    assert.equal(record.value, 'v3');
    assert.equal(record.checksum, sha256('v3'), '覆盖后校验和没跟着更新');
  });
});

test('hidden/unicode-and-multiline-round-trip-exactly', () => {
  withStore((_directory, store) => {
    // 契约第 6 条：换行、中文、emoji 往返一致。
    const samples: Array<[string, string]> = [
      ['lines', '第一行\n第二行\n\n第四行'],
      ['cjk', '中文测试：缓存、并发、边界'],
      ['emoji', '🚀🌟 mixed with text'],
      ['combining', 'é vs é'],
      ['control', 'tab\there\rcr'],
      ['long', 'x'.repeat(10000)],
    ];
    for (const [key, value] of samples) {
      store.write(key, value);
      assert.equal(store.read(key), value, key + ' 往返不一致');
    }
    assert.equal(store.read('lines')!.split('\n').length, 4);
  });
});

test('hidden/invalid-keys-never-escape-the-directory', () => {
  withStore((directory, store) => {
    // 契约第 4 条：键必须匹配 [A-Za-z0-9._-]+，否则 RangeError。
    // 注意 '..' 与 '.' 本身**符合**该正则，因此是合法键（只能读到 <dir>/...rec，仍在目录内）。
    for (const bad of ['../escape', 'a/b', 'a\\b', '', ' ', '键', 'x/../y', 'a b', 'a\nb', 'a;b', 'a:b']) {
      assert.throws(() => store.write(bad, 'x'), RangeError, JSON.stringify(bad));
      assert.throws(() => store.read(bad), RangeError, JSON.stringify(bad));
    }
    assert.deepEqual(readdirSync(directory), [], '非法键留下了文件');
    // 合法键必须被接受，包括正则允许的纯点号形式。
    for (const good of ['a', 'A1', 'a.b', 'a-b', 'a_b', '-_-', '.', '..', '...']) {
      store.write(good, 'v');
      assert.equal(store.read(good), 'v', good);
    }
    // 所有文件都还在目录内，没有逃逸。
    for (const name of readdirSync(directory)) {
      assert.equal(name.endsWith('.rec'), true, name + ' 不是 .rec 文件');
      assert.equal(name.includes('/') || name.includes('\\'), false, name + ' 逃出了目录');
    }
  });
});

test('hidden/close-is-idempotent-and-final', () => {
  const directory = mkdtempSync(join(tmpdir(), 'state-01-'));
  const store = openRecordStore(directory);
  try {
    store.write('a', '1');
    // 契约第 5 条：重复 close 安全。
    store.close();
    store.close();
    store.close();
    assert.throws(() => store.read('a'), StoreClosedError);
    assert.throws(() => store.write('a', '2'), StoreClosedError);
    assert.throws(() => store.write('brand-new', 'x'), StoreClosedError);
    // 关闭后磁盘上的原记录仍完好。
    assert.equal(JSON.parse(readFileSync(join(directory, 'a.rec'), 'utf8')).value, '1');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('hidden/many-keys-stay-independent', () => {
  withStore((directory, store) => {
    // 批量键不得互相污染：校验和按各自的 value 计算。
    const keys = Array.from({ length: 40 }, (_value, index) => 'k' + index);
    keys.forEach((key, index) => store.write(key, 'value-' + index));
    keys.forEach((key, index) => {
      assert.equal(store.read(key), 'value-' + index, key + ' 读到了别的键的值');
    });
    assert.equal(readdirSync(directory).length, 40, '键数量与文件数量不一致');
    // 损坏其中一个，其余仍可读。
    writeFileSync(join(directory, 'k7.rec'), '{"checksum":"bad","value":"value-7"}');
    assert.throws(() => store.read('k7'), CorruptRecordError);
    assert.equal(store.read('k6'), 'value-6');
    assert.equal(store.read('k8'), 'value-8');
  });
});

test('hidden/missing-file-and-zero-byte-file-differ', () => {
  withStore((directory, store) => {
    // 缺失键返回 null；但**存在**的零字节文件是损坏记录，不是缺失。
    assert.equal(store.read('ghost'), null);
    writeFileSync(join(directory, 'hollow.rec'), '');
    assert.throws(() => store.read('hollow'),
      (error: unknown) => error instanceof CorruptRecordError && error.key === 'hollow',
      '零字节文件被当成了缺失键');
    // 重新写入后恢复。
    store.write('hollow', 'restored');
    assert.equal(store.read('hollow'), 'restored');
  });
});
