const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'agent_execute_session_id';
const adminBase = 'http://localhost:3002';
const state = { sessionId:null, task:null, quote:null, order:null, cart:null, razorpayKey:null, working:null };
const money = (paise=0) => `₹${(Number(paise)/100).toFixed(2)}`;
const escapeHtml = (v) => String(v ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const shortId = (v,fallback='—') => !v ? fallback : (String(v).length>26 ? `${String(v).slice(0,13)}…${String(v).slice(-8)}` : String(v));

function rememberSession(id){ state.sessionId=id||null; if(id)localStorage.setItem(SESSION_KEY,id);else localStorage.removeItem(SESSION_KEY); renderSessionMeta(); }
function renderSessionMeta(){ if($('phaseBadge'))$('phaseBadge').textContent=state.task?.phase||'READY'; if($('sessionBadge'))$('sessionBadge').textContent=shortId(state.sessionId,'No active session'); }
function toast(message){ const el=$('toast'); el.textContent=message; el.hidden=false; clearTimeout(toast.t); toast.t=setTimeout(()=>el.hidden=true,3500); }
async function json(url,options={}){ const r=await fetch(url,{headers:{'content-type':'application/json',...(options.headers||{})},...options}); const b=await r.json().catch(()=>({})); if(!r.ok)throw Object.assign(new Error(b.message||b.error||`HTTP ${r.status}`),{body:b}); return b; }
function scrollChat(){ requestAnimationFrame(()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior:'smooth'})); }
function enterChat(){ $('homeView').hidden=true; $('chatView').hidden=false; document.body.classList.add('chat-active'); setTimeout(()=>$('chatInput').focus(),80); }
function enterHome(){ $('chatView').hidden=true; $('homeView').hidden=false; document.body.classList.remove('chat-active'); setTimeout(()=>$('homeInput').focus(),80); }

function addMessage(role,text){
  const wrap=document.createElement('div'); wrap.className=`message ${role}`;
  wrap.innerHTML=`<div class="message-body">${role==='assistant'?'<div class="message-label">Agent Execute</div>':''}<p></p></div>`;
  wrap.querySelector('p').textContent=text; $('messages').appendChild(wrap); scrollChat(); return wrap;
}
function showWorking(){ removeWorking(); const row=document.createElement('div'); row.className='message assistant working-message'; row.innerHTML='<div class="message-body"><div class="message-label">Agent Execute</div><p>Working<span class="working-dots">…</span></p></div>'; $('messages').appendChild(row); state.working=row; scrollChat(); }
function removeWorking(){ if(state.working?.isConnected)state.working.remove(); state.working=null; }

const toolLabels={
  create_cart:'Created merchant cart', search_products:'Searched merchant products', get_product:'Read product details', view_cart:'Read authoritative cart',
  add_to_cart:'Added item to cart', remove_from_cart:'Removed item from cart', update_quantity:'Updated cart quantity', commit_quote:'Committed exact cart state',
  execute_payment:'Verified payment execution', get_payment_status:'Checked payment status'
};
function renderRawEvents(events=[]){
  const target=$('events'); if(target.querySelector('.drawer-empty'))target.innerHTML='';
  for(const e of events){ if(e.type==='state')continue; const row=document.createElement('div'); row.className='event'; const value=e.type==='model'?e.text:e.type==='tool_call'?e.arguments:e.result; row.innerHTML='<span class="kind"></span><span></span><pre></pre>'; row.children[0].textContent=e.type.toUpperCase(); row.children[1].textContent=e.tool||'agent'; row.children[2].textContent=typeof value==='string'?value:JSON.stringify(value,null,2); target.appendChild(row); }
}
function renderInlineActivity(events=[]){
  const useful=events.filter(e=>e.type==='tool_call'||e.type==='tool_result'); if(!useful.length)return;
  const group=document.createElement('div'); group.className='activity-group';
  const calls=new Map();
  for(const e of useful){
    if(e.type==='tool_call'){ calls.set(e.tool,(calls.get(e.tool)||0)+1); const row=document.createElement('div'); row.className='activity-row'; row.innerHTML=`<details><summary><span class="activity-icon">↳</span><span>${escapeHtml(toolLabels[e.tool]||e.tool||'Tool call')}</span><span class="activity-status">called</span></summary><pre>${escapeHtml(JSON.stringify(e.arguments||{},null,2))}</pre></details>`; group.appendChild(row); }
    else { const result=e.result||{}; const failed=result?.isError||result?.status==='BLOCKED'||result?.status==='PAYMENT_FAILED'||result?.error; const row=document.createElement('div'); row.className=`activity-row ${failed?'warn':'ok'}`; row.innerHTML=`<details><summary><span class="activity-icon">${failed?'!':'✓'}</span><span>${escapeHtml(failed?'Tool returned a guarded result':`${toolLabels[e.tool]||e.tool||'Tool'} completed`)}</span><span class="activity-status">${failed?'inspect':'done'}</span></summary><pre>${escapeHtml(JSON.stringify(result,null,2))}</pre></details>`; group.appendChild(row); }
  }
  $('messages').appendChild(group); scrollChat();
}

