import test from 'node:test';
import assert from 'node:assert/strict';
import { createArena } from './arena.js';

test('partial fill, cash reservation, cancel and T+1 lock', async () => {
  const arena = createArena();
  const agentId = arena.createAgent({name:'松',cash:1000000,seed:1});
  const id = arena.submit({agentId,symbol:'SH600000',side:'buy',quantity:100,limitPrice:1000});
  assert.equal(arena.snapshot().agents[0].frozen_cash,100000);
  await new Promise(resolve => setTimeout(resolve, 10));
  arena.quote({symbol:'SH600000',bid:990,ask:995,bidQuantity:100,askQuantity:40,observedAt:new Date().toISOString()});
  let state = arena.snapshot();
  assert.equal(state.orders[0].remaining,60);
  assert.equal(state.agents[0].cash,960200);
  assert.equal(state.agents[0].frozen_cash,60000);
  assert.equal(state.positions[0].quantity,40);
  assert.throws(() => arena.submit({agentId,symbol:'SH600000',side:'sell',quantity:40,limitPrice:1000}), /可卖数量不足/);
  arena.cancel(id);
  state = arena.snapshot();
  assert.equal(state.agents[0].frozen_cash,0);
  assert.equal(state.orders[0].status,'cancelled');
});
test('rejects stale quotes and insufficient cash', () => {
  const arena = createArena();
  const agentId = arena.createAgent({name:'竹',cash:10000});
  assert.throws(() => arena.submit({agentId,symbol:'SH600000',side:'buy',quantity:100,limitPrice:1000}), /资金不足/);
  assert.throws(() => arena.quote({symbol:'SH600000',bid:990,ask:1000,bidQuantity:1,askQuantity:1,observedAt:'2000-01-01T00:00:00Z'}), /过期/);
  assert.equal(arena.snapshot().orders.length,0);
});

test('repeated identical depth cannot be consumed twice', async () => {
  const arena = createArena();
  const id = arena.createAgent({name:'松',cash:1000000});
  arena.submit({agentId:id,symbol:'SH600000',side:'buy',quantity:100,limitPrice:1000});
  await new Promise(resolve => setTimeout(resolve, 10));
  const quote = () => arena.quote({symbol:'SH600000',bid:990,ask:995,bidQuantity:100,askQuantity:40,observedAt:new Date().toISOString()});
  quote();
  await new Promise(resolve => setTimeout(resolve, 10));
  quote();
  assert.equal(arena.snapshot().orders[0].remaining,60);
});

test('settlement unlocks earlier lots once and leaves same-day purchases locked', () => {
  const arena = createArena();
  const id = arena.createAgent({name:'松',cash:1000000});
  arena.db.prepare('INSERT INTO positions(agent_id,symbol,quantity,sellable,frozen) VALUES(?,?,?,?,?)').run(id,'SH600000',200,0,0);
  arena.db.prepare('INSERT INTO buy_lots(agent_id,symbol,quantity,trade_day) VALUES(?,?,?,?)').run(id,'SH600000',100,'2020-01-02');
  arena.db.prepare('INSERT INTO buy_lots(agent_id,symbol,quantity,trade_day) VALUES(?,?,?,?)').run(id,'SH600000',100,'2020-01-03');
  assert.equal(arena.settle('2020-01-03'),1);
  assert.equal(arena.settle('2020-01-03'),0);
  assert.equal(arena.snapshot().positions[0].sellable,100);
  assert.throws(()=>arena.settle('2099-01-01'),/日期无效/);
});
