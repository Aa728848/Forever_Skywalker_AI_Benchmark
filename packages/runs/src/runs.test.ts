import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportWorkspace, readManifest } from '@fsa/tasks';
import type { SubmissionEnvelope } from '@fsa/contracts';
import {
  AttemptExistsError, CandidateHashMismatchError, FrozenSnapshotTamperedError, IdempotencyConflictError,
  SubmissionRejectedError, createRunStore, digestTree, readRunEvents, submissionBaseline,
} from './index.ts';

const taskId = 'CACHE-02';

/** 与真实链路一致：候选目录就是题目包的导出工作区。 */
function exportedCandidate(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fsa-candidate-'));
  exportWorkspace(taskId, directory);
  return directory;
}

function envelopeFor(candidate: string, overrides: Partial<SubmissionEnvelope> = {}): SubmissionEnvelope {
  return {
    schemaVersion: '0.1.0',
    runId: `run-${randomUUID()}`,
    attemptId: `attempt-${randomUUID()}`,
    taskId,
    taskVersion: readManifest(taskId).taskVersion,
    baseCommit: submissionBaseline(taskId),
    candidateTreeHash: digestTree(candidate).treeHash,
    idempotencyKey: `test-${randomUUID()}`,
    reason: 'operator-submit',
    ...overrides,
  };
}

