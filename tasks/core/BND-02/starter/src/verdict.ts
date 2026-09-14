export interface Verdict {
  readonly winner: string;
  readonly scores: Readonly<Record<string, number>>;
  readonly rationale: string;
}

export interface ToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type VerdictErrorCode = 'missing-block' | 'multiple-blocks' | 'invalid-json' | 'invalid-shape' | 'invalid-arguments';

export class VerdictFormatError extends Error {
  readonly code: VerdictErrorCode;
  constructor(code: VerdictErrorCode, message: string) {
    super(message);
    this.name = 'VerdictFormatError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验裁判结论结构；分数必须是 0 到 100 之间的有限数。 */
function toVerdict(value: unknown): Verdict {
  if (!isRecord(value)) throw new VerdictFormatError('invalid-shape', '裁判结果必须是 JSON 对象。');
  const winner = value.winner;
  if (typeof winner !== 'string' || winner.trim() === '') throw new VerdictFormatError('invalid-shape', 'winner 必须是非空字符串。');
  const scores = value.scores;
  if (!isRecord(scores)) throw new VerdictFormatError('invalid-shape', 'scores 必须是对象。');
  const normalized: Record<string, number> = {};
  for (const [name, score] of Object.entries(scores)) {
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
      throw new VerdictFormatError('invalid-shape', 'scores.' + name + ' 必须是 0 到 100 之间的有限数。');
    }
    normalized[name] = score;
  }
  const rationale = value.rationale;
  if (typeof rationale !== 'string' || rationale.trim() === '') throw new VerdictFormatError('invalid-shape', 'rationale 必须是非空字符串。');
  return { winner, scores: normalized, rationale };
}

/** 从原始文本里取出第一个看似 JSON 对象的片段。 */
function extractObjectBody(raw: string): string {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (match === null) throw new VerdictFormatError('missing-block', '没有找到 JSON 对象。');
  return match[0];
}

export function parseVerdict(raw: string): Verdict {
  const body = extractObjectBody(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new VerdictFormatError('invalid-json', 'JSON 解析失败。');
  }
  return toVerdict(parsed);
}

export function parseToolCalls(raw: string): ToolCall[] {
  const match = /\[[\s\S]*\]/.exec(raw);
  if (match === null) throw new VerdictFormatError('missing-block', '没有找到工具调用数组。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new VerdictFormatError('invalid-json', '工具调用 JSON 解析失败。');
  }
  if (!Array.isArray(parsed)) throw new VerdictFormatError('invalid-arguments', '工具调用必须是数组。');
  return parsed.map((item, index) => {
    if (!isRecord(item)) throw new VerdictFormatError('invalid-arguments', '第 ' + index + ' 个工具调用必须是对象。');
    const name = item.name;
    if (typeof name !== 'string' || name.trim() === '') throw new VerdictFormatError('invalid-arguments', '第 ' + index + ' 个工具调用缺少 name。');
    const args = item.arguments;
    if (!isRecord(args) && typeof args !== 'string') throw new VerdictFormatError('invalid-arguments', '第 ' + index + ' 个工具调用的 arguments 必须是对象或 JSON 字符串。');
    return { name, arguments: args as Record<string, unknown> };
  });
}

