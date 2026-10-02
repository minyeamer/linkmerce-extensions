async function readStoreProductsTab(tabId, storeUrl, apiPage = null) {
  const message = { action: 'inspectStoreProductsPage', storeUrl, apiPage };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    // Inject a bundled script rather than serializing a function. This also
    // works in obfuscated builds, where functions can depend on outer helpers.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['store-products-page.js'] });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function readStoreProductsApi(tabId, storeUrl, pageNumber) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if ((await chrome.storage.local.get('stopRequested')).stopRequested) return null;
    const dom = await readStoreProductsTab(tabId, storeUrl, pageNumber);
    if (dom?.error) throw new Error(dom.error);
    const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['store-products-api.js'] });
    const page = results?.[0]?.result;
    if (page?.error) throw new Error(page.error);
    if (page?.ready) return page;
    await sleep(500);
  }
  throw new Error('상품 목록 API 요청 정보 로딩 시간이 초과되었습니다.');
}

async function collectStoreProductUrls(storeUrl, onPage) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  const urls = new Set();
  let pageNumber = 1;
  let expectedTotal = null;
  try {
    const seenPages = new Set();
    const listUrl = `${storeUrl}/category/ALL?st=RECENT&dt=IMAGE&page=1&size=80`;
    while (true) {
      if ((await chrome.storage.local.get('stopRequested')).stopRequested) return [];
      let page;
      for (let attempt = 1; attempt <= 4; attempt++) {
        if ((await chrome.storage.local.get('stopRequested')).stopRequested) return [];
        await onPage(pageNumber, urls.size, attempt === 1 ? '' : `재시도 ${attempt}/4`);
        try {
          if (pageNumber === 1 || attempt > 1) {
            // On retry, reload page 1 to renew page headers after proxy changes.
            const loaded = waitForTabLoad(tab.id, 15000);
            await chrome.tabs.update(tab.id, { url: listUrl });
            await loaded;
          }
          page = await readStoreProductsApi(tab.id, storeUrl, pageNumber);
          if (!page) return [];
          if (seenPages.has([...page.urls].sort().join('\n'))) throw new Error('이전 페이지 상품 목록이 반복되었습니다.');
          if (page.totalCount == null) throw new Error('전체 상품 수 표시를 읽지 못했습니다.');
          if (expectedTotal != null && page.totalCount !== expectedTotal) throw new Error(`수집 도중 총 상품 수가 변경되었습니다 (${expectedTotal} → ${page.totalCount}). 다시 수집해 주세요.`);
          break;
        } catch (error) {
          if ((await chrome.storage.local.get('stopRequested')).stopRequested) return [];
          console.warn(`[BG] 목록 ${storeUrl} ${pageNumber}페이지 ${attempt}/4 실패: ${error.message}`);
          if (attempt === 4) throw error;
          if (_proxyEnabled && _proxyList.length > 1) await switchToNextProxy();
          // Retry only the failed page, preserving every previously read page.
          const delay = Math.min(10000, 1500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
          for (let elapsed = 0; elapsed < delay; elapsed += 500) {
            if ((await chrome.storage.local.get('stopRequested')).stopRequested) return [];
            await sleep(Math.min(500, delay - elapsed));
          }
        }
      }
      const fingerprint = [...page.urls].sort().join('\n');
      seenPages.add(fingerprint);
      expectedTotal = page.totalCount;
      page.urls.forEach(url => urls.add(url));
      await onPage(pageNumber, urls.size);
      if (!page.hasNextPage) {
        if (urls.size !== expectedTotal) throw new Error(`상품 주소 누락: 총 ${expectedTotal}개 중 ${urls.size}개 확인`);
        return [...urls];
      }
      await sleep(randomDelay());
      pageNumber++;
    }
  } catch (error) {
    error.productUrls = [...urls];
    error.message = `${pageNumber}페이지 실패 (확인 ${urls.size}/${expectedTotal ?? '?'}개): ${error.message}`;
    throw error;
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
    // Successful pages keep the IP; failed pages rotate before retrying.
    if (index > 0 && _proxyEnabled && _proxyList.length > 1) await switchToNextProxy();
    sendProgress(index, stores.length, storeUrl, `판매처 ${index + 1}/${stores.length} · 상품 주소 확인 중`);
    try {
      const products = await collectStoreProductUrls(storeUrl, async (page, count, detail = '') => {
        sendProgress(index, stores.length, storeUrl, `판매처 ${index + 1}/${stores.length} · ${page}페이지 · 상품 주소 ${count}개${detail ? ' · ' + detail : ''}`);
      });
      products.forEach(addProduct);
    } catch (error) {
      if ((await chrome.storage.local.get('stopRequested')).stopRequested) break;
      // Keep usable pages even if a later page remains unavailable. The store
      // error row explicitly reports incompleteness instead of claiming success.
      (error.productUrls || []).forEach(addProduct);
      errors.set(storeUrl, '판매처 상품 목록 수집 실패: ' + error.message);
      urls.set('store:' + storeUrl, storeUrl);
    }
  }
  return { urls: [...urls.values()], errors };
}
