import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executionPhaseValidator } from '@fsa/contracts';
import {
  InfrastructureUnavailableError, buildContainerArgv, buildContainerInvocation, containerImageReference,
  defaultPidsLimit, isContainerRuntimeFailure, probeContainerRuntime, requirePinnedImage,
} from './container.ts';

const digest = 'sha256:' + 'a'.repeat(64);
const runtime = { command: 'docker', serverVersion: '27.0.0' };

describe('容器镜像引用', () => {
  it('必须给出镜像名与 manifest digest', () => {
    expect(containerImageReference('fsa-bench-node24', digest)).toBe('fsa-bench-node24@' + digest);
    expect(containerImageReference(digest, digest)).toBe(digest);
    expect(() => containerImageReference('fsa-bench-node24', 'sha256:short')).toThrow(InfrastructureUnavailableError);
    expect(() => containerImageReference('   ', digest)).toThrow(InfrastructureUnavailableError);
  });

  it('docker 自身的失败码与非容器失败分开', () => {
    expect(isContainerRuntimeFailure(125)).toBe(true);
    expect(isContainerRuntimeFailure(127)).toBe(true);
    for (const code of [134, 137, 139]) expect(isContainerRuntimeFailure(code)).toBe(false);
    expect(isContainerRuntimeFailure(1)).toBe(false);
    expect(isContainerRuntimeFailure(null)).toBe(false);
  });
});

describe('容器调用参数', () => {
  const invocation = buildContainerInvocation({
    runtime,
    image: 'fsa-bench-node24',
    imageDigest: digest,
    workspace: join('C:', 'work', 'candidate'),
    hiddenChecksDirectory: join('C:', 'repo', 'graders', 'CACHE-02', 'checks'),
    samplerHostPath: join('C:', 'pkg', 'resource-sampler.mjs'),
    argv: buildContainerArgv(['node', '--test', 'public-tests/**/*.test.ts'], 512),
    limits: { cpus: 1, memoryMb: 512, pidsLimit: defaultPidsLimit },
    resourceReportContainerPath: '/work/public.resources.json',
  });

  it('关闭网络并施加 CPU、内存与 PID 限额', () => {
    expect(invocation.argv.slice(0, 4)).toEqual(['docker', 'run', '--name', invocation.name]);
    expect(invocation.argv.join(' ')).toContain('--pull never');
    expect(invocation.argv).toContain('--read-only');
    expect(invocation.argv.join(' ')).toContain('--cap-drop ALL');
    expect(invocation.argv.join(' ')).toContain('--security-opt no-new-privileges');
    expect(invocation.argv.join(' ')).toContain('--user ');
    expect(invocation.argv).toContain('/tmp:rw,nosuid,nodev,size=256m,mode=1777');
    expect(invocation.argv.join(' ')).toContain('--network none');
    expect(invocation.argv.join(' ')).toContain('--cpus 1');
    expect(invocation.argv.join(' ')).toContain('--memory 512m --memory-swap 512m');
    expect(invocation.argv.join(' ')).toContain('--pids-limit ' + defaultPidsLimit);
  });

  it('真实容器参数可写入执行协议，原始命令的输入上限不随包装放宽', () => {
    const phase = { kind: 'public', declaredCommand: ['node', '--test', 'public-tests/**/*.test.ts'], argv: invocation.argv,
      cwd: invocation.cwd, timeoutMs: 60000, exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1,
      resource: { peakRssBytes: null, userCpuMs: null, systemCpuMs: null, sampler: 'unavailable' }, missing: [], artifacts: [] };
    expect(executionPhaseValidator.Check(phase)).toBe(true);
    expect(executionPhaseValidator.Check({ ...phase, declaredCommand: invocation.argv })).toBe(false);
  });

  it('工作目录可写、隐藏检查只读挂载且不复制进候选树', () => {
    expect(invocation.argv).toContain(join('C:', 'work', 'candidate') + ':/work');
    expect(invocation.argv).toContain(join('C:', 'repo', 'graders', 'CACHE-02', 'checks') + ':/work/__checks__:ro');
    expect(invocation.argv.join(' ')).toContain('--workdir /work');
  });

  it('注入只读采样器，并在镜像内使用 node 而不是宿主路径', () => {
    expect(invocation.argv).toContain(join('C:', 'pkg', 'resource-sampler.mjs') + ':/opt/fsa/resource-sampler.mjs:ro');
    expect(invocation.argv).toContain('FSA_RESOURCE_REPORT=/work/public.resources.json');
    const imageIndex = invocation.argv.indexOf(invocation.reference);
    expect(imageIndex).toBeGreaterThan(0);
    expect(invocation.argv.slice(imageIndex + 1)).toEqual([
      'node', '--import=file:///opt/fsa/resource-sampler.mjs', '--max-old-space-size=512', '--test-isolation=process', '--test', 'public-tests/**/*.test.ts',
    ]);
  });

  it('非 node 命令按原样进入容器（F# 题）', () => {
    expect(buildContainerArgv(['dotnet', 'fsi', 'public-tests/checks.fsx'], 512)).toEqual(['dotnet', 'fsi', 'public-tests/checks.fsx']);
  });

  it('容器环境不透传宿主代理或凭据', () => {
    expect(Object.keys(invocation.environment).filter(key => /proxy|token|secret|password/i.test(key))).toEqual([]);
  });
});

describe('运行时与镜像探测', () => {
  it('运行时缺失时明确报基础设施不可用，且不尝试拉取镜像', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fsa-container-'));
    try {
      expect(() => probeContainerRuntime({ command: 'fsa-missing-container-runtime', captureDir: directory }))
        .toThrow(InfrastructureUnavailableError);
      expect(() => probeContainerRuntime({ command: 'fsa-missing-container-runtime', captureDir: directory }))
        .toThrow(/容器运行时不可用/);
      expect(() => requirePinnedImage(runtime, 'fsa-bench-node24', digest, { captureDir: directory }))
        .toThrow(/不会在运行期拉取镜像/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
