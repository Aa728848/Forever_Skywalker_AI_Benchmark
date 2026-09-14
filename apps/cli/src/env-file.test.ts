import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EnvironmentFileConflictError, readProjectEnvironment, saveProjectEnvironment } from './env-file.ts';

let root: string;
let file: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fsa-env-file-')); file = join(root, '.env'); });
afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-env-file-')) throw new Error('测试清理越界。');
  rmSync(target, { recursive: true, force: true });
});

it('缺文件只读不落盘，补齐后当前启动环境可用且非空继承值继续优先', () => {
  const inherited = { BENCH_FIXTURE_OS: 'inherited-value', BENCH_FIXTURE_EMPTY: '' };
  const before = readProjectEnvironment(root, inherited);
  expect(before.text).toBeNull(); expect(readdirSync(root)).toEqual([]);
  const after = saveProjectEnvironment(root, { BENCH_FIXTURE_OS: 'file-value', BENCH_FIXTURE_EMPTY: 'filled' }, before);
  expect(after.fileValues.BENCH_FIXTURE_OS).toBe('file-value');
  expect(after.effectiveEnv.BENCH_FIXTURE_OS).toBe('inherited-value');
  expect(after.effectiveEnv.BENCH_FIXTURE_EMPTY).toBe('filled');
  expect(inherited).toEqual({ BENCH_FIXTURE_OS: 'inherited-value', BENCH_FIXTURE_EMPTY: '' });
  expect(readdirSync(root)).toEqual(['.env']);
});

it('配置语义下OS和文件纯空白都可补齐，不裁剪实际非空值', () => {
  writeFileSync(file, 'QUOTED="   " # keep\nSINGLE=\'\t \u3000\'\nVALID="  existing  "\n');
  const before = readProjectEnvironment(root, { QUOTED: ' \t ', SINGLE: '\u3000', VALID: '  from-os  ' });
  expect(before.fileValues.QUOTED).toBe('   ');
  const after = saveProjectEnvironment(root, { QUOTED: 'filled', SINGLE: 'value', VALID: 'overwrite' }, before);
  expect(after.fileValues).toMatchObject({ QUOTED: 'filled', SINGLE: 'value', VALID: '  existing  ' });
  expect(after.effectiveEnv).toMatchObject({ QUOTED: 'filled', SINGLE: 'value', VALID: '  from-os  ' });
  expect(after.text).toContain('QUOTED=filled # keep');
});

it('只改真实空赋值，保留非空值、注释、未知键、多行文本和CRLF', () => {
  const original = '# 保留注释\r\nexport EMPTY = ""  # 行尾注释\r\nKEEP=original # 不动\r\nBODY=\'first\r\nEMPTY=not-a-setting\r\nlast\'\r\nOTHER=  # 第二个注释\r\nUNKNOWN="x#y"\r\n';
  writeFileSync(file, original);
  const before = readProjectEnvironment(root, {});
  const after = saveProjectEnvironment(root, { EMPTY: '  #value $literal  ', OTHER: 'ready', KEEP: 'overwrite-attempt', NEW_KEY: 'added' }, before);
  expect(after.fileValues).toMatchObject({ EMPTY: '  #value $literal  ', OTHER: 'ready', KEEP: 'original', UNKNOWN: 'x#y', NEW_KEY: 'added' });
  expect(after.fileValues.BODY).toBe(before.fileValues.BODY);
  expect(after.text).toContain('KEEP=original # 不动\r\n');
  expect(after.text).toContain('BODY=\'first\r\nEMPTY=not-a-setting\r\nlast\'\r\n');
  expect(after.text).toContain('  # 行尾注释\r\n'); expect(after.text).toContain('# 第二个注释\r\n');
  expect(after.text).toContain('NEW_KEY=added\r\n');
  const unchanged = saveProjectEnvironment(root, { EMPTY: 'new attempt' }, after);
  expect(unchanged.text).toBe(after.text); expect(unchanged.revision).toBe(after.revision);
});

