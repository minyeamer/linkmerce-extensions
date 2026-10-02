// Run inside the existing list page. Tokens stay in the page, and pagination
// calls the same endpoint as Naver's own page buttons without reloading HTML.
(async () => {
  const channel = window.__PRELOADED_STATE__?.channel;
  const client = window.__CLIENT_RTK_RTS_STATE__;
  if (!channel?.channelUid || !client?.RTK || !client?.RTS) return { ready: false };
  const page = Number(document.documentElement.getAttribute('data-nsp-list-page'));
  if (!Number.isInteger(page) || page < 1) return { ready: true, error: '유효하지 않은 목록 페이지 번호' };
  const pageSize = 80;
  const headers = { Accept: 'application/json, text/plain, */*',
    'x-client-rtk': client.RTK, 'x-client-rts': String(client.RTS), 'x-client-lct': location.pathname };
  const version = [...document.scripts].map(script => script.src.match(/\/static\/(\d+)\/js\//)?.[1]).find(Boolean);
  if (version) headers['x-client-version'] = version;
  const prefix = location.hostname === 'brand.naver.com' ? 'n' : 'i';
  const query = new URLSearchParams({ categorySearchType: 'DISPCATG', sortType: 'RECENT',
    page: String(page), pageSize: String(pageSize), deduplicateGroupEpId: 'true' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/${prefix}/v2/channels/${encodeURIComponent(channel.channelUid)}/categories/ALL/products?${query}`,
      { credentials: 'include', headers, signal: controller.signal });
    if (!response.ok) return { ready: true, error: `상품 목록 API HTTP ${response.status}` };
    const data = await response.json();
    if (!Number.isInteger(data?.totalCount) || data.totalCount < 0 || !Array.isArray(data.simpleProducts)) {
      return { ready: true, error: '상품 목록 API 응답의 상품 목록 또는 총 상품 수가 올바르지 않습니다.' };
    }
    const expected = Math.max(0, Math.min(pageSize, data.totalCount - (page - 1) * pageSize));
    const ids = data.simpleProducts.map(product => String(product.id ?? product.productId ?? ''));
    if (ids.some(id => !/^\d+$/.test(id)) || new Set(ids).size !== expected || ids.length !== expected) {
      return { ready: true, error: `상품 목록 ${page}페이지 상품 수 불일치 (${ids.length}/${expected})` };
    }
    const store = location.origin + '/' + location.pathname.split('/')[1];
    return { ready: true, urls: ids.map(id => `${store}/products/${id}`), currentPage: page,
      pageSize, totalCount: data.totalCount, hasNextPage: page * pageSize < data.totalCount };
  } catch (error) {
    return { ready: true, error: error.name === 'AbortError' ? '상품 목록 API 타임아웃' : '상품 목록 API 요청 실패: ' + error.message };
  } finally { clearTimeout(timer); }
})();
