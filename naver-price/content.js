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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'READ_RENDERED_PRICES') sendResponse(extractRenderedPrices());
});
