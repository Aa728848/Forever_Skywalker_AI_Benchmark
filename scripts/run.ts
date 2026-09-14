import { parseArgs } from 'node:util';
import { createEnvelope, createRunStore, defaultRunRoot } from '../packages/runs/src/index.ts';
import { executeAttempt } from '../packages/executor/src/index.ts';


const usage = [
  '用法：',
  '  node scripts/run.ts submit <题目 ID> <候选目录> [--key <幂等键>] [--by <提交者>] [--reason agent-completed|operator-submit|patch-import]',
  '      [--root <存储目录>] [--profile local|linux-container] [--image <镜像引用>] [--image-digest sha256:...] [--declared-hash <64 位 hex>] [--declared-base <hex>]',
  '  node scripts/run.ts show <幂等键> [--root <存储目录>]',
  '  node scripts/run.ts list [--root <存储目录>]',
  '  node scripts/run.ts materialize <runId> <attemptId> <目标目录> [--root <存储目录>]',
  '  node scripts/run.ts execute <runId> <attemptId> [--root <存储目录>] [--cancel-after <毫秒>] [--artifacts <产物目录>]',
  '',
  '本命令是控制面的演练入口，不是正式的 bench submit；正式提交入口在 M1-04 实现。',
].join('\n');

const { values, positionals } = parseArgs({
  options: {
    key: { type: 'string' },
    by: { type: 'string', default: 'operator' },
    reason: { type: 'string', default: 'operator-submit' },
    root: { type: 'string', default: defaultRunRoot },
    profile: { type: 'string', default: 'local' },
    image: { type: 'string' },
    'image-digest': { type: 'string' },
    'declared-hash': { type: 'string' },
    'declared-base': { type: 'string' },
    'cancel-after': { type: 'string' },
    artifacts: { type: 'string' },
  },
  allowPositionals: true,
});

const [command, first, second, third] = positionals;

try {
  const store = createRunStore(values.root);
  if (command === 'submit' && first !== undefined && second !== undefined) {
    if (!['agent-completed', 'operator-submit', 'patch-import'].includes(values.reason)) throw new Error('--reason 必须为 agent-completed、operator-submit 或 patch-import。');
    const envelopeOptions: { idempotencyKey?: string; reason?: 'agent-completed' | 'operator-submit' | 'patch-import' } = {
      reason: values.reason as 'agent-completed' | 'operator-submit' | 'patch-import',
    };
    if (values.key !== undefined) envelopeOptions.idempotencyKey = values.key;
    const envelope = createEnvelope(first, second, envelopeOptions);
    if (values['declared-base'] !== undefined) envelope.baseCommit = values['declared-base'];
    if (values['declared-hash'] !== undefined) envelope.candidateTreeHash = values['declared-hash'];
    const outcome = store.submit({
      taskId: first,
      envelope,
      candidateDirectory: second,
      submittedBy: values.by,
      profile: values.profile === 'linux-container' ? 'linux-container' : 'local',
      image: values.image ?? null,
      imageDigest: values['image-digest'] ?? null,
    });
    console.log(`提交结果：${outcome.outcome === 'created' ? '已冻结新 attempt' : '复用已冻结 attempt'}`);
    console.log(`  题目：${outcome.attempt.taskId} ${outcome.attempt.taskVersion}`);
    console.log(`  运行/尝试：${outcome.attempt.runId} / ${outcome.attempt.attemptId}`);
    console.log(`  幂等键：${outcome.attempt.idempotencyKey}`);
    console.log(`  实算候选摘要：${outcome.attempt.treeHash}（自报 ${outcome.attempt.selfReportedTreeHash}）`);
    console.log(`  冻结文件数与字节：${outcome.attempt.fileCount} / ${outcome.attempt.bytes}`);
    console.log(`  冻结目录：${outcome.attempt.directory}`);
    console.log(`  执行工作目录（声明）：${outcome.manifest.environment.workingDirectory}`);
  } else if (command === 'show' && first !== undefined) {
    const found = store.read(first);
    if (found === null) throw new Error(`没有该幂等键的冻结记录：${first}`);
    console.log(JSON.stringify(found.attempt, null, 2));
  } else if (command === 'list') {
    const entries = store.list();
    if (entries.length === 0) console.log('运行索引为空。');
    for (const entry of entries) {
      console.log(`${entry.taskId} ${entry.runId}/${entry.attemptId} ${entry.treeHash.slice(0, 12)}… ${entry.idempotencyKey}`);
    }
  } else if (command === 'execute' && first !== undefined && second !== undefined) {
    const cancelAfter = values['cancel-after'] === undefined ? null : Number(values['cancel-after']);
    const controller = cancelAfter === null ? null : new AbortController();
    const timer = controller === null ? null : setTimeout(() => controller.abort(), cancelAfter ?? 0);
    const result = await executeAttempt({
      store, runId: first, attemptId: second,
      ...(values.artifacts === undefined ? {} : { artifactDirectory: values.artifacts }),
      ...(controller === null ? {} : { signal: controller.signal }),
    });
    if (timer !== null) clearTimeout(timer);
    console.log(`执行结论：${result.classification}（隔离：${result.isolation}，耗时 ${result.durationMs}ms）`);
    console.log(`  候选摘要：${result.candidateTreeHash}`);
    for (const phase of result.phases) {
      console.log(`  ${phase.kind} 阶段：exit=${phase.exitCode} signal=${phase.signal} 超时=${phase.timedOut} 取消=${phase.cancelled} 耗时=${phase.durationMs}ms 峰值RSS=${phase.resource.peakRssBytes ?? '未知'} 缺失=${phase.missing.length}`);
    }
    for (const check of result.checks.filter(item => item.status !== 'passed')) {
      console.log(`  ${check.status === 'failed' ? '失败' : '未运行'}：${check.id}`);
    }
    console.log(`  证据：${result.artifacts.map(item => item.id).join(', ')}`);
    for (const note of result.notes) console.log(`  说明：${note}`);
  } else if (command === 'materialize' && first !== undefined && second !== undefined && third !== undefined) {
    const materialized = store.materialize(first, second, third);
    console.log(`已物化受控副本：${materialized.directory}`);
    console.log(`  摘要：${materialized.treeHash}`);
    console.log(`  文件数：${materialized.fileCount}`);
  } else {
    throw new Error(usage);
  }
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
}
