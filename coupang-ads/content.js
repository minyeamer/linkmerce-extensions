'use strict';

/**
 * Ads 화면을 검사하고 요청 시 Wing 로그인 링크만 클릭한다.
 * @param {boolean} clickWing - Wing 로그인 링크 클릭 여부
 * @returns {{ state: string, clicked?: boolean }} 페이지 상태
 */
function inspectAdsLoginPage(clickWing) {
  const text = `${document.title}\n${document.body?.innerText || ''}`;
  if (/\baccess\s+denied\b/i.test(text)) return { state: 'denied' };

  const link = document.querySelector('a[href^="/user/login?_cap_client=WING"]');
  if (link) {
    if (clickWing) link.click();
    return { state: 'login', clicked: clickWing };
  }

  // 로그인 화면에 버튼이 없으면 우회 URL로 이동하지 않고 다음 새로고침을 기다린다.
  if (/^\/user\/login(?:\/|$)/.test(location.pathname)
      || /쿠팡\s*광고센터\s*로그인/.test(text)) return { state: 'denied' };
  if (document.readyState === 'complete'
      && /^\/marketing\//.test(location.pathname)
      && document.body?.innerText.trim()) {
    return { state: 'ready' };
  }
  return { state: 'waiting' };
}

// 최상위 Ads 문서에서만 로그인 검사 요청을 처리한다.
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action !== 'inspectAdsLogin') return;
  sendResponse(inspectAdsLoginPage(request.clickWing === true));
});
