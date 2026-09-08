importScripts('vendor-bcrypt.js');

const CSV_HEADER = ['상품명', '상품 주소', '정상가', '할인가', '최대 할인가', '이미지 주소', '정상가(이미지)', '할인가(이미지)', '최대 할인가(이미지)'];
const DEFAULTS = {
  urls: '', scheduleConfig: { enabled: false, time: '09:00' },
  apiConfig: { naverClientId: '', naverClientSecret: '', openaiApiKey: '', model: 'gpt-4o-mini' },
  slackConfig: { enabled: false, token: '', channel: '' }
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanPrice = value => {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  return digits ? Number(digits) : null;
};
const csv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
const productNo = url => new URL(url).pathname.match(/\/products\/(\d+)/)?.[1] || null;

async function settings() { return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) }; }
async function setStatus(status) { await chrome.storage.local.set({ runStatus: status }); }
async function updateStatus(patch) {
  const { runStatus = {} } = await chrome.storage.local.get('runStatus');
  await setStatus({ ...runStatus, ...patch });
}
function urlsToList(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || '').split(/\r?\n/))
    .map(value => String(value).trim()).filter(Boolean))];
}

function imageUrls(detailHtml) {
  const urls = [], seen = new Set();
  const pattern = /<img\b[^>]*\b(?:src|data-src|data-original|data-lazy-src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (let match; (match = pattern.exec(detailHtml));) {
    const url = match[1].replace(/&amp;/g, '&');
    if (/^https?:\/\//.test(url) && !seen.has(url)) { seen.add(url); urls.push(url); }
  }
  return urls;
}

async function commerceAccessToken(api) {
  if (!api.naverClientId || !api.naverClientSecret) throw new Error('Commerce API 인증 정보를 설정해 주세요.');
  const cache = (await chrome.storage.local.get('naverOAuthCache')).naverOAuthCache;
  if (cache?.token && cache.expiresAt > Date.now() + 60000) return cache.token;
  if (!self.dcodeIO?.bcrypt) throw new Error('Commerce API 인증 모듈을 불러오지 못했습니다.');
  const timestamp = Date.now() - 3000;
  const hash = self.dcodeIO.bcrypt.hashSync(`${api.naverClientId}_${timestamp}`, api.naverClientSecret);
  const form = new URLSearchParams({
    client_id: api.naverClientId, timestamp: String(timestamp), client_secret_sign: btoa(hash),
    grant_type: 'client_credentials', type: 'SELF'
  });
  const response = await fetch('https://api.commerce.naver.com/external/v1/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
  });
  if (!response.ok) throw new Error(`Commerce OAuth 오류: ${response.status}`);
  const data = await response.json();
  if (!data.access_token) throw new Error('Commerce OAuth 응답에 access_token이 없습니다.');
  await chrome.storage.local.set({
    naverOAuthCache: { token: data.access_token, expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 10800) - 60) * 1000 }
  });
  return data.access_token;
}

async function getProductFromCommerceApi(no, accessToken) {
  const response = await fetch(`https://api.commerce.naver.com/external/v2/products/channel-products/${encodeURIComponent(no)}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Commerce API 오류: ${response.status}`);
  return response.json();
}

function pricesFromCommerceApi(originProduct) {
  const normalPrice = cleanPrice(originProduct?.salePrice);
  const policy = originProduct?.customerBenefit?.immediateDiscountPolicy;
  if (normalPrice == null) return { normalPrice: null, salePrice: null };
  if (!policy) {
    return { normalPrice, salePrice: normalPrice };
  }
  const method = policy.discountMethod || {};
  // Never reconstruct an amount from a percentage. Only an exact won amount
  // supplied by the API is used, so no rounding rule can change the result.
  const discount = cleanPrice(
    policy.discountAmount
    ?? policy.immediateDiscountAmount
    ?? method.discountAmount
    ?? (method.unitType === 'WON' ? method.value : null)
  );
  return { normalPrice, salePrice: discount == null ? null : Math.max(0, normalPrice - discount) };
}

