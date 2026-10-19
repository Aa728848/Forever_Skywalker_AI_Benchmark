/**
 * 解析「作答中的实时输出」日志。
 *
 * 日志行由后端按固定形状写出（见 packages/evaluation/src/dsh-comparison.ts 的 liveStreamLine）：
 *
 * `  题目 · 预设/等级 · 第N次 › 类型: 内容`
 *
 * 并发时多条作答的行交错落在同一份 launch.log 里，前端按行首的身份把它们拆进各自的框：
 * 三路并发就该是三个框，而不是三段文字挤在一处。认不出身份的行（supervisor 的登记信息、
 * 抬头等）不丢，留在「原始日志」里。
 *
 * 这一层是纯函数：不碰 React，也不碰网络，便于单独验证。
 */

export type LiveKind = 'phase' | 'text' | 'think' | 'tool' | 'result' | 'end';

export interface LiveIdentity {
  taskId: string;
  preset: string;
  mode: string;
  repetition: number;
}

export interface LiveEvent {
  kind: LiveKind;
  payload: string;
}

/** 一条作答在面板上的状态：在跑 / 已完成 / 失败 / 已中止。 */
export type LiveAnswerState = 'running' | 'done' | 'failed' | 'stopped';

export interface LiveAnswer {
  key: string;
  identity: LiveIdentity;
  events: LiveEvent[];
  state: LiveAnswerState;
  /** 最近一次的阶段文案：框头显示它。 */
  phase: string;
}

export interface LiveStreams {
  answers: LiveAnswer[];
  /** 认不出身份的行：supervisor 的登记信息与抬头。 */
  other: string[];
}

export const emptyLiveStreams: LiveStreams = { answers: [], other: [] };

/** 行首两格缩进 + 身份 + 类型词。类型词是稳定的机器词，不随文案改。 */
const linePattern = /^ {2}(\S+) · (\S+)\/(\S+) · 第(\d+)次 › ([a-z]+): (.*)$/;

const kinds: readonly LiveKind[] = ['phase', 'text', 'think', 'tool', 'result', 'end'];

export function identityKey(identity: LiveIdentity): string {
  return identity.taskId + '|' + identity.preset + '|' + identity.mode + '|' + identity.repetition;
}

export function parseStreamLine(line: string): { identity: LiveIdentity; kind: LiveKind; payload: string } | null {
  const matched = linePattern.exec(line);
  if (matched === null) return null;
  const kind = matched[5] ?? '';
  if (!kinds.includes(kind as LiveKind)) return null;
  return {
    identity: { taskId: matched[1] ?? '', preset: matched[2] ?? '', mode: matched[3] ?? '', repetition: Number(matched[4] ?? '0') },
    kind: kind as LiveKind,
    payload: matched[6] ?? '',
  };
}

/**
 * 阶段 → 状态。
 *
 * 只有终态阶段才把这条作答标成「已结束」：DSH 的 turn/end 只是本轮对话结束，
 * 后面还有容器验证与评分，那段时间这条作答仍然在跑。
 */
function phaseState(payload: string): LiveAnswerState | null {
  if (payload.startsWith('已完成')) return 'done';
  if (payload.startsWith('失败')) return 'failed';
  if (payload.startsWith('已中止')) return 'stopped';
  return null;
}

/**
 * 把新到的行并进已有的流。
 *
 * 先按作答分组再一次性落库：每行都复制一次数组，长轮次会变成平方级。
 */
export function applyStreamLines(state: LiveStreams, lines: string[]): LiveStreams {
  const meaningful = lines.filter(line => line.trim() !== '');
  if (meaningful.length === 0) return state;
  const answers = new Map(state.answers.map(answer => [answer.key, answer]));
  const order = state.answers.map(answer => answer.key);
  const other = state.other.slice();
  const pending = new Map<string, { identity: LiveIdentity; events: LiveEvent[]; state: LiveAnswerState; phase: string }>();
  for (const line of meaningful) {
    const parsed = parseStreamLine(line);
    if (parsed === null) { other.push(line); continue; }
    const key = identityKey(parsed.identity);
    const bucket = pending.get(key) ?? { identity: parsed.identity, events: [], state: 'running' as LiveAnswerState, phase: '' };
    bucket.events.push({ kind: parsed.kind, payload: parsed.payload });
    if (parsed.kind === 'phase') {
      bucket.phase = parsed.payload;
      const next = phaseState(parsed.payload);
      if (next !== null) bucket.state = next;
    }
    pending.set(key, bucket);
  }
  for (const [key, bucket] of pending) {
    const previous = answers.get(key);
    answers.set(key, {
      key,
      identity: previous?.identity ?? bucket.identity,
      events: previous ? previous.events.concat(bucket.events) : bucket.events,
      state: bucket.state === 'running' && previous !== undefined ? previous.state : bucket.state,
      phase: bucket.phase !== '' ? bucket.phase : (previous?.phase ?? ''),
    });
    if (previous === undefined) order.push(key);
  }
  return { answers: order.map(key => answers.get(key)).filter((answer): answer is LiveAnswer => answer !== undefined), other };
}

export interface LogChunk {
  lines: string[];
  /** 还没写完的半行：下次接着拼。服务端按 64KB 切片，切口可能落在行中间。 */
  rest: string;
}

export function splitLogChunk(rest: string, chunk: string): LogChunk {
  const parts = (rest + chunk).split('\n');
  const tail = parts.pop() ?? '';
  return { lines: parts.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line)), rest: tail };
}

/** 后端用全角竖线分隔字段：工具名｜参数摘要、状态｜工具名｜结果摘要。 */
export function splitFields(payload: string): string[] {
  return payload.split('｜');
}
