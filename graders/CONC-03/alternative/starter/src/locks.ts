export type Release = () => void;
interface Request { keys: string[]; resolve(release: Release): void; reject(error: unknown): void; signal?: AbortSignal; cancel?: () => void }
export class LockManager {
  private owners = new Map<string, object>();
  private waiting = new Map<object, Request>();
  get queueLength(): number { return this.waiting.size; }
  acquire(resource: string): Promise<Release> { return this.acquireMany([resource]); }
  acquireMany(resources: readonly string[], signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const key = {}, request: Request = { keys: [...new Set(resources)], resolve, reject, signal };
      request.cancel = () => { if (!this.waiting.delete(key)) return; signal?.removeEventListener('abort', request.cancel!); reject(signal?.reason); this.drain(); };
      this.waiting.set(key, request); signal?.addEventListener('abort', request.cancel, { once: true }); this.drain();
    });
  }
  private drain(): void {
    const earlier: Request[] = [];
    for (const [ticket, request] of this.waiting) {
      if (request.keys.some(key => this.owners.has(key)) || earlier.some(prior => prior.keys.some(key => request.keys.includes(key)))) { earlier.push(request); continue; }
      this.waiting.delete(ticket); request.signal?.removeEventListener('abort', request.cancel!);
      request.keys.forEach(key => this.owners.set(key, ticket)); let released = false;
      request.resolve(() => { if (released) return; released = true; request.keys.forEach(key => this.owners.delete(key)); this.drain(); });
    }
  }
}
