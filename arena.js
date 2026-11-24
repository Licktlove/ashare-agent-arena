import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export function createArena(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, initial_cash INTEGER NOT NULL,
      cash INTEGER NOT NULL, frozen_cash INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL, endpoint TEXT NOT NULL, seed INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS positions (
      agent_id TEXT NOT NULL REFERENCES agents(id), symbol TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0, sellable INTEGER NOT NULL DEFAULT 0,
      frozen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
      symbol TEXT NOT NULL, side TEXT NOT NULL, quantity INTEGER NOT NULL,
      remaining INTEGER NOT NULL, limit_price INTEGER NOT NULL,
      reserved INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT REFERENCES agents(id),
      type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, bid INTEGER NOT NULL,
      ask INTEGER NOT NULL, bid_quantity INTEGER NOT NULL, ask_quantity INTEGER NOT NULL,
      source TEXT NOT NULL, observed_at TEXT NOT NULL, received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS depth_usage (
      agent_id TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
      price INTEGER NOT NULL, visible INTEGER NOT NULL, available INTEGER NOT NULL,
      PRIMARY KEY(agent_id, symbol, side)
    );
    CREATE TABLE IF NOT EXISTS buy_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agents(id),
      symbol TEXT NOT NULL, quantity INTEGER NOT NULL, trade_day TEXT NOT NULL,
      settled INTEGER NOT NULL DEFAULT 0
    );
  `);
  const now = () => new Date().toISOString();
  const event = (agent, type, payload) => db.prepare(
    'INSERT INTO events(agent_id,type,payload,created_at) VALUES(?,?,?,?)'
  ).run(agent, type, JSON.stringify(payload), now());
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const integer = (value, name, min = 0) => {
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} 必须是大于等于 ${min} 的整数`);
    return value;
  };
  const symbolOk = symbol => typeof symbol === 'string' && /^(SH|SZ|BJ)\d{6}$/.test(symbol);
  const chinaDay = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
  function createAgent(input) {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('请输入名称');
    const cash = integer(input.cash, '初始资金', 1);
    const id = randomUUID();
    db.prepare('INSERT INTO agents(id,name,initial_cash,cash,model,endpoint,seed,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, input.name.trim().slice(0, 40), cash, cash, String(input.model || ''), String(input.endpoint || ''), integer(input.seed ?? 1, '种子'), now());
    event(id, 'agent.created', { cash });
    return id;
  }
  function submit(input) {
    return transaction(() => {
      const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(input.agentId);
      if (!agent) throw new Error('账户不存在');
      if (!symbolOk(input.symbol)) throw new Error('股票代码格式应为 SH600000、SZ000001 或 BJ430047');
      if (!['buy', 'sell'].includes(input.side)) throw new Error('无效方向');
      const quantity = integer(input.quantity, '数量', 1);
      const price = integer(input.limitPrice, '限价', 1);
      if (!Number.isSafeInteger(quantity * price)) throw new Error('金额超出范围');
      const position = db.prepare('SELECT * FROM positions WHERE agent_id=? AND symbol=?').get(agent.id, input.symbol);
      let reserved = 0;
      if (input.side === 'buy') {
        reserved = quantity * price;
        if (agent.cash - agent.frozen_cash < reserved) throw new Error('可用资金不足');
        db.prepare('UPDATE agents SET frozen_cash=frozen_cash+? WHERE id=?').run(reserved, agent.id);
      } else {
        if (!position || position.sellable - position.frozen < quantity) throw new Error('可卖数量不足');
        db.prepare('UPDATE positions SET frozen=frozen+? WHERE agent_id=? AND symbol=?').run(quantity, agent.id, input.symbol);
      }
      const id = randomUUID();
      db.prepare('INSERT INTO orders(id,agent_id,symbol,side,quantity,remaining,limit_price,reserved,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, agent.id, input.symbol, input.side, quantity, quantity, price, reserved, 'open', now());
      event(agent.id, 'order.accepted', { id, symbol: input.symbol, side: input.side, quantity, price });
      return id;
    });
  }
  function cancel(id) {
    return transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      if (!order || order.status !== 'open') throw new Error('订单不可撤销');
      if (order.side === 'buy') db.prepare('UPDATE agents SET frozen_cash=frozen_cash-? WHERE id=?').run(order.reserved, order.agent_id);
      else db.prepare('UPDATE positions SET frozen=frozen-? WHERE agent_id=? AND symbol=?').run(order.remaining, order.agent_id, order.symbol);
      db.prepare("UPDATE orders SET status='cancelled',reserved=0 WHERE id=?").run(id);
      event(order.agent_id, 'order.cancelled', { id });
    });
  }
  function quote(input) {
    if (!symbolOk(input.symbol)) throw new Error('股票代码格式无效');
    const bid = integer(input.bid, '买价', 1), ask = integer(input.ask, '卖价', 1);
    if (bid > ask) throw new Error('买价不能高于卖价');
    const bidQuantity = integer(input.bidQuantity, '买量'), askQuantity = integer(input.askQuantity, '卖量');
    if (!input.observedAt || Number.isNaN(Date.parse(input.observedAt))) throw new Error('必须提供行情时间');
    const observed = Date.parse(input.observedAt);
    const received = Date.now();
    if (observed > received || received - observed > 10000) throw new Error('行情过期或时间无效');
    return transaction(() => {
      db.prepare('INSERT INTO quotes(symbol,bid,ask,bid_quantity,ask_quantity,source,observed_at,received_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(input.symbol,bid,ask,bidQuantity,askQuantity,String(input.source || 'manual'),new Date(observed).toISOString(),new Date(received).toISOString());
      const orders = db.prepare("SELECT * FROM orders WHERE symbol=? AND status='open' ORDER BY CASE side WHEN 'buy' THEN -limit_price ELSE limit_price END, created_at,id").all(input.symbol);
      const available = new Map();
      for (const order of orders) {
        if (observed <= Date.parse(order.created_at)) continue;
        const price = order.side === 'buy' ? ask : bid;
        if (order.side === 'buy' ? price > order.limit_price : price < order.limit_price) continue;
        const key = order.agent_id + ':' + order.side;
        const visible = order.side === 'buy' ? askQuantity : bidQuantity;
        const previous = db.prepare('SELECT * FROM depth_usage WHERE agent_id=? AND symbol=? AND side=?').get(order.agent_id, order.symbol, order.side);
        const depth = available.has(key) ? available.get(key) : previous && previous.price === price
          ? Math.min(visible, previous.available + Math.max(0, visible - previous.visible)) : visible;
        const filled = Math.min(order.remaining, depth);
        available.set(key, depth - filled);
        db.prepare(`INSERT INTO depth_usage(agent_id,symbol,side,price,visible,available) VALUES(?,?,?,?,?,?)
          ON CONFLICT(agent_id,symbol,side) DO UPDATE SET price=excluded.price,visible=excluded.visible,available=excluded.available`)
          .run(order.agent_id,order.symbol,order.side,price,visible,depth-filled);
        if (!filled) continue;
        const remaining = order.remaining - filled;
        let reserved = order.reserved;
        if (order.side === 'buy') {
          const release = filled * order.limit_price;
          reserved -= release;
          db.prepare('UPDATE agents SET cash=cash-?,frozen_cash=frozen_cash-? WHERE id=?').run(filled * price, release, order.agent_id);
          db.prepare(`INSERT INTO positions(agent_id,symbol,quantity,sellable,frozen) VALUES(?,?,?,0,0)
            ON CONFLICT(agent_id,symbol) DO UPDATE SET quantity=quantity+excluded.quantity`).run(order.agent_id, order.symbol, filled);
          db.prepare('INSERT INTO buy_lots(agent_id,symbol,quantity,trade_day) VALUES(?,?,?,?)')
            .run(order.agent_id, order.symbol, filled, chinaDay(observed));
        } else {
          db.prepare('UPDATE positions SET quantity=quantity-?,sellable=sellable-?,frozen=frozen-? WHERE agent_id=? AND symbol=?').run(filled, filled, filled, order.agent_id, order.symbol);
          db.prepare('UPDATE agents SET cash=cash+? WHERE id=?').run(filled * price, order.agent_id);
        }
        db.prepare('UPDATE orders SET remaining=?,reserved=?,status=? WHERE id=?').run(remaining,reserved,remaining ? 'open' : 'filled',order.id);
        event(order.agent_id, 'order.filled', { id: order.id, quantity: filled, price, remaining, observedAt: input.observedAt, source: input.source || 'manual' });
      }
    });
  }
  function settle(day) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day+'T00:00:00Z')) || new Date(day+'T00:00:00Z').toISOString().slice(0,10) !== day || day > chinaDay(Date.now())) throw new Error('结算日期无效');
    return transaction(() => {
      const lots = db.prepare('SELECT * FROM buy_lots WHERE settled=0 AND trade_day<? ORDER BY id').all(day);
      for (const lot of lots) {
        db.prepare('UPDATE positions SET sellable=sellable+? WHERE agent_id=? AND symbol=?').run(lot.quantity,lot.agent_id,lot.symbol);
        db.prepare('UPDATE buy_lots SET settled=1 WHERE id=?').run(lot.id);
        event(lot.agent_id, 'position.settled', {symbol:lot.symbol, quantity:lot.quantity, tradeDay:lot.trade_day, settlementDay:day});
      }
      return lots.length;
    });
  }
  function snapshot() {
    return {
      agents: db.prepare('SELECT * FROM agents ORDER BY created_at').all(),
      positions: db.prepare('SELECT * FROM positions ORDER BY symbol').all(),
      orders: db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all(),
      events: db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT 200').all().map(row => ({ ...row, payload: JSON.parse(row.payload) })),
      quotes: db.prepare('SELECT * FROM quotes ORDER BY id DESC LIMIT 100').all()
    };
  }
  return { db, createAgent, submit, cancel, quote, settle, snapshot };
}
