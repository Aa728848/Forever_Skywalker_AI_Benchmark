import { spawn, spawnSync } from 'node:child_process';
import { BusyError } from './acceptance.ts';
export interface ProcessCommand { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly timeoutMs: number }
export interface ProcessResult { readonly snapshot: string; readonly fault: 'exited' | 'crashed' | 'killed' | 'timeout'; readonly exitCode: number | null; readonly signal: string | null; readonly pid: number }
function stopTree(pid: number): void {
  if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); return; }
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
export class ProcessAcceptance {
  #command: ProcessCommand;
  #active: object | null = null;
  #generation = 0;
  #snapshot = '';
  #latest: ProcessResult | null = null;
  constructor(command: ProcessCommand) { if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1) throw new RangeError('超时预算非法'); this.#command = command; }
  get busy(): boolean { return this.#active !== null; }
  get latest(): ProcessResult | null { return this.#latest === null ? null : { ...this.#latest }; }
  invalidate(snapshot: string): void { this.#generation += 1; this.#snapshot = snapshot; this.#latest = null; }
  run(snapshot: string, context: 'development' | 'judge' = 'development'): Promise<ProcessResult | null> {
    if (context === 'judge') return Promise.resolve(null);
    if (this.#active !== null) return Promise.reject(new BusyError());
    this.invalidate(snapshot); const generation = this.#generation; this.#active = {};
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try { child = spawn(this.#command.command, [...this.#command.args], { cwd: this.#command.cwd, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' }); }
      catch (error) { this.#active = null; reject(error); return; }
      let timedOut = false; let failed = false;
      const timer = setTimeout(() => { timedOut = true; if (child.pid !== undefined) stopTree(child.pid); }, this.#command.timeoutMs);
      child.once('error', error => { failed = true; clearTimeout(timer); this.#active = null; reject(error); });
      child.once('close', (exitCode, signal) => {
        clearTimeout(timer); this.#active = null; if (failed || child.pid === undefined) return;
        stopTree(child.pid);
        const result: ProcessResult = { snapshot, fault: timedOut ? 'timeout' : signal !== null ? 'killed' : exitCode === 0 ? 'exited' : 'crashed', exitCode, signal, pid: child.pid };
        if (generation === this.#generation && snapshot === this.#snapshot) this.#latest = result;
        resolve(result);
      });
    });
  }
}
