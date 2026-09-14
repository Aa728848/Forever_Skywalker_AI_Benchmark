export interface CliDefaults {
  readonly host: string;
  readonly port: number;
  readonly tag: string;
  readonly verbose: boolean;
}

export interface ParsedCli extends CliDefaults {
  readonly rest: readonly string[];
}

export class CliUsageError extends Error {
  readonly option: string;
  constructor(option: string, message: string) {
    super(message);
    this.name = 'CliUsageError';
    this.option = option;
  }
}

const valueOptions = ['host', 'port', 'tag'];

export function parseCli(argv: readonly string[], defaults: CliDefaults): ParsedCli {
  const values = new Map<string, string>();
  const rest: string[] = [];
  let verbose: boolean | null = null;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    if (token === '--') {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) { rest.push(token); index += 1; continue; }
    const body = token.slice(2);
    const separator = body.indexOf('=');
    const name = separator < 0 ? body : body.slice(0, separator);
    const inline = separator < 0 ? null : body.slice(separator + 1);
    if (name.startsWith('no-verbose') || name === 'verbose') {
      if (inline !== null) throw new CliUsageError(name, '布尔选项不接受取值：--' + name);
      verbose = name !== 'no-verbose';
      index += 1;
      continue;
    }
    if (!valueOptions.includes(name)) throw new CliUsageError(name, '未知选项：--' + name);
    let value = inline;
    if (value === null) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new CliUsageError(name, '选项缺少取值：--' + name);
      value = next;
      index += 2;
    } else {
      index += 1;
    }
    values.set(name, value);
  }
  const portText = values.get('port');
  let port = defaults.port;
  if (portText !== undefined) {
    if (!/^\d+$/.test(portText)) throw new CliUsageError('port', '端口必须是非负十进制整数：' + portText);
    port = Number(portText);
    if (port > 65535) throw new CliUsageError('port', '端口超出范围：' + portText);
  }
  return {
    host: values.get('host') ?? defaults.host,
    port,
    tag: values.get('tag') ?? defaults.tag,
    verbose: verbose ?? defaults.verbose,
    rest,
  };
}
