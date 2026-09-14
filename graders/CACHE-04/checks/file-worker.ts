import {AtomicFileStorage} from '../starter/src/file-storage.ts';
const [path,point]=process.argv.slice(2);const store=new AtomicFileStorage(path!,current=>{if(current===point)process.exit(23);});await store.writeAtomic('new');process.exit(23);
