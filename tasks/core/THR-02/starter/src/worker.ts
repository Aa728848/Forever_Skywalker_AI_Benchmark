import {parentPort,workerData} from 'node:worker_threads';
const job=workerData as {value:number;crash?:boolean;gate?:SharedArrayBuffer};
if(job.gate){const gate=new Int32Array(job.gate);Atomics.wait(gate,0,0);}
if(job.crash)throw new Error('job crashed');
parentPort?.postMessage(job.value*2);
