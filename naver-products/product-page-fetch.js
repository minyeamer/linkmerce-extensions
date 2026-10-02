// Executed in the product page's MAIN world. Keep all state inside the IIFE
// so source and obfuscated builds can be injected without external helpers.
(async () => {
  const path = location.pathname.match(/^\/([^/]+)\/products\/(\d+)\/?$/);
  if (!path || !['brand.naver.com', 'smartstore.naver.com'].includes(location.hostname)) {
    return { ready: false };
  }
  const body = document.body?.innerText || '';
  if (/상품이 존재하지 않습니다/.test(body)) {
    return { ready: true, error: '상품 페이지에 상품이 존재하지 않습니다. 주소를 확인해 주세요.' };
  }
  if (document.querySelector('#captcha_wrap, #rcpt_form, #vcpt_form, input[name="captcha"]')
    || /보안 확인|자동화된 요청/.test(body)) {
    return { ready: true, error: '네이버 보안 확인이 필요합니다.' };
  }
  const channel = window.__PRELOADED_STATE__?.channel;
  const client = window.__CLIENT_RTK_RTS_STATE__;
  if (!channel?.channelUid || !client?.RTK || !client?.RTS) return { ready: false };
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'x-client-rtk': client.RTK,
    'x-client-rts': String(client.RTS),
    'x-client-lct': location.pathname
  };
  const version = [...document.scripts].map(script => script.src.match(/\/static\/(\d+)\/js\//)?.[1]).find(Boolean);
  if (version) headers['x-client-version'] = version;
  const prefix = location.hostname === 'brand.naver.com' ? 'n' : 'i';
  const url = `/${prefix}/v2/channels/${encodeURIComponent(channel.channelUid)}/products/${path[2]}?withWindow=false`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { credentials: 'include', headers, signal: controller.signal });
    if (!response.ok) return { ready: true, error: `상품 API HTTP ${response.status}` };
    const text = await response.text();
    if (!text.trim()) return { ready: true, error: `상품 API 빈 응답 (HTTP ${response.status})` };
    let data;
    try { data = JSON.parse(text); } catch (_) {
      return { ready: true, error: `상품 API JSON 파싱 실패 (HTTP ${response.status})` };
    }
    if (!data || String(data.id) !== path[2] || data.salePrice == null || !Number.isFinite(Number(data.salePrice))) {
      return { ready: true, error: '상품 API 응답에 요청한 상품과 가격이 없습니다.' };
    }
    // Return product data only. Page request tokens never leave this page.
    if (!data.channel) data.channel = { channelName: channel.channelName, channelNo: channel.id };
    if (data.mallNo == null) data.mallNo = channel.mallSeq ?? null;
    if (!data.channelId) data.channelId = channel.id ?? null;
    if (!data.channelUid) data.channelUid = channel.channelUid;
    return { ready: true, data };
  } catch (error) {
    return { ready: true, error: error.name === 'AbortError' ? '상품 API 타임아웃 (15000ms)' : '상품 API 요청 실패: ' + error.message };
  } finally {
    clearTimeout(timer);
  }
})();
