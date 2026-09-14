import test from 'node:test';
import assert from 'node:assert/strict';
import {RequestError,validateOrderRequest} from '../starter/src/request.ts';
test('hidden/plain-object-boundary',()=>{
 class Payload {orderId='a';quantity=1;}
 for(const input of [new Payload(),Object.assign(new Date(),{orderId:'a',quantity:1}),Object.create({orderId:'a',quantity:1})])assert.throws(()=>validateOrderRequest(input),e=>e instanceof RequestError&&e.status===400&&JSON.stringify(e.issues)===JSON.stringify([{field:'',code:'type'}]));
 const input=Object.assign(Object.create(null),{orderId:'null-prototype',quantity:17});assert.deepEqual(validateOrderRequest(input),{orderId:'null-prototype',quantity:17});
});
test('hidden/independent-combinations-and-stable-order',()=>{
 for(let seed=1;seed<=32;seed++){
  const quantity=[NaN,Infinity,-Infinity,0,1001,1.2,'3'][seed%7];
  const input={['z'+seed]:true,quantity,orderId:' ',['a'+seed]:null,note:' '.repeat(seed)};
  const expected=[{field:'a'+seed,code:'unknown-field'},{field:'z'+seed,code:'unknown-field'},{field:'orderId',code:'type'},{field:'quantity',code:quantity===0||quantity===1001?'range':'type'},{field:'note',code:'type'}];
  assert.throws(()=>validateOrderRequest(input),error=>{assert.ok(error instanceof RequestError);assert.deepEqual(error.issues,expected);return true;});
 }
});
