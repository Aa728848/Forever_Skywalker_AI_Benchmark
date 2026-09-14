export interface ParsedLine {
  readonly key: string;
  readonly value: number;
}

export class InvalidLineError extends Error {
  readonly index: number;
  constructor(index: number, line: string) {
    super('第 ' + index + ' 行不是合法的 key=value：' + line);
    this.name = 'InvalidLineError';
    this.index = index;
  }
}

const linePattern = /^([^\s=]+)=(-?\d+)$/;

export function parseLine(line: string, index = 0): ParsedLine {
  const match = linePattern.exec(line);
  if (match === null) throw new InvalidLineError(index, line);
  return { key: match[1] as string, value: Number(match[2]) };
}

/** 替代实现：用普通对象累加，并在结束时按 key 排序输出。 */
export function summarizeRecords(lines: readonly string[]): Record<string, number> {
  const totals: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [index, line] of lines.entries()) {
    const parsed = parseLine(line, index);
    totals[parsed.key] = (totals[parsed.key] ?? 0) + parsed.value;
  }
  const result: Record<string, number> = {};
  for (const key of Object.keys(totals).sort()) result[key] = totals[key] as number;
  return result;
}
