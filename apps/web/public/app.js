const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'agent_execute_session_id';
const state = { sessionId: null, task: null, quote: null, order: null, razorpayKey: null };
const money = (paise = 0) => `₹${(Number(paise) / 100).toFixed(2)}`;
const adminBase = 'http://localhost:3002';

function rememberSession(sessionId) {
  state.sessionId = sessionId || null;
  if (state.sessionId) localStorage.setItem(SESSION_KEY, state.sessionId);
  else localStorage.removeItem(SESSION_KEY);
  renderSessionMeta();
}
function shortId(value, fallback = 'No active session') {
  if (!value) return fallback;
  return value.length > 24 ? `${value.slice(0, 13)}…${value.slice(-7)}` : value;
}
function renderSessionMeta() {
  if ($('sessionBadge')) $('sessionBadge').textContent = shortId(state.sessionId);
  if ($('phaseBadge')) $('phaseBadge').textContent = state.task?.phase || (state.sessionId ? 'STARTING' : 'READY');
}
function markStep(id, mode) {
  const node = $(id); if (!node) return;
  node.classList.remove('active', 'done');
  if (mode) node.classList.add(mode);
}
function renderPipeline(task = state.task) {
  const phase = task?.phase;
  const hasSession = Boolean(state.sessionId);
  const hasCart = Boolean(task?.cartId);
  const hasQuote = Boolean(task?.activeQuoteId);
  const approved = Boolean(task?.activeGrantId) || ['APPROVED','PAYMENT_READY','PAYMENT_COMPLETE'].includes(phase);
  const paymentReady = Boolean(state.order) || ['PAYMENT_READY','PAYMENT_COMPLETE'].includes(phase);
  const complete = phase === 'PAYMENT_COMPLETE';

  markStep('stepAgent', hasSession ? (hasCart ? 'done' : 'active') : 'active');
  markStep('stepMcp', hasCart ? (hasQuote ? 'done' : 'active') : null);
  markStep('stepCommit', hasQuote ? (approved ? 'done' : 'active') : null);
  markStep('stepGuard', approved ? (paymentReady ? 'done' : 'active') : null);
  markStep('stepPay', paymentReady ? (complete ? 'done' : 'active') : null);
  renderSessionMeta();
}
function toast(message) {
  const el = $('toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 3500);
}
async function json(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || body.error || `HTTP ${response.status}`), { body });
  return body;
}
function addMessage(role, text) {
  const wrap = document.createElement('div'); wrap.className = `message ${role}`;
  const isUser = role === 'user';
  wrap.innerHTML = `<div class="avatar ${isUser ? '' : 'agent-avatar'}">${isUser ? 'U' : 'AE'}</div><div class="message-content"><div class="message-author"><b>${isUser ? 'You' : 'Agent Execute'}</b><span>${isUser ? 'request' : 'shopping agent'}</span></div><p></p></div>`;
  wrap.querySelector('p').textContent = text; $('messages').appendChild(wrap); $('messages').scrollTop = $('messages').scrollHeight;
}
function eventClass(type) { return String(type || '').replaceAll('_', '-').toLowerCase(); }
function renderEvents(events = []) {
  const target = $('events'); if (target.querySelector('.empty-state')) target.innerHTML = '';
  for (const event of events) {
    if (event.type === 'state') continue;
    const row = document.createElement('div'); row.className = `event ${eventClass(event.type)}`;
    const value = event.type === 'model' ? event.text : event.type === 'tool_call' ? event.arguments : event.result;
    row.innerHTML = `<span class="kind"></span><span></span><pre></pre>`;
    row.children[0].textContent = event.type.toUpperCase();
    row.children[1].textContent = event.tool || 'agent';
    row.children[2].textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    target.appendChild(row);
  }
  target.scrollTop = target.scrollHeight;
}
async function refreshCart() {
  if (!state.task?.cartId) return;
  try {
    const cart = await json(`/api/carts/${encodeURIComponent(state.task.cartId)}`);
    $('cartEmpty').hidden = true; $('cartBody').hidden = false; $('revision').textContent = `rev ${cart.revision}`;
    $('cartItems').innerHTML = cart.items.map(i => `<div class="cart-line"><div><b>${escapeHtml(i.name)}</b><small>${escapeHtml(i.productId)} · qty ${i.quantity} × ${money(i.unitPrice)}</small></div><b>${money(i.lineTotal)}</b></div>`).join('');
    $('subtotal').textContent = money(cart.subtotal); $('discount').textContent = `− ${money(cart.discount)}`; $('delivery').textContent = money(cart.delivery); $('total').textContent = money(cart.total);
  } catch (e) { toast(e.message); }
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
async function renderTask(task) {
  state.task = task;
  await refreshCart();
  $('approvalPanel').hidden = true;
  $('executionPanel').hidden = true;
  if (task?.phase === 'AWAITING_APPROVAL' && task.activeQuoteId) {
    state.quote = await json(`/api/quotes/${encodeURIComponent(task.activeQuoteId)}`);
    $('approvalPanel').hidden = false; $('paymentPanel').hidden = true;
    $('quoteAmount').textContent = money(state.quote.amount); $('quoteId').textContent = state.quote.quoteId;
    $('quoteDigest').textContent = state.quote.cartDigest; $('quoteSignature').textContent = state.quote.signatureValid ? 'VALID' : 'INVALID';
    $('quoteExpiry').textContent = new Date(state.quote.validUntil).toLocaleTimeString();
  } else if (task?.phase === 'APPROVED') {
    $('executionPanel').hidden = false;
  }
  renderPipeline(task);
}
function showOrder(order) {
  if (!order) return;
  state.order = order; $('orderId').textContent = order.id; $('paymentPanel').hidden = false; renderPipeline();
}
async function runAgent(message, continuing = false) {
  $('sendButton').disabled = true; $('approveButton').disabled = true;
  try {
    const result = continuing
      ? await json(`/api/sessions/${encodeURIComponent(state.sessionId)}/continue`, { method: 'POST', body: '{}' })
      : await json('/api/agent/run', { method: 'POST', body: JSON.stringify({ message, session_id: state.sessionId }) });
    rememberSession(result.session_id);
    renderEvents(result.events); await renderTask(result.state); if (result.message) addMessage('assistant', result.message);
    const orderEvent = [...(result.events || [])].reverse().find(e => e.type === 'tool_result' && e.tool === 'execute_payment' && e.result?.status === 'ORDER_CREATED');
    if (orderEvent) showOrder(orderEvent.result.order);
    await refreshAudit();
  } catch (e) {
    addMessage('assistant', `Error: ${e.message}`); if (e.body) renderEvents([{ type:'tool_result', tool:'host', result:e.body }]);
  } finally { $('sendButton').disabled = false; $('approveButton').disabled = false; }
}
$('chatForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const message = $('chatInput').value.trim(); if (!message) return;
  addMessage('user', message); $('chatInput').value = ''; await runAgent(message);
});
document.querySelectorAll('.prompt-chip').forEach((chip) => chip.addEventListener('click', async () => {
  const prompt = chip.dataset.prompt; if (!prompt || $('sendButton').disabled) return;
  $('chatInput').value = prompt; $('chatInput').focus();
}));
$('approveButton').addEventListener('click', async () => {
  if (!state.quote || !state.sessionId) return; $('approveButton').disabled = true;
  try {
    const approved = await json(`/api/quotes/${encodeURIComponent(state.quote.quoteId)}/approve`, { method: 'POST', body: JSON.stringify({ session_id: state.sessionId }) });
    state.task = approved.state; addMessage('user', `Approved ${money(approved.approval.amount)} for quote ${approved.approval.quoteId}.`);
    $('approvalPanel').hidden = true; $('executionPanel').hidden = false; renderPipeline();
    toast('Approval locked. Mutate merchant state now if you want to test the execution guard.');
  } catch (e) { toast(e.message); $('approveButton').disabled = false; }
});
$('continueButton').addEventListener('click', async () => {
  if (!state.sessionId || !state.task?.activeGrantId) return toast('No approved grant is ready.');
  $('executionPanel').hidden = true; await runAgent('', true);
});
$('checkoutButton').addEventListener('click', async () => {
  if (!state.order || !state.razorpayKey) return toast('Razorpay Test credentials are not configured.');
  if (!window.Razorpay) return toast('Razorpay Checkout script did not load.');
  await json('/api/payments/opened', { method: 'POST', body: JSON.stringify({ order_id: state.order.id }) });
  const checkout = new Razorpay({
    key: state.razorpayKey,
    order_id: state.order.id,
    amount: state.order.amount,
    currency: state.order.currency,
    name: 'Agent Execute',
    description: 'Verified agent checkout — Test Mode',
    handler: async (result) => {
      try {
        const verified = await json('/api/payments/verify', { method: 'POST', body: JSON.stringify(result) });
        addMessage('assistant', `Payment verified successfully. Razorpay payment ${verified.payment_id} is bound to the verified order.`);
        $('paymentPanel').hidden = true; state.task.phase = 'PAYMENT_COMPLETE'; renderPipeline(); await refreshAudit();
      } catch (e) { addMessage('assistant', `Payment verification failed: ${e.message}`); }
    },
    modal: { ondismiss: () => toast('Checkout closed without changing the authorization.') },
  });
  checkout.on('payment.failed', async (response) => {
    const failure = await json('/api/payments/failure', { method: 'POST', body: JSON.stringify({ order_id: state.order.id, error: response.error }) }).catch(() => null);
    addMessage('assistant', `Razorpay Test Checkout failed at the payment rail. Quote integrity remained verified.${failure?.retry_allowed ? ' You may retry this Test Checkout.' : ''}`);
    if (failure) renderEvents([{ type:'tool_result', tool:'razorpay_checkout', result:failure }]);
    await refreshAudit();
  });
  checkout.open();
});
async function refreshAudit() {
  try {
    const audit = await json('/api/audit?limit=200'); $('auditEvents').innerHTML = '';
    for (const event of audit) {
      const row = document.createElement('div'); row.className = 'event audit-event'; row.innerHTML = '<span class="kind"></span><span></span><pre></pre>';
      row.children[0].textContent = event.type; row.children[1].textContent = new Date(event.at).toLocaleTimeString(); row.children[2].textContent = JSON.stringify(event.data, null, 2); $('auditEvents').appendChild(row);
    }
  } catch {}
}
async function loadMerchant() {
  try {
    const data = await json(`${adminBase}/state`); $('discountInput').value = (data.merchant.discount/100).toFixed(2); $('deliveryInput').value=(data.merchant.delivery/100).toFixed(2);
    $('products').innerHTML = data.products.map(p => `<div class="product" data-id="${escapeHtml(p.id)}"><div class="product-head"><div><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.id)} · ${escapeHtml(p.category)}</small></div><span class="availability-pill ${p.active ? '' : 'off'}">${p.active ? 'AVAILABLE' : 'OFFLINE'}</span></div><div class="controls"><input class="price" aria-label="Price" type="number" min="0" step="1" value="${(p.price/100).toFixed(2)}"><button class="price-btn button button-secondary">Price</button><input class="inventory" aria-label="Inventory" type="number" min="0" step="1" value="${p.inventory}"><button class="stock-btn button button-secondary">Stock</button><button class="active-btn button ${p.active ? 'button-danger' : 'button-secondary'}" data-active="${p.active}">${p.active ? 'Mark unavailable' : 'Restore availability'}</button></div></div>`).join('');
  } catch (e) { toast(`Merchant admin: ${e.message}`); }
}
$('products').addEventListener('click', async (e) => {
  const card=e.target.closest('.product'); if(!card) return;
  try {
    if(e.target.classList.contains('price-btn')) await json(`${adminBase}/products/${card.dataset.id}/price`,{method:'PATCH',body:JSON.stringify({price:Math.round(Number(card.querySelector('.price').value)*100)})});
    if(e.target.classList.contains('stock-btn')) await json(`${adminBase}/products/${card.dataset.id}/inventory`,{method:'PATCH',body:JSON.stringify({inventory:Number(card.querySelector('.inventory').value)})});
    if(e.target.classList.contains('active-btn')) await json(`${adminBase}/products/${card.dataset.id}/active`,{method:'PATCH',body:JSON.stringify({active:e.target.dataset.active !== 'true'})});
    toast('Merchant state changed. The agent received no recovery instruction.'); await loadMerchant(); await refreshCart(); await refreshAudit();
  } catch(err){toast(err.message)}
});
document.querySelector('.merchant-settings').addEventListener('click', async (e)=>{
  const setting=e.target.dataset.setting; if(!setting)return; const input=setting==='discount'?$('discountInput'):$('deliveryInput');
  try{await json(`${adminBase}/merchant/${setting}`,{method:'PATCH',body:JSON.stringify({[setting]:Math.round(Number(input.value)*100)})});toast('Merchant financial state changed.');await refreshCart();await refreshAudit();}catch(err){toast(err.message)}
});
function resetUiState() {
  state.task=null; state.quote=null; state.order=null;
  $('cartBody').hidden=true; $('cartEmpty').hidden=false; $('revision').textContent='rev —';
  $('approvalPanel').hidden=true; $('executionPanel').hidden=true; $('paymentPanel').hidden=true;
  renderPipeline(null);
}
$('resetMerchant').addEventListener('click',async()=>{
  try{
    await json(`${adminBase}/reset`,{method:'POST',body:'{}'}); rememberSession(null); resetUiState();
    toast('Merchant and local test state reset.');await loadMerchant();await refreshAudit();
  }catch(e){toast(e.message)}
});
$('newSession').addEventListener('click',()=>{
  rememberSession(null); resetUiState();
  addMessage('assistant','Started a fresh agent session. Existing merchant state is unchanged.');
});
$('refreshAudit').addEventListener('click',refreshAudit);
document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active')); document.querySelectorAll('.tab-content').forEach(x=>x.classList.remove('active'));
  btn.classList.add('active'); $(btn.dataset.tab).classList.add('active'); if(btn.dataset.tab==='merchant')loadMerchant(); if(btn.dataset.tab==='audit')refreshAudit();
}));

