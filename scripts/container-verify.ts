import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionClassification, ExecutionManifest } from '../packages/contracts/src/index.ts';
import { classifyExecution, containerTransport, runPhase } from '../packages/executor/src/index.ts';
import { captureCommand, probeContainerRuntime, requirePinnedImage } from '../packages/executor/src/container.ts';
import { readManifest } from '../packages/tasks/src/index.ts';

/** 开发环境验收：只运行本文件声明的小负载，不提交题目或调用裁判。 */
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'data', 'container-acceptance', new Date().toISOString().replace(/[:.]/g, '-'));
const desktopCli = join(process.env.ProgramFiles ?? 'C:/Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe');
const command = process.env.BENCH_CONTAINER_RUNTIME ?? (process.platform === 'win32' && existsSync(desktopCli) ? desktopCli : 'docker');
const taskTemplate = readManifest('CACHE-02');
const liveContainers = new Set<string>();
const cases: Array<{ id: string; passed: boolean; expected: ExecutionClassification; actual: ExecutionClassification | null; error: string | null; container: string | null }> = [];
mkdirSync(artifacts, { recursive: true });

const boundaryProgram = `import errno, json, os, socket, time
from pathlib import Path

def cgroup(name):
    return Path('/sys/fs/cgroup', name).read_text().strip()

def blocked_write(path):
    try:
        with open(path, 'w') as output:
            output.write('unexpected')
    except OSError as error:
        assert error.errno in (errno.EROFS, errno.EACCES), repr(error)
        return error.errno
    raise AssertionError('write unexpectedly succeeded: ' + path)

def cpu_stats():
    return dict((key, int(value)) for key, value in (line.split() for line in cgroup('cpu.stat').splitlines()))

result = {'uid': os.getuid(), 'gid': os.getgid()}
assert result['uid'] != 0 and result['gid'] != 0
assert os.statvfs('/').f_flag & os.ST_RDONLY
result['readonlyRootErrno'] = blocked_write('/var/tmp/fsa-acceptance-probe')
assert Path('/work/__checks__/sentinel.txt').read_text() == 'trusted'
assert os.statvfs('/work/__checks__').f_flag & os.ST_RDONLY
result['readonlyChecksErrno'] = blocked_write('/work/__checks__/sentinel.txt')
result['interfaces'] = sorted(os.listdir('/sys/class/net'))
assert result['interfaces'] == ['lo']
try:
    with socket.create_connection(('192.0.2.1', 9), timeout=1):
        raise AssertionError('external network unexpectedly reachable')
except OSError as error:
    result['networkErrno'] = error.errno
    assert error.errno == errno.ENETUNREACH, repr(error)
result['cpuMax'] = cgroup('cpu.max')
quota, period = map(int, result['cpuMax'].split())
assert quota / period == 0.5
before = cpu_stats()
started = time.monotonic()
while time.monotonic() - started < 1.5:
    pass
result['cpuThrottledPeriods'] = cpu_stats()['nr_throttled'] - before['nr_throttled']
assert result['cpuThrottledPeriods'] > 0
result['memoryMax'] = int(cgroup('memory.max'))
result['memorySwapMax'] = int(cgroup('memory.swap.max'))
assert result['memoryMax'] == 96 * 1024 * 1024
assert result['memorySwapMax'] == 0
Path('/tmp/fsa-acceptance-probe').write_text('tmpfs writable')
Path('/work/writable.txt').write_text('workspace writable')
print(json.dumps(result), flush=True)
`;

const pidsProgram = `import errno, json, os, signal, time
from pathlib import Path

assert int(Path('/sys/fs/cgroup/pids.max').read_text()) == 32
children = []
blocked = None
try:
    for _ in range(40):
        try:
            child = os.fork()
        except OSError as error:
            blocked = error.errno
            break
        if child == 0:
            time.sleep(15)
            os._exit(0)
        children.append(child)
    current = int(Path('/sys/fs/cgroup/pids.current').read_text())
    events = Path('/sys/fs/cgroup/pids.events').read_text().strip()
    assert children and blocked == errno.EAGAIN and current <= 32
    assert int(events.split()[1]) > 0
    print(json.dumps({'children': len(children), 'blockedErrno': blocked, 'pidsCurrent': current, 'pidsEvents': events}), flush=True)
finally:
    for child in children:
        os.kill(child, signal.SIGKILL)
    for child in children:
        os.waitpid(child, 0)
`;

