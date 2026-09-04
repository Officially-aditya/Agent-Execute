const overrideStyles = document.createElement('link');
overrideStyles.rel = 'stylesheet';
overrideStyles.href = '/ui-overrides.css';
document.head.appendChild(overrideStyles);

const nativeFetch = window.fetch.bind(window);

function agentRoute(input, init = {}) {
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST') return false;
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (!raw) return false;
  const path = new URL(raw, window.location.href).pathname;
  return path === '/api/agent/run' || /^\/api\/sessions\/[^/]+\/continue$/.test(path);
}

function jsonError(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function observableFetch(input, init = {}) {
  let target = input;
  if (typeof target === 'string' && target.startsWith('http://localhost:3002')) {
    const suffix = target.slice('http://localhost:3002'.length);
    target = `/api/admin${suffix}`;
  }

  // Agent streaming is an explicit browser transport, not a fetch monkey-patch
  // layered on top of this wrapper. app.js keeps calling fetch normally; this
  // single runtime boundary delegates the two agent POST routes to chat-stream.
  if (agentRoute(target, init)) {
    if (typeof window.agentStreamFetch !== 'function') {
      return jsonError({
        error: 'stream_client_unavailable',
        message: 'The live agent stream client did not initialize. Reload the page and try again.',
      }, 503);
    }
    return window.agentStreamFetch(target, init);
  }

  const response = await nativeFetch(target, init);
  if (response.ok) return response;

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response;

  const text = await response.clone().text().catch(() => '');
  const message = text.trim().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500)
    || `HTTP ${response.status}`;

  return jsonError({
    error: `HTTP_${response.status}`,
    message,
  }, response.status);
}

window.fetch = observableFetch;
