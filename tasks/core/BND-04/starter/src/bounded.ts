export interface Limits { readonly maxBytes: number; readonly maxDepth: number; readonly maxNodes: number }
export class ParseLimitError extends Error { readonly reason: 'bytes' | 'depth' | 'nodes'; readonly offset: number; constructor(reason: 'bytes' | 'depth' | 'nodes', offset: number) { super(reason + ' limit at ' + offset); this.reason=reason; this.offset=offset; } }
export function parseBounded(text: string, limits: Limits): unknown {
  // 缺陷：直接物化输入，所有空间和深度预算都没有检查。
  void limits;
  return JSON.parse(text);
}