function withTemp<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'fsa-runs-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('候选树摘要', () => {
  it('与目录位置无关，对内容和路径敏感', () => {
    const first = mkdtempSync(join(tmpdir(), 'fsa-digest-'));
    const second = mkdtempSync(join(tmpdir(), 'fsa-digest-'));
    try {
      for (const directory of [first, second]) {
        mkdirSync(join(directory, 'src'), { recursive: true });
        writeFileSync(join(directory, 'src', 'a.ts'), 'export const a = 1;\n');
      }
      expect(digestTree(second).treeHash).toBe(digestTree(first).treeHash);

      writeFileSync(join(second, 'src', 'a.ts'), 'export const a = 2;\n');
      expect(digestTree(second).treeHash).not.toBe(digestTree(first).treeHash);

      writeFileSync(join(second, 'src', 'a.ts'), 'export const a = 1;\n');
      mkdirSync(join(second, 'src', 'nested'), { recursive: true });
      writeFileSync(join(second, 'src', 'nested', 'a.ts'), 'export const a = 1;\n');
      expect(digestTree(second).treeHash).not.toBe(digestTree(first).treeHash);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('排除依赖树与 VCS 元数据，并忽略其内容变化', () => {
    withTemp(directory => {
      writeFileSync(join(directory, 'index.ts'), 'export const value = 1;\n');
      const before = digestTree(directory).treeHash;
      mkdirSync(join(directory, 'node_modules', 'left-pad'), { recursive: true });
      writeFileSync(join(directory, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
      mkdirSync(join(directory, '.git'), { recursive: true });
      writeFileSync(join(directory, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      expect(digestTree(directory).treeHash).toBe(before);
      expect(digestTree(directory).fileCount).toBe(1);
    });
  });
});

describe('提交与冻结', () => {
  it('冻结新 attempt，写入信封、冻结记录与执行 manifest', () => {
    const candidate = exportedCandidate();
    withTemp(storeRoot => {
      try {
        const store = createRunStore(storeRoot);
        const envelope = envelopeFor(candidate);
        const outcome = store.submit({ taskId, envelope, candidateDirectory: candidate, submittedBy: 'operator' });

        expect(outcome.outcome).toBe('created');
        expect(outcome.attempt.treeHash).toBe(envelope.candidateTreeHash);
        expect(outcome.attempt.selfReportedTreeHash).toBe(envelope.candidateTreeHash);
        expect(outcome.attempt.submittedBy).toBe('operator');
        expect(outcome.attempt.excluded).toEqual(['.git', 'node_modules']);
        expect(outcome.attempt.files.map(file => file.path)).toEqual([
          'TASK.md', 'package.json', 'public-tests/keyed-loader.test.ts', 'starter/src/keyed-loader.ts',
        ]);

        const directory = join(storeRoot, taskId, envelope.runId, envelope.attemptId);
        expect(existsSync(join(directory, 'envelope.json'))).toBe(true);
        expect(existsSync(join(directory, 'freeze.json'))).toBe(true);
        expect(existsSync(join(directory, 'manifest.json'))).toBe(true);
        expect(existsSync(join(directory, 'candidate', 'starter', 'src', 'keyed-loader.ts'))).toBe(true);

        const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Record<string, any>;
        expect(manifest.candidate.treeHash).toBe(envelope.candidateTreeHash);
        expect(manifest.candidate.taskPackageHash).toBe(submissionBaseline(taskId));
        expect(manifest.environment.profile).toBe('local');
        expect(manifest.environment.imageDigest).toBeNull();
        expect(manifest.environment.network).toBe(false);
        expect(manifest.environment.workingDirectory).toBe(`${taskId}/${envelope.runId}/${envelope.attemptId}/workspace`);
        expect(manifest.task.grader.referencePatch).toBe('graders/CACHE-02/reference.patch');
        expect(manifest.envelope.idempotencyKey).toBe(envelope.idempotencyKey);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
    });
  });

  it('拒绝与实算摘要不符的自报摘要，且不留下任何产物', () => {
    const candidate = exportedCandidate();
    withTemp(storeRoot => {
      try {
        const store = createRunStore(storeRoot);
        const envelope = envelopeFor(candidate, { candidateTreeHash: 'a'.repeat(64) });
        expect(() => store.submit({ taskId, envelope, candidateDirectory: candidate, submittedBy: 'operator' }))
          .toThrow(CandidateHashMismatchError);
        expect(store.list()).toHaveLength(0);
        expect(existsSync(join(storeRoot, taskId))).toBe(false);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
    });
  });

  it('拒绝不是当前题目包导出基线的基线声明', () => {
    const candidate = exportedCandidate();
    withTemp(storeRoot => {
      try {
        const store = createRunStore(storeRoot);
        const envelope = envelopeFor(candidate, { baseCommit: 'b'.repeat(40) });
        expect(() => store.submit({ taskId, envelope, candidateDirectory: candidate, submittedBy: 'operator' }))
          .toThrow(/基线/);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
    });
  });

  it('拒绝不符合协议的提交信封与无镜像的容器档案', () => {
    const candidate = exportedCandidate();
    withTemp(storeRoot => {
      try {
        const store = createRunStore(storeRoot);
        const invalid = { ...envelopeFor(candidate), reason: 'guess' };
        expect(() => store.submit({ taskId, envelope: invalid, candidateDirectory: candidate, submittedBy: 'operator' }))
          .toThrow(SubmissionRejectedError);

        const envelope = envelopeFor(candidate);
        expect(() => store.submit({
          taskId, envelope, candidateDirectory: candidate, submittedBy: 'operator', profile: 'linux-container',
        })).toThrow(/镜像 digest/);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
    });
  });
});

describe('幂等提交记录', () => {
  it('同键同快照复用同一次冻结，不重复冻结', () => {
    const candidate = exportedCandidate();
    withTemp(storeRoot => {
      try {
        const store = createRunStore(storeRoot);
        const envelope = envelopeFor(candidate);
        const first = store.submit({ taskId, envelope, candidateDirectory: candidate, submittedBy: 'operator' });
        const frozen = readFileSync(join(first.directory, 'freeze.json'), 'utf8');
        const second = store.submit({ taskId, envelope, candidateDirectory: candidate, submittedBy: 'operator' });

        expect(first.outcome).toBe('created');
        expect(second.outcome).toBe('reused');
        expect(second.attempt.runId).toBe(first.attempt.runId);
        expect(second.attempt.attemptId).toBe(first.attempt.attemptId);
        expect(readFileSync(join(first.directory, 'freeze.json'), 'utf8')).toBe(frozen);
        expect(store.list()).toHaveLength(1);
        expect(readdirSync(join(storeRoot, taskId))).toHaveLength(1);
        expect(store.read(envelope.idempotencyKey)?.attempt.treeHash).toBe(first.attempt.treeHash);

        // 事件流：冻结时追加 run.created 与 submission.frozen，seq 单调递增
        const events = readRunEvents(first.directory);
        expect(events.map(event => event.type)).toEqual(['run.created', 'submission.frozen']);
        expect(events.map(event => event.seq)).toEqual([1, 2]);
        expect(events.every(event => event.schemaVersion === '0.1.0')).toBe(true);
        expect(events[1]?.evidenceRefs).toEqual(['freeze.json', 'envelope.json']);
        // 重复完成事件复用同一次冻结，不重复记账
        expect(readRunEvents(second.directory)).toHaveLength(2);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
    });
  });

  it('同键不同快照报冲突，不覆盖首次结果', () => {
    const candidate = exportedCandidate();
    withTemp(storeRoot => {
      try {
        const store = createRunStore(storeRoot);
        const envelope = envelopeFor(candidate);
        const first = store.submit({ taskId, envelope, candidateDirectory: candidate, submittedBy: 'operator' });
        writeFileSync(join(candidate, 'starter', 'src', 'keyed-loader.ts'), 'export const fixed = true;\n');

        const second = envelopeFor(candidate, { idempotencyKey: envelope.idempotencyKey, runId: envelope.runId, attemptId: envelope.attemptId });
        expect(() => store.submit({ taskId, envelope: second, candidateDirectory: candidate, submittedBy: 'operator' }))
          .toThrow(IdempotencyConflictError);
        expect(store.read(envelope.idempotencyKey)?.attempt.treeHash).toBe(first.attempt.treeHash);
        expect(store.list()).toHaveLength(1);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
    });
  });

  it('幂等键不得跨题目复用', () => {
    const candidate = exportedCandidate();
    withTemp(storeRoot => {
      try {
        const store = createRunStore(storeRoot);
        const envelope = envelopeFor(candidate);
        store.submit({ taskId, envelope, candidateDirectory: candidate, submittedBy: 'operator' });
        expect(() => store.submit({
          taskId, envelope: { ...envelope, taskId: 'CACHE-01' }, candidateDirectory: candidate, submittedBy: 'operator',
        })).toThrow(/题目与请求不一致/);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
    });
  });

  it('已冻结的 run/attempt 不能被其它幂等键覆盖', () => {
    const candidate = exportedCandidate();
    withTemp(storeRoot => {
      try {
        const store = createRunStore(storeRoot);
        const first = envelopeFor(candidate);
        store.submit({ taskId, envelope: first, candidateDirectory: candidate, submittedBy: 'operator' });
        const replay = envelopeFor(candidate, { runId: first.runId, attemptId: first.attemptId });
        expect(() => store.submit({ taskId, envelope: replay, candidateDirectory: candidate, submittedBy: 'operator' }))
          .toThrow(AttemptExistsError);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
    });
  });
});

describe('冻结之后', () => {
  it('源目录被修改不改变被测对象', () => {
    const candidate = exportedCandidate();
    const original = readFileSync(join(candidate, 'starter', 'src', 'keyed-loader.ts'), 'utf8');
    withTemp(storeRoot => {
      try {
        const store = createRunStore(storeRoot);
        const envelope = envelopeFor(candidate);
        const outcome = store.submit({ taskId, envelope, candidateDirectory: candidate, submittedBy: 'operator' });

        writeFileSync(join(candidate, 'starter', 'src', 'keyed-loader.ts'), '// 提交后修改，不应进入被测对象\n');
        writeFileSync(join(candidate, 'extra.txt'), 'added after freeze\n');

        const materialized = store.materialize(envelope.runId, envelope.attemptId, join(storeRoot, 'replay'));
        expect(materialized.treeHash).toBe(outcome.attempt.treeHash);
        expect(readFileSync(join(materialized.directory, 'starter', 'src', 'keyed-loader.ts'), 'utf8')).toBe(original);
        expect(existsSync(join(materialized.directory, 'extra.txt'))).toBe(false);
        expect(store.readAttempt(envelope.runId, envelope.attemptId)?.attempt.treeHash).toBe(outcome.attempt.treeHash);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
    });
  });

  it('冻结快照被篡改时拒绝物化', () => {
    const candidate = exportedCandidate();
    withTemp(storeRoot => {
      try {
        const store = createRunStore(storeRoot);
        const envelope = envelopeFor(candidate);
        const outcome = store.submit({ taskId, envelope, candidateDirectory: candidate, submittedBy: 'operator' });
        writeFileSync(join(outcome.directory, 'candidate', 'starter', 'src', 'keyed-loader.ts'), '// tampered\n');
        expect(() => store.materialize(envelope.runId, envelope.attemptId, join(storeRoot, 'replay')))
          .toThrow(FrozenSnapshotTamperedError);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
    });
  });

  it('物化目标必须为空', () => {
    const candidate = exportedCandidate();
    withTemp(storeRoot => {
      try {
        const store = createRunStore(storeRoot);
        const envelope = envelopeFor(candidate);
        store.submit({ taskId, envelope, candidateDirectory: candidate, submittedBy: 'operator' });
        const occupied = join(storeRoot, 'occupied');
        mkdirSync(occupied, { recursive: true });
        writeFileSync(join(occupied, 'keep.txt'), 'busy\n');
        expect(() => store.materialize(envelope.runId, envelope.attemptId, occupied)).toThrow(/必须为空/);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
    });
  });
});
