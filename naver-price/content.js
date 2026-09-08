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
  // Naver brand pages commonly append the store name as " : 스토어명".
  const productTitle = title.trim().replace(/\s+:\s+[^:]+$/, '');
  if (!area) {
    return {
      title: productTitle, salesPrice: null, discountedPrice: null,
      discountAmount: null, totalPayAmount: null
    };
  }

  const discountedPrice = priceFollowingLabel(area, '\uC0C1\uD488 \uAC00\uACA9', { excludeStrong: true });
  const salesPrice = priceFollowingLabel(area, '\uD560\uC778 \uC804 \uAC00\uACA9');
  const totalPayAmount = toPrice(area.querySelector(':scope > div > div strong')?.textContent);
  return {
    title: productTitle,
    // No pre-discount price means the displayed product price is the sales price.
    salesPrice: salesPrice ?? discountedPrice,
    discountedPrice,
    discountAmount: null,
    totalPayAmount
  };
}

function extractMallProducts() {
  const mallProducts = [];
  const seen = new Set();
  for (const card of document.querySelectorAll('#CategoryProducts li')) {
    const productLink = [...card.querySelectorAll('a[href*="/products/"]')]
      .map(link => new URL(link.getAttribute('href'), location.origin).href)
      .find(Boolean);
    const productCode = productLink?.match(/\/products\/(\d+)/)?.[1];
    if (!productLink || !productCode || seen.has(productCode)) continue;
    seen.add(productCode);

    const priceInfo = card.querySelector('[data-shp-area="list.priceinfo"]');
    const displayedPrices = priceInfo ? [...priceInfo.querySelectorAll('span')]
      .map(element => element.textContent.trim())
      .filter(text => /^\d{1,3}(?:,\d{3})*$/.test(text))
      .map(toPrice)
      .filter(price => price != null) : [];
    // A card with two displayed prices shows its final member/coupon price last.
    // A single price is not treated as a maximum discount price.
    const totalPayAmount = displayedPrices.length >= 2 ? displayedPrices.at(-1) : null;
    mallProducts.push({
      url: productLink,
      productCode,
      // These are fallbacks only; the Commerce API still replaces them when available.
      title: card.querySelector('img[alt]')?.getAttribute('alt')?.trim() || '',
      salesPrice: toPrice(priceInfo?.querySelector('del')?.textContent),
      discountedPrice: displayedPrices[0] ?? null,
      totalPayAmount,
      fromMallProduct: true
    });
  }
  return { mallProducts, count: mallProducts.length };
}

function mallProductNextPageLink() {
  const pageLinks = [...document.querySelectorAll('a[aria-current]')]
    .filter(link => /^\d+$/.test(link.textContent.trim()));
  const current = pageLinks.find(link => link.getAttribute('aria-current') === 'true');
  if (!current) return null;
  const nextPage = String(Number(current.textContent.trim()) + 1);
  return pageLinks.find(link => link.textContent.trim() === nextPage) || null;
}

function mallProductHasNextPage() {
  if (mallProductNextPageLink()) return true;
  return [...document.querySelectorAll('a, button')].some(element => {
    const label = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return /다음\s*페이지|next\s*page/i.test(label) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  });
}

function goToNextMallProductPage() {
  const next = mallProductNextPageLink() || [...document.querySelectorAll('a, button')].find(element => {
    const label = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return /다음\s*페이지|next\s*page/i.test(label) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  });
  if (!next) return { clicked: false };
  // Respond before navigating so the service worker is not disconnected mid-message.
  setTimeout(() => next.click(), 0);
  return { clicked: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'READ_RENDERED_PRICES') sendResponse(extractRenderedPrices());
  if (message.type === 'READ_MALL_PRODUCTS') {
    sendResponse({ ...extractMallProducts(), hasNextPage: mallProductHasNextPage() });
  }
  if (message.type === 'GO_TO_NEXT_MALL_PRODUCT_PAGE') sendResponse(goToNextMallProductPage());
});
