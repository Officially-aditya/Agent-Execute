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

if (window.marked?.setOptions) {
  window.marked.setOptions({ gfm: true, breaks: true });
}

function isAgentRequest(input, init = {}) {
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST') return false;
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (!raw) return false;
  const path = new URL(raw, window.location.href).pathname;
  return path === '/api/agent/run' || /^\/api\/sessions\/[^/]+\/continue$/.test(path);
}

function scrollChat(behavior = 'auto') {
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

function renderMarkdown(source) {
  const text = String(source || '');
  if (!window.marked?.parse || !window.DOMPurify?.sanitize) {
    return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  }

  const parsed = window.marked.parse(text, { gfm: true, breaks: true });
  return window.DOMPurify.sanitize(parsed, {
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

function messagesRoot() {
  return document.getElementById('messages');
}

function workingMessage() {
  const rows = document.querySelectorAll('.working-message');
  return rows.length ? rows[rows.length - 1] : null;
}

function workingBody() {
  return workingMessage()?.querySelector('.message-body') || null;
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
  document.querySelectorAll('.stream-activity').forEach((node) => node.remove());
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

  liveAssistant = {
    row,
    rich: row.querySelector('.message-rich'),
    buffer: '',
  };
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
  if (!text && !liveAssistant?.buffer) {
    discardIntermediateAssistant();
    return;
  }

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
  return Boolean(
    result?.isError ||
    result?.error ||
    result?.status === 'BLOCKED' ||
    result?.status === 'PAYMENT_FAILED'
  );
}

function renderToolEvent(event) {
  const group = ensureActivityGroup();
  if (!group) return;

  if (event.type === 'tool_call') {
    // Prose emitted before a tool call belongs to an intermediate model turn,
    // not to the final user-facing answer.
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
  if (event.type === 'model_delta') {
    appendAssistantDelta(event.text || '');
    return;
  }
  if (event.type === 'tool_call' || event.type === 'tool_result') {
    renderToolEvent(event);
  }
}

function parseRecord(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function consumeAgentStream(response) {
  const reader = response.body?.getReader();
  if (!reader) return response;

  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  let streamError = null;
  let sawReady = false;

  const consumeLine = (line) => {
    const record = parseRecord(line);
    if (!record) return;

    if (record.type === 'ready') {
      sawReady = true;
      return;
    }
    if (record.type === 'event') {
      handleAgentEvent(record.event);
      return;
    }
    if (record.type === 'result') {
      result = record.result;
      return;
    }
    if (record.type === 'error') {
      streamError = record.error || { error: 'agent_error', message: 'Agent stream failed' };
    }
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
    streamError = {
      error: 'stream_read_failed',
      message: error instanceof Error ? error.message : String(error),
    };
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
        ? 'The agent stream opened but ended before a final result was received.'
        : 'The agent stream ended before the server acknowledged it.',
    }, 502);
  }

  finalizeAssistant(result.message || liveAssistant?.buffer || '');
  removeWorkingMessage();

  // app.js still owns state cards, Judge Mode, payment controls, and session
  // persistence. Give it the authoritative result without a second assistant
  // message; the streamed bubble above is the canonical user-facing response.
  return jsonResponse({ ...result, message: '' }, 200);
}

window.fetch = async function agentStreamingFetch(input, init = {}) {
  if (!isAgentRequest(input, init)) return networkFetch(input, init);

  pendingTools.length = 0;
  discardIntermediateAssistant();
  clearToolActivity();

  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  headers.set('accept', 'application/x-ndjson');

  let response;
  try {
    response = await networkFetch(input, { ...init, headers });
  } catch (error) {
    return jsonResponse({
      error: 'stream_request_failed',
      message: error instanceof Error ? error.message : String(error),
    }, 502);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !response.body || !contentType.includes('application/x-ndjson')) {
    return response;
  }

  return consumeAgentStream(response);
};

// app.js still appends its historical post-run activity group. It is useful in
// Judge Mode but should never remain in the conversation timeline.
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
