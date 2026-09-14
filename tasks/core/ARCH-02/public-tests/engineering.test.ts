import test from 'node:test';
import assert from 'node:assert/strict';

import {ProviderRegistry} from '../starter/src/provider-registry.ts';

test('public/metadata-does-not-load-forbidden-runtime',async()=>{let loads=0;const registry=new ProviderRegistry([{id:'arbitrary',runtime:'browser',label:'web',async load(){loads++;throw new Error('DOM unavailable');}},{id:'browser-shared',runtime:'shared',label:'shared',async load(){loads++;return 1;}}]);assert.deepEqual(registry.list('node'),[{id:'browser-shared',runtime:'shared',label:'shared'}]);assert.equal(loads,0);await assert.rejects(registry.load('arbitrary','node'),RangeError);assert.equal(loads,0);});
