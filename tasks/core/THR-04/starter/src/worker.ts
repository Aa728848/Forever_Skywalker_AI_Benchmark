import {parentPort,workerData} from 'node:worker_threads';
const job=workerData as {id:string;value:number;gate?:SharedArrayBuffer;crash?:boolean};
if(job.gate){const gate=new Int32Array(job.gate);Atomics.wait(gate,0,0);}
if(job.crash)throw new Error('generation worker failed');
parentPort?.postMessage(job.value*2);
