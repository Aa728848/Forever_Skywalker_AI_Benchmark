import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessAcceptance } from '../starter/src/process-acceptance.ts';
function temporary(work:(directory:string)=>Promise<void>) { const directory=mkdtempSync(join(tmpdir(),'fsa-process-life-'));return work(directory).finally(()=>rmSync(directory,{recursive:true,force:true})); }
const command=(directory:string,script:string,timeoutMs=5000)=>({command:process.execPath,args:['-e',script],cwd:directory,timeoutMs});
test('public/real-child-crash-is-classified',()=>temporary(async directory=>{const runner=new ProcessAcceptance(command(directory,'process.exit(7)'));const result=await runner.run('one');assert.equal(result?.fault,'crashed');assert.equal(result?.exitCode,7);assert.ok((result?.pid??0)>0);assert.equal(runner.busy,false);}));
test('public/judge-context-does-not-reenter-acceptance',()=>temporary(async directory=>{const marker=join(directory,'spawned');const runner=new ProcessAcceptance(command(directory,'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"spawned")'));assert.equal(await runner.run('snapshot','judge'),null);assert.equal(existsSync(marker),false);assert.equal(runner.latest,null);}));
test('public/new-snapshot-invalidates-old-passing-result',()=>temporary(async directory=>{const runner=new ProcessAcceptance(command(directory,'process.exit(0)'));await runner.run('old');assert.equal(runner.latest?.snapshot,'old');runner.invalidate('new');assert.equal(runner.latest,null);}));
