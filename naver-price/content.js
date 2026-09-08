/* Reads only the visible, logged-in product page; no page state or network
 * response is inspected. */
function toPrice(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits ? Number(digits) : null;
}

function priceFollowingLabel(area, labelText, { excludeStrong = false } = {}) {
  const labels = [...area.querySelectorAll('.blind')]
    .filter(label => label.textContent.trim() === labelText);
  for (const label of labels) {
    const container = label.parentElement;
    if (!container || (excludeStrong && container.closest('strong'))) continue;
    const price = toPrice(container.textContent.replace(label.textContent, ''));
    if (price != null) return price;
  }
  return null;
}

function extractRenderedPrices() {
  const area = document.querySelector('#product-main-price-area');
  const title = document.querySelector('meta[property="og:title"]')?.content
    || document.querySelector('h1')?.innerText || document.title.replace(/\s*:\s*.*$/, '');
  if (!area) return { title: title.trim(), normalPrice: null, benefitPrice: null, maximumPrice: null };

  const salePrice = priceFollowingLabel(area, '상품 가격', { excludeStrong: true });
  const normalPrice = priceFollowingLabel(area, '할인 전 가격');
  const maximumPrice = toPrice(area.querySelector(':scope > div > div strong')?.textContent);
  return {
    title: title.trim(),
    // 할인 전 가격이 없으면 상품 가격이 정상가이기도 합니다.
    normalPrice: normalPrice ?? salePrice,
    benefitPrice: salePrice,
    maximumPrice
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'READ_RENDERED_PRICES') sendResponse(extractRenderedPrices());
});
