const $ = (id) => document.getElementById(id);
const state = { sessionId: null, task: null, quote: null, order: null, razorpayKey: null };
const money = (paise = 0) => `₹${(Number(paise) / 100).toFixed(2)}`;
const adminBase = 'http://localhost:3002';

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
  wrap.innerHTML = `<div class="avatar">${role === 'user' ? 'U' : 'A'}</div><div><b>${role === 'user' ? 'You' : 'Agent'}</b><p></p></div>`;
  wrap.querySelector('p').textContent = text; $('messages').appendChild(wrap); $('messages').scrollTop = $('messages').scrollHeight;
}
function renderEvents(events = []) {
  const target = $('events'); if (target.querySelector('.empty')) target.innerHTML = '';
  for (const event of events) { if (event.type === 'state') continue; const row = document.createElement('div'); row.className = 'event'; const value = event.type === 'model' ? event.text : event.type === 'tool_call' ? event.arguments : event.result; row.innerHTML = `<span class="kind"></span><span></span><pre></pre>`; row.children[0].textContent = event.type.toUpperCase(); row.children[1].textContent = event.tool || 'agent'; row.children[2].textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); target.appendChild(row); }
  target.scrollTop = target.scrollHeight;
}
async function refreshCart() {
  if (!state.task?.cartId) return;
  try { const cart = await json(`/api/carts/${encodeURIComponent(state.task.cartId)}`); $('cartEmpty').hidden = true; $('cartBody').hidden = false; $('revision').textContent = `rev ${cart.revision}`; $('cartItems').innerHTML = cart.items.map(i => `<div class="cart-line"><div><b>${escapeHtml(i.name)}</b><small>${i.productId} · qty ${i.quantity} × ${money(i.unitPrice)}</small></div><b>${money(i.lineTotal)}</b></div>`).join(''); $('subtotal').textContent = money(cart.subtotal); $('discount').textContent = `− ${money(cart.discount)}`; $('delivery').textContent = money(cart.delivery); $('total').textContent = money(cart.total); } catch (e) { toast(e.message); }
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
async function renderTask(task) {
  state.task = task; await refreshCart();
  if (task?.phase === 'AWAITING_APPROVAL' && task.activeQuoteId) { state.quote = await json(`/api/quotes/${encodeURIComponent(task.activeQuoteId)}`); $('approvalPanel').hidden = false; $('executionPanel').hidden = true; $('paymentPanel').hidden = true; $('quoteAmount').textContent = money(state.quote.amount); $('quoteId').textContent = state.quote.quoteId; $('quoteDigest').textContent = state.quote.cartDigest; $('quoteSignature').textContent = state.quote.signatureValid ? 'VALID' : 'INVALID'; $('quoteExpiry').textContent = new Date(state.quote.validUntil).toLocaleTimeString(); }
  else if (task?.phase !== 'AWAITING_APPROVAL') $('approvalPanel').hidden = true;
}
async function runAgent(message, continuing = false) {
  $('sendButton').disabled = true; $('approveButton').disabled = true;
  try { const result = continuing ? await json(`/api/sessions/${encodeURIComponent(state.sessionId)}/continue`, { method: 'POST', body: '{}' }) : await json('/api/agent/run', { method: 'POST', body: JSON.stringify({ message, session_id: state.sessionId }) }); state.sessionId = result.session_id; renderEvents(result.events); await renderTask(result.state); if (result.message) addMessage('assistant', result.message); const orderEvent = [...(result.events || [])].reverse().find(e => e.type === 'tool_result' && e.tool === 'execute_payment' && e.result?.status === 'ORDER_CREATED'); if (orderEvent) { state.order = orderEvent.result.order; $('orderId').textContent = state.order.id; $('paymentPanel').hidden = false; } await refreshAudit(); }
  catch (e) { addMessage('assistant', `Error: ${e.message}`); if (e.body) renderEvents([{ type:'tool_result', tool:'host', result:e.body }]); }
  finally { $('sendButton').disabled = false; $('approveButton').disabled = false; }
}
$('chatForm').addEventListener('submit', async (event) => { event.preventDefault(); const message = $('chatInput').value.trim(); if (!message) return; addMessage('user', message); $('chatInput').value = ''; await runAgent(message); });
$('approveButton').addEventListener('click', async () => {
  if (!state.quote || !state.sessionId) return; $('approveButton').disabled = true;
  try { const approved = await json(`/api/quotes/${encodeURIComponent(state.quote.quoteId)}/approve`, { method: 'POST', body: JSON.stringify({ session_id: state.sessionId }) }); state.task = approved.state; addMessage('user', `Approved ${money(approved.approval.amount)} for quote ${approved.approval.quoteId}.`); $('approvalPanel').hidden = true; $('executionPanel').hidden = false; toast('Approved. You can mutate merchant state before continuing execution.'); }
  catch (e) { toast(e.message); $('approveButton').disabled = false; }
});
$('continueButton').addEventListener('click', async () => { if (!state.sessionId || !state.task?.activeGrantId) return toast('No approved grant is ready.'); $('executionPanel').hidden = true; await runAgent('', true); });
$('checkoutButton').addEventListener('click', async () => {
  if (!state.order || !state.razorpayKey) return toast('Razorpay Test credentials are not configured.'); if (!window.Razorpay) return toast('Razorpay Checkout script did not load.'); await json('/api/payments/opened', { method: 'POST', body: JSON.stringify({ order_id: state.order.id }) });
  const checkout = new Razorpay({ key: state.razorpayKey, order_id: state.order.id, amount: state.order.amount, currency: state.order.currency, name: 'Agent Execute', description: 'Verified agent checkout — Test Mode', handler: async (result) => { try { const verified = await json('/api/payments/verify', { method: 'POST', body: JSON.stringify(result) }); addMessage('assistant', `Payment verified successfully. Razorpay payment ${verified.payment_id} is bound to the verified order.`); $('paymentPanel').hidden = true; await refreshAudit(); } catch (e) { addMessage('assistant', `Payment verification failed: ${e.message}`); } }, modal: { ondismiss: () => toast('Checkout closed without changing the authorization.') } });
  checkout.on('payment.failed', async (response) => { await json('/api/payments/failure', { method: 'POST', body: JSON.stringify({ order_id: state.order.id, error: response.error }) }).catch(()=>{}); addMessage('assistant', `Razorpay Test Checkout failed at the payment rail. Quote integrity remained verified.`); await refreshAudit(); }); checkout.open();
});
async function refreshAudit() { try { const audit = await json('/api/audit?limit=200'); $('auditEvents').innerHTML = ''; for (const event of audit) { const row = document.createElement('div'); row.className = 'event'; row.innerHTML = '<span class="kind"></span><span></span><pre></pre>'; row.children[0].textContent = event.type; row.children[1].textContent = new Date(event.at).toLocaleTimeString(); row.children[2].textContent = JSON.stringify(event.data, null, 2); $('auditEvents').appendChild(row); } } catch {} }
async function loadMerchant() { try { const data = await json(`${adminBase}/state`); $('discountInput').value = (data.merchant.discount/100).toFixed(2); $('deliveryInput').value=(data.merchant.delivery/100).toFixed(2); $('products').innerHTML = data.products.map(p => `<div class="product" data-id="${p.id}"><strong>${escapeHtml(p.name)}</strong><small>${p.id} · ${p.category}</small><div class="controls"><input class="price" type="number" min="0" step="1" value="${(p.price/100).toFixed(2)}"><button class="price-btn">Price</button><input class="inventory" type="number" min="0" step="1" value="${p.inventory}"><button class="stock-btn">Stock</button></div></div>`).join(''); } catch (e) { toast(`Merchant admin: ${e.message}`); } }
$('products').addEventListener('click', async (e) => { const card=e.target.closest('.product'); if(!card) return; try { if(e.target.classList.contains('price-btn')) await json(`${adminBase}/products/${card.dataset.id}/price`,{method:'PATCH',body:JSON.stringify({price:Math.round(Number(card.querySelector('.price').value)*100)})}); if(e.target.classList.contains('stock-btn')) await json(`${adminBase}/products/${card.dataset.id}/inventory`,{method:'PATCH',body:JSON.stringify({inventory:Number(card.querySelector('.inventory').value)})}); toast('Merchant state changed. The agent has not been told what to do next.'); await refreshCart(); await refreshAudit(); } catch(err){toast(err.message)} });
document.querySelector('.merchant-settings').addEventListener('click', async (e)=>{ const setting=e.target.dataset.setting; if(!setting)return; const input=setting==='discount'?$('discountInput'):$('deliveryInput'); try{await json(`${adminBase}/merchant/${setting}`,{method:'PATCH',body:JSON.stringify({[setting]:Math.round(Number(input.value)*100)})});toast('Merchant financial state changed.');await refreshCart();await refreshAudit();}catch(err){toast(err.message)} });
$('resetMerchant').addEventListener('click',async()=>{try{await json(`${adminBase}/reset`,{method:'POST',body:'{}'});state.sessionId=null;state.task=null;state.quote=null;state.order=null;$('cartBody').hidden=true;$('cartEmpty').hidden=false;$('approvalPanel').hidden=true;$('executionPanel').hidden=true;$('paymentPanel').hidden=true;toast('Merchant and local test state reset.');await loadMerchant();await refreshAudit();}catch(e){toast(e.message)}});
$('newSession').addEventListener('click',()=>{state.sessionId=null;state.task=null;state.quote=null;state.order=null;$('approvalPanel').hidden=true;$('executionPanel').hidden=true;$('paymentPanel').hidden=true;addMessage('assistant','Started a fresh agent session. Existing merchant state is unchanged.');});
$('refreshAudit').addEventListener('click',refreshAudit);
document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.tab-content').forEach(x=>x.classList.remove('active'));btn.classList.add('active');$(btn.dataset.tab).classList.add('active');if(btn.dataset.tab==='merchant')loadMerchant();if(btn.dataset.tab==='audit')refreshAudit();}));
(async function boot(){ try { const h=await json('/health'); $('healthDot').classList.add('ok'); $('healthText').textContent=h.ok?'Agent service online':'Agent service issue'; } catch { $('healthText').textContent='Agent service offline'; } try { const cfg=await json('/api/config/public'); state.razorpayKey=cfg.razorpay_key_id; } catch {} await refreshAudit(); })();