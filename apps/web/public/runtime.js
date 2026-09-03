const nativeFetch = window.fetch.bind(window);

window.fetch = (input, init) => {
  if (typeof input === 'string' && input.startsWith('http://localhost:3002')) {
    const suffix = input.slice('http://localhost:3002'.length);
    return nativeFetch(`/api/admin${suffix}`, init);
  }
  return nativeFetch(input, init);
};
