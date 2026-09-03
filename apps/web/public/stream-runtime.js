const baseFetch = window.fetch.bind(window);

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

let pendingRows = [];
let liveAssistant = null;

if (window.marked?.setOptions) {
  window.marked.setOptions({
    gfm: true,
    breaks: true,
  });
}

function isAgentRequest(input, init = {}) {
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST') return false;
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (!raw) return false;
  const path = new URL(raw, window.location.href).pathname;
  return path === '/api/agent/run' || /^\/api\/sessions\/[^/]+\/continue$/.test(path);
}

function scrollChat(behavior = 'smooth') {
  requestAnimationFrame(() => window.scrollTo({
    top: document.documentElement.scrollHeight,
    behavior,
  }));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function renderMarkdown(value) {
  const source = String(value || '');
  if (!window.marked?.parse || !window.DOMPurify?.sanitize) {
    return `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
  }

  const dirty = window.marked.parse(source, {
    gfm: true,
    breaks: true,
  });

  return window.DOMPurify.sanitize(dirty, {
    USE_PROFILES: { html: true },
    ALLOW_DATA_ATTR: false,
  });
}

function hardenRenderedLinks(root) {
  root?.querySelectorAll?.('a[href]').forEach((anchor) => {
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  });
}

function workingBody() {
  const rows = document.querySelectorAll('.working-message .message-body');
  return rows.length ? rows[rows.length - 1] : null;
}

function ensureStreamGroup() {
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

function ensureAssistantMessage() {
  if (liveAssistant?.row?.isConnected) return liveAssistant;
  const root = document.getElementById('messages');
  if (!root) return null;

  const row = document.createElement('div');
  row.className = 'message assistant streamed-message streaming';
  row.innerHTML = '<div class="message-body"><div class="message-label">Agent Execute</div><div class="message-rich"></div><span class="stream-caret" aria-hidden="true"></span></div>';
  root.appendChild(row);
  liveAssistant = {
    row,
    rich: row.querySelector('.message-rich'),
    buffer: '',
  };
  scrollChat();
  return liveAssistant;
}

function updateAssistantMessage(text) {
  const message = ensureAssistantMessage();
  if (!message) return;
  message.buffer = text;
  message.rich.innerHTML = renderMarkdown(text);
  hardenRenderedLinks(message.rich);
  scrollChat('auto');
}

function appendAssistantDelta(delta) {
  if (typeof delta !== 'string' || !delta) return;
  const message = ensureAssistantMessage();
  if (!message) return;
  message.buffer += delta;
  message.rich.innerHTML = renderMarkdown(message.buffer);
  hardenRenderedLinks(message.rich);
  scrollChat('auto');
}

function discardIntermediateAssistant() {
  if (!liveAssistant?.row?.isConnected) {
    liveAssistant = null;
    return;
  }
  // Tool-calling turns should not remain as chat messages. If a provider emits
  // prose before a tool call anyway, keep it transient and replace it with the
  // eventual final assistant response.
  liveAssistant.row.remove();
  liveAssistant = null;
}

function finalizeAssistant(text) {
  if (!text) {
    discardIntermediateAssistant();
    return;
  }
  updateAssistantMessage(text);
  if (!liveAssistant) return;
  liveAssistant.row.classList.remove('streaming');
  liveAssistant.row.querySelector('.stream-caret')?.remove();
  liveAssistant = null;
  scrollChat();
}

function trimRows(group) {
  while (group.children.length > 6) group.firstElementChild?.remove();
  pendingRows = pendingRows.filter((entry) => entry.row.isConnected);
}

function toolFailed(result) {
  return Boolean(
    result?.isError ||
    result?.error ||
    result?.status === 'BLOCKED' ||
    result?.status === 'PAYMENT_FAILED'
  );
}

function streamToolEvent(event) {
  const group = ensureStreamGroup();
  if (!group) return;

  if (event.type === 'tool_call') {
    discardIntermediateAssistant();
    const row = document.createElement('div');
    row.className = 'stream-activity-row pending';
    row.dataset.tool = event.tool || '';
    row.innerHTML = '<span class="stream-icon">↳</span><span class="stream-label"></span><span class="stream-status">live</span>';
    row.querySelector('.stream-label').textContent = activeLabels[event.tool] || event.tool || 'Using merchant tool';
    group.appendChild(row);
    pendingRows.push({ tool: event.tool, row });
    trimRows(group);
  } else {
    const index = pendingRows.findIndex((entry) => entry.tool === event.tool && entry.row.classList.contains('pending'));
    const entry = index >= 0 ? pendingRows[index] : null;
    const failed = toolFailed(event.result);
    const row = entry?.row || document.createElement('div');
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
    trimRows(group);
  }

  scrollChat();
}

function streamEvent(event) {
  if (!event) return;
  if (event.type === 'model_delta') {
    appendAssistantDelta(event.text || '');
    return;
  }
  if (event.type === 'tool_call' || event.type === 'tool_result') {
    streamToolEvent(event);
  }
}

function clearTransientActivity() {
  pendingRows = [];
  document.querySelectorAll('.stream-activity, .activity-group, .working-message').forEach((element) => element.remove());
}

function removeLegacyActivity(node) {
  if (!(node instanceof Element)) return;
  if (node.matches('.activity-group')) node.remove();
  node.querySelectorAll?.('.activity-group').forEach((element) => element.remove());
}

// app.js still contains the old post-hoc renderInlineActivity() path. Block
// those completed groups at the chat root, while leaving Judge Mode's raw
// event renderer untouched.
const messagesRoot = document.getElementById('messages');
if (messagesRoot) {
  const nativeAppendChild = messagesRoot.appendChild.bind(messagesRoot);
  messagesRoot.appendChild = function appendChatNode(node) {
    if (node instanceof Element && node.matches('.activity-group')) return node;
    return nativeAppendChild(node);
  };
}

const activityObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) removeLegacyActivity(node);
  }
});
activityObserver.observe(document.documentElement, { childList: true, subtree: true });

function parseRecord(line) {
  if (!line.trim()) return null;
  try { return JSON.parse(line); } catch { return null; }
}

async function consumeNdjson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  let error = null;

  const consumeLine = (line) => {
    const record = parseRecord(line);
    if (!record) return;
    if (record.type === 'event') streamEvent(record.event);
    else if (record.type === 'result') result = record.result;
    else if (record.type === 'error') error = record.error || { error: 'agent_error', message: 'Agent stream failed' };
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  if (buffer.trim()) consumeLine(buffer);

  if (error) {
    discardIntermediateAssistant();
    clearTransientActivity();
    return new Response(JSON.stringify(error), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  finalizeAssistant(result?.message || liveAssistant?.buffer || '');
  clearTransientActivity();

  // The streamed bubble is now the canonical user-facing assistant message.
  // Return an empty message so app.js does not append a duplicate plaintext
  // bubble. Keep the complete event list for Judge Mode and guard rendering.
  const bridgedResult = { ...(result || {}), message: '' };
  return new Response(JSON.stringify(bridgedResult), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

window.fetch = async function streamingAgentFetch(input, init = {}) {
  if (!isAgentRequest(input, init)) return baseFetch(input, init);

  pendingRows = [];
  discardIntermediateAssistant();
  clearTransientActivity();

  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  headers.set('accept', 'application/x-ndjson');
  const response = await baseFetch(input, { ...init, headers });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !response.body || !contentType.includes('application/x-ndjson')) return response;
  return consumeNdjson(response);
};
