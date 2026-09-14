import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 容器档案：把冻结快照以只读隐藏检查挂载进固定镜像，用容器自身的限额与网络策略执行。
 * 执行器不在运行期拉取镜像，也不把候选代码放到宿主上跑；运行时缺失时直接拒绝执行。
 */
export class InfrastructureUnavailableError extends Error {}

export const containerWorkspace = '/work';
export const hiddenChecksMount = '/work/__checks__';
export const containerSamplerPath = '/opt/fsa/resource-sampler.mjs';
export const containerSamplerUrl = 'file://' + containerSamplerPath;
export const defaultPidsLimit = 512;

export interface CommandCapture {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 用文件描述符采集外部命令输出：受限沙盒下管道不可用，而且原始输出要留作证据。 */
export function captureCommand(
  argv: readonly string[],
  options: { cwd?: string; timeoutMs: number; captureDir: string; label: string },
): CommandCapture {
  mkdirSync(options.captureDir, { recursive: true });
  const stdoutPath = join(options.captureDir, options.label + '.stdout.txt');
  const stderrPath = join(options.captureDir, options.label + '.stderr.txt');
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  let status: number | null = null;
  try {
    const result = spawnSync(argv[0] ?? '', argv.slice(1), {
      cwd: options.cwd ?? process.cwd(),
      stdio: ['ignore', stdoutFd, stderrFd],
      timeout: options.timeoutMs,
      windowsHide: true,
    });
    status = result.status;
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  return { exitCode: status, stdout: readFileSync(stdoutPath, 'utf8'), stderr: readFileSync(stderrPath, 'utf8') };
}

export interface ContainerRuntime {
  readonly command: string;
  readonly serverVersion: string;
}

export interface ContainerLimits {
  readonly cpus: number;
  readonly memoryMb: number;
  readonly pidsLimit: number;
}

export interface ContainerInvocationOptions {
  readonly runtime: ContainerRuntime;
  readonly image: string;
  readonly imageDigest: string;
  readonly workspace: string;
  readonly hiddenChecksDirectory: string;
  readonly samplerHostPath: string;
  readonly argv: readonly string[];
  readonly limits: ContainerLimits;
  readonly resourceReportContainerPath: string | null;
}

export interface ContainerInvocation {
  readonly reference: string;
  readonly argv: string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** 容器运行时的固定引用：镜像名 + manifest digest。 */
export function containerImageReference(image: string, imageDigest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new InfrastructureUnavailableError('容器镜像 digest 非法：' + imageDigest);
  if (image.trim() === '') throw new InfrastructureUnavailableError('容器镜像引用不能为空。');
  return image + '@' + imageDigest;
}

/** docker 自身的失败码：125 参数或守护进程问题，126 无法执行，127 命令不存在。 */
export function isContainerRuntimeFailure(exitCode: number | null): boolean {
  return exitCode !== null && exitCode >= 125;
}

/** node 命令在容器内使用镜像提供的 node，并注入只读挂载的采样器。 */
export function buildContainerArgv(declared: readonly string[], memoryMb: number): string[] {
  const [executable = '', ...rest] = declared;
  if (executable !== 'node') return [...declared];
  return ['node', '--import=' + containerSamplerUrl, '--max-old-space-size=' + memoryMb, ...rest];
}

/** docker CLI 自身需要的宿主环境；容器内环境只通过 --env 显式传入。 */
function dockerClientEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'windir', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'DOCKER_HOST', 'DOCKER_CONTEXT']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function buildContainerInvocation(options: ContainerInvocationOptions): ContainerInvocation {
  const reference = containerImageReference(options.image, options.imageDigest);
  const argv = [
    options.runtime.command, 'run', '--rm',
    '--network', 'none',
    '--cpus', String(options.limits.cpus),
    '--memory', options.limits.memoryMb + 'm',
    '--memory-swap', options.limits.memoryMb + 'm',
    '--pids-limit', String(options.limits.pidsLimit),
    '--workdir', containerWorkspace,
    '--volume', options.workspace + ':' + containerWorkspace,
    '--volume', options.hiddenChecksDirectory + ':' + hiddenChecksMount + ':ro',
    '--volume', options.samplerHostPath + ':' + containerSamplerPath + ':ro',
  ];
  if (options.resourceReportContainerPath !== null) {
    argv.push('--env', 'FSA_RESOURCE_REPORT=' + options.resourceReportContainerPath);
  }
  argv.push(reference, ...options.argv);
  return { reference, argv, cwd: options.workspace, environment: dockerClientEnvironment() };
}

export interface ContainerRuntimeOptions {
  readonly command?: string;
  readonly captureDir: string;
  readonly timeoutMs?: number;
}

/** 探测容器运行时与守护进程；不可用时抛 InfrastructureUnavailableError。 */
export function probeContainerRuntime(options: ContainerRuntimeOptions): ContainerRuntime {
  const command = options.command ?? process.env.BENCH_CONTAINER_RUNTIME ?? 'docker';
  const probe = captureCommand([command, 'version', '--format', '{{.Server.Version}}'], {
    timeoutMs: options.timeoutMs ?? 30_000,
    captureDir: options.captureDir,
    label: 'runtime-probe',
  });
  if (probe.exitCode !== 0) {
    const detail = (probe.stderr.trim() || probe.stdout.trim()).split('\n')[0] ?? '';
    throw new InfrastructureUnavailableError('容器运行时不可用（' + command + ' version 退出码 ' + String(probe.exitCode) + '）：' + detail.slice(0, 200));
  }
  const serverVersion = probe.stdout.trim();
  if (serverVersion === '') throw new InfrastructureUnavailableError('容器运行时没有返回服务端版本。');
  return { command, serverVersion };
}

/** 镜像必须已在本地按 digest 固定；执行器不在运行期拉取镜像。 */
export function requirePinnedImage(
  runtime: ContainerRuntime,
  image: string,
  imageDigest: string,
  options: { captureDir: string; timeoutMs?: number },
): string {
  const reference = containerImageReference(image, imageDigest);
  const inspected = captureCommand([runtime.command, 'image', 'inspect', reference], {
    timeoutMs: options.timeoutMs ?? 30_000,
    captureDir: options.captureDir,
    label: 'image-inspect',
  });
  if (inspected.exitCode !== 0) {
    throw new InfrastructureUnavailableError('本地没有按 digest 固定的镜像 ' + reference + '；正式执行不会在运行期拉取镜像。');
  }
  return reference;
}
