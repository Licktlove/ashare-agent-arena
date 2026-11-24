import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTencent, fetchTencent } from './tencent-feed.js';

const record = 'v_sh600000="1~浦发银行~600000~10.69~10.75~10.62~724504~357854~366650~10.69~7~10.68~1197~10.67~8692~10.66~10430~10.65~5953~10.70~242~10.71~1553~10.72~1223~10.73~1134~10.74~1886~~20261124101500";';
test('Tencent parser preserves exchange time and converts lots to shares', () => {
  assert.deepEqual(parseTencent(record)[0], {
    symbol:'SH600000', name:'浦发银行', last:1069, bid:1069, ask:1070,
    bidQuantity:700, askQuantity:24200, observedAt:'2026-11-24T02:15:00.000Z'
  });
});
test('rejects malformed records and symbol lists', async () => {
  assert.deepEqual(parseTencent('v_sh600000="";'), []);
  await assert.rejects(fetchTencent(['https://bad']), /股票代码/);
});
test('handles no bid or ask without inventing a price', () => {
  const item = parseTencent(record.replace('~10.69~7~', '~0.00~0~'))[0];
  assert.equal(item.bid, null);
  assert.equal(item.bidQuantity, 0);
});
