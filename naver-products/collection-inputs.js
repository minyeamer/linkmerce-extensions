// Shared by the popup and service worker so manual/file/scheduled inputs agree.
function normalizeCollectionInput(value) {
  try {
    const parsed = new URL(String(value).trim());
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password
      || !['brand.naver.com', 'smartstore.naver.com'].includes(parsed.hostname)) return null;
    const product = parsed.pathname.match(/^\/([^/]+)\/products\/(\d+)\/?$/);
    if (product) return { type: 'product', url: `${parsed.origin}/${product[1]}/products/${product[2]}` };
    const store = parsed.pathname.match(/^\/([^/]+)(?:\/category\/[^/]+)?\/?$/);
    if (store) return { type: 'store', url: `${parsed.origin}/${store[1]}` };
  } catch (_) { /* Invalid input lines are ignored. */ }
  return null;
}

function parseCollectionInputs(value) {
  const lines = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  return [...new Set(lines.map(normalizeCollectionInput).filter(Boolean).map(input => input.url))];
}
