/**
 * 지정 시간만큼 비동기 대기한다.
 * @param {number} ms - 대기 시간(ms)
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 현재 페이지의 Google 검색 결과를 파싱하여 행 배열로 반환한다.
 * @param {number} pageNumber - 현재 페이지 번호(결과 행의 page 필드로 ³주됨)
 * @returns {Array<{ query: string, page: number, rank: number, title: string, url: string, display_url: string, snippet: string, collected_at: string }>}
 */
function parseCurrentGooglePage(pageNumber) {
  const anchors = Array.from(document.querySelectorAll('a h3'))
    .map((h3) => h3.closest('a'))
    .filter(Boolean);

  const seen = new Set();
  const rows = [];
  let rank = 0;
  const query = new URL(location.href).searchParams.get('q') || '';

  for (const anchor of anchors) {
    const href = anchor.href || '';
    if (!href || seen.has(href)) continue;
    seen.add(href);

    const title = anchor.querySelector('h3')?.innerText?.trim() || '';
    if (!title) continue;

    const container = anchor.closest('div[data-snc], div.g, div.Gx5Zad, div.MjjYud') || anchor.parentElement;
    const snippet = container?.querySelector('div.VwiC3b, div[data-sncf="1"], span.aCOpRe, div.s3v9rd')?.innerText?.trim() || '';
    const displayUrl = container?.querySelector('cite')?.innerText?.trim() || href;

    rank += 1;
    rows.push({
      query,
      page: pageNumber,
      rank,
      title,
      url: href,
      display_url: displayUrl,
      snippet,
      collected_at: new Date().toISOString(),
    });
  }

  return rows;
}

/**
 * 현재 페이지에서 CAPTCHA 또는 보안 확인 페이지 여부를 감지한다.
 * @returns {boolean} CAPTCHA/보안 확인 감지 여부
 */
function detectCaptchaOrVerification() {
  const text = (document.body?.innerText || '').toLowerCase();
  const markers = [
    'unusual traffic',
    'our systems have detected',
    'i\'m not a robot',
    'not a robot',
    '자동화된 요청',
    '비정상적인 트래픽',
    '로봇이 아닙니다',
    'captcha',
  ];

  if (markers.some((marker) => text.includes(marker))) {
    return true;
  }

  return Boolean(
    document.querySelector('form[action*="sorry"], iframe[src*="recaptcha"], div.g-recaptcha, #captcha-form')
  );
}

/**
 * 다음 페이지 URL을 찾아 반환한다. '다음' 링크 명시 실패 시 start 파라미터 기준으로 폴백업 탐색한다.
 * @returns {string|null} 다음 페이지 URL 또는 null
 */
function findNextPageUrl() {
  const candidates = Array.from(document.querySelectorAll('a[href]'));
  for (const anchor of candidates) {
    const text = (anchor.innerText || '').trim();
    if (text === '다음' || text === 'Next') {
      return anchor.href;
    }
  }

  const currentStart = Number(new URL(location.href).searchParams.get('start') || '0');
  const fallback = candidates
    .map((anchor) => anchor.href)
    .filter(Boolean)
    .find((href) => {
      try {
        const url = new URL(href);
        return url.origin === location.origin && url.pathname === '/search' && Number(url.searchParams.get('start') || '-1') > currentStart;
      } catch {
        return false;
      }
    });
  return fallback || null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'extractSearchResults') {
    const captchaDetected = detectCaptchaOrVerification();
    const rows = parseCurrentGooglePage(message.pageNumber || 1);
    sendResponse({ ok: true, rows, nextPageUrl: findNextPageUrl(), pageUrl: location.href, query: new URL(location.href).searchParams.get('q') || '', captchaDetected });
    return true;
  }
  if (message?.action === 'navigateToUrl') {
    location.href = message.url;
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
