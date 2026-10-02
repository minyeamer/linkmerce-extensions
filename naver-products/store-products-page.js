// Isolated-world bridge for the bundled MAIN-world list API script.
if (!globalThis.__nspStoreProductsListener) {
  globalThis.__nspStoreProductsListener = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action !== 'inspectStoreProductsPage') return;
    const text = document.body?.innerText || '';
    const error = document.querySelector('#captcha_wrap, #rcpt_form, #vcpt_form, input[name="captcha"]')
      || /보안 확인|자동화된 요청/.test(text) ? '네이버 보안 확인이 필요합니다.'
      : /스토어가 존재하지 않습니다/.test(text) ? '판매처를 찾지 못했습니다.' : null;
    if (message.apiPage) document.documentElement.setAttribute('data-nsp-list-page', String(message.apiPage));
    sendResponse({ error });
  });
}
