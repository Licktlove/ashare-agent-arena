import { randomUUID } from 'node:crypto';

// All amounts in this module are integer millionths of CNY.
export function createHarness(arena, options = {}) {
  const db = arena.db;
  const call = options.fetch ?? fetch;
  const now = () => new Date().toISOString();
  db.exec(`
    CREATE TABLE IF NOT EXISTS harness_config (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      key_env TEXT NOT NULL, input_rate INTEGER NOT NULL, output_rate INTEGER NOT NULL,
      output_limit INTEGER NOT NULL, budget INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0,
      reserved INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0,
      interval_seconds INTEGER NOT NULL DEFAULT 300, last_started TEXT
    );
    CREATE TABLE IF NOT EXISTS model_calls (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL,
      status TEXT NOT NULL, reservation INTEGER NOT NULL, actual_cost INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, request_id TEXT,
      created_at TEXT NOT NULL, completed_at TEXT, error TEXT
    );
  `);
  const columns = db.prepare('PRAGMA table_info(model_calls)').all().map(column => column.name);
  if (!columns.includes('input_rate')) db.exec('ALTER TABLE model_calls ADD COLUMN input_rate INTEGER');
  if (!columns.includes('output_rate')) db.exec('ALTER TABLE model_calls ADD COLUMN output_rate INTEGER');
  db.prepare("UPDATE model_calls SET status='unknown', error='服务重启，等待对账' WHERE status='pending'").run();
  const record = (id, type, payload) => db.prepare(
    'INSERT INTO events(agent_id,type,payload,created_at) VALUES(?,?,?,?)'
  ).run(id, type, JSON.stringify(payload), now());
  const safeInteger = (x, name, min = 0) => {
    if (!Number.isSafeInteger(x) || x < min) throw new Error(`${name}必须是大于等于 ${min} 的整数`);
    return x;
  };
  const atomic = (operation) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  function configure(id, input) {
    const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(id);
    if (!agent) throw new Error('账户不存在');
    if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(input.keyEnv)) throw new Error('密钥环境变量名称无效');
    const endpoint = new URL(input.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) throw new Error('模型地址需要 HTTPS 且不能包含凭据或查询参数');
    if (!input.model || typeof input.model !== 'string') throw new Error('模型名称不能为空');
    const inputRate = safeInteger(input.inputRate, '输入费率');
    const outputRate = safeInteger(input.outputRate, '输出费率');
    const outputLimit = safeInteger(input.outputLimit, '输出 token 上限', 1);
    const budget = safeInteger(input.budget, '预算');
    const interval = safeInteger(input.intervalSeconds, '间隔', 30);
    if (outputLimit > 4096 || interval > 86400) throw new Error('输出上限或间隔超出范围');
    atomic(() => {
      const existing = db.prepare('SELECT * FROM harness_config WHERE agent_id=?').get(id);
      if (existing && budget < existing.spent + existing.reserved) throw new Error('预算不能低于已支出及预留');
      db.prepare('UPDATE agents SET model=?,endpoint=? WHERE id=?').run(input.model, endpoint.toString().replace(/\/$/, ''), id);
      db.prepare(`INSERT INTO harness_config(agent_id,key_env,input_rate,output_rate,output_limit,budget,enabled,interval_seconds)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET key_env=excluded.key_env,input_rate=excluded.input_rate,
        output_rate=excluded.output_rate,output_limit=excluded.output_limit,budget=excluded.budget,
        enabled=excluded.enabled,interval_seconds=excluded.interval_seconds`)
        .run(id,input.keyEnv,inputRate,outputRate,outputLimit,budget,input.enabled ? 1 : 0,interval);
      record(id,'harness.configured',{model:input.model, endpoint:endpoint.origin, budget, enabled:!!input.enabled});
    });
  }
  async function decide(id) {
    const callId = randomUUID();
    const entry = atomic(() => {
      const row = db.prepare('SELECT a.*,c.* FROM agents a JOIN harness_config c ON a.id=c.agent_id WHERE a.id=?').get(id);
      if (!row || !row.enabled) throw new Error('Agent 未启用');
      if (db.prepare("SELECT id FROM model_calls WHERE agent_id=? AND status='pending'").get(id)) throw new Error('已有进行中的决策');
      if (!process.env[row.key_env]) throw new Error('模型密钥环境变量未设置');
      const snapshot = arena.snapshot();
      const quotes = snapshot.quotes.filter(q => Date.now()-Date.parse(q.received_at)<10000 && Date.now()-Date.parse(q.observed_at)<10000 && q.source === 'external-feed');
      if (!quotes.length) throw new Error('没有可信的新鲜行情');
      const context = {
        account: { cash:row.cash, frozenCash:row.frozen_cash },
        positions:snapshot.positions.filter(p=>p.agent_id===id),
        orders:snapshot.orders.filter(o=>o.agent_id===id && o.status==='open'),
        quotes:quotes.slice(0,30),
        instruction:'金额和价格单位为分。返回 JSON，格式为 {"action":"hold","reason":"..."} 或 {"action":"buy|sell","symbol":"SH600000","quantity":100,"limitPrice":1000,"reason":"..."}。只允许对可见行情操作。'
      };
      const messages = [{role:'system',content:'你是 A 股模拟账户的自主决策助手。只返回 JSON。'}, {role:'user',content:JSON.stringify(context)}];
      // Conservative byte bound plus fixed protocol allowance. Prices are CNY per million tokens.
      const inputBound = Buffer.byteLength(JSON.stringify(messages),'utf8') + 2048;
      const reservation = Math.ceil((inputBound * row.input_rate + row.output_limit * row.output_rate) / 1000000);
      if (!Number.isSafeInteger(reservation) || reservation <= 0) throw new Error('请配置大于零的模型费率');
      if (row.spent + row.reserved + reservation > row.budget) throw new Error('推理预算不足');
      const globalBudget = Number(process.env.GLOBAL_MODEL_BUDGET_MICRO || 0);
      const total = db.prepare('SELECT COALESCE(SUM(spent+reserved),0) AS used FROM harness_config').get().used;
      if (!Number.isSafeInteger(globalBudget) || globalBudget <= 0 || total + reservation > globalBudget) throw new Error('全局推理预算未设置或不足');
      db.prepare('UPDATE harness_config SET reserved=reserved+?,last_started=? WHERE agent_id=?').run(reservation,now(),id);
      db.prepare("INSERT INTO model_calls(id,agent_id,model,endpoint,status,reservation,created_at,input_rate,output_rate) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(callId,id,row.model,row.endpoint,'pending',reservation,now(),row.input_rate,row.output_rate);
      record(id,'decision.started',{callId,model:row.model,quoteIds:quotes.slice(0,30).map(q=>q.id),reservation});
      return {row,messages,reservation,quoteIds:quotes.slice(0,30).map(q=>q.id)};
    });
    let data;
    try {
      const res = await call(entry.row.endpoint + '/chat/completions', {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(45000),
        headers:{'content-type':'application/json','authorization':'Bearer '+process.env[entry.row.key_env]},
        body:JSON.stringify({model:entry.row.model,messages:entry.messages,max_tokens:entry.row.output_limit,temperature:0.2})
      });
      if (!res.ok) throw new Error('模型接口返回 HTTP '+res.status);
      data = await res.json();
      const usage=data.usage;
      if (!Number.isSafeInteger(usage?.prompt_tokens) || !Number.isSafeInteger(usage?.completion_tokens) || usage.prompt_tokens<0 || usage.completion_tokens<0) throw new Error('接口未返回有效用量，等待对账');
      const cost=Math.ceil((usage.prompt_tokens*entry.row.input_rate+usage.completion_tokens*entry.row.output_rate)/1000000);
      if (!Number.isSafeInteger(cost) || cost<0) throw new Error('用量金额异常');
      atomic(() => {
        db.prepare("UPDATE model_calls SET status='settled',actual_cost=?,input_tokens=?,output_tokens=?,request_id=?,completed_at=? WHERE id=?")
          .run(cost,usage.prompt_tokens,usage.completion_tokens,String(data.id || ''),now(),callId);
        db.prepare('UPDATE harness_config SET reserved=reserved-?,spent=spent+? WHERE agent_id=?').run(entry.reservation,cost,id);
        record(id,'decision.usage',{callId,cost,inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens});
      });
    } catch (error) {
      atomic(() => {
        db.prepare("UPDATE model_calls SET status='unknown',error=?,completed_at=? WHERE id=?").run(String(error.message).slice(0,200),now(),callId);
        record(id,'decision.unknown',{callId,error:String(error.message).slice(0,200)});
      });
      throw new Error('调用状态待对账，预留额度已保留：'+error.message);
    }
    let action;
    try {
      const content = data.choices?.[0]?.message?.content;
      action = JSON.parse(content.replace(/^\s*```(?:json)?\s*/i,'').replace(/\s*```\s*$/,''));
      if (!['hold','buy','sell'].includes(action.action)) throw new Error('无效动作');
      const reason = String(action.reason || '').slice(0,500);
      record(id,'decision.completed',{callId,action:action.action,symbol:action.symbol,quantity:action.quantity,reason});
      if (action.action !== 'hold') {
        if (!db.prepare('SELECT enabled FROM harness_config WHERE agent_id=?').get(id)?.enabled) throw new Error('Agent 已暂停');
        const latest=db.prepare('SELECT * FROM quotes WHERE symbol=? ORDER BY id DESC LIMIT 1').get(action.symbol);
        const observed = db.prepare('SELECT symbol FROM quotes WHERE id IN (' + entry.quoteIds.map(() => '?').join(',') + ')').all(...entry.quoteIds);
        if (!latest || latest.source !== 'external-feed' || !observed.some(q => q.symbol === action.symbol) || Date.now()-Date.parse(latest.received_at)>10000 || Date.now()-Date.parse(latest.observed_at)>10000) throw new Error('决策行情已过期或不在观察范围');
        const orderId = arena.submit({agentId:id,symbol:action.symbol,side:action.action,quantity:action.quantity,limitPrice:action.limitPrice});
        record(id,'decision.order_submitted',{callId,orderId});
      }
    } catch (error) {
      record(id,'decision.rejected',{callId,error:String(error.message).slice(0,200)});
      throw new Error('决策未执行：'+error.message);
    }
    return {callId, action:action.action};
  }
  function list() {
    return {
      configs: db.prepare('SELECT * FROM harness_config').all(),
      calls: db.prepare('SELECT * FROM model_calls ORDER BY created_at DESC LIMIT 100').all()
    };
  }
  function reconcile(callId, actualCost) {
    safeInteger(actualCost, '实际费用');
    atomic(() => {
      const call = db.prepare("SELECT * FROM model_calls WHERE id=? AND status='unknown'").get(callId);
      if (!call) throw new Error('调用不存在或不需要对账');
      db.prepare("UPDATE model_calls SET status='reconciled',actual_cost=?,completed_at=? WHERE id=?").run(actualCost,now(),callId);
      db.prepare('UPDATE harness_config SET reserved=reserved-?,spent=spent+? WHERE agent_id=?').run(call.reservation,actualCost,call.agent_id);
      record(call.agent_id,'decision.reconciled',{callId,actualCost});
    });
  }
  return { configure, decide, list, reconcile };
}