function findNested(obj,key,depth=0){ if(!obj||typeof obj!=='object'||depth>5)return undefined; if(Object.prototype.hasOwnProperty.call(obj,key))return obj[key]; for(const v of Object.values(obj)){const hit=findNested(v,key,depth+1);if(hit!==undefined)return hit;} }
function extractCode(result){ return result?.error?.code||result?.code||result?.reason?.code||findNested(result,'code')||''; }
function timelineNode(key){ return $('messages').querySelector(`[data-timeline-key="${CSS.escape(key)}"]`); }
function appendCard(key,html){ let node=timelineNode(key); if(node)return node; node=document.createElement('div'); node.className='inline-card'; node.dataset.timelineKey=key; node.innerHTML=html; $('messages').appendChild(node); scrollChat(); return node; }
function resolveCard(key){ const node=timelineNode(key); if(node){node.classList.add('resolved'); node.querySelectorAll('button').forEach(b=>b.disabled=true);} }

async function refreshCart(){ if(!state.task?.cartId)return null; try{ state.cart=await json(`/api/carts/${encodeURIComponent(state.task.cartId)}`); return state.cart; }catch(e){toast(e.message);return null;} }
function renderQuoteCard(){
  if(!state.quote)return; const cart=state.cart; const items=(cart?.items||[]).map(i=>`<tr><td>${escapeHtml(i.name)} <span class="muted">× ${i.quantity}</span></td><td>${money(i.unitPrice)}</td><td>${money(i.lineTotal)}</td></tr>`).join('');
  appendCard(`quote:${state.quote.quoteId}`,`<div class="card-head"><div class="card-title"><span class="card-icon">◇</span>Your cart</div><span class="status-pill">COMMITTED</span></div><p class="card-copy">This is the current server cart and the exact signed checkout state waiting for your approval.</p><table class="cart-table"><thead><tr><th>Item</th><th>Unit</th><th>Total</th></tr></thead><tbody>${items||'<tr><td colspan="3">Cart committed</td></tr>'}</tbody></table><div class="card-total"><span>Exact amount</span><strong>${money(state.quote.amount)}</strong></div><div class="proof-list"><div><i>✓</i> Merchant state committed <span class="activity-status">rev ${escapeHtml(cart?.revision??'—')}</span></div><div><i>✓</i> Merchant signature ${state.quote.signatureValid?'verified':'invalid'}</div></div><div class="proof-meta"><span>Quote</span><code>${escapeHtml(shortId(state.quote.quoteId))}</code><span>Digest</span><code>${escapeHtml(shortId(state.quote.cartDigest))}</code><span>Expires</span><code>${escapeHtml(new Date(state.quote.validUntil).toLocaleTimeString())}</code></div><button class="card-action" data-action="approve" type="button">Approve exact amount · ${money(state.quote.amount)}</button><p class="card-note">The agent cannot create this approval or change the amount after it.</p>`);
}
function renderApprovalCard(){
  const grant=state.task?.activeGrantId; if(!grant)return; const amount=state.quote?.amount||state.cart?.total||0;
  appendCard(`grant:${grant}`,`<div class="card-head"><div class="card-title"><span class="card-icon">✓</span>Approval confirmed</div><span class="status-pill">APPROVED</span></div><div class="amount-hero">${money(amount)}</div><div class="proof-meta"><span>Grant</span><code>${escapeHtml(shortId(grant))}</code><span>Authority</span><code>User approval</code></div><div class="success-box">✓ Execution grant created. The approved amount cannot be changed by the agent.</div><button class="card-action green" data-action="continue" type="button">Continue to execution</button>`);
}
function renderGuardIssue(result){
  const code=extractCode(result); if(!code)return; const text=JSON.stringify(result); const stale=code==='QUOTE_CHANGED'||code==='STALE_CART'||text.includes('QUOTE_CHANGED')||text.includes('STALE_CART');
  if(stale){ const approved=findNested(result,'approved')||{}; const current=findNested(result,'current')||{}; const approvedAmount=approved.amount??approved.total??state.quote?.amount; const currentAmount=current.amount??current.total??state.cart?.total; appendCard(`guard:${Date.now()}`,`<div class="card-head"><div class="card-title"><span class="card-icon">!</span>Checkout changed</div><span class="status-pill amber">STALE STATE</span></div><p class="card-copy">The merchant changed after your approval. The guard stopped execution before payment.</p><div class="compare-amounts"><div><strong>${approvedAmount!=null?money(approvedAmount):'Approved'}</strong><span>Approved</span></div><span class="compare-arrow">→</span><div><strong>${currentAmount!=null?money(currentAmount):'Changed'}</strong><span>Current</span></div></div><div class="alert-box"><b>No payment was created.</b><br>The agent can now re-read the merchant and recover with a fresh quote.</div><div class="proof-meta"><span>Reason</span><code>${escapeHtml(code)}</code></div>`); return; }
  const blocked=['INVALID_SIGNATURE','AMOUNT_MISMATCH','CURRENCY_MISMATCH','MERCHANT_MISMATCH','REPLAY_ATTEMPT','GRANT_ALREADY_USED','PAYMENT_VERIFICATION_FAILED'].includes(code);
  if(blocked) appendCard(`blocked:${Date.now()}`,`<div class="card-head"><div class="card-title"><span class="card-icon">×</span>Execution blocked</div><span class="status-pill red">GUARD</span></div><p class="card-copy">The deterministic guard refused to create a payment.</p><div class="error-box">${escapeHtml(code)}</div><div class="alert-box">No payment was created. The agent cannot bypass this result.</div>`);
}
function showOrder(order){
  if(!order)return; state.order=order; const amount=order.amount??state.quote?.amount??0;
  appendCard(`order:${order.id}`,`<div class="card-head"><div class="card-title"><span class="card-icon">✓</span>Payment ready</div><span class="status-pill">GUARD PASSED</span></div><div class="amount-hero">${money(amount)}</div><p class="card-copy">The deterministic guard passed. Razorpay received an amount derived from the verified signed quote.</p><div class="proof-list"><div><i>✓</i> Cart matches committed state</div><div><i>✓</i> Approval matches quote</div><div><i>✓</i> Merchant signature valid</div><div><i>✓</i> Amount derived from signed quote</div></div><div class="proof-meta"><span>Razorpay order</span><code>${escapeHtml(shortId(order.id))}</code><span>Amount source</span><code>Signed quote</code></div><button class="card-action" data-action="checkout" type="button">Pay ${money(amount)} with Razorpay Test</button>`);
}
function renderPaymentSuccess(paymentId){
  if(state.order)resolveCard(`order:${state.order.id}`); appendCard(`success:${paymentId||state.order?.id||Date.now()}`,`<div class="card-head"><div class="card-title"><span class="card-icon">✓</span>Payment successful</div><span class="status-pill">VERIFIED</span></div><div class="amount-hero">${money(state.order?.amount??state.quote?.amount??0)}</div><p class="card-copy">Razorpay payment verification succeeded.</p><div class="proof-meta"><span>Payment</span><code>${escapeHtml(shortId(paymentId))}</code><span>Order</span><code>${escapeHtml(shortId(state.order?.id))}</code></div><div class="success-box">✓ The exact approved amount was charged.<br><b>SEEN = COMMITTED = APPROVED = CHARGED</b></div>`); }
