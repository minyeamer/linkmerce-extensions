// This function is injected into the list page; keep it self-contained.
function inspectStoreProductsPage(storeUrl, clickNext = false) {
  const root = document.querySelector('#CategoryProducts');
  const bodyText = document.body?.innerText || '';
  if (!root) {
    const error = document.querySelector('#captcha_wrap, #rcpt_form, #vcpt_form, input[name="captcha"]')
      || /보안 확인|자동화된 요청/.test(bodyText) ? '네이버 보안 확인이 필요합니다.'
      : /상품이 존재하지 않습니다|스토어가 존재하지 않습니다/.test(bodyText) ? '판매처를 찾지 못했습니다.' : null;
    return { ready: false, urls: [], error };
  }
  const store = new URL(storeUrl);
  const storeSlug = store.pathname.split('/').filter(Boolean)[0];
  const urls = new Set();
  for (const link of root.querySelectorAll('li a[href*="/products/"]')) {
    try {
      const url = new URL(link.getAttribute('href'), location.href);
      const match = url.pathname.match(/^\/([^/]+)\/products\/(\d+)\/?$/);
      if (url.protocol === 'https:' && ['brand.naver.com', 'smartstore.naver.com'].includes(url.hostname)
        && match && match[1] === storeSlug) {
        urls.add(`${url.origin}/${storeSlug}/products/${match[2]}`);
      }
    } catch (_) { /* Ignore malformed links. */ }
  }
  const pageLinks = [...root.querySelectorAll('a[aria-current], button[aria-current]')]
    .filter(link => /^\d+$/.test(link.textContent.trim()));
  const current = pageLinks.find(link => link.getAttribute('aria-current') === 'true');
  const currentPage = current ? Number(current.textContent.trim()) : null;
  const enabled = element => !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  const numericNext = currentPage == null ? null
    : pageLinks.find(link => Number(link.textContent.trim()) === currentPage + 1 && enabled(link));
  // At the end of a paginator group, its next arrow leads to the next group.
  const arrowNext = [...root.querySelectorAll('[role="menubar"] a, [role="menubar"] button, [data-shp-area="list.pgn"]')]
    .find(element => {
      const label = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      return /다음|next/i.test(label) && enabled(element);
    });
  const next = numericNext || arrowNext;
  const empty = /등록된 상품이 없습니다|상품이 없습니다|검색 결과가 없습니다/.test(root.innerText);
  if (clickNext && next) setTimeout(() => next.click(), 0);
  return { ready: urls.size > 0 || empty, urls: [...urls], currentPage, hasNextPage: Boolean(next), clicked: Boolean(clickNext && next), error: null };
}

if (!globalThis.__nspStoreProductsListener) {
  globalThis.__nspStoreProductsListener = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'inspectStoreProductsPage') {
      sendResponse(inspectStoreProductsPage(message.storeUrl, message.clickNext));
    }
  });
}
