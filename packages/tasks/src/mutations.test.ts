import { expect, it } from 'vitest';
import { classifyMutation } from './mutations.ts';

it('反例必须命中目标断言，缺测与进程崩溃不提升检出率，交叉不变量失败保留', () => {
  const good = [{ kind: 'public' as const, exitCode: 0, failed: [], missing: [], unexpected: [] },
    { kind: 'hidden' as const, exitCode: 1, failed: ['hidden/fencing'], missing: [], unexpected: [] }];
  expect(classifyMutation(good, ['hidden/fencing'])).toMatchObject({ valid: true, detected: true, matchesExpected: true });
  expect(classifyMutation([good[0]!, { ...good[1]!, exitCode: null }], ['hidden/fencing']).detected).toBe(false);
  expect(classifyMutation([good[0]!, { ...good[1]!, missing: ['hidden/recovery'] }], ['hidden/fencing']).detected).toBe(false);
  expect(classifyMutation([good[0]!, { ...good[1]!, unexpected: ['SyntaxError'] }], ['hidden/fencing']).detected).toBe(false);
  expect(classifyMutation([good[0]!, { ...good[1]!, failed: ['hidden/fencing', 'hidden/recovery'] }], ['hidden/fencing']))
    .toMatchObject({ matchesExpected: true, additionalFailures: ['hidden/recovery'] });
  expect(classifyMutation(good, ['hidden/recovery']).matchesExpected).toBe(false);
  expect(classifyMutation([good[0]!, { ...good[1]!, exitCode: 0, failed: [] }], ['hidden/fencing']).detected).toBe(false);
});