function renderPaymentFailure(reason,retry=true){ appendCard(`failure:${Date.now()}`,`<div class="card-head"><div class="card-title"><span class="card-icon">×</span>Payment failed</div><span class="status-pill red">PAYMENT RAIL</span></div><p class="card-copy">Razorpay could not complete the test payment. Quote integrity remains separate from this failure.</p><div class="error-box">${escapeHtml(reason||'PAYMENT_FAILED')}</div>${retry?'<button class="card-action red" data-action="checkout" type="button">Try again</button>':''}`); }

async function renderTask(task){
  state.task=task; renderSessionMeta(); await refreshCart();
  if(task?.phase==='AWAITING_APPROVAL'&&task.activeQuoteId){ state.quote=await json(`/api/quotes/${encodeURIComponent(task.activeQuoteId)}`); renderQuoteCard(); }
  if(task?.phase==='APPROVED'&&task.activeGrantId)renderApprovalCard();
}
function processGuardResults(events=[]){ for(const e of events){ if(e.type!=='tool_result')continue; const result=e.result||{}; renderGuardIssue(result); if((e.tool==='execute_payment'||findNested(result,'order'))&&(result.status==='ORDER_CREATED'||result.order?.id)) showOrder(result.order||findNested(result,'order')); if(result.status==='PAYMENT_FAILED')renderPaymentFailure(extractCode(result)||'PAYMENT_FAILED',result.retry_allowed!==false); } }

