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
    Object.defineProperty(normalized, name, { value:score, enumerable:true, writable:true, configurable:true });
  }
  const rationale = value.rationale;
  if (typeof rationale !== 'string' || rationale.trim() === '') throw new VerdictFormatError('invalid-shape', 'rationale 必须是非空字符串。');
  return { winner, scores: normalized, rationale };
}

/** 替代实现：用非贪婪正则收集围栏块，并用计数校验未闭合的 json 围栏。 */
function jsonBlocks(raw:string):string[]{
 const result:string[]=[];let active:{length:number;json:boolean;body:string[]}|undefined;
 for(const line of raw.split(/\r?\n/)){
  const match=/^[ \t]*(\x60{3,})([^\x60]*)$/.exec(line);
  if(!active){if(match)active={length:match[1]!.length,json:match[2]!.trim().toLowerCase()==='json',body:[]};continue;}
  if(match&&match[1]!.length>=active.length&&match[2]!.trim()===''){if(active.json)result.push(active.body.join('\n'));active=undefined;}else active.body.push(line);
 }
 if(active?.json)throw new VerdictFormatError('invalid-json','unclosed json fence');return result;
}

function singleBody(raw: string): string {
  const bodies = jsonBlocks(raw);
  if (bodies.length === 0) throw new VerdictFormatError('missing-block', '缺少 json 围栏块。');
  if (bodies.length > 1) throw new VerdictFormatError('multiple-blocks', '只能有一个 json 围栏块。');
  return bodies[0] as string;
}

function decode(body: string, label: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new VerdictFormatError('invalid-json', label + ' JSON 解析失败。');
  }
}

export function parseVerdict(raw: string): Verdict {
  return toVerdict(decode(singleBody(raw), '裁判结果'));
}

export function parseToolCalls(raw: string): ToolCall[] {
  const parsed = decode(singleBody(raw), '工具调用');
  if (!Array.isArray(parsed)) throw new VerdictFormatError('invalid-arguments', '工具调用必须是数组。');
  const calls: ToolCall[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const item: unknown = parsed[index];
    if (!isRecord(item)) throw new VerdictFormatError('invalid-arguments', '第 ' + index + ' 个工具调用必须是对象。');
    if (typeof item.name !== 'string' || item.name.trim() === '') throw new VerdictFormatError('invalid-arguments', '第 ' + index + ' 个工具调用缺少 name。');
    const rawArguments = item.arguments;
    let decoded: unknown = rawArguments;
    if (typeof rawArguments === 'string') {
      try {
        decoded = JSON.parse(rawArguments);
      } catch {
        throw new VerdictFormatError('invalid-arguments', '第 ' + index + ' 个工具调用的 arguments 不是合法 JSON。');
      }
    }
    if (!isRecord(decoded)) throw new VerdictFormatError('invalid-arguments', '第 ' + index + ' 个工具调用的 arguments 必须是对象。');
    calls.push({ name: item.name, arguments: decoded });
  }
  return calls;
}
