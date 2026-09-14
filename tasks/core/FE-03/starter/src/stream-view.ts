export interface Message { readonly id:string; readonly text:string }
export interface StreamView { snapshot(sequence:number,messages:readonly Message[]):boolean; append(sequence:number,id:string,chunk:string):boolean; fail(message:string):void; dispose():void; lastSequence():number }

export function mount(root:HTMLElement,onRetry:()=>void):StreamView {
  const log=document.createElement('div');log.setAttribute('role','log');log.setAttribute('aria-live','polite');
  const error=document.createElement('p');error.setAttribute('role','alert');
  const retry=document.createElement('button');retry.type='button';retry.textContent='重试';retry.hidden=true;
  root.replaceChildren(log,error,retry);const nodes=new Map<string,HTMLElement>();let last=0,disposed=false;
  const click=()=>{if(!disposed)onRetry();};const key=(event:KeyboardEvent)=>{if(event.key==='Enter'){event.preventDefault();click();}};
  retry.addEventListener('click',click);retry.addEventListener('keydown',key);
  const mutate=(action:()=>void)=>{const before=root.scrollTop;const pinned=root.scrollHeight-root.clientHeight-before<=2;action();root.scrollTop=pinned?root.scrollHeight:before;};
  const check=(sequence:number)=>{if(!Number.isSafeInteger(sequence)||sequence<0)throw new RangeError('sequence');};
  return {
    snapshot(sequence,messages){if(disposed)return false;check(sequence);if(sequence<last)return false;if(new Set(messages.map(item=>item.id)).size!==messages.length)throw new RangeError('duplicate message');
      mutate(()=>{const retained=new Set<string>();for(const item of messages){let node:HTMLElement|undefined;if(!node){node=document.createElement('article');node.dataset['messageId']=item.id;nodes.set(item.id,node);}if(node.textContent!==item.text)node.textContent=item.text;log.append(node);retained.add(item.id);}for(const [id,node]of nodes)if(!retained.has(id)){node.remove();nodes.delete(id);}});last=sequence;return true;},
    append(sequence,id,chunk){if(disposed)return false;check(sequence);mutate(()=>{let node=nodes.get(id);if(!node){node=document.createElement('article');node.dataset['messageId']=id;nodes.set(id,node);log.append(node);}node.textContent=(node.textContent??'')+chunk;});last=sequence;return true;},
    fail(message){if(disposed)return;log.replaceChildren();error.textContent=message;retry.hidden=false;},
    dispose(){if(disposed)return;disposed=true;retry.removeEventListener('click',click);retry.removeEventListener('keydown',key);root.replaceChildren();nodes.clear();},
    lastSequence(){return last;}
  };
}
