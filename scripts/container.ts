import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stateDirectory = join(root, 'data', 'container');
const stateFile = join(stateDirectory, 'runtime.json');
const desktopCli = join(process.env.ProgramFiles ?? 'C:/Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe');
const docker = process.platform === 'win32' && existsSync(desktopCli) ? desktopCli : 'docker';
if (docker !== 'docker') process.env.PATH = dirname(docker) + delimiter + (process.env.PATH ?? '');

function capture(args: string[], timeout = 30000): string {
  const result = spawnSync(docker, args, { cwd: root, encoding: 'utf8', timeout, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker ${args[0]} 失败：${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

function run(command: string, args: string[], env = process.env): void {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} 退出 ${result.status}`);
}

function runtimeStatus() {
  const serverVersion = capture(['version', '--format', '{{.Server.Version}}']);
  const os = capture(['info', '--format', '{{.OSType}}']);
  if (os !== 'linux') throw new Error('当前 Docker 引擎不是 Linux 容器引擎。');
  return { serverVersion, os };
}

interface RuntimeRecord {
  image: string;
  imageDigest: string;
  createdAt: string;
  baseImages: { node: string; dotnet: string };
  versions: Record<string, string>;
}

function readRuntime(): RuntimeRecord {
  const value = JSON.parse(readFileSync(stateFile, 'utf8')) as RuntimeRecord;
  if (!/^sha256:[a-f0-9]{64}$/.test(value.image) || value.image !== value.imageDigest) throw new Error('运行镜像配置必须固定到不可变 image ID。');
  if (capture(['image', 'inspect', '--format', '{{.Id}}', value.image]) !== value.image) throw new Error('本地镜像与固定摘要不一致。');
  return value;
}

function configureProject(record: RuntimeRecord) {
  const path = join(root, '.env');
  let content = existsSync(path) ? readFileSync(path, 'utf8') : readFileSync(join(root, '.env.example'), 'utf8');
  for (const [key, value] of Object.entries({ BENCH_PROFILE: 'linux-container', BENCH_IMAGE: record.image, BENCH_IMAGE_DIGEST: record.imageDigest })) {
    const line = new RegExp('^' + key + '=.*$', 'm');
    content = line.test(content) ? content.replace(line, key + '=' + value) : content.trimEnd() + '\n' + key + '=' + value + '\n';
  }
  writeFileSync(path, content);
  console.log('已将本项目 .env 的执行档案设为固定 Linux 镜像；裁判与访问令牌保持原值。');
}

let runtimeConnected = false;
try {
  const command = process.argv[2] ?? 'status';
  if (!['status', 'build', 'trial'].includes(command)) throw new Error('用法：node scripts/container.ts status | build | trial [试跑参数]');
  const status = runtimeStatus();
  runtimeConnected = true;
  if (command === 'status') {
    console.log(JSON.stringify({ ...status, configuredImage: existsSync(stateFile) ? readRuntime() : null }, null, 2));
  } else if (command === 'build') {
    const baseImages = { node: 'node:24.14.1-bookworm-slim', dotnet: 'mcr.microsoft.com/dotnet/sdk:10.0.301' };
    for (const name of ['node', 'dotnet'] as const) {
      run(docker, ['pull', baseImages[name]]);
      baseImages[name] = capture(['image', 'inspect', '--format', '{{index .RepoDigests 0}}', baseImages[name]]);
      if (!/@sha256:[a-f0-9]{64}$/.test(baseImages[name])) throw new Error('基础镜像未返回固定 manifest digest。');
    }
    run(docker, ['build', '--build-arg', `NODE_IMAGE=${baseImages.node}`, '--build-arg', `DOTNET_IMAGE=${baseImages.dotnet}`,
      '--tag', 'forever-skywalker-runtime:0.1.0', '--file', join(root, 'containers', 'runtime.Dockerfile'), join(root, 'containers')]);
    const image = capture(['image', 'inspect', '--format', '{{.Id}}', 'forever-skywalker-runtime:0.1.0']);
    const versions: Record<string, string> = {};
    for (const tool of ['node', 'dotnet', 'python', 'chromium']) versions[tool] = capture(['run', '--rm', '--network', 'none', '--entrypoint', tool, image, '--version']);
    const record: RuntimeRecord = { image, imageDigest: image, createdAt: new Date().toISOString(), baseImages, versions };
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(stateFile, JSON.stringify(record, null, 2) + '\n');
    configureProject(record);
    console.log(JSON.stringify(record, null, 2));
  } else {
    const record = readRuntime();
    run(process.execPath, ['scripts/trial.ts', ...process.argv.slice(3)], { ...process.env, BENCH_PROFILE: 'linux-container', BENCH_IMAGE: record.image, BENCH_IMAGE_DIGEST: record.imageDigest });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (process.platform === 'win32' && !runtimeConnected) console.error('若本次刚启用 VirtualMachinePlatform，须先重启 Windows，再启动 Docker Desktop；此命令不会回退到宿主执行。');
  process.exitCode = 1;
}
