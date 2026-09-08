importScripts('vendor-bcrypt.js');

const CSV_HEADER = ['상품명', '상품 주소', '정상가', '할인가', '최대 할인가', '이미지 주소', '정상가(이미지)', '할인가(이미지)', '최대 할인가(이미지)'];
const DEFAULTS = {
  urls: '', excludedProductUrls: '', scheduleConfig: { enabled: false, time: '09:00' },
  smartstoreApiConfig: { clientId: '', clientSecret: '' },
  visionAiApiConfig: { provider: 'google', apiKey: '', model: 'gemini-3.1-flash-lite' },
  slackConfig: { enabled: false, token: '', channel: '' }
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanPrice = value => {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  return digits ? Number(digits) : null;
};
const csv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
function productNo(url) {
  try {
    return new URL(url).pathname.match(/\/products\/(\d+)/)?.[1] || null;
  } catch (_) {
    return null;
  }
}

function normalizeSmartstoreApiConfig(smartstoreApiConfig = {}) {
  return {
    ...DEFAULTS.smartstoreApiConfig,
    ...smartstoreApiConfig,
    clientId: smartstoreApiConfig.clientId || '',
    clientSecret: smartstoreApiConfig.clientSecret || ''
  };
}

function normalizeVisionAiApiConfig(visionAiApiConfig = {}) {
  const provider = visionAiApiConfig.provider === 'openai' ? 'openai' : 'google';
  const defaultModel = provider === 'google' ? 'gemini-3.1-flash-lite' : 'gpt-4o-mini';
  return {
    ...DEFAULTS.visionAiApiConfig,
    ...visionAiApiConfig,
    provider,
    apiKey: visionAiApiConfig.apiKey || '',
    model: visionAiApiConfig.provider ? (visionAiApiConfig.model || defaultModel) : defaultModel
  };
}

async function settings() {
  const saved = await chrome.storage.local.get(DEFAULTS);
  return {
    ...DEFAULTS, ...saved,
    smartstoreApiConfig: normalizeSmartstoreApiConfig(saved.smartstoreApiConfig),
    visionAiApiConfig: normalizeVisionAiApiConfig(saved.visionAiApiConfig),
    slackConfig: { ...DEFAULTS.slackConfig, ...(saved.slackConfig || {}) },
    scheduleConfig: { ...DEFAULTS.scheduleConfig, ...(saved.scheduleConfig || {}) }
  };
}
async function setStatus(status) { await chrome.storage.local.set({ runStatus: status }); }
async function updateStatus(patch) {
  const { runStatus = {} } = await chrome.storage.local.get('runStatus');
  await setStatus({ ...runStatus, ...patch });
}
function urlsToList(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || '').split(/\r?\n/))
    .map(value => String(value).trim()).filter(Boolean))];
}

function mallUrlFromInput(value) {
  try {
    const parsed = new URL(value);
    if (!['brand.naver.com', 'smartstore.naver.com'].includes(parsed.hostname) || productNo(parsed.href)) return null;
    const storeId = parsed.pathname.split('/').filter(Boolean)[0];
    return storeId ? `${parsed.origin}/${storeId}` : null;
  } catch (_) {
    return null;
  }
}

function mallProductsPageUrl(mallUrl, page, size = 80) {
  const parsed = new URL(mallUrl);
  const mallId = parsed.pathname.split('/').filter(Boolean)[0];
  return `${parsed.origin}/${mallId}/category/ALL?st=RECENT&dt=IMAGE&page=${page}&size=${size}`;
}

function excludedProductCodes(excludedProductUrls) {
  const codes = new Set();
  for (const url of urlsToList(excludedProductUrls)) {
    const code = productNo(url);
    if (!code) throw new Error('제외 상품 URL에는 네이버 상품 상세 URL만 입력할 수 있습니다.');
    codes.add(code);
  }
  return codes;
}

function uniqueTargets(targets, excludedCodes) {
  const seen = new Set();
  return targets.filter(target => {
    const code = productNo(target.url);
    if (!code || excludedCodes.has(code) || seen.has(code)) return false;
    seen.add(code);
    return true;
  });
}

async function navigateAndWait(tabId, url, timeoutMessage) {
  await new Promise((resolve, reject) => {
    const listener = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(timeoutMessage));
    }, 30000);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(error => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(error);
    });
  });
}

