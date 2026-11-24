import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createArena } from './arena.js';
import { createHarness } from './harness.js';

mkdirSync('data', { recursive: true });
const arena = createArena('data/arena.sqlite');
const harness = createHarness(arena);
const port = Number(process.env.PORT || 8765);
let feedStatus = { status: 'unconfigured', lastSuccess: null, error: null };
let feedBusy = false;
async function pollFeed() {
  if (!process.env.MARKET_FEED_URL || feedBusy) return;
  feedBusy = true;
  try {
    const endpoint = new URL(process.env.MARKET_FEED_URL);
    if (endpoint.protocol !== 'https:' && endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') throw new Error('行情源必须使用 HTTPS');
    const result = await fetch(endpoint, { signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!result.ok) throw new Error('行情源 HTTP ' + result.status);
    const quotes = await result.json();
    if (!Array.isArray(quotes) || quotes.length > 10000) throw new Error('行情源应返回报价数组');
    let accepted = 0;
    for (const quote of quotes) {
      try { arena.quote({ ...quote, source: 'external-feed' }); accepted++; } catch { /* Reject stale or invalid records individually. */ }
    }
    if (!accepted) throw new Error('行情源没有新鲜有效的报价');
    feedStatus = { status: 'connected', lastSuccess: new Date().toISOString(), error: null, accepted };
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
    if (req.method === 'GET' && url.pathname === '/api/state') return response(res, 200, { ...arena.snapshot(), harness: harness.list(), feed: feedStatus });
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
    else if (url.pathname === '/api/quotes') result = arena.quote({ ...input, source: 'manual' });
    else if (url.pathname === '/api/harness/configure') result = harness.configure(input.agentId, input);
    else if (url.pathname === '/api/harness/decide') result = await harness.decide(input.agentId);
    else if (url.pathname === '/api/harness/reconcile') result = harness.reconcile(input.callId, input.actualCost);
    else return response(res, 404, { error: '接口不存在' });
    return response(res, 200, { ok: true, result });
  } catch (error) { return response(res, 400, { error: error.message }); }
}).listen(port, '127.0.0.1', () => console.log(`沙盘已启动 http://127.0.0.1:${port}`));
