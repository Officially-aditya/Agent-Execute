const overrideStyles = document.createElement('link');
overrideStyles.rel = 'stylesheet';
overrideStyles.href = '/ui-overrides.css';
document.head.appendChild(overrideStyles);

const nativeFetch = window.fetch.bind(window);

async function observableFetch(input, init) {
  let target = input;
  if (typeof target === 'string' && target.startsWith('http://localhost:3002')) {
    const suffix = target.slice('http://localhost:3002'.length);
    target = `/api/admin${suffix}`;
  }

  const response = await nativeFetch(target, init);
  if (response.ok) return response;

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response;

  const text = await response.clone().text().catch(() => '');
  const message = text.trim().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500)
    || `HTTP ${response.status}`;

  return new Response(JSON.stringify({
    error: `HTTP_${response.status}`,
    message,
  }), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

window.fetch = observableFetch;