async function runAgent(message,continuing=false){
  $('sendButton').disabled=true; $('homeSend').disabled=true; showWorking();
  try{
    const result=continuing ? await json(`/api/sessions/${encodeURIComponent(state.sessionId)}/continue`,{method:'POST',body:'{}'}) : await json('/api/agent/run',{method:'POST',body:JSON.stringify({message,session_id:state.sessionId})});
    rememberSession(result.session_id); removeWorking(); renderRawEvents(result.events||[]); renderInlineActivity(result.events||[]); if(result.message)addMessage('assistant',result.message); processGuardResults(result.events||[]); await renderTask(result.state); await refreshAudit();
  }catch(e){ removeWorking(); addMessage('assistant',`Error: ${e.message}`); if(e.body){renderRawEvents([{type:'tool_result',tool:'host',result:e.body}]); renderGuardIssue(e.body);} }
  finally{$('sendButton').disabled=false;$('homeSend').disabled=false;}
}
async function submitPrompt(message){ if(!message)return; enterChat(); addMessage('user',message); $('homeInput').value=''; $('chatInput').value=''; await runAgent(message,false); }

$('homeForm').addEventListener('submit',e=>{e.preventDefault();submitPrompt($('homeInput').value.trim())});
$('chatForm').addEventListener('submit',e=>{e.preventDefault();const m=$('chatInput').value.trim();if(!m)return;addMessage('user',m);$('chatInput').value='';runAgent(m,false)});
for(const id of ['homeInput','chatInput']) $(id).addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.target.form?.requestSubmit();}});
$('homeInput').addEventListener('input',()=>{$('animatedPlaceholder').hidden=Boolean($('homeInput').value)});
document.querySelectorAll('.suggestions button').forEach(b=>b.addEventListener('click',()=>{$('homeInput').value=b.dataset.prompt||'';$('animatedPlaceholder').hidden=true;$('homeInput').focus();}));

$('messages').addEventListener('click',async e=>{
  const action=e.target.closest('[data-action]')?.dataset.action; if(!action)return;
  if(action==='approve'){
    if(!state.quote||!state.sessionId)return; e.target.disabled=true;
    try{const approved=await json(`/api/quotes/${encodeURIComponent(state.quote.quoteId)}/approve`,{method:'POST',body:JSON.stringify({session_id:state.sessionId})}); state.task=approved.state; resolveCard(`quote:${state.quote.quoteId}`); renderSessionMeta(); renderApprovalCard(); toast('Exact amount approved.'); await refreshAudit();}catch(err){toast(err.message);e.target.disabled=false;}
  }
  if(action==='continue'){
    if(!state.sessionId||!state.task?.activeGrantId)return toast('No approved grant is ready.'); resolveCard(`grant:${state.task.activeGrantId}`); await runAgent('',true);
  }
  if(action==='checkout') await openCheckout();
});

