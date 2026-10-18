import test from 'node:test';
import assert from 'node:assert/strict';
import {DependencyWorkspace} from '../starter/src/workspace.ts';
const doc=(id,deps,value=id)=>({id,deps,value});
const evaluate=(document)=>document.value;

test('hidden/subscribers-see-only-published-snapshots',async()=>{
  const workspace=new DependencyWorkspace([doc('a',[]),doc('b',['a'])]);
  const seen=[];
  const off=workspace.subscribe(snapshot=>seen.push(snapshot.generation));
  const first=await workspace.prepare(evaluate);
  // 只是准备、尚未发布：订阅者不应收到任何通知。
  assert.deepEqual(seen,[],'prepare 不是发布，不得通知');
  assert.equal(workspace.commit(first),true);
  assert.deepEqual(seen,[first.generation],'成功提交必须恰好通知一次');
  // 被拒的提交不得通知。
  assert.equal(workspace.commit(first),false);
  assert.deepEqual(seen,[first.generation],'被拒提交不得通知');
  off();
  workspace.apply([{kind:'put',document:doc('c',[])}]);
  const second=await workspace.prepare(evaluate);
  assert.equal(workspace.commit(second),true);
  assert.deepEqual(seen,[first.generation],'退订后不得再通知');
});

test('hidden/subscriber-reads-the-just-published-state',async()=>{
  const workspace=new DependencyWorkspace([doc('a',[])]);
  const first=await workspace.prepare(evaluate);
  workspace.commit(first);
  // 第二个订阅在已有快照之后注册，避免用首次发布掩盖顺序问题。
  let observed=null;
  workspace.subscribe(()=>{observed=workspace.snapshot();});
  workspace.apply([{kind:'put',document:doc('b',[])}]);
  const ticket=await workspace.prepare(evaluate);
  assert.equal(workspace.commit(ticket),true);
  assert.notEqual(observed,null,'订阅者必须在提交后被通知');
  // 关键：监听器里通过 snapshot() 读到的必须是**本次已发布**的新代际。
  // 先通知再落发布状态的实现会在这里读到上一代。
  assert.equal(observed.generation,ticket.generation,'通知时发布状态必须已生效');
  assert.deepEqual(observed.documents.map(document=>document.id),['a','b']);
});

test('hidden/listener-failure-cannot-roll-back-publication',async()=>{
  const workspace=new DependencyWorkspace([doc('a',[])]);
  let second=0;
  workspace.subscribe(()=>{throw new Error('listener exploded');});
  workspace.subscribe(()=>{second+=1;});
  const ticket=await workspace.prepare(evaluate);
  // 监听器抛错不得让 commit 失败，也不得回滚已发布的快照。
  assert.equal(workspace.commit(ticket),true);
  assert.equal(workspace.snapshot()!.generation,ticket.generation);
  assert.equal(second,1,'其它监听器仍须收到通知');
});