async function readRenderedPage(url) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  try {
    await chrome.tabs.update(tab.id, { url });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('상품 페이지 로딩 시간이 초과되었습니다.'));
      }, 30000);
      const listener = (id, info) => {
        if (id !== tab.id || info.status !== 'complete') return;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    // Login and coupon state can finish updating after document completion.
    // This is only a wait for the rendered DOM, not a network inspection.
    await sleep(3000);
    return await chrome.tabs.sendMessage(tab.id, { type: 'READ_RENDERED_PRICES' });
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function responseText(data) {
  return data.output_text || (data.output || []).flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text').map(item => item.text).join('');
}

async function imagePrices(url, api) {
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      is_price_image: { type: 'boolean' }, selected_block_ordinal: { type: ['integer', 'null'] },
      selected_block_label: { type: ['string', 'null'] }, normal_price: { type: ['integer', 'null'] },
      sale_price: { type: ['integer', 'null'] }, coupon_discount: { type: ['integer', 'null'] },
      maximum_discount_price: { type: ['integer', 'null'] }, evidence_text: { type: ['string', 'null'] }
    },
    required: ['is_price_image', 'selected_block_ordinal', 'selected_block_label', 'normal_price', 'sale_price', 'coupon_discount', 'maximum_discount_price', 'evidence_text']
  };
  const prompt = '상품 상세 이미지의 가격표를 읽으세요. 여러 옵션·용량 가격표가 있으면 화면에서 가장 위에 있는 가격 블록 하나만 선택합니다. 선택한 블록 안에서 정상가, 일반 할인가, 쿠폰 할인액, 쿠폰 적용 후 최종 금액(최대 할인가)을 읽습니다. 최종 금액은 쿠폰적용 시·최대할인가·최종 혜택가 등 어떤 문구로 표시될 수 있습니다. 보이는 숫자만 반환하고 계산하거나 추측하지 마세요. 정상가와 가격이 함께 있어야 가격 이미지입니다.';
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${api.openaiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: api.model || 'gpt-4o-mini',
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: url, detail: 'high' }] }],
      text: { format: { type: 'json_schema', name: 'price_check', strict: true, schema } }
    })
  });
  if (!response.ok) throw new Error(`OpenAI 오류: ${response.status}`);
  return JSON.parse(responseText(await response.json()));
}

function slackAlertText(row) {
  const maximum = row.imageMaximum != null;
  const label = maximum ? '최대 할인가' : '할인가';
  const actual = maximum ? row.maximumPrice : row.benefitPrice;
  const image = maximum ? row.imageMaximum : row.imageSale;
  return `:warning: 상세페이지 이미지 가격과 실제 ${label}가 다릅니다.\n*${row.title}*\n실제 ${label}: ${actual?.toLocaleString()}원 / 이미지 ${label}: ${image?.toLocaleString()}원\n상품 주소: ${row.url}`;
}

async function postSlackText(text, slack, imageUrl = null) {
  const blocks = imageUrl ? [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'image', image_url: imageUrl, alt_text: '가격이 표시된 상세페이지 이미지' }
  ] : undefined;
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { Authorization: `Bearer ${slack.token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: slack.channel, text, blocks, unfurl_links: true, unfurl_media: false })
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`Slack 오류: ${data.error || response.status}`);
}

async function postSlack(row, slack) {
  if (!slack.enabled || !slack.token || !slack.channel) return;
  const text = slackAlertText(row);
  await postSlackText(row.imageUrl ? `${text}\n이미지 주소: ${row.imageUrl}` : text, slack, row.imageUrl);
}

async function writeCsv(run) {
  const price = value => value == null ? '' : String(value);
  const lines = [CSV_HEADER.map(csv).join(',')].concat(run.rows.map(row => [
    csv(row.title), csv(row.url), price(row.normalPrice), price(row.benefitPrice),
    price(row.maximumPrice), csv(row.imageUrl), price(row.imageNormal),
    price(row.imageSale), price(row.imageMaximum)
  ].join(',')));
  const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent('\uFEFF' + lines.join('\r\n'))}`;
  await chrome.downloads.download({ url: dataUrl, filename: run.filename, conflictAction: 'uniquify', saveAs: false });
}

async function validateOne(url, cfg, position, total) {
  const no = productNo(url);
  if (!no) throw new Error('유효한 네이버 상품 URL이 아닙니다.');
  await updateStatus({ stage: '로그인된 상품 페이지에서 가격 확인', currentUrl: url, current: position, total, currentImage: 0, imageTotal: 0 });
  const page = await readRenderedPage(url);
  await updateStatus({ stage: 'Commerce API 상품 상세 조회' });
  let origin = null;
  let apiPrices = null;
  try {
    const product = await getProductFromCommerceApi(no, await commerceAccessToken(cfg.apiConfig));
    origin = product.originProduct || {};
    apiPrices = pricesFromCommerceApi(origin);
  } catch (_) {
    // A product outside the app's seller authority (for example a 403) is not
    // a validation failure. Preserve the page values and move to the next URL.
    await updateStatus({ stage: 'Commerce API 조회 불가: 화면 가격만 기록' });
  }
  // Keep reading the visible page first, then deliberately replace normal and
  // ordinary sale prices with the seller's Commerce API configuration.
  // The maximum discount price remains the separately-read visible DOM value.
  const row = {
    title: page.title || origin?.name || '', url,
    normalPrice: apiPrices?.normalPrice ?? page.normalPrice,
    benefitPrice: apiPrices?.salePrice ?? page.benefitPrice,
    maximumPrice: page.maximumPrice ?? null,
    imageUrl: null, imageNormal: null, imageSale: null, imageMaximum: null
  };
  await updateStatus({ maximumPrice: row.maximumPrice, maximumPriceSource: '상세페이지에 표시된 최대 할인가' });
  if (!cfg.apiConfig?.openaiApiKey) {
    await updateStatus({ stage: '이미지 가격 검증 건너뜀 (OpenAI API 키 없음)' });
    return row;
  }
  if (!origin) return row;
  const images = imageUrls(origin.detailContent || '');
  for (let index = 0; index < images.length; index++) {
    await updateStatus({ stage: `상세 이미지 ${index + 1}/${images.length} OpenAI 가격 분석`, currentImage: index + 1, imageTotal: images.length });
    const extracted = await imagePrices(images[index], cfg.apiConfig);
    if (extracted?.is_price_image && extracted.normal_price != null && (extracted.sale_price != null || extracted.maximum_discount_price != null)) {
      row.imageUrl = images[index];
      row.imageNormal = extracted.normal_price;
      row.imageSale = extracted.sale_price;
      row.imageMaximum = extracted.maximum_discount_price;
      break;
    }
  }
  const actual = row.imageMaximum != null ? row.maximumPrice : row.benefitPrice;
  const image = row.imageMaximum != null ? row.imageMaximum : row.imageSale;
  if (actual != null && image != null && actual !== image) {
    await updateStatus({ stage: '가격 불일치 Slack 알림 전송' });
    await postSlack(row, cfg.slackConfig);
  }
  return row;
}

