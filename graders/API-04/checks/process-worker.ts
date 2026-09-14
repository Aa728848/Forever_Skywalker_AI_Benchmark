import { readSync, writeSync } from 'node:fs';
import { DurableQueue, type Lease } from '../starter/src/queue.ts';
import type { Checkpoint } from '../starter/src/model.ts';

const config = JSON.parse(process.argv[2]!) as {
  path: string; operation: 'submit' | 'claim' | 'complete';
  crash?: Checkpoint; hold?: Checkpoint; lease?: Lease;
};
const queue = new DurableQueue(config.path, {
  onCheckpoint(phase) {
    if (config.crash === phase) process.exit(86);
    if (config.hold === phase) {
      writeSync(1, JSON.stringify({ checkpoint: phase }) + '\n');
      readSync(0, Buffer.alloc(1), 0, 1, null);
    }
  },
});
const value = config.operation === 'submit' ? queue.submit('child-request', 'child-payload')
  : config.operation === 'claim' ? queue.claim('child-worker', 0, 100)
    : queue.complete(config.lease!, 'child-result', 1);
queue.close();
writeSync(1, JSON.stringify({ value }) + '\n');