function imageUrls(detailHtml) {
  const urls = [], seen = new Set();
  const supportedImageExtension = /\.(?:jpe?g|png|webp|heic|heif)(?:[?#]|$)/i;
  const pattern = /<img\b[^>]*\b(?:src|data-src|data-original|data-lazy-src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (let match; (match = pattern.exec(detailHtml));) {
    const url = match[1].replace(/&amp;/g, '&');
    if (/^https?:\/\//.test(url) && supportedImageExtension.test(url) && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

async function commerceAccessToken(smartstoreApiConfig) {
  if (!smartstoreApiConfig.clientId || !smartstoreApiConfig.clientSecret) throw new Error('Commerce API 인증 정보를 설정해 주세요.');
  const cache = (await chrome.storage.local.get('naverOAuthCache')).naverOAuthCache;
  if (cache?.token && cache.expiresAt > Date.now() + 60000) return cache.token;
  if (!self.dcodeIO?.bcrypt) throw new Error('Commerce API 인증 모듈을 불러오지 못했습니다.');
  const timestamp = Date.now() - 3000;
  const hash = self.dcodeIO.bcrypt.hashSync(`${smartstoreApiConfig.clientId}_${timestamp}`, smartstoreApiConfig.clientSecret);
  const form = new URLSearchParams({
    client_id: smartstoreApiConfig.clientId, timestamp: String(timestamp), client_secret_sign: btoa(hash),
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
  const salesPrice = cleanPrice(originProduct?.salePrice);
  const policy = originProduct?.customerBenefit?.immediateDiscountPolicy;
  if (salesPrice == null) return { salesPrice: null, discountedPrice: null, discountAmount: null };
  if (!policy) {
    return { salesPrice, discountedPrice: salesPrice, discountAmount: 0 };
  }
  const method = policy.discountMethod || {};
  // Never reconstruct an amount from a percentage. Only an exact won amount
  // supplied by the API is used, so no rounding rule can change the result.
  const discountAmount = cleanPrice(
    policy.discountAmount
    ?? policy.immediateDiscountAmount
    ?? method.discountAmount
    ?? (method.unitType === 'WON' ? method.value : null)
  );
  return {
    salesPrice,
    discountedPrice: discountAmount == null ? null : Math.max(0, salesPrice - discountAmount),
    discountAmount
  };
}

async function readRenderedPage(url) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  try {
    await navigateAndWait(tab.id, url, '상품 페이지 로딩 시간이 초과되었습니다.');
    // Login and coupon state can finish updating after document completion.
    // This is only a wait for the rendered DOM, not a network inspection.
    await sleep(3000);
    return await chrome.tabs.sendMessage(tab.id, { type: 'READ_RENDERED_PRICES' });
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function goToNextMallProductPage(tabId) {
  const currentUrl = (await chrome.tabs.get(tabId)).url;
  const result = await chrome.tabs.sendMessage(tabId, { type: 'GO_TO_NEXT_MALL_PRODUCT_PAGE' });
  if (!result?.clicked) return false;

  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(500);
    if ((await chrome.tabs.get(tabId)).url !== currentUrl) {
      // The list changes route before its product cards finish rendering.
      await sleep(3000);
      return true;
    }
  }
  throw new Error('다음 상품 목록 페이지로 이동하지 못했습니다.');
}

async function readMallProducts(mallUrl, status, excludedCodes) {
  const size = 80;
  const mallProducts = [];
  const seenProductCodes = new Set();
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  try {
    for (let page = 1; page <= 100; page++) {
      await updateStatus({
        ...status,
        stage: `판매처 상품 목록 ${page}페이지 수집`,
        currentMallUrl: mallUrl,
        mallProductPage: page
      });
      if (page === 1) {
        await navigateAndWait(tab.id, mallProductsPageUrl(mallUrl, 1, size), '판매처 상품 목록 로딩 시간이 초과되었습니다.');
        await sleep(3000 + Math.floor(Math.random() * 4000));
      } else {
        // Naver resolves /category/ALL to its internal category path while changing
        // pages. Use the rendered paginator instead of rebuilding a stale ALL URL.
        await sleep(3000 + Math.floor(Math.random() * 4000));
        if (!await goToNextMallProductPage(tab.id)) break;
      }
      const mallProductPage = await chrome.tabs.sendMessage(tab.id, { type: 'READ_MALL_PRODUCTS' });
      const pageMallProducts = (mallProductPage?.mallProducts || []).filter(mallProduct => {
        if (excludedCodes.has(mallProduct.productCode)) return false;
        if (seenProductCodes.has(mallProduct.productCode)) return false;
        seenProductCodes.add(mallProduct.productCode);
        return true;
      });
      mallProducts.push(...pageMallProducts);
      await updateStatus({ stage: `판매처 상품 목록 ${page}페이지: ${pageMallProducts.length}개 수집`, mallProductCount: mallProducts.length });
      if (!mallProductPage?.hasNextPage) break;
    }
    return mallProducts;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function collectValidationTargets(inputUrls, excludedProductUrls, status) {
  const excludedCodes = excludedProductCodes(excludedProductUrls);
  const mallUrls = [];
  const productUrls = [];
  for (const value of inputUrls) {
    if (productNo(value)) productUrls.push({ url: value, fromMallProduct: false });
    else {
      const mallUrl = mallUrlFromInput(value);
      if (!mallUrl) throw new Error('상품 상세 URL 또는 판매처 URL만 입력할 수 있습니다.');
      mallUrls.push(mallUrl);
    }
  }
  const validationTargets = [];
  for (const mallUrl of [...new Set(mallUrls)]) {
    try {
      validationTargets.push(...await readMallProducts(mallUrl, status, excludedCodes));
    } catch (error) {
      status.errors.push({ url: mallUrl, error: error.message });
      await updateStatus({ stage: '판매처 상품 목록 수집 오류', errors: status.errors, error: error.message });
    }
  }
  // Store products deliberately run first; directly entered product URLs follow.
  return uniqueTargets([...validationTargets, ...productUrls], excludedCodes);
}

function responseText(data) {
  return data.output_text || (data.output || []).flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text').map(item => item.text).join('');
}

function priceImagePrompt({ title, discountedPrice } = {}) {
  const targetTitle = title || '알 수 없음';
  const targetDiscountedPrice = discountedPrice == null ? '알 수 없음' : `${discountedPrice.toLocaleString()}원`;
  return [
    '상품 상세 이미지의 가격표를 읽으세요. 이미지에 여러 구성·옵션 가격 블록이 있으면, 절대로 가장 위 블록을 자동 선택하지 마세요.',
    `검증 대상 상품명: ${targetTitle}`,
    `검증 대상의 실제 일반 할인가: ${targetDiscountedPrice}`,
    '여러 블록 중 검증 대상에 해당하는 블록 하나를 선택하세요. 실제 일반 할인가와 가장 가깝거나 일치하는 블록을 가장 우선하고, 상품명·구성·수량·묶음 표현을 보조 단서로 사용하세요.',
    '구성 표현은 5개/5박스/4+1박스처럼 서로 다를 수 있으므로 단어가 완전히 일치하지 않아도 의미가 맞는지 판단하세요.',
    '정상가는 할인율 변경으로 달라질 수 있으므로 블록 선택의 주된 근거로 쓰지 마세요. 실제 최대 할인가도 블록 선택에 사용하지 마세요.',
    '선택한 블록 안에서만 정상가, 일반 할인가, 쿠폰 할인액, 쿠폰 적용 후 최종 금액(최대 할인가)을 읽으세요.',
    '최종 금액은 쿠폰적용 시·최대할인가·최종 혜택가 등 어떤 문구로 표시될 수 있습니다. 보이는 숫자만 반환하고 계산하거나 추측하지 마세요.',
    '정상가와 가격이 함께 있어야 가격 이미지입니다.'
  ].join(' ');
}

async function apiErrorMessage(response, serviceName) {
  const body = await response.text();
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message || parsed?.message || '';
  } catch (_) {
    detail = body;
  }
  detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 500);
  return `${serviceName} 오류 ${response.status}${detail ? `: ${detail}` : ''}`;
}

async function openAiImagePrices(url, visionAiApiConfig, priceTarget) {
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      is_price_image: { type: 'boolean' }, selected_block_ordinal: { type: ['integer', 'null'] },
      selected_block_label: { type: ['string', 'null'] }, sales_price: { type: ['integer', 'null'] },
      discounted_price: { type: ['integer', 'null'] }, discount_amount: { type: ['integer', 'null'] },
      total_pay_amount: { type: ['integer', 'null'] }, evidence_text: { type: ['string', 'null'] }
    },
    required: ['is_price_image', 'selected_block_ordinal', 'selected_block_label', 'sales_price', 'discounted_price', 'discount_amount', 'total_pay_amount', 'evidence_text']
  };
  const prompt = priceImagePrompt(priceTarget);
  const outputInstructions = '\nJSON fields: sales_price (normal price), discounted_price (ordinary discounted price), discount_amount (coupon discount), total_pay_amount (coupon-applied final price).';
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${visionAiApiConfig.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: visionAiApiConfig.model || 'gpt-4o-mini',
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt + outputInstructions }, { type: 'input_image', image_url: url, detail: 'high' }] }],
      text: { format: { type: 'json_schema', name: 'price_check', strict: true, schema } }
    })
  });
  if (!response.ok) throw new Error(await apiErrorMessage(response, 'OpenAI'));
  return JSON.parse(responseText(await response.json()));
}

