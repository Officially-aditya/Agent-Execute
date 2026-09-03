const networkFetch = window.fetch.bind(window);

const activeLabels = {
  create_cart: 'Creating merchant cart',
  search_products: 'Searching merchant products',
  get_product: 'Reading product details',
  view_cart: 'Reading authoritative cart',
  add_to_cart: 'Adding item to cart',
  remove_from_cart: 'Removing item from cart',
  update_quantity: 'Updating cart quantity',
  commit_quote: 'Committing exact cart state',
  execute_payment: 'Verifying payment execution',
  get_payment_status: 'Checking payment status',
};

const doneLabels = {
  create_cart: 'Created merchant cart',
  search_products: 'Searched merchant products',
  get_product: 'Read product details',
  view_cart: 'Read authoritative cart',
  add_to_cart: 'Added item to cart',
  remove_from_cart: 'Removed item from cart',
  update_quantity: 'Updated cart quantity',
  commit_quote: 'Committed exact cart state',
  execute_payment: 'Verified payment execution',
  get_payment_status: 'Checked payment status',
};

let liveAssistant = null;
const pendingTools = [];

if (window.marked?.setOptions) window.marked.setOptions({ gfm: true, breaks: true });

function requestInfo(input, init = {}) {
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (!raw) return null;
  const path = new URL(raw, window.location.href).pathname;
  if (method !== 'POST') return null;
  if (path === '/api/agent/run') return { path, directUrl: `/api/agent-stream?__path=${encodeURIComponent(path)}` };
  if (/^\/api\/sessions\/[^/]+\/continue$/.test(path)) return { path, directUrl: `/api/agent-stream?__path=${encodeURIComponent(path)}` };
  return null;
}

function scrollChat(behavior = 'auto') {
  requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior }));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function renderMarkdown(source) {
  const text = String(source || '');
  if (!window.marked?.parse || !window.DOMPurify?.sanitize) return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  return window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true, breaks: true }), {
    USE_PROFILES: { html: true },
    ALLOW_DATA_ATTR: false,
  });
}

function hardenLinks(root) {
  root?.querySelectorAll?.('a[href]').forEach((anchor) => {
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  });
}

function messagesRoot() { return document.getElementById('messages'); }
function workingMessage() {
  const rows = document.querySelectorAll('.working-message');
  return rows.length ? rows[rows.length - 1] : null;
}
function workingBody() { return workingMessage()?.querySelector('.message-body') || null; }

function setWorkingStatus(text) {
  const body = workingBody();
  if (!body) return;
  let status = body.querySelector('.stream-phase');
  if (!status) {
    status = document.createElement('p');
    status.className = 'stream-phase';
    body.appendChild(status);
  }
  status.textContent = text;
  scrollChat();
}

function ensureActivityGroup() {
  const body = workingBody();
  if (!body) return null;
  let group = body.querySelector('.stream-activity');
  if (!group) {
    group = document.createElement('div');
    group.className = 'stream-activity';
    group.setAttribute('aria-live', 'polite');
    body.appendChild(group);
  }
  return group;
}

function clearToolActivity() {
  pendingTools.length = 0;
  document.querySelectorAll('.stream-activity, .stream-phase').forEach((node) => node.remove());
}

function removeWorkingMessage() {
  document.querySelectorAll('.working-message').forEach((node) => node.remove());
  clearToolActivity();
}

function ensureAssistantMessage() {
  if (liveAssistant?.row?.isConnected) return liveAssistant;
  const root = messagesRoot();
  if (!root) return null;
  const row = document.createElement('div');
  row.className = 'message assistant streamed-message streaming';
  row.innerHTML = '<div class="message-body"><div class="message-label">Agent Execute</div><div class="message-rich"></div><span class="stream-caret" aria-hidden="true"></span></div>';
  root.appendChild(row);
  liveAssistant = { row, rich: row.querySelector('.message-rich'), buffer: '' };
  scrollChat();
  return liveAssistant;
}

function renderAssistantBuffer() {
  if (!liveAssistant?.rich) return;
  liveAssistant.rich.innerHTML = renderMarkdown(liveAssistant.buffer);
  hardenLinks(liveAssistant.rich);
  scrollChat();
}

function appendAssistantDelta(delta) {
  if (typeof delta !== 'string' || !delta) return;
  const message = ensureAssistantMessage();
  if (!message) return;
  message.buffer += delta;
  renderAssistantBuffer();
}

function discardIntermediateAssistant() {
  if (liveAssistant?.row?.isConnected) liveAssistant.row.remove();
  liveAssistant = null;
}

function finalizeAssistant(finalText) {
  const text = String(finalText || '');
  const current = liveAssistant?.buffer || '';
  if (!text && !current) throw new Error('Agent completed without any assistant text.');
  const message = ensureAssistantMessage();
  if (!message) return;
  if (text && text !== message.buffer) {
    message.buffer = text;
    renderAssistantBuffer();
  }
  message.row.classList.remove('streaming');
  message.row.querySelector('.stream-caret')?.remove();
  liveAssistant = null;
  scrollChat('smooth');
}

function toolFailed(result) {
  return Boolean(result?.isError || result?.error || result?.status === 'BLOCKED' || result?.status === 'PAYMENT_FAILED');
}

