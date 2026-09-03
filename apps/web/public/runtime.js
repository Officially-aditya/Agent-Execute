const overrideStyles = document.createElement('link');
overrideStyles.rel = 'stylesheet';
overrideStyles.href = '/ui-overrides.css';
document.head.appendChild(overrideStyles);

const nativeFetch = window.fetch.bind(window);

window.fetch = (input, init) => {
  if (typeof input === 'string' && input.startsWith('http://localhost:3002')) {
    const suffix = input.slice('http://localhost:3002'.length);
    return nativeFetch(`/api/admin${suffix}`, init);
  }
  return nativeFetch(input, init);
};