const GOOGLE_PRICE_SCHEMA = {
  type: 'object',
  properties: {
    is_price_image: { type: 'boolean' },
    selected_block_ordinal: { type: ['integer', 'null'] },
    selected_block_label: { type: ['string', 'null'] },
    sales_price: { type: ['integer', 'null'] },
    discounted_price: { type: ['integer', 'null'] },
    discount_amount: { type: ['integer', 'null'] },
    total_pay_amount: { type: ['integer', 'null'] },
    evidence_text: { type: ['string', 'null'] }
  },
  required: [
    'is_price_image', 'selected_block_ordinal', 'selected_block_label', 'sales_price',
    'discounted_price', 'discount_amount', 'total_pay_amount', 'evidence_text'
  ]
};

function base64FromBytes(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function googleImagePrices(url, visionAiApiConfig, priceTarget) {
  const imageResponse = await fetch(url);
  if (!imageResponse.ok) throw new Error(`Google image download error: ${imageResponse.status}`);
  const mimeType = imageResponse.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  const imageData = base64FromBytes(new Uint8Array(await imageResponse.arrayBuffer()));
  const model = visionAiApiConfig.model || 'gemini-3.1-flash-lite';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(visionAiApiConfig.apiKey)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { text: `${priceImagePrompt(priceTarget)} JSON 필드는 sales_price(정상가), discounted_price(일반 할인가), discount_amount(쿠폰 할인액), total_pay_amount(쿠폰 적용 후 최종 금액)입니다.` },
        { inlineData: { mimeType, data: imageData } }
      ] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: GOOGLE_PRICE_SCHEMA,
        maxOutputTokens: 500
      }
    })
  });
  if (!response.ok) throw new Error(await apiErrorMessage(response, 'Google AI'));
  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
  if (!text) throw new Error('Google AI returned no text response.');
  return JSON.parse(text);
}

