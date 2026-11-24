import test from 'node:test';
import assert from 'node:assert/strict';
import { createArena } from './arena.js';
import { createHarness } from './harness.js';

test('model request settles usage and preserves model identity', async () => {
  const arena = createArena();
  const id = arena.createAgent({name:'松',cash:1000000,seed:1});
  process.env.TEST_ARENA_MODEL_KEY='test-key';
  process.env.GLOBAL_MODEL_BUDGET_MICRO='100000000';
  let request;
  const harness = createHarness(arena,{fetch:async (url,init) => {
    request={url,init};
    return {ok:true,json:async()=>({id:'request-1',usage:{prompt_tokens:100,completion_tokens:20},choices:[{message:{content:'{"action":"hold","reason":"等待"}'}}]})};
  }});
  harness.configure(id,{endpoint:'https://example.test',model:'local-test',keyEnv:'TEST_ARENA_MODEL_KEY',inputRate:1000000,outputRate:2000000,outputLimit:100,budget:5000000,enabled:true,intervalSeconds:300});
  arena.quote({symbol:'SH600000',bid:990,ask:1000,bidQuantity:100,askQuantity:100,observedAt:new Date().toISOString(),source:'external-feed'});
  const result = await harness.decide(id);
  assert.equal(result.action,'hold');
  const state = harness.list();
  assert.equal(state.calls[0].actual_cost,140);
  assert.equal(state.calls[0].model,'local-test');
  assert.equal(state.configs[0].reserved,0);
  assert.equal(state.configs[0].spent,140);
  assert.equal(request.url,'https://example.test/chat/completions');
  assert.ok(!JSON.stringify(arena.snapshot()).includes('test-key'));
  delete process.env.TEST_ARENA_MODEL_KEY;
  delete process.env.GLOBAL_MODEL_BUDGET_MICRO;
});
test('unknown usage keeps reservation until one reconciliation', async () => {
  const arena = createArena();
  const id = arena.createAgent({name:'竹',cash:1000000});
  process.env.TEST_ARENA_MODEL_KEY='test-key';
  process.env.GLOBAL_MODEL_BUDGET_MICRO='100000000';
  const harness = createHarness(arena,{fetch:async()=>{throw new Error('timeout')}});
  harness.configure(id,{endpoint:'https://example.test',model:'test',keyEnv:'TEST_ARENA_MODEL_KEY',inputRate:1000000,outputRate:1000000,outputLimit:100,budget:5000000,enabled:true,intervalSeconds:300});
  arena.quote({symbol:'SH600000',bid:990,ask:1000,bidQuantity:100,askQuantity:100,observedAt:new Date().toISOString(),source:'external-feed'});
  await assert.rejects(harness.decide(id), /待对账/);
  const before = harness.list();
  assert.equal(before.calls[0].status,'unknown');
  assert.ok(before.configs[0].reserved>0);
  harness.reconcile(before.calls[0].id,300);
  assert.equal(harness.list().configs[0].reserved,0);
  assert.equal(harness.list().configs[0].spent,300);
  assert.throws(()=>harness.reconcile(before.calls[0].id,300), /不存在/);
  delete process.env.TEST_ARENA_MODEL_KEY;
  delete process.env.GLOBAL_MODEL_BUDGET_MICRO;
});
test('manual quote is excluded from agent observations', async () => {
  const arena = createArena();
  const id = arena.createAgent({name:'梅',cash:1000000});
  process.env.TEST_ARENA_MODEL_KEY='test-key';
  const harness = createHarness(arena);
  harness.configure(id,{endpoint:'https://example.test',model:'test',keyEnv:'TEST_ARENA_MODEL_KEY',inputRate:1000000,outputRate:1000000,outputLimit:100,budget:5000000,enabled:true,intervalSeconds:300});
  arena.quote({symbol:'SH600000',bid:990,ask:1000,bidQuantity:100,askQuantity:100,observedAt:new Date().toISOString(),source:'manual'});
  await assert.rejects(harness.decide(id), /没有可信的新鲜行情/);
  delete process.env.TEST_ARENA_MODEL_KEY;
});

test('agent submits a simulated order using a fresh observed quote', async () => {
  const arena = createArena();
  const id = arena.createAgent({name:'兰',cash:1000000});
  process.env.TEST_ARENA_MODEL_KEY='test-key';
  process.env.GLOBAL_MODEL_BUDGET_MICRO='100000000';
  const harness = createHarness(arena,{fetch:async()=>({ok:true,json:async()=>({
    id:'request-order',usage:{prompt_tokens:100,completion_tokens:30},
    choices:[{message:{content:'{"action":"buy","symbol":"SH600000","quantity":100,"limitPrice":1000,"reason":"测试"}'}}]
  })})});
  harness.configure(id,{endpoint:'https://example.test',model:'test',keyEnv:'TEST_ARENA_MODEL_KEY',inputRate:1000000,outputRate:1000000,outputLimit:100,budget:5000000,enabled:true,intervalSeconds:300});
  arena.quote({symbol:'SH600000',bid:990,ask:1000,bidQuantity:100,askQuantity:100,observedAt:new Date().toISOString(),source:'external-feed'});
  await harness.decide(id);
  assert.equal(arena.snapshot().orders.length,1);
  assert.equal(arena.snapshot().orders[0].status,'open');
  assert.ok(arena.snapshot().events.some(event => event.type === 'decision.order_submitted'));
  delete process.env.TEST_ARENA_MODEL_KEY;
  delete process.env.GLOBAL_MODEL_BUDGET_MICRO;
});
