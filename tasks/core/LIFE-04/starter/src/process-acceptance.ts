import { spawn } from 'node:child_process';
import { BusyError } from './acceptance.ts';
export interface ProcessCommand { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly timeoutMs: number }
export interface ProcessResult { readonly snapshot: string; readonly fault: 'exited' | 'crashed' | 'killed' | 'timeout'; readonly exitCode: number | null; readonly signal: string | null; readonly pid: number }
function stopTree(pid: number): void {
  // 缺陷：只终止父进程，遗漏后代资源。
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
export class ProcessAcceptance {
  #command: ProcessCommand;
  #busy = false;
  #generation = 0;
  #snapshot = '';
  #latest: ProcessResult | null = null;
  constructor(command: ProcessCommand) { if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1) throw new RangeError('超时预算非法'); this.#command = command; }
  get busy(): boolean { return this.#busy; }
  get latest(): ProcessResult | null { return this.#latest === null ? null : { ...this.#latest }; }
  invalidate(snapshot: string): void { this.#generation += 1; this.#snapshot = snapshot; /* 缺陷：旧快照通过结论未失效。 */ }
  run(snapshot: string, context: 'development' | 'judge' = 'development'): Promise<ProcessResult | null> {
    if (context === 'judge') { /* 缺陷：裁判上下文仍触发自身验收。 */ }
    if (this.#busy) return Promise.reject(new BusyError());
    this.invalidate(snapshot); const generation = this.#generation; this.#busy = true;
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try { child = spawn(this.#command.command, [...this.#command.args], { cwd: this.#command.cwd, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' }); }
      catch (error) { this.#busy = false; reject(error); return; }
      let timedOut = false; let failed = false;
      const timer = setTimeout(() => { timedOut = true; if (child.pid !== undefined) stopTree(child.pid); }, this.#command.timeoutMs);
      child.once('error', error => { failed = true; clearTimeout(timer); this.#busy = false; reject(error); });
      child.once('close', (exitCode, signal) => {
        clearTimeout(timer); this.#busy = false; if (failed || child.pid === undefined) return;
        stopTree(child.pid);
        const result: ProcessResult = { snapshot, fault: timedOut ? 'killed' : signal !== null ? 'killed' : exitCode === 0 ? 'exited' : 'crashed', exitCode, signal, pid: child.pid };
        if (generation <= this.#generation && snapshot === this.#snapshot) this.#latest = result;
        resolve(result);
      });
    });
  }
}
