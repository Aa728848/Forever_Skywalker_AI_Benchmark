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
  const values: Record<string, string> = {};
  const rest: string[] = [];
  let verbose: boolean | null = null;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    if (token === '--') {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith('--')) {
      const name = token.slice(2);
      if (name === 'verbose') { verbose = true; index += 1; continue; }
      if (name === 'no-verbose') { verbose = false; index += 1; continue; }
      if (!valueOptions.includes(name)) { index += 1; continue; }
      const inline = argv[index] as string;
      if (inline.includes('=')) {
        values[name] = inline.slice(inline.indexOf('=') + 1);
        index += 1;
        continue;
      }
      values[name] = (argv[index + 1] ?? '') as string;
      index += 2;
      continue;
    }
    rest.push(token);
    index += 1;
  }
  return {
    host: values.host || defaults.host,
    port: Number(values.port) || defaults.port,
    tag: values.tag || defaults.tag,
    verbose: verbose ?? defaults.verbose,
    rest,
  };
}