async function imagePrices(url, visionAiApiConfig, priceTarget) {
  return visionAiApiConfig.provider === 'google'
    ? googleImagePrices(url, visionAiApiConfig, priceTarget)
    : openAiImagePrices(url, visionAiApiConfig, priceTarget);
}

function slackAlertText(row) {
  const comparesMaximum = row.imageTotalPayAmount != null;
  const label = comparesMaximum ? '최대 할인가' : '할인가';
  const actual = comparesMaximum ? row.totalPayAmount : row.discountedPrice;
  const image = comparesMaximum ? row.imageTotalPayAmount : row.imageDiscountedPrice;
  const difference = image - actual;
  const requiresAction = comparesMaximum && difference < 0;
  const title = requiresAction
    ? ':rotating_light: 이미지 가격 불일치 조치 바람 :rotating_light:'
    : ':placard: 이미지 가격 불일치 알림 :placard:';
  const differenceText = difference < 0
    ? `이미지 가격이 실제보다 ${Math.abs(difference).toLocaleString()}원 낮음:small_red_triangle_down:`
    : `이미지 가격이 실제보다 ${difference.toLocaleString()}원 높음:small_red_triangle:`;
  return [
    title,
    '',
    '*상품명:*',
    row.title,
    '',
    '*가격 비교*',
    `• 실제 ${label}: *${actual.toLocaleString()}원*`,
    `• 이미지 ${label}: *${image.toLocaleString()}원*`,
    `• 차이: *${differenceText}*`,
    '',
    `<${row.url}|상품 페이지 열기>${row.imageUrl ? `  ·  <${row.imageUrl}|가격 이미지 열기>` : ''}`
  ].join('\n');
}