async function openCheckout(){
  if(!state.order||!state.razorpayKey)return toast('Razorpay Test credentials are not configured.'); if(!window.Razorpay)return toast('Razorpay Checkout did not load.');
  await json('/api/payments/opened',{method:'POST',body:JSON.stringify({order_id:state.order.id})});
  const checkout=new Razorpay({key:state.razorpayKey,order_id:state.order.id,amount:state.order.amount,currency:state.order.currency,name:'Agent Execute',description:'Verified agent checkout — Test Mode',handler:async result=>{try{const verified=await json('/api/payments/verify',{method:'POST',body:JSON.stringify(result)}); if(state.task)state.task.phase='PAYMENT_COMPLETE';renderSessionMeta();renderPaymentSuccess(verified.payment_id);await refreshAudit();}catch(err){renderPaymentFailure(err.message,false);}},modal:{ondismiss:()=>toast('Checkout closed. Your approval is unchanged.')}});
  checkout.on('payment.failed',async response=>{const failure=await json('/api/payments/failure',{method:'POST',body:JSON.stringify({order_id:state.order.id,error:response.error})}).catch(()=>null);renderPaymentFailure(response.error?.description||response.error?.reason||'PAYMENT_FAILED',failure?.retry_allowed!==false);await refreshAudit();}); checkout.open();
}

function openJudge(){ $('drawerBackdrop').hidden=false; $('judgeDrawer').classList.add('open'); $('judgeDrawer').setAttribute('aria-hidden','false'); }
function closeJudge(){ $('drawerBackdrop').hidden=true; $('judgeDrawer').classList.remove('open'); $('judgeDrawer').setAttribute('aria-hidden','true'); }
$('judgeButton').addEventListener('click',openJudge); $('closeJudge').addEventListener('click',closeJudge); $('drawerBackdrop').addEventListener('click',closeJudge);
document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.tab-content').forEach(x=>x.classList.remove('active'));btn.classList.add('active');$(btn.dataset.tab).classList.add('active');if(btn.dataset.tab==='merchant')loadMerchant();if(btn.dataset.tab==='audit')refreshAudit();}));

async function refreshAudit(){ try{const audit=await json('/api/audit?limit=200');$('auditEvents').innerHTML='';for(const e of audit){const row=document.createElement('div');row.className='event';row.innerHTML='<span class="kind"></span><span></span><pre></pre>';row.children[0].textContent=e.type;row.children[1].textContent=new Date(e.at).toLocaleTimeString();row.children[2].textContent=JSON.stringify(e.data,null,2);$('auditEvents').appendChild(row);}}catch{} }
async function loadMerchant(){
  try{const data=await json(`${adminBase}/state`);$('discountInput').value=(data.merchant.discount/100).toFixed(2);$('deliveryInput').value=(data.merchant.delivery/100).toFixed(2);$('products').innerHTML=data.products.map(p=>`<div class="product" data-id="${escapeHtml(p.id)}"><div class="product-head"><div><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.id)} · ${escapeHtml(p.category)}</small></div><span class="availability-pill ${p.active?'':'off'}">${p.active?'AVAILABLE':'OFFLINE'}</span></div><div class="controls"><input class="price" type="number" min="0" step="1" value="${(p.price/100).toFixed(2)}"><button class="price-btn" type="button">Price</button><input class="inventory" type="number" min="0" step="1" value="${p.inventory}"><button class="stock-btn" type="button">Stock</button><button class="active-btn" type="button" data-active="${p.active}">${p.active?'Mark unavailable':'Restore availability'}</button></div></div>`).join('');}catch(e){toast(`Merchant admin: ${e.message}`);} }
