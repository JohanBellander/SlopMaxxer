import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAccount, pickNext } from '../src/pace.mjs';
import { derive } from '../public/guidance.js';
import { toSlopAccount } from '../src/snapshot.mjs';
const now = Date.parse('2026-10-31T12:00:00Z');
const account = (id, used) => ({ id, provider:'claude', dir:'/demo', observedAt:now,
  windows:[{kind:'weekly', label:'Weekly', usedPercent:used, resetsAt:now+3600000, windowSeconds:604800}] });
test('raw CLI compatibility and browser use exactly the same decisions', () => {
  const raw=[account('available',30),account('blocked',100)];
  const vm=derive({now:new Date(now).toISOString(),accounts:raw.map(a=>toSlopAccount(a,now))});
  assert.equal(analyzeAccount(raw[0],now).verdict,vm.accounts[0].status);
  assert.equal(analyzeAccount(raw[1],now).headline,vm.accounts[1].reason);
  assert.equal(pickNext(raw,now).id,vm.next.id);
  assert.equal(pickNext([raw[1]],now),null);
});
