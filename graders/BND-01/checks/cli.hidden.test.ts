import test from 'node:test';
import assert from 'node:assert/strict';
import { CliUsageError, parseCli, type CliDefaults } from '../starter/src/cli.ts';

const defaults: CliDefaults = { host: '127.0.0.1', port: 8080, tag: 'stable', verbose: false };

/** 断言某个 argv 组合抛出 CliUsageError，并校验 option 字段。 */
function usageErrorOf(argv: string[], option?: string): string {
  try {
    parseCli(argv, defaults);
  } catch (error) {
    assert.equal(error instanceof CliUsageError, true, '不是 CliUsageError: ' + String(error));
    if (option !== undefined) assert.equal((error as CliUsageError).option, option, 'option 字段不符');
    return (error as CliUsageError).option;
  }
  assert.fail('本应抛出 CliUsageError：' + JSON.stringify(argv));
}

test('hidden/zero-and-empty-string-are-literal-values', () => {
  // 契约第 2 条：0 与空串是合法取值，不得退回默认值。
  assert.equal(parseCli(['--port', '0'], defaults).port, 0, '--port 0 退回了默认值');
  assert.equal(parseCli(['--port=0'], defaults).port, 0, '--port=0 退回了默认值');
  assert.equal(parseCli(['--tag', ''], defaults).tag, '');
  assert.equal(parseCli(['--tag='], defaults).tag, '', '--tag= 退回了默认值');
  assert.equal(parseCli(['--host', ''], defaults).host, '');
  assert.equal(parseCli(['--host='], defaults).host, '');
  // 上下界与缺省都保持原语义。
  assert.equal(parseCli(['--port', '65535'], defaults).port, 65535);
  assert.equal(parseCli([], defaults).port, 8080, '未提供时应保留默认值');
  assert.equal(parseCli([], defaults).host, '127.0.0.1');
  assert.equal(parseCli([], defaults).tag, 'stable');
});

test('hidden/unknown-option-reports-its-name', () => {
  // 契约第 3 条：未知选项抛错，option 是去掉 -- 的名字。
  for (const name of ['unknown', 'Host', 'hostt', 'verbos', 'tags', 'verbose2']) {
    usageErrorOf(['--' + name], name);
    usageErrorOf(['--' + name + '=x'], name);
  }
  // 契约只把「以 -- 开头」当作选项：单连字符形式是非选项参数，进入 rest。
  assert.deepEqual(parseCli(['-h'], defaults).rest, ['-h'], '单连字符被当成了选项');
  assert.deepEqual(parseCli(['-'], defaults).rest, ['-']);
  // 已知选项不得被误判为未知。
  assert.equal(parseCli(['--host', 'h'], defaults).host, 'h');
  assert.equal(parseCli(['--tag', 't'], defaults).tag, 't');
  assert.equal(parseCli(['--port', '1'], defaults).port, 1);
});

test('hidden/missing-value-is-rejected', () => {
  // 契约第 4 条：后面没参数或以 -- 开头都算缺值。
  for (const option of ['host', 'port', 'tag']) {
    usageErrorOf(['--' + option], option);
    usageErrorOf(['--' + option, '--verbose'], option);
    usageErrorOf(['--' + option, '--other'], option);
    usageErrorOf(['--' + option, '--'], option);
  }
  // =value 形式即使为空也算「已提供」。
  assert.equal(parseCli(['--host='], defaults).host, '');
  assert.equal(parseCli(['--port=0'], defaults).port, 0);
});

test('hidden/port-range-and-format', () => {
  // 契约第 5 条：非负十进制整数且 ≤ 65535。
  assert.equal(parseCli(['--port', '0'], defaults).port, 0);
  assert.equal(parseCli(['--port', '65535'], defaults).port, 65535);
  assert.equal(parseCli(['--port', '00080'], defaults).port, 80);
  for (const bad of ['65536', '99999', '-1', '1.5', 'abc', '', ' ', '0x50', '1e3', '80 ', ' 80', '+80', '８０']) {
    usageErrorOf(['--port', bad], 'port');
    usageErrorOf(['--port=' + bad], 'port');
  }
  // 出错时 option 始终是 port。
  assert.equal(usageErrorOf(['--port', 'abc']), 'port');
});

