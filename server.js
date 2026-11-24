import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createArena } from './arena.js';

mkdirSync('data', { recursive: true });
const arena = createArena('data/arena.sqlite');
const port = Number(process.env.PORT || 8765);
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
    if (req.method === 'GET' && url.pathname === '/api/state') return response(res, 200, arena.snapshot());
    if (req.method !== 'POST') return response(res, 404, { error: '接口不存在' });
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
    else if (url.pathname === '/api/quotes') result = arena.quote(input);
    else return response(res, 404, { error: '接口不存在' });
    return response(res, 200, { ok: true, result });
  } catch (error) { return response(res, 400, { error: error.message }); }
}).listen(port, '127.0.0.1', () => console.log(`沙盘已启动 http://127.0.0.1:${port}`));
