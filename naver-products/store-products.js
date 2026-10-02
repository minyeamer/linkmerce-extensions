async function readStoreProductsTab(tabId, storeUrl, clickNext = false) {
  const message = { action: 'inspectStoreProductsPage', storeUrl, clickNext };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    // Inject a bundled script rather than serializing a function. This also
    // works in obfuscated builds, where functions can depend on outer helpers.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['store-products-page.js'] });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function waitForStoreProductsPage(tabId, storeUrl, previousPage = null) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if ((await chrome.storage.local.get('stopRequested')).stopRequested) return null;
    let page;
    try {
      page = await readStoreProductsTab(tabId, storeUrl);
    } catch (_) {
      // Navigation briefly removes the previous document's message listener.
      await sleep(500);
      continue;
    }
    if (page?.error) throw new Error(page.error);
    if (page?.ready) {
      const changed = !previousPage || (page.urls.join('\n') !== previousPage.urls.join('\n')
        && (previousPage.currentPage == null || page.currentPage > previousPage.currentPage));
      if (changed) return page;
    }
    await sleep(500);
  }
  throw new Error(previousPage ? '다음 상품 목록 페이지로 이동하지 못했습니다.' : '판매처 상품 목록을 읽는 시간이 초과되었습니다.');
}

async function collectStoreProductUrls(storeUrl, onPage) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  try {
    const load = waitForTabLoad(tab.id, 15000);
    await chrome.tabs.update(tab.id, { url: `${storeUrl}/category/ALL?st=RECENT&dt=IMAGE&page=1&size=80` });
    await load;
    let page = await waitForStoreProductsPage(tab.id, storeUrl);
    const urls = new Set();
    const seenPages = new Set();
    let pageNumber = 0;
    while (page) {
      if ((await chrome.storage.local.get('stopRequested')).stopRequested) return [];
      const fingerprint = page.urls.join('\n');
      if (seenPages.has(fingerprint)) throw new Error('상품 목록 페이지가 반복되어 수집을 중단했습니다.');
      seenPages.add(fingerprint);
      page.urls.forEach(url => urls.add(url));
      await onPage(++pageNumber, urls.size);
      if (!page.hasNextPage) return [...urls];
      await sleep(randomDelay());
      if ((await chrome.storage.local.get('stopRequested')).stopRequested) return [];
      const next = await readStoreProductsTab(tab.id, storeUrl, true);
      if (!next?.clicked) throw new Error('상품 목록의 다음 페이지 버튼을 찾지 못했습니다.');
      page = await waitForStoreProductsPage(tab.id, storeUrl, page);
    }
    return [];
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function resolveCollectionUrls(inputs) {
  const normalized = parseCollectionInputs(inputs).map(normalizeCollectionInput);
  const stores = normalized.filter(input => input.type === 'store');
  const urls = new Map();
  const addProduct = url => {
    const id = extractProductNoFromUrl(url);
    if (!urls.has(id)) urls.set(id, url);
  };
  normalized.filter(input => input.type === 'product').forEach(input => addProduct(input.url));
  const errors = new Map();
  for (let index = 0; index < stores.length; index++) {
    if ((await chrome.storage.local.get('stopRequested')).stopRequested) break;
    const storeUrl = stores[index].url;
    // The first store uses the already-applied proxy; later stores rotate once.
    // List page transitions never call the product-level rotation logic.
    if (index > 0 && _proxyEnabled && _proxyList.length > 1) await switchToNextProxy();
    sendProgress(index, stores.length, storeUrl, `판매처 ${index + 1}/${stores.length} · 상품 주소 확인 중`);
    try {
      const products = await collectStoreProductUrls(storeUrl, async (page, count) => {
        sendProgress(index, stores.length, storeUrl, `판매처 ${index + 1}/${stores.length} · ${page}페이지 · 상품 주소 ${count}개`);
      });
      products.forEach(addProduct);
    } catch (error) {
      if ((await chrome.storage.local.get('stopRequested')).stopRequested) break;
      errors.set(storeUrl, '판매처 상품 목록 수집 실패: ' + error.message);
      urls.set('store:' + storeUrl, storeUrl);
    }
  }
  return { urls: [...urls.values()], errors };
}
