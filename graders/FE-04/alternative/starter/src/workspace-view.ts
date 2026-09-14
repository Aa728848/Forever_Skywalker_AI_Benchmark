export interface Row { readonly id:string; readonly text:string }
export type StreamEvent={kind:'snapshot';sequence:number;rows:readonly Row[]}|{kind:'append';sequence:number;id:string;text:string}|{kind:'error';message:string};
export type Connect=(workspace:string,after:number,onEvent:(event:StreamEvent)=>void)=>()=>void;
export interface Limits {readonly maxRows:number;readonly maxWorkspaces:number}
export interface Viewer {switchWorkspace(workspace:string):void;dispose():void;stats():{workspace:string|null;sequence:number;retainedRows:number;cachedWorkspaces:number}}

interface State {workspace:string;sequence:number;rows:Row[]}
export function mount(root:HTMLElement,connect:Connect,limits:Limits):Viewer {
  if(!Number.isInteger(limits.maxRows)||limits.maxRows<1||!Number.isInteger(limits.maxWorkspaces)||limits.maxWorkspaces<1)throw new RangeError('limits');
  const log=document.createElement('div'),alert=document.createElement('p');log.setAttribute('role','log');alert.setAttribute('role','alert');root.replaceChildren(log,alert);
  let caches:State[]=[],active:State|undefined,token:object={},stopped=false,close:(()=>void)|undefined;const nodes=new Map<string,HTMLElement>();
  const write=(row:Row)=>{let node=nodes.get(row.id);if(!node){node=document.createElement('article');node.dataset['rowId']=row.id;nodes.set(row.id,node);log.append(node);}node.textContent=row.text;};
  const show=(state:State)=>{nodes.clear();log.replaceChildren();state.rows.forEach(write);};
  return {
    switchWorkspace(workspace){if(stopped)return;close?.();const ticket={};token=ticket;const state=caches.find(entry=>entry.workspace===workspace)??{workspace,sequence:0,rows:[]};caches=caches.filter(entry=>entry!==state);caches.push(state);caches=caches.slice(-limits.maxWorkspaces);active=state;show(state);alert.textContent='';
      close=connect(workspace,state.sequence,event=>{if(stopped||token!==ticket)return;if(event.kind==='error'){alert.textContent=event.message;return;}if(!Number.isSafeInteger(event.sequence)||event.sequence<0)throw new RangeError('sequence');
        if(event.kind==='snapshot'){if(event.sequence<state.sequence)return;if(new Set(event.rows.map(row=>row.id)).size!==event.rows.length)throw new RangeError('duplicate row');state.rows=event.rows.slice(-limits.maxRows).map(row=>({...row}));state.sequence=event.sequence;show(state);return;}
        if(event.sequence<=state.sequence)return;if(event.sequence!==state.sequence+1){alert.textContent='sequence gap';return;}
        const row={id:event.id,text:event.text};const at=state.rows.findIndex(entry=>entry.id===row.id);if(at===-1)state.rows.push(row);else state.rows[at]=row;state.sequence=event.sequence;write(row);
        if(state.rows.length>limits.maxRows){const removed=state.rows.shift()!;nodes.get(removed.id)?.remove();nodes.delete(removed.id);}
      });
    },
    dispose(){if(stopped)return;stopped=true;token={};close?.();close=undefined;active=undefined;caches=[];nodes.clear();root.replaceChildren();},
    stats(){return {workspace:active?.workspace??null,sequence:active?.sequence??0,retainedRows:caches.reduce((n,state)=>n+state.rows.length,0),cachedWorkspaces:caches.length};}
  };
}