test('hidden/boolean-toggles-and-rejects-values', () => {
  // 契约第 6 条：布尔切换，且不接受 =value。
  assert.equal(parseCli(['--verbose'], defaults).verbose, true);
  assert.equal(parseCli(['--no-verbose'], defaults).verbose, false);
  assert.equal(parseCli(['--verbose'], { ...defaults, verbose: true }).verbose, true);
  assert.equal(parseCli(['--no-verbose'], { ...defaults, verbose: true }).verbose, false);
  assert.equal(parseCli([], { ...defaults, verbose: true }).verbose, true, '缺省未保留传入默认值');
  for (const name of ['verbose', 'no-verbose']) {
    usageErrorOf(['--' + name + '=true'], name);
    usageErrorOf(['--' + name + '='], name);
  }
  // 布尔后面的普通 token 仍是位置参数，不能被吞掉。
  assert.deepEqual(parseCli(['--verbose', 'true'], defaults).rest, ['true'], '布尔选项吞掉了后面的 token');
  assert.equal(parseCli(['--verbose', 'true'], defaults).verbose, true);
});

test('hidden/last-occurrence-wins', () => {
  // 契约第 7 条：重复选项最后一次生效。
  assert.equal(parseCli(['--host', 'a', '--host', 'b', '--host', 'c'], defaults).host, 'c');
  assert.equal(parseCli(['--host', 'a', '--host=b'], defaults).host, 'b');
  assert.equal(parseCli(['--port', '1', '--port', '2'], defaults).port, 2);
  assert.equal(parseCli(['--tag', 'x', '--tag', 'y', '--tag='], defaults).tag, '');
  assert.equal(parseCli(['--verbose', '--no-verbose'], defaults).verbose, false);
  assert.equal(parseCli(['--no-verbose', '--verbose'], defaults).verbose, true);
  // 最后一次非法时必须抛错，不能退回前一次。
  usageErrorOf(['--port', '1', '--port', 'abc'], 'port');
  usageErrorOf(['--host', 'a', '--unknown'], 'unknown');
});

test('hidden/double-dash-stops-option-parsing', () => {
  // 契约第 7 条：-- 之后原样进入 rest，即使看起来像选项。
  const parsed = parseCli(['--host', 'h', '--', '--verbose', '--port', '0', '--', 'x', 'y'], defaults);
  assert.equal(parsed.host, 'h');
  assert.equal(parsed.verbose, false, '-- 之后的内容被当成了选项');
  assert.equal(parsed.port, 8080, '-- 之后的内容被当成了选项');
  assert.deepEqual(parsed.rest, ['--verbose', '--port', '0', '--', 'x', 'y']);
  assert.deepEqual(parseCli(['--'], defaults).rest, []);
  assert.deepEqual(parseCli(['a', '--host', 'h', 'b', '--', 'c'], defaults).rest, ['a', 'b', 'c']);
});

test('hidden/rest-collects-positional-in-order', () => {
  // 契约第 7 条：非选项参数按出现顺序进入 rest。
  assert.deepEqual(parseCli(['a', 'b', 'c'], defaults).rest, ['a', 'b', 'c']);
  assert.deepEqual(parseCli(['--host', 'h', 'a', '--port', '1', 'b'], defaults).rest, ['a', 'b']);
  assert.deepEqual(parseCli(['-x', 'y', '--'], defaults).rest, ['-x', 'y']);
  assert.deepEqual(parseCli(['', 'a'], defaults).rest, ['', 'a']);
  assert.deepEqual(parseCli(['--host', 'h', '--verbose'], defaults).rest, []);
});

test('hidden/inline-equals-splits-on-first-only', () => {
  // --key=value 只在第一个 = 处切分，值里的 = 属于值本身。
  assert.equal(parseCli(['--tag=a=b=c'], defaults).tag, 'a=b=c');
  assert.equal(parseCli(['--host=http://h:8080/x?a=b'], defaults).host, 'http://h:8080/x?a=b');
  assert.equal(parseCli(['--tag='], defaults).tag, '');
  assert.equal(parseCli(['--tag==x'], defaults).tag, '=x');
  assert.equal(parseCli(['--tag', 'a=b'], defaults).tag, 'a=b');
  // 两种形式等价。
  assert.deepEqual(
    { ...parseCli(['--host=h', '--port=1', '--tag=t'], defaults) },
    { ...parseCli(['--host', 'h', '--port', '1', '--tag', 't'], defaults) },
  );
});