it('Node dotenv无损往返空格、井号、引号、反斜杠、美元和多行值', () => {
  const samples = [
    ' plain words ', String.raw`C:\fixture\new\$VALUE#comment`, 'has "double" # value', "has 'single' # value",
    "has 'single' and \"double\" # value", 'all\'"`quotes-without-hash', 'line one\n#still value\nOTHER=not-a-setting',
    String.raw`literal\n with "quote" # value`, '$VALUE $(not-executed) `literal`',
  ];
  const updates = Object.fromEntries(samples.map((value, index) => [`FIXTURE_${index}`, value]));
  const result = saveProjectEnvironment(root, updates, readProjectEnvironment(root, {}));
  expect(result.fileValues).toEqual(updates);
  expect(parseEnv(readFileSync(file, 'utf8'))).toEqual(updates);
  expect(Object.keys(result.fileValues)).toHaveLength(samples.length);
});

it('不能无损表达或变量名非法时拒绝整批，不泄漏值或留下临时文件', () => {
  writeFileSync(file, '# unchanged\nEMPTY=\n'); const before = readProjectEnvironment(root, {});
  const secret = ' private-fixture\'"`#with-all-quotes ';
  let message = '';
  try { saveProjectEnvironment(root, { OK: 'would-write', EMPTY: secret }, before); } catch (error) { message = (error as Error).message; }
  expect(message).toContain('无损'); expect(message).not.toContain('private-fixture');
  expect(() => saveProjectEnvironment(root, { 'INVALID\nKEY': 'value' }, before)).toThrow('名称');
  expect(readFileSync(file, 'utf8')).toBe(before.text); expect(readdirSync(root)).toEqual(['.env']);
});

it('同一key重复时只补最后的有效空值，不改先前非空赋值', () => {
  writeFileSync(file, 'DUP=old\nDUP=\'\' # latest\n');
  const result = saveProjectEnvironment(root, { DUP: 'new' }, readProjectEnvironment(root, {}));
  expect(result.text).toBe('DUP=old\nDUP=new # latest\n'); expect(result.fileValues.DUP).toBe('new');
});

it('拒绝内容改动、相同内容的外部重写和并发保存锁', () => {
  writeFileSync(file, 'EMPTY=\n'); const first = readProjectEnvironment(root, {});
  writeFileSync(file, 'EMPTY=\nUNKNOWN=external\n');
  expect(() => saveProjectEnvironment(root, { EMPTY: 'new' }, first)).toThrow(EnvironmentFileConflictError);
  const second = readProjectEnvironment(root, {}); const changedTime = new Date(Date.now() + 2000); utimesSync(file, changedTime, changedTime);
  expect(() => saveProjectEnvironment(root, { EMPTY: 'new' }, second)).toThrow(EnvironmentFileConflictError);
  const third = readProjectEnvironment(root, {}); writeFileSync(file + '.fsa-lock', 'another writer');
  expect(() => saveProjectEnvironment(root, { EMPTY: 'new' }, third)).toThrow(EnvironmentFileConflictError);
  expect(readFileSync(file, 'utf8')).toBe('EMPTY=\nUNKNOWN=external\n');
  expect(readFileSync(file + '.fsa-lock', 'utf8')).toBe('another writer');
});

it.each(['partial-write', 'rename'])('%s失败保持旧文件完整并回收本次temp/lock', failure => {
  writeFileSync(file, 'EMPTY=\nKEEP=existing\n'); const before = readProjectEnvironment(root, {});
  if (failure === 'rename') vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('fixture failure'); });
  else {
    const originalWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
      if (typeof target === 'number') { originalWrite(target, 'partial-fixture'); throw new Error('fixture failure'); }
      return originalWrite(target, data, options);
    });
  }
  syncBuiltinESMExports();
  expect(() => saveProjectEnvironment(root, { EMPTY: 'replacement' }, before)).toThrow('保存失败');
  expect(readFileSync(file, 'utf8')).toBe(before.text); expect(readdirSync(root)).toEqual(['.env']);
});

it.runIf(process.platform === 'win32')('Windows非空继承变量按大小写无关优先，文件非空同名项不被覆写', () => {
  writeFileSync(file, 'fixture_value=file-value\nfixture_empty=\n');
  const before = readProjectEnvironment(root, { FIXTURE_VALUE: 'os-value', FIXTURE_EMPTY: '' });
  const after = saveProjectEnvironment(root, { FIXTURE_VALUE: 'override', FIXTURE_EMPTY: 'filled' }, before);
  expect(after.fileValues.fixture_value).toBe('file-value'); expect(after.fileValues.fixture_empty).toBe('filled');
  expect(after.effectiveEnv.FIXTURE_VALUE).toBe('os-value'); expect(after.effectiveEnv.FIXTURE_EMPTY).toBe('filled');
});