async function postSlackText(text, slack, imageUrl = null) {
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  if (imageUrl) blocks.push({ type: 'image', image_url: imageUrl, alt_text: '가격이 표시된 상세페이지 이미지' });
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { Authorization: `Bearer ${slack.token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: slack.channel, text, blocks, unfurl_links: false, unfurl_media: false })
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`Slack 오류: ${data.error || response.status}`);
}

async function postSlack(row, slack) {
  if (!slack.enabled || !slack.token || !slack.channel) return;
  await postSlackText(slackAlertText(row), slack, row.imageUrl);
}

async function writeCsv(run) {
  const price = value => value == null ? '' : String(value);
  const lines = [CSV_HEADER.map(csv).join(',')].concat(run.rows.map(row => [
    csv(row.title), csv(row.url), price(row.salesPrice), price(row.discountedPrice),
    price(row.totalPayAmount), csv(row.imageUrl), price(row.imageSalesPrice),
    price(row.imageDiscountedPrice), price(row.imageTotalPayAmount)
  ].join(',')));
  const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent('\uFEFF' + lines.join('\r\n'))}`;
  await chrome.downloads.download({ url: dataUrl, filename: run.filename, conflictAction: 'uniquify', saveAs: false });
}

async function validateOne(target, cfg, position, total) {
  const {
    url,
    title: mallProductTitle = '',
    salesPrice: mallProductSalesPrice = null,
    discountedPrice: mallProductDiscountedPrice = null,
    totalPayAmount: mallProductTotalPayAmount = null,
    fromMallProduct = false
  } = typeof target === 'string'
    ? { url: target }
    : target;
  const no = productNo(url);
  if (!no) throw new Error('유효한 네이버 상품 URL이 아닙니다.');
  await updateStatus({
    stage: fromMallProduct ? '판매처 상품 목록 가격 사용' : '로그인된 상품 페이지에서 가격 확인',
    currentUrl: url,
    current: position,
    total,
    currentImage: 0,
    imageTotal: 0
  });
  // A mall product already provides title and all visible price values needed
  // for validation. Only individually entered product URLs need a detail-page DOM read.
  const page = fromMallProduct
    ? { title: mallProductTitle, salesPrice: mallProductSalesPrice, discountedPrice: mallProductDiscountedPrice, discountAmount: null, totalPayAmount: mallProductTotalPayAmount }
    : await readRenderedPage(url);
  await updateStatus({ stage: 'Commerce API 상품 상세 조회' });
  let origin = null;
  let apiPrices = null;
  try {
    const product = await getProductFromCommerceApi(no, await commerceAccessToken(cfg.smartstoreApiConfig));
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
    salesPrice: apiPrices?.salesPrice ?? page.salesPrice,
    discountedPrice: apiPrices?.discountedPrice ?? page.discountedPrice,
    discountAmount: apiPrices?.discountAmount ?? page.discountAmount,
    totalPayAmount: mallProductTotalPayAmount ?? page.totalPayAmount ?? null,
    imageUrl: null, imageSalesPrice: null, imageDiscountedPrice: null,
    imageDiscountAmount: null, imageTotalPayAmount: null, imageErrors: []
  };
  await updateStatus({
    totalPayAmount: row.totalPayAmount,
    totalPayAmountSource: fromMallProduct ? '판매처 상품 목록에 표시된 최대 할인가' : '상세페이지에 표시된 최대 할인가'
  });
  if (!cfg.visionAiApiConfig?.apiKey) {
    await updateStatus({ stage: '이미지 가격 검증 건너뜀 (생성형AI API 키 없음)' });
    return row;
  }
  if (!origin) return row;
  const images = imageUrls(origin.detailContent || '');
  for (let index = 0; index < images.length; index++) {
    await updateStatus({ stage: `상세 이미지 ${index + 1}/${images.length} ${cfg.visionAiApiConfig.provider === 'google' ? 'Google AI' : 'OpenAI'} 가격 분석`, currentImage: index + 1, imageTotal: images.length });
    let extracted;
    try {
      extracted = await imagePrices(images[index], cfg.visionAiApiConfig, {
        title: row.title,
        discountedPrice: row.discountedPrice
      });
    } catch (error) {
      // One malformed or unsupported image must not prevent later price images
      // or the product's CSV row from being collected.
      row.imageErrors.push({ imageUrl: images[index], error: error.message });
      continue;
    }
    if (extracted?.is_price_image && extracted.sales_price != null && (extracted.discounted_price != null || extracted.total_pay_amount != null)) {
      row.imageUrl = images[index];
      row.imageSalesPrice = extracted.sales_price;
      row.imageDiscountedPrice = extracted.discounted_price;
      row.imageDiscountAmount = extracted.discount_amount;
      row.imageTotalPayAmount = extracted.total_pay_amount;
      break;
    }
  }
  const actual = row.imageTotalPayAmount != null ? row.totalPayAmount : row.discountedPrice;
  const image = row.imageTotalPayAmount != null ? row.imageTotalPayAmount : row.imageDiscountedPrice;
  if (actual != null && image != null && actual !== image) {
    await updateStatus({ stage: '가격 불일치 Slack 알림 전송' });
    await postSlack(row, cfg.slackConfig);
  }
  return row;
}

async function runValidation(reason = 'manual') {
  const cfg = await settings(), inputUrls = urlsToList(cfg.urls);
  if (!inputUrls.length) throw new Error('설정에 상품 상세 URL 또는 판매처 URL을 한 개 이상 입력해 주세요.');
  const now = new Date(), pad = value => String(value).padStart(2, '0');
  const filename = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.csv`;
  const run = { filename, rows: [] };
  const status = { running: true, reason, total: 0, done: 0, current: 0, currentUrl: '', currentImage: 0, imageTotal: 0, stage: '수집 대상 준비', filename, errors: [] };
  await setStatus(status);
  const targets = await collectValidationTargets(inputUrls, cfg.excludedProductUrls, status);
  if (!targets.length) throw new Error('검증할 상품을 찾지 못했습니다. 판매처 URL과 로그인 상태를 확인해 주세요.');
  status.total = targets.length;
  await updateStatus({ total: targets.length, stage: `검증 대상 ${targets.length}개 준비 완료`, currentMallUrl: '', mallProductPage: 0 });
  for (let index = 0; index < targets.length; index++) {
    try {
      const row = await validateOne(targets[index], cfg, index + 1, targets.length);
      run.rows.push(row);
      for (const imageError of row.imageErrors) {
        status.errors.push({ url: row.url, ...imageError });
      }
      if (row.imageErrors.length) {
        await updateStatus({ stage: '일부 상세 이미지 분석 건너뜀', errors: status.errors });
      }
    }
    catch (error) {
      status.errors.push({ url: targets[index].url, error: error.message });
      await updateStatus({ stage: '상품 처리 오류', errors: status.errors, error: error.message });
    }
    status.done = index + 1;
    await updateStatus({ done: status.done, current: index + 1 });
  }
  try {
    await updateStatus({ stage: 'CSV 파일 저장' });
    await writeCsv(run);
    await setStatus({ ...status, running: false, done: targets.length, total: targets.length, stage: '검증 완료', finishedAt: new Date().toISOString() });
  } catch (error) {
    await setStatus({ ...status, running: false, done: targets.length, total: targets.length, stage: 'CSV 저장 실패', error: error.message, finishedAt: new Date().toISOString() });
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
      return {
        success: true,
        settings: {
          _version: '0.3.5',
          ...saved,
          urls: urlsToList(saved.urls),
          excludedProductUrls: urlsToList(saved.excludedProductUrls)
        }
      };
    }
    if (request.action === 'importSettings') {
      const imported = request.settings || {};
      await chrome.storage.local.set({
        urls: urlsToList(imported.urls).join('\n'),
        excludedProductUrls: urlsToList(imported.excludedProductUrls).join('\n'),
        smartstoreApiConfig: imported.smartstoreApiConfig || DEFAULTS.smartstoreApiConfig,
        visionAiApiConfig: imported.visionAiApiConfig || DEFAULTS.visionAiApiConfig,
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
