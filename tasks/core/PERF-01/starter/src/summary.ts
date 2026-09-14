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

export function summarizeRecords(lines: readonly string[]): Record<string, number> {
  const keys: string[] = [];
  const result: Record<string, number> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseLine(lines[index] as string, index);
    if (!keys.includes(parsed.key)) keys.push(parsed.key);
  }
  // 缺陷：为了求和中途结果，对每个 key 重新全量扫描输入，复杂度退化到 O(key 数 × 行数)。
  for (const key of keys) {
    let sum = 0;
    for (const line of lines) {
      const parsed = parseLine(line, 0);
      if (parsed.key === key) sum += parsed.value;
    }
    result[key] = sum;
  }
  return result;
}