const heartbeatProgram = `import os, time
from pathlib import Path

child = os.fork()
if child == 0:
    with open('/work/heartbeat.txt', 'a', buffering=1) as output:
        while True:
            output.write('alive\\n')
            time.sleep(0.05)
Path('/work/started.txt').write_text(str(child))
while True:
    time.sleep(1)
`;

const oomProgram = `import json
from pathlib import Path

assert int(Path('/sys/fs/cgroup/memory.max').read_text()) == 96 * 1024 * 1024
print(json.dumps({'started': True, 'expectedMemoryBytes': 96 * 1024 * 1024}), flush=True)
chunks = []
for _ in range(32):
    chunks.append(bytearray(8 * 1024 * 1024))
raise AssertionError('256 MiB allocation survived a 96 MiB cgroup limit')
`;

try {
  const record = JSON.parse(readFileSync(join(root, 'data', 'container', 'runtime.json'), 'utf8')) as { image: string; imageDigest: string };
  assert.match(record.image, /^sha256:[a-f0-9]{64}$/);
  assert.equal(record.image, record.imageDigest, '必须使用 container:build 保存的不可变 image ID。');
  const runtime = probeContainerRuntime({ command, captureDir: artifacts });
  const imageReference = requirePinnedImage(runtime, record.image, record.imageDigest, { captureDir: artifacts });
  const platform = captureCommand([command, 'info', '--format', '{{.OSType}}/{{.CgroupVersion}}'], { captureDir: artifacts, label: 'platform', timeoutMs: 10000 });
  assert.equal(platform.exitCode, 0);
  assert.equal(platform.stdout.trim(), 'linux/2', '此验收入口要求 Linux cgroup v2。');
  writeFileSync(join(artifacts, 'environment.json'), JSON.stringify({ ...runtime, imageReference, platform: platform.stdout.trim() }, null, 2) + '\n');

  async function runCase(id: string, program: string, expected: ExecutionClassification, mode?: 'timeout' | 'cancel') {
    const artifactDir = join(artifacts, id);
    mkdirSync(artifactDir, { recursive: true });
    const temporary = mkdtempSync(join(tmpdir(), 'fsa-container-acceptance-'));
    const workspace = join(temporary, 'workspace');
    const checks = join(temporary, 'checks');
    mkdirSync(workspace);
    mkdirSync(checks);
    chmodSync(workspace, 0o777);
    writeFileSync(join(checks, 'sentinel.txt'), 'trusted');
    writeFileSync(join(workspace, 'probe.py'), program);
    copyFileSync(join(workspace, 'probe.py'), join(artifactDir, 'probe.py'));
    const controller = new AbortController();
    let watcher: ReturnType<typeof setInterval> | undefined;
    let name: string | null = null;
    let actual: ExecutionClassification | null = null;
    let error: string | null = null;
    try {
      const declaredCommand = ['python', '-I', '-B', 'probe.py'];
      const manifest: Pick<ExecutionManifest, 'environment'> = { environment: {
        profile: 'linux-container', runtimeRange: 'python >=3.11', image: record.image, imageDigest: record.imageDigest,
        network: false, workingDirectory: workspace,
      } };
      const transport = containerTransport({ kind: 'hidden', task: { ...taskTemplate, commands: { ...taskTemplate.commands, hidden: declaredCommand },
        limits: { ...taskTemplate.limits, memoryMb: 96, cpus: 0.5 } }, manifest, runtime,
        hiddenChecksDirectory: checks, workspace, artifactDirectory: artifactDir, pidsLimit: 32 });
      name = transport.argv[transport.argv.indexOf('--name') + 1] ?? null;
      assert.ok(name !== null && name.startsWith('fsa-'));
      liveContainers.add(name);
      if (mode === 'cancel') watcher = setInterval(() => {
        if (existsSync(join(workspace, 'heartbeat.txt'))) controller.abort();
      }, 50);
      const phase = await runPhase({ kind: 'hidden', declaredCommand, workspace, artifactDir, timeoutMs: mode === 'timeout' ? 4000 : 15000,
        memoryMb: 96, signal: controller.signal, transport });
      actual = classifyExecution([phase], []);
      writeFileSync(join(artifactDir, 'phase.json'), JSON.stringify({ ...phase, classification: actual }, null, 2) + '\n');
      const remaining = captureCommand([command, 'ps', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.Names}}'], {
        captureDir: artifactDir, label: 'cleanup-check', timeoutMs: 10000,
      });
      assert.equal(remaining.exitCode, 0);
      assert.equal(remaining.stdout.trim(), '', '真实执行器应删除本次容器。');
      liveContainers.delete(name);
      assert.equal(actual, expected, phase.stderr || phase.spawnError || '分类不符合预期。');
      if (id === 'oom') {
        assert.equal(phase.oomKilled, true, '必须读取到 Docker OOMKilled=true，不能只匹配错误文本。');
        assert.equal(phase.exitCode, 137);
        assert.match(phase.stdout, /"started": true/);
      }
      if (mode) {
        assert.ok(existsSync(join(workspace, 'started.txt')), '候选和子进程必须已启动。');
        const heartbeat = readFileSync(join(workspace, 'heartbeat.txt'), 'utf8');
        assert.ok(heartbeat.length > 0);
        await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
        assert.equal(readFileSync(join(workspace, 'heartbeat.txt'), 'utf8'), heartbeat, '回收后子进程不得继续写入。');
        writeFileSync(join(artifactDir, 'cleanup-evidence.json'), JSON.stringify({ containerAbsent: true, heartbeatStopped: true, heartbeatBytes: heartbeat.length }, null, 2) + '\n');
      } else if (id !== 'oom') {
        const observed: unknown = JSON.parse(phase.stdout.trim());
        assert.ok(observed && typeof observed === 'object');
        writeFileSync(join(artifactDir, 'observed.json'), JSON.stringify(observed, null, 2) + '\n');
      }
      assert.equal(readFileSync(join(checks, 'sentinel.txt'), 'utf8'), 'trusted');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (watcher) clearInterval(watcher);
      if (name && liveContainers.has(name)) {
        const cleanup = captureCommand([command, 'rm', '--force', name], { captureDir: artifactDir, label: 'fallback-cleanup', timeoutMs: 10000 });
        if (cleanup.exitCode === 0) liveContainers.delete(name);
        else error = (error ?? '') + '; 专属容器兜底回收失败，参见 fallback-cleanup.stderr.txt';
      }
      // 仅删除本次 mkdtemp 创建、且明确位于系统临时目录内的路径。
      const inside = relative(resolve(tmpdir()), resolve(temporary));
      assert.ok(inside.startsWith('fsa-container-acceptance-') && !inside.includes(sep) && !inside.startsWith('..'));
      rmSync(temporary, { recursive: true, force: true });
    }
    const result = { id, passed: error === null, expected, actual, error, container: name };
    cases.push(result);
    console.log(JSON.stringify(result));
    writeFileSync(join(artifacts, 'report.json'), JSON.stringify({ imageReference, passed: cases.every(item => item.passed), cases }, null, 2) + '\n');
  }

  await runCase('isolation-and-cpu', boundaryProgram, 'passed');
  await runCase('pids', pidsProgram, 'passed');
  await runCase('timeout-cleanup', heartbeatProgram, 'timeout', 'timeout');
  await runCase('cancel-cleanup', heartbeatProgram, 'cancelled', 'cancel');
  await runCase('oom', oomProgram, 'memory-exceeded');
  assert.equal(cases.length, 5);
  assert.ok(cases.every(item => item.passed), 'Linux 隔离验收存在失败项。');
  console.log('Linux 环境验收通过：' + artifacts);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
