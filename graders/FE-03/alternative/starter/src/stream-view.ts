export interface Message { readonly id:string; readonly text:string }
export interface StreamView { snapshot(sequence:number,messages:readonly Message[]):boolean; append(sequence:number,id:string,chunk:string):boolean; fail(message:string):void; dispose():void; lastSequence():number }

export function mount(root:HTMLElement,onRetry:()=>void):StreamView {
  const log=document.createElement('div'),alert=document.createElement('p'),button=document.createElement('button');log.setAttribute('role','log');log.setAttribute('aria-live','polite');alert.setAttribute('role','alert');button.type='button';button.textContent='重试';button.hidden=true;root.replaceChildren(log,alert,button);
  let last=0,stopped=false;const retry=()=>{if(!stopped)onRetry();};const key=(event:KeyboardEvent)=>{if(event.key==='Enter'){event.preventDefault();retry();}};button.addEventListener('click',retry);button.addEventListener('keydown',key);
  const update=(work:()=>void)=>{const top=root.scrollTop;const bottom=root.scrollHeight-root.clientHeight-top<=2;work();root.scrollTop=bottom?root.scrollHeight:top;};
  const valid=(sequence:number)=>{if(sequence<0||!Number.isSafeInteger(sequence))throw new RangeError('sequence');};
  const find=(id:string)=>Array.from(log.children).find(node=>(node as HTMLElement).dataset['messageId']===id) as HTMLElement|undefined;
  const element=(id:string)=>{const node=find(id)??document.createElement('article');node.dataset['messageId']=id;return node;};
  return {
    snapshot(sequence,messages){if(stopped)return false;valid(sequence);if(sequence<last)return false;const ids=new Set(messages.map(m=>m.id));if(ids.size!==messages.length)throw new RangeError('duplicate message');update(()=>{const ordered=messages.map(message=>{const node=element(message.id);node.textContent=message.text;return node;});log.replaceChildren(...ordered);});last=sequence;return true;},
    append(sequence,id,chunk){if(stopped)return false;valid(sequence);if(sequence<=last)return false;if(sequence!==last+1)throw new Error('sequence gap');update(()=>{const node=element(id);node.append(document.createTextNode(chunk));if(!node.parentElement)log.append(node);});last=sequence;return true;},
    fail(message){if(!stopped){alert.textContent=message;button.hidden=false;}},
    dispose(){if(stopped)return;stopped=true;button.removeEventListener('click',retry);button.removeEventListener('keydown',key);root.replaceChildren();},
    lastSequence(){return last;}
  };
}
