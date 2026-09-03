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

function isAgentRequest(input, init = {}) {
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST') return false;
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (!raw) return false;
  const path = new URL(raw, window.location.href).pathname;
  return path === '/api/agent/run' || /^\/api\/sessions\/[^/]+\/continue$/.test(path);
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

function streamEvent(event) {
  if (!event || (event.type !== 'tool_call' && event.type !== 'tool_result')) return;
  const group = ensureStreamGroup();
  if (!group) return;

  if (event.type === 'tool_call') {
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

  requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));
}

function removeLegacyActivity(node) {
  if (!(node instanceof Element)) return;
  if (node.matches('.activity-group')) node.remove();
  node.querySelectorAll?.('.activity-group').forEach((element) => element.remove());
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

  pendingRows = [];
  if (error) {
    return new Response(JSON.stringify(error), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(result || {}), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

window.fetch = async function streamingAgentFetch(input, init = {}) {
  if (!isAgentRequest(input, init)) return baseFetch(input, init);

  pendingRows = [];
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  headers.set('accept', 'application/x-ndjson');
  const response = await baseFetch(input, { ...init, headers });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !response.body || !contentType.includes('application/x-ndjson')) return response;
  return consumeNdjson(response);
};
