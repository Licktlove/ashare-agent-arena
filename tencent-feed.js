const SYMBOL = /^(SH|SZ|BJ)\d{6}$/;

function cents(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function quantity(value) {
  if (!/^\d+$/.test(value)) return null;
  const shares = Number(value) * 100;
  return Number.isSafeInteger(shares) ? shares : null;
}

function quoteTime(value) {
  if (!/^\d{14}$/.test(value)) return null;
  const time = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(8,10)}:${value.slice(10,12)}:${value.slice(12,14)}+08:00`;
  const stamp = Date.parse(time);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

export function parseTencent(text) {
  const results = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^v_((?:sh|sz|bj)\d{6})="([^"]*)";?$/.exec(line.trim());
    if (!match || !match[2]) continue;
    const fields = match[2].split('~');
    const symbol = match[1].toUpperCase();
    if (fields[2] !== symbol.slice(2)) continue;
    const bid = cents(fields[9]);
    const ask = cents(fields[19]);
    const bidQuantity = quantity(fields[10]);
    const askQuantity = quantity(fields[20]);
    const observedAt = quoteTime(fields[30] || '');
    results.push({symbol, name: fields[1] || '', last: cents(fields[3]), bid, ask,
      bidQuantity, askQuantity, observedAt});
  }
  return results;
}

export async function fetchTencent(symbols, fetcher = fetch) {
  const unique = [...new Set(symbols.map(s => String(s).trim().toUpperCase()))];
  if (!unique.length || unique.length > 200 || unique.some(s => !SYMBOL.test(s))) {
    throw new Error('请配置 1 至 200 个股票代码，例如 SH600000');
  }
  const result = await fetcher('https://qt.gtimg.cn/q=' + unique.map(s => s.toLowerCase()).join(','), {
    signal: AbortSignal.timeout(8000), redirect: 'error'
  });
  if (!result.ok) throw new Error('腾讯行情接口 HTTP ' + result.status);
  const body = await result.arrayBuffer();
  if (body.byteLength > 1024 * 1024) throw new Error('行情响应过大');
  return parseTencent(new TextDecoder('gb18030').decode(body));
}