async function runValidation(reason = 'manual') {
  const cfg = await settings(), urls = urlsToList(cfg.urls);
  if (!urls.length) throw new Error('설정에 상품 URL을 한 개 이상 입력해 주세요.');
  const now = new Date(), pad = value => String(value).padStart(2, '0');
  const filename = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.csv`;
  const run = { filename, rows: [] };
  const status = { running: true, reason, total: urls.length, done: 0, current: 0, currentUrl: '', currentImage: 0, imageTotal: 0, stage: '검증 준비', filename, errors: [] };
  await setStatus(status);
  for (let index = 0; index < urls.length; index++) {
    try { run.rows.push(await validateOne(urls[index], cfg, index + 1, urls.length)); }
    catch (error) {
      status.errors.push({ url: urls[index], error: error.message });
      await updateStatus({ stage: '상품 처리 오류', errors: status.errors, error: error.message });
    }
    status.done = index + 1;
    await updateStatus({ done: status.done, current: index + 1 });
  }
  try {
    await updateStatus({ stage: 'CSV 파일 저장' });
    await writeCsv(run);
    await setStatus({ ...status, running: false, done: urls.length, stage: '검증 완료', finishedAt: new Date().toISOString() });
  } catch (error) {
    await setStatus({ ...status, running: false, done: urls.length, stage: 'CSV 저장 실패', error: error.message, finishedAt: new Date().toISOString() });
  }
}

async function applySchedule(config) {
  await chrome.alarms.clear('naver-price-schedule');
  if (!config?.enabled || !/^\d\d:\d\d$/.test(config.time)) return;
  const [hours, minutes] = config.time.split(':').map(Number);
  const at = new Date(); at.setHours(hours, minutes, 0, 0);
  if (at <= new Date()) at.setDate(at.getDate() + 1);
  await chrome.alarms.create('naver-price-schedule', { when: at.getTime(), periodInMinutes: 1440 });
}

chrome.runtime.onInstalled.addListener(async () => applySchedule((await settings()).scheduleConfig));
chrome.runtime.onStartup.addListener(async () => applySchedule((await settings()).scheduleConfig));
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'naver-price-schedule' && !(await chrome.storage.local.get('runStatus')).runStatus?.running) runValidation('schedule').catch(console.error);
});
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    if (request.action === 'getSettings') return { success: true, settings: await settings(), status: (await chrome.storage.local.get('runStatus')).runStatus || null };
    if (request.action === 'saveSettings') {
      await chrome.storage.local.set(request.settings);
      await applySchedule(request.settings.scheduleConfig);
      return { success: true };
    }
    if (request.action === 'run') {
      if ((await chrome.storage.local.get('runStatus')).runStatus?.running) throw new Error('이미 실행 중입니다.');
      runValidation().catch(async error => {
        await updateStatus({ running: false, stage: '검증 시작 실패', error: error.message, finishedAt: new Date().toISOString() });
      });
      return { success: true };
    }
    if (request.action === 'exportSettings') {
      const saved = await settings();
      return { success: true, settings: { _version: '0.3.0', ...saved, urls: urlsToList(saved.urls) } };
    }
    if (request.action === 'importSettings') {
      const imported = request.settings || {};
      await chrome.storage.local.set({
        urls: urlsToList(imported.urls).join('\n'),
        apiConfig: imported.apiConfig || DEFAULTS.apiConfig,
        slackConfig: imported.slackConfig || DEFAULTS.slackConfig,
        scheduleConfig: imported.scheduleConfig || DEFAULTS.scheduleConfig
      });
      await applySchedule(imported.scheduleConfig || DEFAULTS.scheduleConfig);
      return { success: true };
    }
    return { success: false, error: '알 수 없는 요청입니다.' };
  })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});