$('products').addEventListener('click',async e=>{const card=e.target.closest('.product');if(!card)return;try{if(e.target.classList.contains('price-btn'))await json(`${adminBase}/products/${card.dataset.id}/price`,{method:'PATCH',body:JSON.stringify({price:Math.round(Number(card.querySelector('.price').value)*100)})});if(e.target.classList.contains('stock-btn'))await json(`${adminBase}/products/${card.dataset.id}/inventory`,{method:'PATCH',body:JSON.stringify({inventory:Number(card.querySelector('.inventory').value)})});if(e.target.classList.contains('active-btn'))await json(`${adminBase}/products/${card.dataset.id}/active`,{method:'PATCH',body:JSON.stringify({active:e.target.dataset.active!=='true'})});toast('Merchant state changed. The agent received no recovery instruction.');await loadMerchant();await refreshCart();await refreshAudit();}catch(err){toast(err.message)}});
$('.merchant-settings').addEventListener('click',async e=>{const setting=e.target.dataset.setting;if(!setting)return;const input=setting==='discount'?$('discountInput'):$('deliveryInput');try{await json(`${adminBase}/merchant/${setting}`,{method:'PATCH',body:JSON.stringify({[setting]:Math.round(Number(input.value)*100)})});toast('Merchant financial state changed.');await refreshCart();await refreshAudit();}catch(err){toast(err.message)}});

function resetUi(){ state.task=null;state.quote=null;state.order=null;state.cart=null;$('messages').innerHTML='';$('events').innerHTML='<div class="drawer-empty">Run a request to inspect tool calls.</div>';$('auditEvents').innerHTML='';renderSessionMeta(); }
function newChat(){ rememberSession(null);resetUi();closeJudge();enterHome();$('homeInput').value='';$('animatedPlaceholder').hidden=false; }
$('newSession').addEventListener('click',newChat);$('brandHome').addEventListener('click',newChat);
$('resetMerchant').addEventListener('click',async()=>{try{await json(`${adminBase}/reset`,{method:'POST',body:'{}'});rememberSession(null);resetUi();closeJudge();enterHome();toast('Merchant and local test state reset.');}catch(e){toast(e.message)}});$('refreshAudit').addEventListener('click',refreshAudit);

const placeholders=['Buy milk, eggs and cereal under ₹500','Get breakfast essentials for less than ₹450','Find the cheapest rice and butter','Buy coffee and biscuits under ₹350'];let ph=0;setInterval(()=>{if($('homeInput').value)return;const el=$('animatedPlaceholder');el.classList.add('swap');setTimeout(()=>{ph=(ph+1)%placeholders.length;el.textContent=placeholders[ph];el.classList.remove('swap')},220)},3000);

async function restoreSession(){const saved=localStorage.getItem(SESSION_KEY);if(!saved)return;try{const snapshot=await json(`/api/sessions/${encodeURIComponent(saved)}`);rememberSession(saved);enterChat();addMessage('assistant',`Restored your previous checkout session. Current phase: ${snapshot.state.phase}.`);await renderTask(snapshot.state);if(snapshot.execution?.state==='ORDER_CREATED'&&snapshot.execution.result?.order)showOrder(snapshot.execution.result.order);if(snapshot.payment?.state==='PAYMENT_SUCCESS'){if(state.task)state.task.phase='PAYMENT_COMPLETE';renderSessionMeta();renderPaymentSuccess(snapshot.payment.payment_id||snapshot.payment.paymentId||'verified');}}catch{rememberSession(null);resetUi();enterHome();}}

(async function boot(){
  try{const h=await json('/health');$('healthDot').classList.add('ok');const missing=[h.llm_configured?null:'LLM',h.razorpay_test_configured?null:'Razorpay Test'].filter(Boolean);$('healthText').textContent=missing.length?`Online · configure ${missing.join(' + ')}`:'Agent + payment ready';}catch{$('healthText').textContent='Agent service offline';}
  try{const cfg=await json('/api/config/public');state.razorpayKey=cfg.razorpay_key_id;}catch{}
  await restoreSession();await refreshAudit();
})();