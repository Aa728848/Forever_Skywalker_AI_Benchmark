export interface Limits { readonly maxBytes: number; readonly maxDepth: number; readonly maxNodes: number }
export class ParseLimitError extends Error { readonly reason: 'bytes' | 'depth' | 'nodes'; readonly offset: number; constructor(reason: 'bytes' | 'depth' | 'nodes', offset: number) { super(reason + ' limit at ' + offset); this.reason=reason; this.offset=offset; } }
export function parseBounded(text: string, limits: Limits): unknown {
  for (const value of [limits.maxBytes, limits.maxDepth, limits.maxNodes]) if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('limits must be nonnegative safe integers');
  if (Buffer.byteLength(text, 'utf8') > limits.maxBytes) throw new ParseLimitError('bytes', 0);
  const tokens= /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]|[^\s,:{}\[\]"]+/g;
  let depth=0, count=0;
  for(const match of text.matchAll(tokens)) {
    const token=match[0];
    if(token===']'||token==='}') {depth--;continue;}
    if(++count>limits.maxNodes) throw new ParseLimitError('nodes',match.index);
    if(token==='['||token==='{') if(++depth>limits.maxDepth) throw new ParseLimitError('depth',match.index);
  }
  return JSON.parse(text);
}
