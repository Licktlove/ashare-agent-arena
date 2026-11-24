import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createArena } from './arena.js';
import { createHarness } from './harness.js';
import { fetchTencent } from './tencent-feed.js';

mkdirSync('data', { recursive: true });
const arena = createArena('data/arena.sqlite');
const harness = createHarness(arena);
const port = Number(process.env.PORT || 8765);
arena.db.exec('CREATE TABLE IF NOT EXISTS market_watchlist (symbol TEXT PRIMARY KEY)');
if (!arena.db.prepare('SELECT 1 FROM market_watchlist LIMIT 1').get()) {
  for (const symbol of ['SH600000', 'SZ000001', 'BJ430047']) arena.db.prepare('INSERT INTO market_watchlist(symbol) VALUES(?)').run(symbol);
}
const watchlist = () => arena.db.prepare('SELECT symbol FROM market_watchlist ORDER BY symbol').all().map(row => row.symbol);
let feedStatus = { status: 'connecting', provider: process.env.MARKET_FEED_URL ? 'custom' : 'tencent', lastSuccess: null, error: null, quotes: [] };
let feedBusy = false;
function continuousSession(isoTime) {
  const instant = Date.parse(isoTime);
  if (!Number.isFinite(instant)) return false;
  const china = new Date(instant + 8 * 3600000);
  const weekday = china.getUTCDay();
  const minute = china.getUTCHours() * 60 + china.getUTCMinutes();
  return weekday >= 1 && weekday <= 5 && ((minute >= 570 && minute < 690) || (minute >= 780 && minute < 897));
}
async function pollFeed() {
  if (feedBusy) return;
  feedBusy = true;
  try {
    let quotes;
    if (process.env.MARKET_FEED_URL) {
      const endpoint = new URL(process.env.MARKET_FEED_URL);
      if (endpoint.protocol !== 'https:' && endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') throw new Error('行情源必须使用 HTTPS');
      const result = await fetch(endpoint, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!result.ok) throw new Error('行情源 HTTP ' + result.status);
      quotes = await result.json();
    } else {
      quotes = await fetchTencent(watchlist());
    }
    if (!Array.isArray(quotes) || quotes.length > 10000) throw new Error('行情源应返回报价数组');
    if (!quotes.length) throw new Error('行情源未返回有效股票数据');
    let accepted = 0;
    for (const quote of quotes) {
      if (!continuousSession(quote.observedAt)) continue;
      try { arena.quote({ ...quote, source: 'external-feed' }); accepted++; } catch { /* Reject stale or invalid records individually. */ }
    }
    feedStatus = { status: accepted ? 'connected' : 'stale', provider: process.env.MARKET_FEED_URL ? 'custom' : 'tencent', lastSuccess: new Date().toISOString(), error: null, accepted, quotes: quotes.slice(0,200), watchlist: watchlist() };
  } catch (error) {
    feedStatus = { ...feedStatus, status: 'degraded', error: String(error.message).slice(0,200) };
  } finally { feedBusy = false; }
}
setInterval(pollFeed, 5000).unref();
pollFeed();
setInterval(() => {
  for (const config of harness.list().configs) {
    if (!config.enabled || (config.last_started && Date.now() - Date.parse(config.last_started) < config.interval_seconds * 1000)) continue;
    // A failed preflight is retried on the next interval without making an API request.
    harness.decide(config.agent_id).catch(() => {});
  }
}, 30000).unref();
const files = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']]
]);
const response = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && files.has(url.pathname)) {
      const [file, type] = files.get(url.pathname);
      res.writeHead(200, { 'content-type': type });
      return res.end(readFileSync(file));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return response(res, 200, { ...arena.snapshot(), harness: harness.list(), feed: { ...feedStatus, watchlist: watchlist() } });
    if (req.method !== 'POST') return response(res, 404, { error: '接口不存在' });
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}` && req.headers.origin !== `http://localhost:${port}`) return response(res, 403, { error: '来源不允许' });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 16384) throw new Error('请求过大');
    }
    const input = JSON.parse(raw || '{}');
    let result;
    if (url.pathname === '/api/agents') result = arena.createAgent(input);
    else if (url.pathname === '/api/orders') result = arena.submit(input);
    else if (url.pathname === '/api/cancel') result = arena.cancel(input.id);
    else if (url.pathname === '/api/settle') result = arena.settle(input.day);
    else if (url.pathname === '/api/quotes') result = arena.quote({ ...input, source: 'manual' });
    else if (url.pathname === '/api/watchlist') {
      if (!Array.isArray(input.symbols)) throw new Error('股票列表格式无效');
      const symbols = [...new Set(input.symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean))];
      if (!symbols.length || symbols.length > 200 || symbols.some(s => !/^(SH|SZ|BJ)\d{6}$/.test(s))) throw new Error('请输入 1 至 200 个股票代码，例如 SH600000');
      arena.db.exec('BEGIN IMMEDIATE');
      try {
        arena.db.exec('DELETE FROM market_watchlist');
        for (const symbol of symbols) arena.db.prepare('INSERT INTO market_watchlist(symbol) VALUES(?)').run(symbol);
        arena.db.exec('COMMIT');
      } catch (error) { arena.db.exec('ROLLBACK'); throw error; }
      result = symbols;
      pollFeed();
    }
    else if (url.pathname === '/api/harness/configure') result = harness.configure(input.agentId, input);
    else if (url.pathname === '/api/harness/decide') result = await harness.decide(input.agentId);
    else if (url.pathname === '/api/harness/reconcile') result = harness.reconcile(input.callId, input.actualCost);
    else return response(res, 404, { error: '接口不存在' });
    return response(res, 200, { ok: true, result });
  } catch (error) { return response(res, 400, { error: error.message }); }
}).listen(port, '127.0.0.1', () => console.log(`沙盘已启动 http://127.0.0.1:${port}`));
