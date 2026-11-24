const $ = selector => document.querySelector(selector);
const money = amount => '¥' + (amount / 100).toFixed(2);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let state;
async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
async function refresh() {
  state = await request('/api/state');
  const names = new Map(state.agents.map(a => [a.id, a.name]));
  $('#accounts').innerHTML = state.agents.map(a => `<article><div class="card-head"><strong>${escapeHtml(a.name)}</strong><span>种子 ${a.seed}</span></div><p class="amount">${money(a.cash)}</p><small>现金余额 · 冻结 ${money(a.frozen_cash)}</small><p>模型 ${escapeHtml(a.model || '待配置')}</p></article>`).join('') || '<p class="empty">还没有账户，创建第一个 Agent。</p>';
  const select = $('#order select[name=agentId]');
  const selected = select.value;
  select.innerHTML = state.agents.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  if (state.agents.some(a => a.id === selected)) select.value = selected;
  const harnessSelect = $('#harness select[name=agentId]');
  const harnessSelected = harnessSelect.value;
  harnessSelect.innerHTML = select.innerHTML;
  if (state.agents.some(a => a.id === harnessSelected)) harnessSelect.value = harnessSelected;
  $('#feed-status').textContent = '行情源状态：' + state.feed.status + (state.feed.error ? ' · ' + state.feed.error : '');
  $('#calls').innerHTML = state.harness.calls.map(c => `<p>${escapeHtml(c.model)} · ${escapeHtml(c.status)} · ${escapeHtml(c.created_at)} · ${c.actual_cost == null ? '待对账' : '¥' + (c.actual_cost/1000000).toFixed(6)}<br><small>调用 ID ${escapeHtml(c.id)}</small></p>`).join('') || '<p class="empty">暂无调用</p>';
  $('#orders').innerHTML = state.orders.length ? `<h3>委托</h3><div class="table"><table><thead><tr><th>账户</th><th>股票</th><th>方向</th><th>限价</th><th>剩余 / 总数</th><th>状态</th><th></th></tr></thead><tbody>${state.orders.map(o => `<tr><td>${escapeHtml(names.get(o.agent_id))}</td><td>${escapeHtml(o.symbol)}</td><td>${o.side === 'buy' ? '买入' : '卖出'}</td><td>${money(o.limit_price)}</td><td>${o.remaining} / ${o.quantity}</td><td>${escapeHtml(o.status)}</td><td>${o.status === 'open' ? `<button data-cancel="${o.id}">撤单</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">暂无委托</p>';
  $('#positions').innerHTML = state.positions.length ? `<h3>持仓</h3><div class="table"><table><thead><tr><th>账户</th><th>股票</th><th>持有</th><th>可卖</th><th>冻结</th></tr></thead><tbody>${state.positions.map(p => `<tr><td>${escapeHtml(names.get(p.agent_id))}</td><td>${escapeHtml(p.symbol)}</td><td>${p.quantity}</td><td>${p.sellable}</td><td>${p.frozen}</td></tr>`).join('')}</tbody></table></div>` : '';
  $('#events').innerHTML = state.events.map(e => `<div class="event"><time>${escapeHtml(new Date(e.created_at).toLocaleString('zh-CN'))}</time><strong>${escapeHtml(names.get(e.agent_id) || '系统')} · ${escapeHtml(e.type)}</strong><span>${escapeHtml(JSON.stringify(e.payload))}</span></div>`).join('') || '<p class="empty">暂无日志</p>';
}
const formValues = form => Object.fromEntries(new FormData(form));
async function run(action) { try { await action(); $('#message').textContent = '操作成功'; await refresh(); } catch (e) { $('#message').textContent = e.message; } }
$('#agent').onsubmit = event => { event.preventDefault(); const x = formValues(event.target); run(() => request('/api/agents', {...x, cash: Math.round(Number(x.cash)*100), seed: Number(x.seed)})); };
$('#order').onsubmit = event => { event.preventDefault(); const x = formValues(event.target); run(() => request('/api/orders', {...x, quantity: Number(x.quantity), limitPrice: Math.round(Number(x.limitPrice)*100)})); };
$('#quote').onsubmit = event => { event.preventDefault(); const x = formValues(event.target); run(() => request('/api/quotes', {...x, bid: Math.round(Number(x.bid)*100), ask: Math.round(Number(x.ask)*100), bidQuantity: Number(x.bidQuantity), askQuantity: Number(x.askQuantity), observedAt: new Date().toISOString(), source: 'manual'})); };
$('#harness').onsubmit = event => {
  event.preventDefault();
  const x = formValues(event.target);
  run(() => request('/api/harness/configure', {...x, inputRate: Math.round(Number(x.inputRate)*1000000), outputRate: Math.round(Number(x.outputRate)*1000000), budget: Math.round(Number(x.budget)*1000000), outputLimit: Number(x.outputLimit), intervalSeconds: Number(x.intervalSeconds), enabled: Boolean(x.enabled)}));
};
$('#decide').onclick = () => run(() => request('/api/harness/decide', {agentId: $('#harness select[name=agentId]').value}));
$('#reconcile').onsubmit = event => { event.preventDefault(); const x = formValues(event.target); run(() => request('/api/harness/reconcile', {callId: x.callId, actualCost: Math.round(Number(x.cost)*1000000)})); };
$('#settle').onsubmit = event => { event.preventDefault(); run(() => request('/api/settle', formValues(event.target))); };
$('#orders').onclick = event => { const id = event.target.dataset.cancel; if (id) run(() => request('/api/cancel', {id})); };
$('#refresh').onclick = () => run(refresh);
refresh().catch(e => { $('#message').textContent = e.message; });
