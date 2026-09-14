import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/bounded.ts';
const limits={maxBytes:1000000,maxDepth:30000,maxNodes:100000};

test('public/depth-budget', async () => {
  assert.throws(()=>candidate.parseBounded('[[0]]',{...limits,maxDepth:1}), e=>e instanceof candidate.ParseLimitError && e.reason==='depth' && e.offset===1);
});

test('public/boundary-utf8-budget', async () => {
  assert.throws(()=>candidate.parseBounded('"😀"',{...limits,maxBytes:5}), e=>e instanceof candidate.ParseLimitError && e.reason==='bytes');
});

test('public/escaped-strings', async () => {
  const input=JSON.stringify({a:'["\\}]',b:[true,null,3]});
  assert.deepEqual(candidate.parseBounded(input,limits),JSON.parse(input));
});
