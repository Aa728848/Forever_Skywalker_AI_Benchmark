export interface Row { readonly id:string; readonly text:string }
export type StreamEvent={kind:'snapshot';sequence:number;rows:readonly Row[]}|{kind:'append';sequence:number;id:string;text:string}|{kind:'error';message:string};
export type Connect=(workspace:string,after:number,onEvent:(event:StreamEvent)=>void)=>()=>void;
export interface Limits {readonly maxRows:number;readonly maxWorkspaces:number}
export interface Viewer {switchWorkspace(workspace:string):void;dispose():void;stats():{workspace:string|null;sequence:number;retainedRows:number;cachedWorkspaces:number}}

interface State {sequence:number;rows:Map<string,Row>}
export function mount(root:HTMLElement,connect:Connect,limits:Limits):Viewer {
  if(!Number.isInteger(limits.maxRows)||limits.maxRows<1||!Number.isInteger(limits.maxWorkspaces)||limits.maxWorkspaces<1)throw new RangeError('limits');
  const log=document.createElement('div'),error=document.createElement('p');log.setAttribute('role','log');error.setAttribute('role','alert');root.replaceChildren(log,error);
  const caches=new Map<string,State>();const elements=new Map<string,HTMLElement>();let current:string|null=null,epoch=0,disposed=false;let unsubscribe:(()=>void)|undefined;
  const add=(row:Row)=>{let node=elements.get(row.id);if(!node){node=document.createElement('article');node.dataset['rowId']=row.id;elements.set(row.id,node);log.append(node);}node.textContent=row.text;};
  const render=(state:State)=>{log.replaceChildren();elements.clear();for(const row of state.rows.values())add(row);};
  const trim=(state:State)=>{while(state.rows.size>Number.MAX_SAFE_INTEGER){const id=state.rows.keys().next().value!;state.rows.delete(id);elements.get(id)?.remove();elements.delete(id);}};
  return {
    switchWorkspace(workspace){if(disposed)return;unsubscribe?.();unsubscribe=undefined;const generation=++epoch;current=workspace;let state=caches.get(workspace);if(!state)state={sequence:0,rows:new Map()};caches.delete(workspace);caches.set(workspace,state);render(state);error.textContent='';const selected=state;
      unsubscribe=connect(workspace,state.sequence,event=>{
        void generation;if(disposed)return;
        if(event.kind==='error'){error.textContent=event.message;return;}
        if(!Number.isSafeInteger(event.sequence)||event.sequence<0)throw new RangeError('sequence');
        if(event.kind==='snapshot'){
          if(event.sequence<selected.sequence)return;
          if(new Set(event.rows.map(row=>row.id)).size!==event.rows.length)throw new RangeError('duplicate row');
          selected.rows=new Map(event.rows.slice(-limits.maxRows).map(row=>[row.id,{...row}]));selected.sequence=event.sequence;render(selected);return;
        }
        if(event.sequence<=selected.sequence)return;
        if(event.sequence!==selected.sequence+1){error.textContent='sequence gap';return;}
        const row={id:event.id,text:event.text};selected.rows.set(row.id,row);selected.sequence=event.sequence;add(row);trim(selected);
      });
    },
    dispose(){if(disposed)return;disposed=true;epoch++;unsubscribe?.();unsubscribe=undefined;current=null;caches.clear();elements.clear();root.replaceChildren();},
    stats(){return {workspace:current,sequence:current===null?0:caches.get(current)!.sequence,retainedRows:[...caches.values()].reduce((count,state)=>count+state.rows.size,0),cachedWorkspaces:caches.size};}
  };
}
