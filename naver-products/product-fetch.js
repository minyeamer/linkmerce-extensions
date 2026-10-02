async function fetchProductDataInPage(productUrl) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  try {
    const loaded = waitForTabLoad(tab.id, 15000);
    await chrome.tabs.update(tab.id, { url: productUrl });
    await loaded;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if ((await chrome.storage.local.get('stopRequested')).stopRequested) {
        throw new Error('상품 데이터 획득 실패: 수집 중단');
      }
      let result;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN', files: ['product-page-fetch.js']
        });
        result = results?.[0]?.result;
      } catch (_) {
        // A redirect can temporarily remove the document being inspected.
        await sleep(500);
        continue;
      }
      if (result?.error) throw new Error('상품 데이터 획득 실패: ' + result.error);
      if (result?.data) return result.data;
      await sleep(500);
    }
    throw new Error('상품 데이터 획득 실패: 상품 페이지의 API 요청 정보 로딩 시간이 초과되었습니다.');
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}
