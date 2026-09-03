const streamedFetch = window.fetch.bind(window);

function isAgentRequest(input, init = {}) {
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST') return false;
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (!raw) return false;
  const path = new URL(raw, window.location.href).pathname;
  return path === '/api/agent/run' || /^\/api\/sessions\/[^/]+\/continue$/.test(path);
}

function ensureWorkingContainer() {
  const messages = document.getElementById('messages');
  if (!messages || messages.querySelector('.working-message')) return;

  const row = document.createElement('div');
  row.className = 'message assistant working-message stream-recovered-working';
  row.innerHTML = '<div class="message-body"><div class="message-label">Agent Execute</div><p>Working<span class="working-dots">…</span></p></div>';
  messages.appendChild(row);
  requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));
}

window.fetch = async function keepWorkingWhileStreaming(input, init = {}) {
  if (!isAgentRequest(input, init)) return streamedFetch(input, init);

  // stream-runtime starts by clearing transient rows. Re-create the active
  // working container on the next microtask so incoming tool events have a
  // stable DOM target for the full lifetime of the streamed request.
  const responsePromise = streamedFetch(input, init);
  queueMicrotask(ensureWorkingContainer);

  try {
    return await responsePromise;
  } finally {
    document.querySelectorAll('.stream-recovered-working').forEach((element) => element.remove());
  }
};