function renderToolEvent(event) {
  const group = ensureActivityGroup();
  if (!group) return;
  if (event.type === 'tool_call') {
    discardIntermediateAssistant();
    const row = document.createElement('div');
    row.className = 'stream-activity-row pending';
    row.innerHTML = '<span class="stream-icon">↳</span><span class="stream-label"></span><span class="stream-status">live</span>';
    row.querySelector('.stream-label').textContent = activeLabels[event.tool] || event.tool || 'Using merchant tool';
    group.appendChild(row);
    pendingTools.push({ tool: event.tool, row });
  } else if (event.type === 'tool_result') {
    const entry = pendingTools.find((item) => item.tool === event.tool && item.row.isConnected && item.row.classList.contains('pending'));
    const row = entry?.row || document.createElement('div');
    const failed = toolFailed(event.result);
    if (!entry) {
      row.innerHTML = '<span class="stream-icon"></span><span class="stream-label"></span><span class="stream-status"></span>';
      group.appendChild(row);
    }
    row.className = `stream-activity-row ${failed ? 'failed' : 'complete'}`;
    row.querySelector('.stream-icon').textContent = failed ? '!' : '✓';
    row.querySelector('.stream-label').textContent = failed
      ? `${doneLabels[event.tool] || event.tool || 'Merchant tool'} returned an issue`
      : doneLabels[event.tool] || event.tool || 'Merchant tool completed';
    row.querySelector('.stream-status').textContent = failed ? 'check' : 'done';
  }
  while (group.children.length > 6) group.firstElementChild?.remove();
  scrollChat();
}

function handleAgentEvent(event) {
  if (!event) return;
  if (event.type === 'model_delta') return appendAssistantDelta(event.text || '');
  if (event.type === 'tool_call' || event.type === 'tool_result') renderToolEvent(event);
}

function parseRecord(line) {
  if (!line.trim()) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

async function consumeAgentStream(response) {
  const reader = response.body?.getReader();
  if (!reader) return jsonResponse({ error: 'stream_body_missing', message: 'The streaming response had no readable body.' }, 502);

  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  let streamError = null;
  let sawReady = false;
  let sawAnyEvent = false;

  const consumeLine = (line) => {
    const record = parseRecord(line);
    if (!record) return;
    if (record.type === 'ready') {
      sawReady = true;
      const phase = record.phase;
      setWorkingStatus(phase === 'runtime_starting' ? 'Connecting to agent…' : phase === 'runtime_ready' ? 'Agent runtime ready…' : 'Starting merchant tools…');
      return;
    }
    if (record.type === 'event') {
      sawAnyEvent = true;
      handleAgentEvent(record.event);
      return;
    }
    if (record.type === 'result') {
      result = record.result;
      return;
    }
    if (record.type === 'error') streamError = record.error || { error: 'agent_error', message: 'Agent stream failed' };
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
    if (buffer.trim()) consumeLine(buffer);
  } catch (error) {
    streamError = { error: 'stream_read_failed', message: error instanceof Error ? error.message : String(error) };
  }

  if (streamError) {
    discardIntermediateAssistant();
    removeWorkingMessage();
    return jsonResponse(streamError, 500);
  }
  if (!result) {
    discardIntermediateAssistant();
    removeWorkingMessage();
    return jsonResponse({
      error: 'stream_incomplete',
      message: sawReady
        ? `The agent stream opened${sawAnyEvent ? ' and produced activity' : ''} but ended before a final result.`
        : 'The stream endpoint returned without acknowledging the request.',
    }, 502);
  }

  try {
    finalizeAssistant(result.message || liveAssistant?.buffer || '');
  } catch (error) {
    removeWorkingMessage();
    return jsonResponse({ error: 'empty_agent_response', message: error.message || String(error) }, 502);
  }
  removeWorkingMessage();
  return jsonResponse({ ...result, message: '' }, 200);
}

window.fetch = async function agentStreamingFetch(input, init = {}) {
  const info = requestInfo(input, init);
  if (!info) return networkFetch(input, init);

  pendingTools.length = 0;
  discardIntermediateAssistant();
  clearToolActivity();
  setWorkingStatus('Opening live stream…');

  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  headers.set('accept', 'application/x-ndjson');
  headers.set('content-type', headers.get('content-type') || 'application/json');

  let response;
  try {
    // Call the streaming function directly. This deliberately avoids relying
    // on a rewrite for the live transport; rewrites remain only for external
    // compatibility with the original API routes.
    response = await networkFetch(info.directUrl, { ...init, method: 'POST', headers });
  } catch (error) {
    return jsonResponse({ error: 'stream_request_failed', message: error instanceof Error ? error.message : String(error) }, 502);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) return response;
  if (!response.body || !contentType.includes('application/x-ndjson')) {
    const text = await response.clone().text().catch(() => '');
    return jsonResponse({
      error: 'stream_protocol_error',
      message: `Expected application/x-ndjson from the agent stream but received ${contentType || 'an unknown content type'}${text ? `: ${text.slice(0, 300)}` : ''}`,
    }, 502);
  }

  return consumeAgentStream(response);
};

const root = messagesRoot();
if (root) {
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('.activity-group')) node.remove();
        node.querySelectorAll?.('.activity-group').forEach((child) => child.remove());
      }
    }
  }).observe(root, { childList: true, subtree: true });
}