async function restoreSession() {
  const saved = localStorage.getItem(SESSION_KEY);
  if (!saved) return;
  try {
    const snapshot = await json(`/api/sessions/${encodeURIComponent(saved)}`);
    rememberSession(saved); await renderTask(snapshot.state);
    if (snapshot.execution?.state === 'ORDER_CREATED' && snapshot.execution.result?.order) showOrder(snapshot.execution.result.order);
    if (snapshot.payment?.state === 'PAYMENT_SUCCESS') { $('paymentPanel').hidden = true; state.task.phase = 'PAYMENT_COMPLETE'; renderPipeline(); }
    addMessage('assistant', `Restored persisted session ${shortId(saved, saved)}. Current phase: ${snapshot.state.phase}.`);
  } catch { rememberSession(null); resetUiState(); }
}

(async function boot(){
  renderPipeline(null); renderSessionMeta();
  try {
    const h=await json('/health'); $('healthDot').classList.add('ok');
    const missing = [h.llm_configured ? null : 'LLM', h.razorpay_test_configured ? null : 'Razorpay Test'].filter(Boolean);
    $('healthText').textContent = missing.length ? `Online · configure ${missing.join(' + ')}` : 'Agent + payment services configured';
  } catch { $('healthText').textContent='Agent service offline'; }
  try { const cfg=await json('/api/config/public'); state.razorpayKey=cfg.razorpay_key_id; } catch {}
  await restoreSession(); await refreshAudit();
})();
