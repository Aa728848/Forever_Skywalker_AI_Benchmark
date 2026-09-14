import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessAcceptance } from '../starter/src/process-acceptance.ts';
function temporary(work:(directory:string)=>Promise<void>) { const directory=mkdtempSync(join(tmpdir(),'fsa-process-life-'));return work(directory).finally(()=>rmSync(directory,{recursive:true,force:true})); }
const command=(directory:string,script:string,timeoutMs=5000)=>({command:process.execPath,args:['-e',script],cwd:directory,timeoutMs});
import { spawnSync } from 'node:child_process';
import { BusyError } from '../starter/src/acceptance.ts';
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
const stop=(pid:number)=>{if(process.platform==='win32')spawnSync('taskkill',['/pid',String(pid),'/t','/f'],{stdio:'ignore',windowsHide:true});else{try{process.kill(pid,'SIGKILL')}catch{}}};
test('hidden/late-completion-cannot-publish-old-snapshot',()=>temporary(async directory=>{const runner=new ProcessAcceptance(command(directory,'setTimeout(()=>process.exit(0),100)'));const first=runner.run('snapshot');runner.invalidate('snapshot');await assert.rejects(runner.run('snapshot'),BusyError);await first;assert.equal(runner.latest,null);await runner.run('snapshot');assert.equal(runner.latest?.snapshot,'snapshot');}));
test('hidden/timeout-reaps-real-descendant',()=>temporary(async directory=>{const marker=join(directory,'descendant.json');const script='const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync('+JSON.stringify(marker)+',String(child.pid));setInterval(()=>{},1000);';const runner=new ProcessAcceptance(command(directory,script,1000));let descendant:number|null=null;try{const result=await runner.run('tree');assert.equal(result?.fault,'timeout');assert.ok(existsSync(marker));descendant=Number(readFileSync(marker,'utf8'));for(let attempt=0;attempt<10&&alive(descendant);attempt++)await new Promise(resolve=>setTimeout(resolve,25));assert.equal(alive(descendant),false);assert.equal(runner.busy,false);}finally{if(descendant===null&&existsSync(marker))descendant=Number(readFileSync(marker,'utf8'));if(descendant!==null&&alive(descendant))stop(descendant);}}));

test('hidden/spawn-errors-release-busy',()=>temporary(async directory=>{for(const executable of ['', 'fsa-missing-child-command']){const runner=new ProcessAcceptance({...command(directory,''),command:executable});await assert.rejects(runner.run('error'));assert.equal(runner.busy,false);await assert.rejects(runner.run('again'),error=>!(error instanceof BusyError));assert.equal(runner.latest,null);}}));
