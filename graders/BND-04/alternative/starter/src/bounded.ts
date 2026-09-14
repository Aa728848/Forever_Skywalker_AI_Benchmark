export interface Limits {readonly maxBytes:number;readonly maxDepth:number;readonly maxNodes:number}
export class ParseLimitError extends Error {readonly reason:'bytes'|'depth'|'nodes';readonly offset:number;constructor(reason:'bytes'|'depth'|'nodes',offset:number){super(reason+' limit at '+offset);this.reason=reason;this.offset=offset;}}
function prepare(text:string,limits:Limits){for(const n of [limits.maxBytes,limits.maxDepth,limits.maxNodes])if(!Number.isSafeInteger(n)||n<0)throw new RangeError('invalid limits');if(Buffer.byteLength(text,'utf8')>limits.maxBytes)throw new ParseLimitError('bytes',0);}
function stringEnd(text:string,start:number):number{let index=start+1;while(index<text.length){const code=text.charCodeAt(index++);if(code===34)return index;if(code<32)throw new SyntaxError('control character');if(code===92){const escape=text[index++];if(escape==='u'){if(!/^[0-9a-fA-F]{4}$/.test(text.slice(index,index+4)))throw new SyntaxError('unicode escape');index+=4;}else if(escape===undefined||![34,92,47,98,102,110,114,116].includes(escape.charCodeAt(0)))throw new SyntaxError('escape');}}throw new SyntaxError('unterminated string');}
const numeric=/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
function scalarEnd(text:string,index:number):number{if(text[index]==='"')return stringEnd(text,index);for(const literal of ['true','false','null'])if(text.startsWith(literal,index))return index+literal.length;numeric.lastIndex=index;const number=numeric.exec(text);if(!number)throw new SyntaxError('expected value');return numeric.lastIndex;}
export function parseBounded(text:string,limits:Limits):unknown{
 prepare(text,limits);let index=0,count=0;const instructions:{kind:string;depth:number}[]=[{kind:'end',depth:0},{kind:'value',depth:0}];
 const node=(at:number,depth:number)=>{if(++count>limits.maxNodes)throw new ParseLimitError('nodes',at);if(depth>limits.maxDepth)throw new ParseLimitError('depth',at);};
 const push=(kind:string,depth:number)=>instructions.push({kind,depth});
 while(instructions.length){while(index<text.length&&' \t\r\n'.includes(text[index]!))index++;const instruction=instructions.pop()!,{kind,depth}=instruction,token=text[index];
  if(kind==='end'){if(index!==text.length)throw new SyntaxError('trailing input');continue;}
  if(kind==='value'){const container=token==='['||token==='{';node(index,container?depth+1:0);if(container){index++;push(token==='['?'array-first':'object-first',depth+1);}else index=scalarEnd(text,index);continue;}
  if(kind==='colon'){if(token!==':')throw new SyntaxError('expected colon');index++;continue;}
  const object=kind.startsWith('object'),close=object?'}':']';
  if(kind.endsWith('first')&&token===close){index++;continue;}
  if(kind.endsWith('tail')){if(token===close){index++;continue;}if(token!==',')throw new SyntaxError('expected comma');index++;push(object?'object-next':'array-next',depth);continue;}
  push(object?'object-tail':'array-tail',depth);push('value',depth);
  if(object){if(token!=='"')throw new SyntaxError('expected key');node(index,0);index=stringEnd(text,index);push('colon',depth);}
 }
 return JSON.parse(text);
}
