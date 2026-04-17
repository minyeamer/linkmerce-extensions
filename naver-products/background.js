/**
 * 네이버 상품 ETL
 *
 * 변경 내용 (v2.4 → v3.0):
 *  - fetchPreloadedInfo(상품 페이지 HTML 파싱) 제거 → API 전용 수집으로 단순화
 *  - 특수 상태 감지: API productStatusType 기반 유지 (SUSPENSION/OUTOFSTOCK)
 *  - deleted: HTTP 204 빈 응답 → SpecialStatusError('deleted')
 *  - 딜레이: _delayMin/_delayMax 변수로 랜덤 범위 설정 (설정 탭에서 변경)
 *  - accountNo(채널ID) mallNo 폴백 제거 (판매처순번과 다른 값)
 *  - 수집 탭 delaySelect 제거 → 설정 탭 딜레이 설정으로 통합
 *
 * 변경 내용 (v3.0 → v3.1):
 *  - chrome.alarms 기반 스케줄 자동 수집 기능 추가
 *  - Slack Bot API를 통한 수집 완료 알림 전송 기능 추가
 *  - 프록시 설정 포함 모든 설정 변경 즉시 저장으로 통일
 *
 * 변경 내용 (v3.1 → v3.2.1):
 *  - Slack getUploadURLExternal: Content-Type application/x-www-form-urlencoded 수정
 *  - 수집 시작 로그: 이모티콘 제거, 비활성 항목 생략, urls 정수 표시
 *  - 딜레이 UI: 좌우 각각 중앙 정렬
 *  - 채널 정보 획득 전면 개선 (v3.2.1):
 *    - getChannelInfo(): channelUid + channelId + mallSeq + channelName 통합 반환
 *    - fetchChannelInfo(): BrandStore 응답 구조 수정 (최상위 json.channelUid)
 *    - 5단계 폴백: 런타임캐시 → channels.json → chrome.storage → 데스크탑API → 모바일API
 *    - 학습된 채널 정보 chrome.storage.local에 영구 보관 (자동 학습)
 *    - mallSeq, channelId 도 채널 API에서 추출해 상품 데이터 보완
 *
 * 변경 내용 (v3.2.1 → v3.2.2):
 *  - 삭제 상품 캐시 (_deletedProductIds) 추가:
 *    - 같은 URL 파일로 반복 수집 시 deleted 확정 상품코드 기억
 *    - 다음 수집 시 해당 상품코드 URL은 HTTP 요청 없이 즉시 deleted 처리
 *    - urlSource(파일명 or 'manual')가 바뀌면 캐시 자동 초기화
 *    - popup.js에서 수집 시작 시 urlSource 전달 (파일명/수동 구분)
 *
 * 변경 내용 (v3.2.2 → v3.2.3):
 *  - 즉시 중단 시 미처리 행 제거:
 *    - 중단 이후 null 슬롯을 '미처리' 오류 행으로 채우던 동작 제거
 *    - results.filter(Boolean)으로 수집 완료된 행만 내보내기
 *    - stopCollection 핸들러도 partialResults.filter(Boolean) 적용
 *
 * 변경 내용 (v3.2.3 → v3.3.0):
 *  - 옵션/추가상품 단위 재고 수집:
 *    - buildProductResult가 배열 반환 (옵션별 행 생성)
 *    - optionCombinations(조합형), options(단독형), supplementProducts(추가상품) 파싱
 *    - 단품은 optionId=productId, 옵션상품은 옵션별 행 생성
 *    - productId(=id)와 productNo 분리 추출
 *  - CSV 컬럼 확장:
 *    - productNo, optionId, optionGroup1~3, optionName1~3, optionPrice, registerDate 추가
 *  - results 구조 변경: 배열의 배열 → flat()으로 평탄화
 *
 * 변경 내용 (v3.3.0 → v3.4.0):
 *  - 데이터 구조 분리: {products, options, supplements} 3종 구조
 *    - buildProductResult가 {product, options, supplements} 반환
 *    - collectionResults 저장 형식 변경 (flat 배열 → 3종 분리 객체)
 *  - optionSeq 필드 추가 (옵션: regOrder, 추가상품: 배열 인덱스)
 *  - 상품 stockQuantity = 옵션+추가상품 재고 합산
 *  - CSV 내보내기: 3개 파일 (상품/옵션/추가상품) 별도 컬럼 세트
 *  - JSON 내보내기: 단일 파일 {products, options, supplements} 구조
 *  - 파일 접두어 3개로 확장 (prefix, prefixOption, prefixSupplement)
 *  - JSON 형식 선택 시 옵션/추가상품 접두어 입력 비활성화
 *  - 미리보기: 상품 단위로 표시 (재고 합산, 옵션 행 제외)
 *
 * 변경 내용 (v3.4.2 → v3.4.3):
 *  - 설정 일괄 내보내기/불러오기 기능 추가
 *    - getAllSettings 핸들러: proxyConfig/exportSettings/delayConfig/scheduleConfig/slackConfig 일괄 반환
 *    - setAllSettings 핸들러: 항목명이 동일하면 하위 버전 설정 파일도 호환 적용
 *    - 불러오기 시 프록시/딜레이 런타임 변수 즉시 갱신, 스케줄 알람 재설정
 *  - 기본 URL 파일 매번 최신 내용 자동 로드
 *    - File System Access API + IndexedDB: fileHandle 보관 → 팝업 열 때마다 getFile() 재호출
 *    - API 미지원/권한 없음 시 chrome.storage fallback (기존 동작 유지)
 *
 * 변경 내용 (v3.4.3 → v3.4.4):
 *  - 기본 URL 파일 절대경로 저장/복원 지원
 *    - defaultFilePath 키 추가: getAllSettings/setAllSettings 모두 포함
 *    - 설정 탭에 경로 직접 입력 필드 추가 (편집 즉시 chrome.storage 저장)
 *    - 파일 선택(legacy input) 시 file.path 있으면 자동 기록
 *    - 설정 파일 내보내기에 절대경로 포함 → 불러오기 시 경로 필드 복원
 *
 * 변경 내용 (v3.4.4 → v3.4.5):
 *  - 기본 URL 파일 경로 입력 필드를 기본 URL 파일 카드에서 설정 관리 카드로 이동
 *    - 설정 내보낼 경우에만 필요하므로 설정 관리 영역에 배치
 *    - 안내문: "설정을 내보낼 때 기본 URL 파일의 위치를 함께 저장하려면 절대경로를 입력하세요."
 *  - 설정 불러오기 완료 알림에서 영어 변수명 → 한글 명칭으로 변환 표시
 *
 * 변경 내용 (v3.4.5 → v3.4.6):
 *  - 설정 내보내기/불러오기에 defaultFileContent 포함 (← v3.4.7에서 철회)
 *
 * 변경 내용 (v3.4.6 → v3.4.7):
 *  - 설정 내보내기/불러오기에서 defaultFileContent, defaultFileName 제거
 *    - getAllSettings: defaultFilePath 만 포함 (URL 목록 스냅샷 제거)
 *    - setAllSettings: defaultFilePath 만 복원 (defaultFileName/defaultFileContent 제외)
 *    - 설정 불러오기 후 defaultFilePath가 있으면 파일 재선택 안내 메시지 표시
 *    - KEY_LABEL에서 '기본 파일명', '기본 파일내용' 제거
 *  → defaultFileContent는 런타임/레거시 fallback용으로 chrome.storage에는 유지
 *    (파일 선택 시 갱신, 설정 파일엔 포함 안 함 - URL 1000개 이상 대응)
 *
 * 변경 내용 (v3.4.7 → v3.4.8):
 *  - 빈 문자열 → null 통일: 값이 없으면 빈 문자열 대신 null로 표현
 *    - buildProductResult baseProduct 모든 필드: nn() 헬퍼 일관 적용
 *    - optionRows / supplementRows: 빈 문자열 기본값 제거 (이미 null 기반)
 *    - makeError: 이미 null 기반으로 구현됨 (변경 없음)
 *  - salesPrice 폴백: discountedSalePrice 없으면 salePrice(=price) 값 그대로 사용
 *    - 할인 없는 상품: salesPrice = price (동일값)
 *    - 할인 있는 상품: salesPrice = discountedSalePrice (기존 동작 유지)
 *
 * 채널 정보 획득 전략 (5단계 폴백):
 *  1. 런타임 인메모리 캐시 (_channelInfoCache) - 같은 수집 세션 내 재사용
 *  2. channels.json 로컬 파일 (사전 빌드, 현재 빈 딕셔너리)
 *  3. chrome.storage.local 'channelPersist' - 이전 수집에서 자동 학습된 값
 *  4. 데스크탑 API: smartstore.naver.com/i/v1/smart-stores?url= 또는 brand.naver.com/n/v1/channels?brandUrl=
 *  5. 모바일 API: m.smartstore.naver.com 또는 m.brand.naver.com 엔드포인트
 */

'use strict';

// SpecialStatusError
// ⚠️ class는 hoisting이 안 되므로 반드시 파일 최상단에 위치해야 함
class SpecialStatusError extends Error {
  constructor(status, productUrl, data) {
    super('special_status:' + status);
    this.specialStatus = status;  // 'paused' | 'deleted' | 'soldout'
    this.productUrl = productUrl;
    this.data = data || null;
  }
}

// 규칙 ID 관리 (아이템스카우트: 21~30, 우리는 31~50 사용)
let _ruleCounter = 0;
/**
 * declarativeNetRequest 동적 규칙에 사용할 다음 ID를 반환한다. (31~50 순환)
 * @returns {number} 규칙 ID (31~50)
 */
function nextRuleId() {
  _ruleCounter = (_ruleCounter + 1) % 20;
  return _ruleCounter + 31; // 31~50
}

// 상수
const DEFAULT_DELAY = 2000;  // 기본 상품 간 대기 (ms)
const API_TIMEOUT = 15000;

// 요청 간 랜덤 지연 (설정으로 변경 가능, 기본값 ms)
let _delayMin = 1200;
let _delayMax = 2200;

// captcha 감지/해결 대기
const CAPTCHA_WAIT = 30000;   // 30초
const CAPTCHA_RETRY_WAIT = 300000; // 5분
const MAX_RETRY_COUNT = 3;

// 로컬 채널 UID 캐시
// channels.json 파일 캐시 (Service Worker 수명 동안 1회 로드)
let _channelCache = null;

// 런타임 인메모리 캐시: storeSlug → { channelUid, channelId, mallSeq, channelName }
// (수집 세션 내에서 같은 storeSlug 재요청 방지)
let _channelInfoCache = {};

// 삭제 상품 캐시: productId(string) → true
// 같은 urlSource 반복 수집 시 삭제 확정된 상품은 HTTP 요청 없이 즉시 deleted 처리
// urlSource가 바뀌면 초기화 (다른 파일로 교체 또는 수동 입력)
let _deletedProductIds = new Set();
let _lastUrlSource = null;

/**
 * channels.json 데이터를 로드해 반환한다. Service Worker 수명 동안 한 번만 읽는다.
 * @returns {Promise<Object>} storeSlug 키 배열의 채널 정보 객체
 */
async function getChannelCache() {
  if (_channelCache) return _channelCache;
  try {
    const url = chrome.runtime.getURL('channels.json');
    const res = await fetch(url);
    const data = await res.json();
    _channelCache = data;
    const cnt = Object.keys(_channelCache).length;
    if (cnt > 0) console.log('[BG] channels.json 로드: ' + cnt + '개');
  } catch (e) {
    console.warn('[BG] channels.json 로드 실패: ' + e.message);
    _channelCache = {};
  }
  return _channelCache;
}

/**
 * 채널 정보를 chrome.storage.local의 channelPersist에 저장한다. 이미 저장된 항목은 겹쳐 쓰지 않는다.
 * @param {string} storeSlug - 스토어 슬러그 (URL 식별자)
 * @param {{channelUid: string, channelId: string, mallSeq: number|null, channelName: string}} info - 저장할 채널 정보
 * @returns {Promise<void>}
 */
async function persistChannelInfo(storeSlug, info) {
  try {
    const { channelPersist = {} } = await chrome.storage.local.get('channelPersist');
    if (!channelPersist[storeSlug]) {
      channelPersist[storeSlug] = info;
      await chrome.storage.local.set({ channelPersist });
    }
  } catch (e) { /* 저장 실패 무시 */ }
}

/**
 * chrome.storage에서 특정 storeSlug의 저장된 채널 정보를 조회한다.
 * @param {string} storeSlug - 스토어 슬러그
 * @returns {Promise<{channelUid: string, channelId: string, mallSeq: number|null, channelName: string}|null>} 저장된 정보, 없으면 null
 */
async function getPersistedChannelInfo(storeSlug) {
  try {
    const { channelPersist = {} } = await chrome.storage.local.get('channelPersist');
    return channelPersist[storeSlug] || null;
  } catch (e) { return null; }
}

// 프록시 관리
// 설정 형식 (chrome.storage.local 'proxyConfig'):
// {
//   enabled: true/false,
//   proxies: [
//     { host: '1.2.3.4', port: 8080, username: 'id', password: 'pw' },
//     ...
//   ]
// }
//
// PAC script를 사용하여 naver.com 도메인만 프록시 경유, 나머지는 DIRECT

let _proxyList = [];   // { host, port, username, password }
let _proxyIndex = 0;    // 현재 사용 중인 프록시 인덱스
let _proxyEnabled = false;
let _proxyRotateInterval = 0;  // N 요청마다 IP 교체 (0 = 비활성)
let _proxyErrorThreshold = 3;  // N번 오류 시 IP 교체
let _proxyRequestCount = 0;  // 현재 IP로 처리한 요청 수
let _proxyErrorCount = 0;  // 현재 IP로 발생한 오류 수

/**
 * chrome.storage.local의 proxyConfig를 읽어 프록시 런타임 변수를 초기화한다.
 * @returns {Promise<void>}
 */
async function loadProxyConfig() {
  try {
    const { proxyConfig } = await chrome.storage.local.get('proxyConfig');
    if (!proxyConfig) {
      _proxyEnabled = false;
      _proxyList = [];
      return;
    }
    _proxyEnabled = !!proxyConfig.enabled;
    _proxyList = Array.isArray(proxyConfig.proxies) ? proxyConfig.proxies : [];
    _proxyIndex = 0;
    _proxyRotateInterval = proxyConfig.rotateInterval || 0;
    _proxyErrorThreshold = (proxyConfig.errorThreshold != null && proxyConfig.errorThreshold >= 0) ? proxyConfig.errorThreshold : 3;
    _proxyRequestCount = 0;
    _proxyErrorCount = 0;
  } catch (e) {
    console.warn('[BG] 프록시 설정 로드 실패: ' + e.message);
  }
}

/**
 * chrome.storage.local의 delayConfig를 읽어 요청 간 지연 런타임 변수를 설정한다.
 * @returns {Promise<void>}
 */
async function loadDelayConfig() {
  try {
    const { delayConfig } = await chrome.storage.local.get('delayConfig');
    if (delayConfig) {
      _delayMin = (delayConfig.min != null && delayConfig.min >= 0) ? delayConfig.min : 1200;
      _delayMax = (delayConfig.max != null && delayConfig.max >= _delayMin) ? delayConfig.max : 2200;
    }
  } catch (e) { /* 기본값 유지 */ }
}

/**
 * 현재 활성화된 프록시 정보를 반환한다.
 * @returns {{host: string, port: number, username: string, password: string}|null} 프록시 정보, 비활성화 상태이면 null
 */
function getCurrentProxy() {
  if (!_proxyEnabled || _proxyList.length === 0) return null;
  return _proxyList[_proxyIndex % _proxyList.length];
}

/**
 * 프록시를 다음 항목으로 순환 교체하고 PAC 스크립트를 다시 적용한다.
 * 프록시가 1개를 1개면 실제 교체 없이 카운터만 리셋한다.
 * @returns {Promise<boolean>} 실제 교체 여부
 */
async function switchToNextProxy() {
  if (_proxyList.length === 0) {
    console.warn('[BG] 프록시 목록이 비어있음');
    return false;
  }
  if (_proxyList.length === 1) {
    // 1개뿐이면 교체 불가, 카운터만 리셋
    _proxyRequestCount = 0;
    _proxyErrorCount = 0;
    return false;
  }
  const prev = _proxyIndex % _proxyList.length;
  _proxyIndex = (_proxyIndex + 1) % _proxyList.length;
  _proxyRequestCount = 0;
  _proxyErrorCount = 0;
  const next = _proxyList[_proxyIndex];
  console.log('[BG] 프록시 교체: ' + prev + ' → ' + _proxyIndex + ' (' + next.host + ':' + next.port + ')');
  await applyCurrentProxy();
  // 캡챠 처리된 탭이 있을 때 쿠키도 갱신
  _naverCookieCache = null;
  _naverCookieCacheTime = 0;
  return true;
}

/**
 * 네이버 도메인만 프록시를 경유하는 PAC 스크립트 문자열을 생성다.
 * @param {{host: string, port: number}|null} proxy - 프록시 정보, null이면 DIRECT 실도 반환
 * @returns {string} PAC 스크립트 문자열
 */
function buildPacScript(proxy) {
  if (!proxy) {
    return 'function FindProxyForURL(url, host) { return "DIRECT"; }';
  }
  const proxyStr = 'PROXY ' + proxy.host + ':' + proxy.port;
  return (
    'function FindProxyForURL(url, host) {\n' +
    '  var naverDomains = [\n' +
    '    "smartstore.naver.com",\n' +
    '    "brand.naver.com",\n' +
    '    "m.smartstore.naver.com",\n' +
    '    "m.brand.naver.com",\n' +
    '    "naver.com"\n' +
    '  ];\n' +
    '  for (var i = 0; i < naverDomains.length; i++) {\n' +
    '    if (dnsDomainIs(host, naverDomains[i]) || host === naverDomains[i]) {\n' +
    '      return "' + proxyStr + '";\n' +
    '    }\n' +
    '  }\n' +
    '  return "DIRECT";\n' +
    '}'
  );
}

/**
 * 현재 프록시 를 PAC 스크립트로 Chrome에 적용한다. 프록시가 비활성화상태면 시스템 설정으로 복원한다.
 * @returns {Promise<void>}
 */
async function applyCurrentProxy() {
  const proxy = getCurrentProxy();
  try {
    if (!_proxyEnabled || !proxy) {
      await chrome.proxy.settings.set({
        value: { mode: 'system' },
        scope: 'regular'
      });
      return;
    }
    const pacScript = buildPacScript(proxy);
    await chrome.proxy.settings.set({
      value: {
        mode: 'pac_script',
        pacScript: { data: pacScript }
      },
      scope: 'regular'
    });
  } catch (e) {
    console.error('[BG] 프록시 적용 실패: ' + e.message);
  }
}

// 프록시 인증 핸들러 (webRequest.onAuthRequired)
// 프록시 서버가 407 응답 시 자동으로 id/pw 공급
chrome.webRequest.onAuthRequired.addListener(
  function(details, callback) {
    if (details.isProxy) {
      const proxy = getCurrentProxy();
      if (proxy && proxy.username) {
        console.log('[BG] 프록시 인증 자동 응답: ' + proxy.username);
        callback({ authCredentials: { username: proxy.username, password: proxy.password || '' } });
        return;
      }
    }
    callback({});
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

// 프록시 에러 감지
chrome.proxy.onProxyError.addListener(function(details) {
  console.error('[BG] 프록시 에러: ' + details.error + ' - ' + details.details);
});

// 네이버 쿠키 획득
let _naverCookieCache = null;
let _naverCookieCacheTime = 0;
const COOKIE_CACHE_TTL = 60000; // 1분

/**
 * .naver.com 쿠키를 읽어 'name=value; ...' 형식으로 반환한다. 1분 동안 캐시된다.
 * @returns {Promise<string|null>} 쿠키 문자열, 쿠키가 없으면 null
 */
async function getNaverCookieString() {
  const now = Date.now();
  if (_naverCookieCache && (now - _naverCookieCacheTime) < COOKIE_CACHE_TTL) {
    return _naverCookieCache;
  }
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'naver.com' });
    if (cookies && cookies.length > 0) {
      const cookieStr = cookies.map(function(c) { return c.name + '=' + c.value; }).join('; ');
      _naverCookieCache = cookieStr;
      _naverCookieCacheTime = now;
      return cookieStr;
    }
  } catch (e) {
    console.warn('[BG] 쿠키 획득 실패: ' + e.message);
  }
  return null;
}


// 메시지 리스너 등록
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));
  return true;
});

/**
 * URL 목록을 순서대로 수집하고 결과를 chrome.storage에 저장한다.
 * 자동 내보내기/Slack 알림은 수집 완료 후 실행된다.
 * @param {string[]} urls - 수집할 네이버 상품 URL 배열
 * @param {string} urlSource - URL 원본 식별자 (파일명 또는 'manual')
 * @returns {Promise<{success: boolean, data: {products: Object[], options: Object[], supplements: Object[]}}>} 수집 결과
 */
async function runCollection(urls, urlSource) {
  const emptyResult = { products: [], options: [], supplements: [] };
  await chrome.storage.local.set({ collectionResults: emptyResult, isRunning: true, stopRequested: false, collectionStartTime: Date.now() });

  // 삭제 상품 캐시: urlSource가 변경됐으면 초기화 (다른 파일 or 수동 입력으로 교체)
  const src = urlSource || 'manual';
  if (src !== _lastUrlSource) {
    _deletedProductIds = new Set();
    _lastUrlSource = src;
    console.log('[BG] 삭제 캐시 초기화 (소스 변경: ' + src + ')');
  } else if (_deletedProductIds.size > 0) {
    console.log('[BG] 삭제 캐시 유지 (' + _deletedProductIds.size + '개, 소스: ' + src + ')');
  }

  // 수집 시작 시 현재 설정을 한 번에 요약 출력
  const { exportSettings = {}, scheduleConfig = {}, slackConfig = {} } = await chrome.storage.local.get(['exportSettings', 'scheduleConfig', 'slackConfig']);
  const state = { urls: urls.length };
  state.delay = (_delayMin / 1000).toFixed(1) + '~' + (_delayMax / 1000).toFixed(1) + 's';
  if (_proxyEnabled && _proxyList.length > 0) {
    state.proxy = _proxyList.length + '개'
      + (_proxyRotateInterval > 0 ? ' / 반복:' + _proxyRotateInterval : '')
      + (_proxyErrorThreshold > 0 ? ' / 오류:' + _proxyErrorThreshold : '');
  }
  if (exportSettings.autoExport) state.autoExport = (exportSettings.format || 'csv').toUpperCase();
  if (scheduleConfig.enabled)    state.schedule = scheduleConfig.time;
  if (slackConfig.enabled)       state.slack = slackConfig.channel;
  console.log('[BG] 수집 시작', state);

  // 결과를 분류 저장할 구조
  const results = new Array(urls.length).fill(null);  // index별 {product, options, supplements}
  const queue = urls.map((url, index) => ({ url, index, attempt: 0, nextRetryAt: 0 }));
  let completed = 0;

  // results → {products, options, supplements} 평탄화 헬퍼
  function flattenResults() {
    const out = { products: [], options: [], supplements: [] };
    for (let i = 0; i < results.length; i++) {
      if (!results[i]) continue;
      out.products.push(results[i].product);
      if (results[i].options)      out.options = out.options.concat(results[i].options);
      if (results[i].supplements)  out.supplements = out.supplements.concat(results[i].supplements);
    }
    return out;
  }

  try {
    while (queue.length > 0) {
      const { stopRequested } = await chrome.storage.local.get('stopRequested');
      if (stopRequested) { console.log('[BG] 중단됨'); break; }

      const now = Date.now();
      let idx = queue.findIndex(task => task.nextRetryAt <= now);
      if (idx === -1) {
        const nextTime = Math.min(...queue.map(task => task.nextRetryAt));
        await sleep(Math.max(500, nextTime - now));
        continue;
      }

      const task = queue.splice(idx, 1)[0];
      const url = task.url;
      sendProgress(completed, urls.length, url);

      if (!isValidNaverUrl(url)) {
        results[task.index] = { product: makeError(url, '유효하지 않은 네이버 상품 URL'), options: [], supplements: [] };
        completed++;
        await chrome.storage.local.set({ collectionResults: flattenResults() });
        continue;
      }

      // 삭제 캐시 확인: 이미 삭제 확정된 상품코드면 HTTP 요청 없이 즉시 처리
      const cachedProductId = extractProductNoFromUrl(url);
      if (cachedProductId && _deletedProductIds.has(cachedProductId)) {
        console.log('[BG] 삭제 캐시 히트 → 즉시 deleted: ' + url);
        results[task.index] = {
          product: {
            productId:    cachedProductId,
            productNo:    cachedProductId,
            productUrl:   url,
            status:       'deleted',
            timestamp:    new Date().toISOString()
          },
          options: [],
          supplements: []
        };
        completed++;
        await chrome.storage.local.set({ collectionResults: flattenResults() });
        if (queue.length > 0) await sleep(50);
        continue;
      }

      console.log('[BG] [' + (completed + 1) + '/' + urls.length + '] ' + url);

      try {
        const data = await attemptExtractProduct(url);
        // buildProductResult returns {product, options, supplements}
        results[task.index] = data;
        completed++;
        await chrome.storage.local.set({ collectionResults: flattenResults() });
      } catch (err) {
        // 특수 상태(판매중지/삭제/품절): 재시도 없이 최종 결과로 저장
        if (err instanceof SpecialStatusError) {
          const d = err.data;
          const pid = d?.id ? String(d.id) : extractProductNoFromUrl(url);
          const pno = d?.productNo ? String(d.productNo) : pid;
          results[task.index] = {
            product: {
              productId:           pid,
              productNo:           pno,
              mallNo:              d?.mallNo       != null ? d.mallNo : null,
              mallName:            d?.channelName  || d?.storeName   || null,
              channelId:           d?.channelId    != null ? String(d.channelId) : null,
              channelName:         d?.channelName  || d?.storeName   || null,
              brandId:             d?.brandId      != null ? String(d.brandId)   : null,
              brandName:           d?.brandName    || null,
              categoryId:          d?.categoryId   || null,
              categoryName:        d?.categoryName || null,
              productName:         d?.name         || null,
              price:               d?.salePrice    != null ? d.salePrice : null,
              salesPrice:          d?.discountedSalePrice != null ? d.discountedSalePrice : (d?.salePrice != null ? d.salePrice : null),
              stockQuantity:       d?.stockQuantity != null ? d.stockQuantity : null,
              reviewCount:         null,
              reviewScore:         null,
              soldout:             err.specialStatus === 'soldout' ? true : null,
              status:              err.specialStatus,  // 'paused' | 'deleted' | 'soldout'
              deliveryType:        d?.deliveryType || null,
              wholeCategoryId:     d?.wholeCategoryId   || null,
              wholeCategoryName:   d?.wholeCategoryName || null,
              productUrl:          url,
              channelUid:          d?.channelUid   || null,
              timestamp:           new Date().toISOString()
            },
            options: [],
            supplements: []
          };
          // 삭제 확정된 상품코드를 캐시에 저장
          if (err.specialStatus === 'deleted' && pid) {
            _deletedProductIds.add(pid);
          }
          completed++;
          await chrome.storage.local.set({ collectionResults: flattenResults() });
        } else {
          // 오류 발생 시 오류교체주기 체크
          if (_proxyEnabled && _proxyList.length > 1) {
            _proxyErrorCount++;
            if (_proxyErrorThreshold > 0 && _proxyErrorCount >= _proxyErrorThreshold) {
              console.log('[BG] 오류교체주기 도달(' + _proxyErrorThreshold + '회) → 프록시 교체');
              await switchToNextProxy();
            }
          }
          // JSON 파싱 실패 등 캡챠와 무관한 에러는 재시도 없이 즉시 error로 기록
          const skipRetry = isNonCaptchaError(err);
          task.attempt += 1;
          if (skipRetry || task.attempt >= MAX_RETRY_COUNT) {
            results[task.index] = { product: makeError(url, err.message || '오류'), options: [], supplements: [] };
            completed++;
            await chrome.storage.local.set({ collectionResults: flattenResults() });
            if (skipRetry) console.warn('[BG] 재시도 불가 에러, 즉시 기록: ' + url + ' → ' + err.message);
          } else {
            console.warn('[BG] 재시도 예약(' + task.attempt + '/' + MAX_RETRY_COUNT + '): ' + url);
            task.nextRetryAt = Date.now() + CAPTCHA_RETRY_WAIT;
            queue.push(task);
          }
        }
      }

      // 반복교체주기 체크
      if (_proxyEnabled && _proxyList.length > 1 && results[task.index] != null) {
        _proxyRequestCount++;
        if (_proxyRotateInterval > 0 && _proxyRequestCount >= _proxyRotateInterval) {
          console.log('[BG] 반복교체주기 도달(' + _proxyRotateInterval + '회) → 프록시 교체');
          await switchToNextProxy();
        }
      }

      if (queue.length > 0) await sleep(randomDelay());
    }
  } catch (fatalErr) {
    console.error('[BG] 치명적 루프 에러: ' + fatalErr.message);
    await chrome.storage.local.set({ collectionResults: flattenResults() });
  }

  await chrome.storage.local.set({ isRunning: false });
  sendProgress(completed, urls.length, '');

  // 프록시 비활성화: 수집 완료 후 시스템 설정으로 복원
  if (_proxyEnabled) {
    await chrome.proxy.settings.set({ value: { mode: 'system' }, scope: 'regular' });
  }

  const finalResults = flattenResults();

  // 자동 내보내기
  try {
    const { exportSettings = {} } = await chrome.storage.local.get('exportSettings');
    if (exportSettings.autoExport && finalResults.products.length > 0) {
      const fmt = exportSettings.format        || 'csv';
      const prefixProd = exportSettings.prefix        || '네이버상품';
      const prefixOpt = exportSettings.prefixOption  || '네이버옵션';
      const prefixSup = exportSettings.prefixSupplement || '네이버추가상품';
      const ts = buildTimestamp();

      if (fmt === 'json') {
        const fname = prefixProd + '_' + ts + '.json';
        const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify({
          products:     finalResults.products.map(sortResultKeys),
          options:      finalResults.options,
          supplements:  finalResults.supplements
        }, null, 2));
        await chrome.downloads.download({ url: dataUrl, filename: fname, saveAs: false });
        console.log('[BG] 자동 내보내기 완료: ' + fname);
      } else {
        // CSV: 3개 파일
        const dlProd = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(buildCSV(finalResults.products, PRODUCT_COLUMNS));
        await chrome.downloads.download({ url: dlProd, filename: prefixProd + '_' + ts + '.csv', saveAs: false });
        if (finalResults.options.length > 0) {
          const dlOpt = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(buildCSV(finalResults.options, OPTION_COLUMNS));
          await chrome.downloads.download({ url: dlOpt, filename: prefixOpt + '_' + ts + '.csv', saveAs: false });
        }
        if (finalResults.supplements.length > 0) {
          const dlSup = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(buildCSV(finalResults.supplements, SUPPLEMENT_COLUMNS));
          await chrome.downloads.download({ url: dlSup, filename: prefixSup + '_' + ts + '.csv', saveAs: false });
        }
        console.log('[BG] 자동 내보내기 완료 (CSV 3파일)');
      }
    }
  } catch (autoExportErr) {
    console.warn('[BG] 자동 내보내기 실패: ' + autoExportErr.message);
  }

  // Slack 알림
  try {
    await sendSlackNotification(finalResults);
  } catch (slackErr) {
    console.warn('[BG] Slack 알림 실패: ' + slackErr.message);
  }

  return { success: true, data: finalResults };
}

/**
 * popup.js로부터 수신한 메시지를 처리하는 메인 디스패치 함수.
 * @param {{action: string, [key: string]: any}} request - 수신 메시지 객체
 * @returns {Promise<Object>} 행동별 응답 객체
 */
async function handleMessage(request) {
  switch (request.action) {

    case 'startCollection': {
      const urls = (request.urls || []).map(u => u.trim()).filter(Boolean);
      // 프록시 설정 로드 및 적용
      await loadProxyConfig();
      await loadDelayConfig();
      await applyCurrentProxy();
      return await runCollection(urls, request.urlSource || 'manual');
    }

    case 'stopCollection': {
      await chrome.storage.local.set({ stopRequested: true, isRunning: false });
      const { collectionResults = { products: [], options: [], supplements: [] } } = await chrome.storage.local.get('collectionResults');
      return { success: true, stopped: true, data: collectionResults };
    }

    case 'getResults': {
      const { collectionResults = { products: [], options: [], supplements: [] } } = await chrome.storage.local.get('collectionResults');
      return { success: true, data: collectionResults };
    }

    case 'clearResults':
      await chrome.storage.local.set({ collectionResults: { products: [], options: [], supplements: [] } });
      return { success: true };

    case 'downloadCSV':  // 하위 호환 유지
    case 'exportData': {
      const { collectionResults = { products: [], options: [], supplements: [] } } = await chrome.storage.local.get('collectionResults');
      const safeProducts = (collectionResults.products     || []).filter(Boolean);
      const safeOptions = (collectionResults.options      || []).filter(Boolean);
      const safeSupplements = (collectionResults.supplements  || []).filter(Boolean);
      if (!safeProducts.length) return { success: false, error: '데이터 없음' };

      const format = request.format          || 'csv';
      const prefixProd = request.prefix           || '네이버상품';
      const prefixOpt = request.prefixOption     || '네이버옵션';
      const prefixSup = request.prefixSupplement || '네이버추가상품';
      const ts = buildTimestamp();
      const filenames = [];

      if (format === 'json') {
        const fname = prefixProd + '_' + ts + '.json';
        const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify({
          products:     safeProducts.map(sortResultKeys),
          options:      safeOptions,
          supplements:  safeSupplements
        }, null, 2));
        await chrome.downloads.download({ url: dataUrl, filename: fname, saveAs: false });
        filenames.push(fname);
      } else {
        // CSV: 상품 파일은 항상 저장
        const fnProd = prefixProd + '_' + ts + '.csv';
        const dlProd = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(buildCSV(safeProducts, PRODUCT_COLUMNS));
        await chrome.downloads.download({ url: dlProd, filename: fnProd, saveAs: false });
        filenames.push(fnProd);

        if (safeOptions.length > 0) {
          const fnOpt = prefixOpt + '_' + ts + '.csv';
          const dlOpt = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(buildCSV(safeOptions, OPTION_COLUMNS));
          await chrome.downloads.download({ url: dlOpt, filename: fnOpt, saveAs: false });
          filenames.push(fnOpt);
        }

        if (safeSupplements.length > 0) {
          const fnSup = prefixSup + '_' + ts + '.csv';
          const dlSup = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(buildCSV(safeSupplements, SUPPLEMENT_COLUMNS));
          await chrome.downloads.download({ url: dlSup, filename: fnSup, saveAs: false });
          filenames.push(fnSup);
        }
      }
      return { success: true, filename: filenames.join(', ') };
    }

    // 프록시 설정
    case 'saveDelay': {
      const min = Math.max(0, Number(request.min) || 1200);
      const max = Math.max(min, Number(request.max) || 2200);
      await chrome.storage.local.set({ delayConfig: { min, max } });
      _delayMin = min;
      _delayMax = max;
      return { success: true };
    }

    case 'saveProxyConfig': {
      const config = request.config || { enabled: false, proxies: [] };
      await chrome.storage.local.set({ proxyConfig: config });
      _proxyEnabled = !!config.enabled;
      _proxyList = Array.isArray(config.proxies) ? config.proxies : [];
      _proxyIndex = 0;
      _proxyRotateInterval = config.rotateInterval || 0;
      _proxyErrorThreshold = (config.errorThreshold != null && config.errorThreshold >= 0) ? config.errorThreshold : 3;
      _proxyRequestCount = 0;
      _proxyErrorCount = 0;
      await applyCurrentProxy();
      return { success: true };
    }

    case 'getProxyConfig': {
      const { proxyConfig = { enabled: false, proxies: [] } } = await chrome.storage.local.get('proxyConfig');
      return { success: true, config: proxyConfig };
    }

    case 'getProxyStatus': {
      const proxy = getCurrentProxy();
      return {
        success:         true,
        enabled:         _proxyEnabled,
        total:           _proxyList.length,
        current:         _proxyIndex % Math.max(_proxyList.length, 1),
        host:            proxy ? proxy.host + ':' + proxy.port : null,
        requestCount:    _proxyRequestCount,
        errorCount:      _proxyErrorCount,
        rotateInterval:  _proxyRotateInterval,
        errorThreshold:  _proxyErrorThreshold
      };
    }

    case 'saveExportSettings': {
      await chrome.storage.local.set({ exportSettings: request.settings || {} });
      return { success: true };
    }

    case 'getExportSettings': {
      const { exportSettings = {} } = await chrome.storage.local.get('exportSettings');
      return { success: true, settings: exportSettings };
    }

    case 'switchProxy': {
      const switched = await switchToNextProxy();
      return { success: switched, current: _proxyIndex % Math.max(_proxyList.length, 1) };
    }

    // 스케줄 설정
    case 'saveScheduleConfig': {
      const cfg = request.config || { enabled: false, time: '09:00' };
      await chrome.storage.local.set({ scheduleConfig: cfg });
      await applyScheduleAlarm(cfg);
      return { success: true };
    }

    case 'getScheduleConfig': {
      const { scheduleConfig = { enabled: false, time: '09:00' } } = await chrome.storage.local.get('scheduleConfig');
      return { success: true, config: scheduleConfig };
    }

    // Slack 설정
    case 'saveSlackConfig': {
      const cfg = request.config || { enabled: false, token: '', channel: '', attachFile: false };
      await chrome.storage.local.set({ slackConfig: cfg });
      return { success: true };
    }

    case 'getSlackConfig': {
      const { slackConfig = { enabled: false, token: '', channel: '', attachFile: false } } = await chrome.storage.local.get('slackConfig');
      return { success: true, config: slackConfig };
    }

    // 설정 일괄 내보내기/불러오기
    case 'getAllSettings': {
      // 내보내기 대상 키 목록 (collectionResults/캐시/defaultFileContent 제외)
      // defaultFilePath: 재설치 후 파일 재선택 안내용 (내용 스냅샷은 포함 안 함)
      const keys = ['proxyConfig', 'exportSettings', 'delayConfig', 'scheduleConfig', 'slackConfig', 'defaultFilePath'];
      const stored = await chrome.storage.local.get(keys);
      return {
        success:  true,
        settings: {
          _version:        '3.4.8',
          _exportedAt:     new Date().toISOString(),
          proxyConfig:     stored.proxyConfig     || { enabled: false, proxies: [] },
          exportSettings:  stored.exportSettings  || {},
          delayConfig:     stored.delayConfig     || { min: 1200, max: 2200 },
          scheduleConfig:  stored.scheduleConfig  || { enabled: false, time: '09:00' },
          slackConfig:     stored.slackConfig     || { enabled: false, token: '', channel: '' },
          defaultFilePath: stored.defaultFilePath || ''
        }
      };
    }

    case 'setAllSettings': {
      // 하위 버전 설정 파일도 항목명이 동일하면 그대로 적용
      // _version / _exportedAt 은 메타데이터이므로 저장 제외
      const s = request.settings || {};
      const toSave = {};
      if (s.proxyConfig)    toSave.proxyConfig = s.proxyConfig;
      if (s.exportSettings) toSave.exportSettings = s.exportSettings;
      if (s.delayConfig)    toSave.delayConfig = s.delayConfig;
      if (s.scheduleConfig) toSave.scheduleConfig = s.scheduleConfig;
      if (s.slackConfig)    toSave.slackConfig = s.slackConfig;
      // defaultFilePath만 저장 (defaultFileName/defaultFileContent는 파일 선택 시 갱신)
      if (s.defaultFilePath !== undefined) toSave.defaultFilePath = s.defaultFilePath;
      await chrome.storage.local.set(toSave);
      // 프록시/딜레이 런타임 변수 갱신
      if (toSave.proxyConfig) {
        const c = toSave.proxyConfig;
        _proxyEnabled = !!c.enabled;
        _proxyList = Array.isArray(c.proxies) ? c.proxies : [];
        _proxyIndex = 0;
        _proxyRotateInterval = c.rotateInterval  || 0;
        _proxyErrorThreshold = (c.errorThreshold != null && c.errorThreshold >= 0) ? c.errorThreshold : 3;
        _proxyRequestCount = 0;
        _proxyErrorCount = 0;
        await applyCurrentProxy();
      }
      if (toSave.delayConfig) {
        _delayMin = toSave.delayConfig.min ?? 1200;
        _delayMax = toSave.delayConfig.max ?? 2200;
      }
      if (toSave.scheduleConfig) {
        await applyScheduleAlarm(toSave.scheduleConfig);
      }
      return { success: true, applied: Object.keys(toSave) };
    }

    default:
      return { success: false, error: '알 수 없는 액션: ' + request.action };
  }
}

/**
 * 네이버 상품 URL로 API를 호출해 상품-재고-리뷰 데이터를 추출한다.
 * 채널 정보 획득 → 데스크탑/모바일 API 4단계 폴백 → 결과 반환 순으로 진행한다.
 * @param {string} productUrl - 네이버 상품 페이지 URL
 * @returns {Promise<{product: Object, options: Object[], supplements: Object[]}>} 추출 결과
 */
async function extractProduct(productUrl) {
  try {
    const parsed = parseNaverUrl(productUrl);
    const storeType = parsed.storeType;
    const storeSlug = parsed.storeSlug;
    const productId = parsed.productId;

    // Step 1: 채널 정보 획득 (channelUid + mallSeq + channelId)
    const uaInfo = await getUAInfo();
    const cookieStr = await getNaverCookieString();

    const channelInfo = await getChannelInfo(storeType, storeSlug, uaInfo, cookieStr);
    if (!channelInfo || !channelInfo.channelUid) throw new Error('channelUid 획득 실패');

    const channelUid = channelInfo.channelUid;
    const cacheChannelId = channelInfo.channelId  || null;
    const cacheMallSeq = channelInfo.mallSeq    != null ? channelInfo.mallSeq : null;

    await sleep(500);

    let apiData = null;
    let apiErr = '';

    // 데스크탑 API (원래 storeType)
    try {
      apiData = await fetchProductData(storeType, storeSlug, productId, channelUid, uaInfo, false, cookieStr);
    } catch (e) {
      apiErr = e.message;
    }

    // SmartStore → Brand 폴백 (데스크탑)
    if (!apiData && storeType === 'smartstore') {
      await sleep(randomDelay());
      try {
        apiData = await fetchProductData('brand', storeSlug, productId, channelUid, uaInfo, false, cookieStr);
      } catch (e) {
        apiErr = e.message;
      }
    }

    // 모바일 API 폴백
    if (!apiData) {
      await sleep(randomDelay());
      try {
        apiData = await fetchProductData(storeType, storeSlug, productId, channelUid, uaInfo, true, cookieStr);
      } catch (e) {
        apiErr = e.message;
      }
    }

    // SmartStore → Brand 폴백 (모바일)
    if (!apiData && storeType === 'smartstore') {
      await sleep(randomDelay());
      try {
        apiData = await fetchProductData('brand', storeSlug, productId, channelUid, uaInfo, true, cookieStr);
      } catch (e) {
        apiErr = e.message;
      }
    }

    // 삭제된 상품: 4단계 API 전부 실패 시 error 메시지로 판별
    if (!apiData) {
      if (apiErr.includes('204') || apiErr.includes('빈 응답')) {
        console.warn('[BG] API 빈 응답(204) → deleted 판정: ' + productUrl);
        throw new SpecialStatusError('deleted', productUrl, null);
      }
      throw new Error('상품 데이터 획득 실패: ' + apiErr);
    }

    // 채널 정보로 mallNo / channelId 보완
    if (apiData.mallNo == null && cacheMallSeq != null) {
      apiData.mallNo = cacheMallSeq;
    }
    if (!apiData.channelId && cacheChannelId) {
      apiData.channelId = cacheChannelId;
    }

    // API 응답의 productStatusType으로 특수 상태 감지
    const apiProductStatus = apiData.productStatusType || null;
    const apiSpecialStatus = detectSpecialStatusFromType(apiProductStatus);
    if (apiSpecialStatus) {
      throw new SpecialStatusError(apiSpecialStatus, productUrl, {
        id:                apiData.id           || extractProductNoFromUrl(productUrl),
        channelUid:        apiData.channelUid   || channelUid,
        channelId:         apiData.channelId    || (apiData.channel && apiData.channel.channelNo) || cacheChannelId || null,
        channelName:       apiData.channelName  || (apiData.channel && apiData.channel.channelName) || channelInfo.channelName || null,
        mallNo:            apiData.mallNo       != null ? apiData.mallNo : (cacheMallSeq ?? null),
        brandId:           apiData.brandId      != null ? String(apiData.brandId) : null,
        brandName:         apiData.brandName    || null,
        storeName:         (apiData.channel && apiData.channel.channelName) || channelInfo.channelName || null,
        productStatusType: apiProductStatus,
        stockQuantity:     apiData.stockQuantity != null ? apiData.stockQuantity : null,
        categoryId:        (apiData.category && apiData.category.categoryId)        || null,
        categoryName:      (apiData.category && apiData.category.categoryName)       || null,
        wholeCategoryId:   (apiData.category && apiData.category.wholeCategoryId)    || null,
        wholeCategoryName: (apiData.category && apiData.category.wholeCategoryName)  || null,
        deliveryType:      (apiData.productDeliveryInfo && apiData.productDeliveryInfo.deliveryAttributeType) || null,
        name:              apiData.name      || null,
        salePrice:         apiData.salePrice != null ? apiData.salePrice : null,
        productNo:         apiData.productNo || apiData.id || null
      });
    }

    return buildProductResult(productUrl, apiData);

  } catch (err) {
    if (err instanceof SpecialStatusError) {
      console.log('[BG] ' + err.specialStatus + ': ' + productUrl);
    } else {
      console.error('[BG] 실패: ' + productUrl + ' → ' + err.message);
    }
    throw err;
  }
}

/**
 * API의 productStatusType으로 특수 상태를 판별한다.
 * @param {string|null} productStatusType - API 응답의 productStatusType 값
 * @returns {'paused'|'soldout'|null} 특수 상태 코드, 해당하지 않으면 null
 */
function detectSpecialStatusFromType(productStatusType) {
  if (productStatusType === 'SUSPENSION') return 'paused';
  if (productStatusType === 'OUTOFSTOCK') return 'soldout';
  return null;
}

// 캡챠 대응
/**
 * 캡챠 확인이 필요 없는 에러를 판별한다 (JSON 파싱 실패, 네트워크 단절 등).
 * @param {Error} err - 판별할 에러
 * @returns {boolean} 캡챠와 무관한 에러이면 true
 */
function isNonCaptchaError(err) {
  const msg = err.message || '';
  return msg.includes('JSON') ||            // Unexpected end of JSON input 등
    msg.includes('Failed to fetch') ||      // 네트워크 단절
    msg.includes('NetworkError') ||
    msg.includes('타임아웃') ||
    msg.includes('상품 데이터 획득 실패');  // 4단계 모두 실패
}

/**
 * 상품 URL을 수집할 때 캡챠 감지 시 프록시 교체 또는 캡챠 해결 대기 후 재시도한다.
 * @param {string} productUrl - 네이버 상품 페이지 URL
 * @returns {Promise<{product: Object, options: Object[], supplements: Object[]}>} 추출 결과
 */
async function attemptExtractProduct(productUrl) {
  try {
    return await extractProduct(productUrl);
  } catch (err) {
    // 특수 상태(판매중지/삭제/품절)는 캡챠와 무관 → 재시도 없이 바로 재throw
    if (err instanceof SpecialStatusError) throw err;

    // JSON 파싱 실패 / 네트워크 에러 등은 캡챠와 무관 → 탭 열기 없이 바로 throw
    if (isNonCaptchaError(err)) throw err;

    // 프록시 교체 (활성화된 경우)
    // 캡챠가 감지되면 프록시를 먼저 교체하고 재시도
    if (_proxyEnabled && _proxyList.length > 1) {
      console.warn('[BG] 캡챠 의심 → 프록시 교체 후 재시도: ' + productUrl);
      const switched = await switchToNextProxy();
      if (switched) {
        await sleep(2000); // 프록시 적용 대기
        try {
          return await extractProduct(productUrl);
        } catch (retryErr) {
          if (retryErr instanceof SpecialStatusError) throw retryErr;
          if (isNonCaptchaError(retryErr)) throw retryErr;
          // 프록시 교체 후에도 실패 → 캡챠 탭 열기로 이어짐
        }
      }
    }

    const captchaStatus = await handleCaptchaForUrl(productUrl);

    if (captchaStatus === 'resolved') {
      return await extractProduct(productUrl);
    }

    if (captchaStatus === 'timeout') {
      // 캡챠 타임아웃 + 프록시 있음 → 한 번 더 프록시 교체
      if (_proxyEnabled && _proxyList.length > 0) {
        console.warn('[BG] 캡챠 타임아웃 → 프록시 교체');
        await switchToNextProxy();
      }
      throw new Error('captcha_timeout');
    }

    throw err;
  }
}

/**
 * 상품 URL로 다일 캐시를 열어 쮡차 여부를 확인하고, 쮡차면 사용자 해결을 대기한다.
 * @param {string} productUrl - 네이버 상품 페이지 URL
 * @returns {Promise<'no_captcha'|'resolved'|'timeout'|'error'>} 쮡차 처리 결과
 */
async function handleCaptchaForUrl(productUrl) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: productUrl, active: true });
    tabId = tab.id;
    await waitForTabLoad(tabId, 15000);

    const status = await getPageStatus(tabId);
    if (status.isProduct) {
      return 'no_captcha';
    }

    if (!status.isCaptcha) {
      return 'no_captcha';
    }

    console.warn('[BG] 캡챠 감지: 사용자 해결 대기 시작');
    const resolved = await waitForCaptchaResolution(tabId, CAPTCHA_WAIT);
    return resolved ? 'resolved' : 'timeout';
  } catch (e) {
    console.warn('[BG] 캡챠 확인 실패: ' + e.message);
    return 'error';
  } finally {
    if (tabId) { chrome.tabs.remove(tabId).catch(() => {}); }
  }
}

/**
 * 탭이 특정 상태가 될 때까지 최대 timeoutMs만크 대기한다.
 * @param {number} tabId - 대기할 탭 ID
 * @param {number} timeoutMs - 최대 대기 시간 (ms)
 * @returns {Promise<void>}
 */
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * 탭의 현재 URL과 DOM을 스캔해 쮡차 여부와 상품 페이지 여부를 판별한다.
 * @param {number} tabId - 확인할 탭 ID
 * @returns {Promise<{isCaptcha: boolean, isProduct: boolean}>} 페이지 상태
 */
async function getPageStatus(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const url = window.location.href;
        const bodyText = document.body ? document.body.innerText : '';
        const hasCaptchaEl = document.querySelector('#captcha_wrap, #rcpt_form, #vcpt_form, #cpt_confirm, input[name="captcha"]') !== null;
        const hasCaptchaText = bodyText.includes('보안 확인') || bodyText.includes('자동화된 요청') || bodyText.includes('캡차');
        const hasOgTitle = document.querySelector('meta[property="og:title"]')?.content;
        const isProductUrl = /\/products\//.test(url);
        return {
          isCaptcha: url.includes('nid.naver.com') || url.includes('captcha') || hasCaptchaEl || hasCaptchaText,
          isProduct: Boolean(isProductUrl && hasOgTitle)
        };
      }
    });
    return results && results[0] && results[0].result ? results[0].result : { isCaptcha: false, isProduct: false };
  } catch (e) {
    return { isCaptcha: false, isProduct: false };
  }
}

/**
 * timeoutMs 안에 쮡차가 해결되어 상품 페이지가 로드될 때까지 1초마다 야백한다.
 * @param {number} tabId - 쮡차가 표시된 탭 ID
 * @param {number} timeoutMs - 최대 대기 시간 (ms)
 * @returns {Promise<boolean>} 쮡차 해결 여부
 */
async function waitForCaptchaResolution(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const status = await getPageStatus(tabId);
    if (status.isProduct) {
      console.warn('[BG] 캡챠 해결 후 정상 페이지 확인');
      return true;
    }
  }
  return false;
}

/**
 * 현재 브라우저의 User-Agent 고엔트로피 값을 읽어 반환한다.
 * 고엔트로피 API가 지원되지 않는 환경에서는 Chrome 124 기반 기본값을 반환한다.
 * @returns {Promise<{brands: string, fullBrands: string, platform: string}>} UA 정보 객체
 */
async function getUAInfo() {
  try {
    const ua = await navigator.userAgentData.getHighEntropyValues([
      'architecture', 'model', 'platform', 'uaFullVersion', 'fullVersionList'
    ]);
    const brands = ua.brands.map(function(b) { return '"' + b.brand + '";v="' + b.version + '"'; }).join(', ');
    const fullBrands = (ua.fullVersionList || ua.brands).map(function(b) { return '"' + b.brand + '";v="' + b.version + '"'; }).join(', ');
    return { brands: brands, fullBrands: fullBrands, platform: ua.platform || 'Windows' };
  } catch (e) {
    return {
      brands:     '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      fullBrands: '"Chromium";v="124.0.6367.82", "Google Chrome";v="124.0.6367.82", "Not-A.Brand";v="99.0.0.0"',
      platform:   'Windows'
    };
  }
}

/**
 * 채널 정보를 획득한다 (5단계 폴백).
 * 우선순위: 1. 런타임 인메모리 캐시 → 2. channels.json 파일 → 3. storage.local 영구 캐시
 *           → 4. API 호출 (데스크탑) → 5. API 호출 (모바일)
 * @param {'smartstore'|'brand'} storeType - 스토어 타입
 * @param {string} storeSlug - 스토어 슬러그
 * @param {{isMobile: boolean, ua: string, sec_ch_ua: string, platform: string}} uaInfo - UA 정보
 * @param {string|null} cookieStr - 네이버 쿠키 문자열
 * @returns {Promise<{channelUid: string, channelId: string, mallSeq: string, channelName: string}|null>}
 */
async function getChannelInfo(storeType, storeSlug, uaInfo, cookieStr) {

  // 1순위: 런타임 인메모리 캐시
  if (_channelInfoCache[storeSlug]) {
    return _channelInfoCache[storeSlug];
  }

  // 2순위: channels.json 로컬 파일
  try {
    const cache = await getChannelCache();
    const entry = cache[storeSlug];
    if (entry && entry.channelUid) {
      const info = {
        channelUid:  entry.channelUid,
        channelId:   entry.channelId  || String(entry.channelNo || ''),
        mallSeq:     entry.mallSeq    != null ? entry.mallSeq : null,
        channelName: entry.channelName || storeSlug
      };
      _channelInfoCache[storeSlug] = info;
      return info;
    }
  } catch (e) { /* 무시 */ }

  // 3순위: chrome.storage 영구 캐시
  const persisted = await getPersistedChannelInfo(storeSlug);
  if (persisted && persisted.channelUid) {
    _channelInfoCache[storeSlug] = persisted;
    return persisted;
  }

  // 4순위: 데스크탑 API
  try {
    const info = await fetchChannelInfo(storeType, storeSlug, uaInfo, false, cookieStr);
    if (info && info.channelUid) {
      _channelInfoCache[storeSlug] = info;
      await persistChannelInfo(storeSlug, info);
      console.log('[BG] channelUid 획득(데스크탑API): ' + storeSlug + ' → ' + info.channelUid);
      return info;
    }
  } catch (e) {
    console.warn('[BG] channelUid 데스크탑API 실패 (' + storeSlug + '): ' + e.message);
  }

  // 5순위: 모바일 API
  try {
    const info = await fetchChannelInfo(storeType, storeSlug, uaInfo, true, cookieStr);
    if (info && info.channelUid) {
      _channelInfoCache[storeSlug] = info;
      await persistChannelInfo(storeSlug, info);
      console.log('[BG] channelUid 획득(모바일API): ' + storeSlug + ' → ' + info.channelUid);
      return info;
    }
  } catch (e) {
    console.warn('[BG] channelUid 모바일API 실패 (' + storeSlug + '): ' + e.message);
  }

  return null;
}

/**
 * 채널 정보 API를 호출해 channelUid를 포함한 채널 정보를 대치한다.
 * SmartStore: /i/v1/smart-stores?url= → json.channel, BrandStore: /n/v1/channels?brandUrl= → json 최상위
 * @param {'smartstore'|'brand'} storeType - 스토어 종류
 * @param {string} storeSlug - 스토어 슬러그
 * @param {{brands: string, fullBrands: string, platform: string}} uaInfo - User-Agent 정보
 * @param {boolean} isMobile - 모바일 API 엔드포인트 사용 여부
 * @param {string|null} cookieStr - 네이버 쿠키 문자열
 * @returns {Promise<{channelUid: string, channelId: string, mallSeq: number|null, channelName: string}|null>} 채널 정보, 실패 시 null
 */
async function fetchChannelInfo(storeType, storeSlug, uaInfo, isMobile, cookieStr) {
  const ruleId = nextRuleId();
  let apiUrl, referer;

  if (storeType === 'smartstore') {
    if (isMobile) {
      apiUrl = 'https://m.smartstore.naver.com/i/v1/smart-stores?url=' + storeSlug;
      referer = 'https://m.smartstore.naver.com/' + storeSlug;
    } else {
      apiUrl = 'https://smartstore.naver.com/i/v1/smart-stores?url=' + storeSlug;
      referer = 'https://smartstore.naver.com/' + storeSlug;
    }
  } else {
    // BrandStore: 데스크탑/모바일 모두 성공 → 데스크탑 우선
    if (isMobile) {
      apiUrl = 'https://m.brand.naver.com/n/v1/channels?brandUrl=' + storeSlug;
      referer = 'https://m.brand.naver.com/' + storeSlug;
    } else {
      apiUrl = 'https://brand.naver.com/n/v1/channels?brandUrl=' + storeSlug;
      referer = 'https://brand.naver.com/' + storeSlug;
    }
  }

  await setDynamicRule(ruleId, apiUrl, referer, uaInfo, isMobile, cookieStr);
  try {
    const res = await fetchWithTimeout(apiUrl, { credentials: 'include' }, API_TIMEOUT);
    if (!res.ok) throw new Error('channelInfo API HTTP ' + res.status);
    const text = await res.text();
    if (!text || text.trim() === '') return null;
    let json;
    try { json = JSON.parse(text); } catch (e) { return null; }
    if (!json) return null;

    // SmartStore: 응답 래퍼 { channel: { channelUid, id, mallSeq, channelName, ... } }
    // BrandStore: 응답 최상위에 직접 { channelUid, id, mallSeq, channelName, ... }
    let ch;
    if (storeType === 'smartstore') {
      ch = json.channel || null;
    } else {
      // BrandStore: 최상위에 channelUid가 직접 있음
      ch = json.channelUid ? json : (json.channel || null);
    }
    if (!ch || !ch.channelUid) return null;

    return {
      channelUid:  ch.channelUid,
      channelId:   ch.id         != null ? String(ch.id)         : String(ch.channelNo  || ch.accountNo || ''),
      mallSeq:     ch.mallSeq    != null ? ch.mallSeq            : (ch.brandMallSeq != null ? ch.brandMallSeq : null),
      channelName: ch.channelName || ch.brandStoreName || storeSlug
    };
  } finally {
    await removeRule(ruleId);
  }
}

/**
 * 네이버 상품 API를 호출해 상품 데이터 원시 JSON을 반환한다. 데스크탑/모바일 공용.
 * @param {'smartstore'|'brand'} storeType - 스토어 종류
 * @param {string} storeSlug - 스토어 슬러그
 * @param {string} productId - 상품 ID
 * @param {string} channelUid - 채널 UID
 * @param {{brands: string, fullBrands: string, platform: string}} uaInfo - User-Agent 정보
 * @param {boolean} isMobile - 모바일 API 엔드포인트 사용 여부
 * @param {string|null} cookieStr - 네이버 쿠키 문자열
 * @returns {Promise<Object>} 상품 API 응답 JSON 객체
 */
async function fetchProductData(storeType, storeSlug, productId, channelUid, uaInfo, isMobile, cookieStr) {
  const ruleId = nextRuleId();
  let apiUrl, referer;

  if (isMobile) {
    if (storeType === 'smartstore') {
      apiUrl = 'https://m.smartstore.naver.com/i/v2/channels/' + channelUid + '/products/' + productId + '?withWindow=false';
      referer = 'https://m.smartstore.naver.com/' + storeSlug + '/products/' + productId;
    } else {
      apiUrl = 'https://m.brand.naver.com/n/v2/channels/' + channelUid + '/products/' + productId + '?withWindow=false';
      referer = 'https://m.brand.naver.com/' + storeSlug + '/products/' + productId;
    }
  } else {
    if (storeType === 'smartstore') {
      apiUrl = 'https://smartstore.naver.com/i/v2/channels/' + channelUid + '/products/' + productId + '?withWindow=false';
      referer = 'https://smartstore.naver.com/' + storeSlug + '/products/' + productId;
    } else {
      apiUrl = 'https://brand.naver.com/n/v2/channels/' + channelUid + '/products/' + productId + '?withWindow=false';
      referer = 'https://brand.naver.com/' + storeSlug + '/products/' + productId;
    }
  }

  await setDynamicRule(ruleId, apiUrl, referer, uaInfo, isMobile, cookieStr);
  try {
    const res = await fetchWithTimeout(apiUrl, { credentials: 'include' }, API_TIMEOUT);
    if (!res.ok) throw new Error('상품 API HTTP ' + res.status);
    const text = await res.text();
    if (!text || text.trim() === '') throw new Error('상품 API 빈 응답 (HTTP ' + res.status + ')');
    try {
      return JSON.parse(text);
    } catch (jsonErr) {
      throw new Error('상품 API JSON 파싱 실패 (응답 잘림): ' + jsonErr.message);
    }
  } finally {
    await removeRule(ruleId);
  }
}

/**
 * 네이버 API 호출용 declarativeNetRequest 동적 규칙을 등록한다.
 * Referer, Cookie, Sec-Ch-Ua 등 실제 브라우저 요청과 동일한 헤더를 주입한다.
 * @param {number} ruleId - 동적 규칙 ID (31~50)
 * @param {string} urlFilter - 규칙을 적용할 URL 필터
 * @param {string} referer - 주입할 Referer 에더넷 값
 * @param {{brands: string, fullBrands: string, platform: string}} uaInfo - User-Agent 정보
 * @param {boolean} isMobile - 모바일 UA 적용 여부
 * @param {string|null} cookieStr - 주입할 Cookie 헤더 값
 * @returns {Promise<void>}
 */
async function setDynamicRule(ruleId, urlFilter, referer, uaInfo, isMobile, cookieStr) {
  const secChUaMobile = isMobile ? '?1' : '?0';

  const requestHeaders = [
    { header: 'Accept',             operation: 'set',    value: 'application/json, text/plain, */*' },
    { header: 'Accept-Encoding',    operation: 'set',    value: 'gzip, deflate, br, zstd' },
    { header: 'Accept-Language',    operation: 'set',    value: 'ko,en-US;q=0.9,en;q=0.8,ko-KR;q=0.7' },
    { header: 'Sec-Ch-Ua',          operation: 'set',    value: uaInfo.brands },
    { header: 'Sec-Ch-Ua-Mobile',   operation: 'set',    value: secChUaMobile },
    // 아이템스카우트 원문: `"${n.platform}"` → 따옴표 포함
    { header: 'Sec-Ch-Ua-Platform', operation: 'set',    value: '"' + uaInfo.platform + '"' },
    { header: 'Sec-Fetch-Site',     operation: 'set',    value: 'same-origin' },
    { header: 'Sec-Fetch-Mode',     operation: 'set',    value: 'cors' },
    { header: 'Sec-Fetch-Dest',     operation: 'set',    value: 'empty' },
    { header: 'Referer',            operation: 'set',    value: referer },
    { header: 'priority',           operation: 'set',    value: 'u=1, i' }
  ];

  // Cookie 헤더 주입 (아이템스카우트는 h[] 배열에서 랜덤 선택, 우리는 실제 브라우저 쿠키 사용)
  if (cookieStr) {
    requestHeaders.push({ header: 'Cookie', operation: 'set', value: cookieStr });
  }

  const rule = {
    id:       ruleId,
    priority: 2,
    action: {
      type: 'modifyHeaders',
      requestHeaders: requestHeaders
    },
    condition: {
      urlFilter:                urlFilter,
      resourceTypes:            ['xmlhttprequest'],
      // 아이템스카우트와 동일: m. 도메인 제외 안 함
      excludedInitiatorDomains: [
        'smartstore.naver.com', 'brand.naver.com'
      ]
    }
  };

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules:      [rule]
  });
}

/**
 * 지정한 ID의 declarativeNetRequest 동적 규칙을 제거한다.
 * @param {number} ruleId - 제거할 규칙 ID
 * @returns {Promise<void>}
 */
async function removeRule(ruleId) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules:      []
  }).catch(function() {});
}

/**
 * 타임아웃이 적용된 fetch를 실행한다.
 * @param {string} url - 요청 URL
 * @param {RequestInit} options - fetch 옵션
 * @param {number} timeoutMs - 타임아웃 제한 시간 (ms)
 * @returns {Promise<Response>} fetch 응답
 */
function fetchWithTimeout(url, options, timeoutMs) {
  return new Promise(function(resolve, reject) {
    const timer = setTimeout(function() {
      reject(new Error('fetch 타임아웃 (' + timeoutMs + 'ms): ' + url));
    }, timeoutMs);
    fetch(url, options)
      .then(function(res) { clearTimeout(timer); resolve(res); })
      .catch(function(err) { clearTimeout(timer); reject(err); });
  });
}

/**
 * 네이버 상품 URL을 파싱해 storeType, storeSlug, productId를 있는 객체를 반환한다.
 * @param {string} url - 네이버 상품 URL
 * @returns {{storeType: 'smartstore'|'brand', storeSlug: string, productId: string}} 파싱 결과
 * @throws {Error} URL 형식이 유효하지 않으면
 */
function parseNaverUrl(url) {
  const m = url.match(/https:\/\/(smartstore|brand)\.naver\.com\/([^/]+)\/products\/(\d+)/);
  if (!m) throw new Error('URL 파싱 실패: ' + url);
  return {
    storeType: m[1] === 'brand' ? 'brand' : 'smartstore',
    storeSlug: m[2],
    productId: m[3]
  };
}

/**
 * URL에서 productId(마지막 숫자)를 추출한다. productNo 폴백용.
 * @param {string} url - 네이버 상품 URL
 * @returns {string} 상품 ID 문자열, 파싱 실패 시 빈 문자열
 */
function extractProductNoFromUrl(url) {
  const m = url && url.match(/\/products\/(\d+)/);
  return m ? m[1] : '';
}

/**
 * URL이 유효한 네이버 상품 URL 형식인지 확인한다.
 * @param {string} url - 코인할 URL
 * @returns {boolean} 유효한 네이버 상품 URL이면 true
 */
function isValidNaverUrl(url) {
  return /^https:\/\/(smartstore|brand)\.naver\.com\/[^/]+\/products\/\d+/.test(url);
}

/**
 * API 응답으로부터 {product, options, supplements} 구조의 수집 결과를 생성한다.
 * product의 stockQuantity는 옵션+추가상품 재고 합산값이다.
 * @param {string} productUrl - 네이버 상품 페이지 URL
 * @param {Object|null} data - 상품 API 응답 JSON 객체
 * @returns {{product: Object, options: Object[], supplements: Object[]}} 수집 결과
 */
function buildProductResult(productUrl, data) {
  if (!data) return { product: makeError(productUrl, 'API 응답 비어있음'), options: [], supplements: [] };

  const amt = data.reviewAmount      || {};
  const bv = data.benefitsView      || {};
  const cat = data.category          || {};
  const ch = data.channel           || {};
  const pdi = data.productDeliveryInfo || {};
  const nss = data.naverShoppingSearchInfo || {};

  const channelUid = data.channelUid  || ch.channelUid  || null;
  const channelId = data.channelId   || ch.channelNo   || ch.id       || ch.channelId || null;
  const channelName = data.channelName || ch.channelName || null;

  // productId = URL 끝 숫자 (id 필드), productNo = 내부 상품번호
  const productId = String(data.id != null ? data.id : extractProductNoFromUrl(productUrl));
  const productNo = String(data.productNo != null ? data.productNo : productId);

  // null 헬퍼: 빈 문자열/undefined/null → null, 숫자 0은 0 유지
  function nn(v) { return (v != null && v !== '') ? v : null; }

  // 상품 공통 필드
  const baseProduct = {
    productId:           productId,
    productNo:           productNo,
    mallNo:              data.mallNo != null ? data.mallNo : (data.mallSeq != null ? data.mallSeq : (ch.mallSeq != null ? ch.mallSeq : (ch.brandMallSeq != null ? ch.brandMallSeq : null))),
    mallName:            channelName,
    channelId:           channelId != null ? String(channelId) : null,
    channelName:         channelName,
    brandId:             data.brandId       != null ? String(data.brandId)       : (nss.brandId != null ? String(nss.brandId) : null),
    brandName:           nn(data.brandName != null ? data.brandName : (nss.brandName || null)),
    categoryId:          nn(cat.categoryId),
    categoryName:        nn(cat.categoryName),
    productName:         nn(data.name),
    price:               data.salePrice     != null ? data.salePrice     : null,
    salesPrice:          bv.discountedSalePrice != null ? bv.discountedSalePrice : (data.discountedSalePrice != null ? data.discountedSalePrice : (data.salePrice != null ? data.salePrice : null)),
    reviewCount:         amt.totalReviewCount   != null ? amt.totalReviewCount   : null,
    reviewScore:         amt.averageReviewScore != null ? +Number(amt.averageReviewScore).toFixed(2) : null,
    soldout:             data.soldout != null ? !!data.soldout : null,
    status:              'success',
    deliveryType:        nn(pdi.deliveryAttributeType),
    wholeCategoryId:     nn(cat.wholeCategoryId),
    wholeCategoryName:   nn(cat.wholeCategoryName),
    productUrl:          productUrl,
    channelUid:          channelUid,
    timestamp:           new Date().toISOString()
  };

  const optionRows = [];
  const supplementRows = [];

  // optionGroup 이름 추출 (options 배열에서 순서대로)
  const optionsArr = Array.isArray(data.options) ? data.options : [];
  const optionGroup1 = optionsArr[0] ? optionsArr[0].groupName : null;
  const optionGroup2 = optionsArr[1] ? optionsArr[1].groupName : null;
  const optionGroup3 = optionsArr[2] ? optionsArr[2].groupName : null;

  // optionCombinations (조합형 옵션)
  if (data.optionUsable && Array.isArray(data.optionCombinations) && data.optionCombinations.length > 0) {
    for (const opt of data.optionCombinations) {
      optionRows.push({
        productId:      productId,
        optionId:       opt.id != null ? String(opt.id) : null,
        optionSeq:      opt.regOrder != null ? opt.regOrder : null,
        optionGroup1:   optionGroup1,
        optionName1:    opt.optionName1 || null,
        optionGroup2:   optionGroup2,
        optionName2:    opt.optionName2 || null,
        optionGroup3:   optionGroup3,
        optionName3:    opt.optionName3 || null,
        optionPrice:    opt.price != null ? opt.price : null,
        stockQuantity:  opt.stockQuantity != null ? opt.stockQuantity : null,
        registerDate:   normalizeDate(opt.registerDate),
        timestamp:      baseProduct.timestamp
      });
    }
  }

  // optionSimple (단독형 옵션)
  else if (data.optionUsable && Array.isArray(data.options) && data.options.length > 0
          && (!data.optionCombinations || data.optionCombinations.length === 0)) {
    for (const opt of data.options) {
      if (opt.stockQuantity != null || opt.price != null) {
        optionRows.push({
          productId:      productId,
          optionId:       opt.id != null ? String(opt.id) : null,
          optionSeq:      opt.regOrder != null ? opt.regOrder : null,
          optionGroup1:   opt.groupName || null,
          optionName1:    opt.name || null,
          optionGroup2:   null,
          optionName2:    null,
          optionGroup3:   null,
          optionName3:    null,
          optionPrice:    opt.price != null ? opt.price : null,
          stockQuantity:  opt.stockQuantity != null ? opt.stockQuantity : null,
          registerDate:   null,
          timestamp:      baseProduct.timestamp
        });
      }
    }
  }

  // supplementProducts (추가상품)
  if (data.supplementProductUsable && Array.isArray(data.supplementProducts) && data.supplementProducts.length > 0) {
    data.supplementProducts.forEach(function(sup, idx) {
      supplementRows.push({
        productId:      productId,
        optionId:       sup.id != null ? String(sup.id) : null,
        optionSeq:      idx,
        optionGroup1:   sup.groupName || null,
        optionName1:    sup.name || null,
        optionGroup2:   null,
        optionName2:    null,
        optionGroup3:   null,
        optionName3:    null,
        optionPrice:    sup.price != null ? sup.price : null,
        stockQuantity:  sup.stockQuantity != null ? sup.stockQuantity : null,
        registerDate:   null,
        timestamp:      baseProduct.timestamp
      });
    });
  }

  // 상품 stockQuantity = 옵션+추가상품 합산 (옵션 있으면 합산, 없으면 원래값)
  const allOptionStocks = optionRows.concat(supplementRows)
    .map(function(r) { return r.stockQuantity; })
    .filter(function(v) { return v != null && v >= 0; });
  if (allOptionStocks.length > 0) {
    baseProduct.stockQuantity = allOptionStocks.reduce(function(a, b) { return a + b; }, 0);
  } else {
    baseProduct.stockQuantity = data.stockQuantity != null ? data.stockQuantity : null;
  }
  // soldout: 재고 합산 후 최종 판단 (재고 0이면 true, null이면 API 값 그대로)
  if (baseProduct.stockQuantity != null) {
    baseProduct.soldout = baseProduct.stockQuantity === 0;
  }
  // soldout이 여전히 null이고 API에 soldout 필드가 있으면 그 값 사용
  if (baseProduct.soldout == null && data.soldout != null) {
    baseProduct.soldout = !!data.soldout;
  }

  return { product: baseProduct, options: optionRows, supplements: supplementRows };
}

/**
 * registerDate 문자열을 ISO 8601 UTC 형식으로 정규화한다.
 * @param {string|null} dateStr - 변환할 날짜 문자열
 * @returns {string|null} ISO 형식 문자열, 입력값이 없으면 null
 */
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toISOString();
  } catch (e) {
    return dateStr;
  }
}

/**
 * 수집 진행 상황을 chrome.storage.local에 저장하고 팝업에 메시지로 전송한다.
 * @param {number} current - 현재 처리 완료된 상품 수
 * @param {number} total - 전체 상품 수
 * @param {string} currentUrl - 현재 처리 중인 URL
 */
function sendProgress(current, total, currentUrl) {
  const progress = {
    current,
    total,
    currentUrl,
    percent: total > 0 ? Math.round((current / total) * 100) : 0
  };
  chrome.storage.local.set({ collectionProgress: progress }).catch(() => {});
  chrome.runtime.sendMessage({
    action:     'progressUpdate',
    ...progress
  }).catch(function() {});
}

// CSV 생성
// v3.4.0: 상품/옵션/추가상품 각각 별도 컬럼 세트
const PRODUCT_COLUMNS = [
  ['상품코드',            'productId'],
  ['상품번호',            'productNo'],
  ['판매처순번',          'mallNo'],
  ['판매처명',            'mallName'],
  ['채널ID',             'channelId'],
  ['채널명',             'channelName'],
  ['브랜드ID',           'brandId'],
  ['브랜드명',           'brandName'],
  ['카테고리ID',         'categoryId'],
  ['카테고리',           'categoryName'],
  ['상품명',             'productName'],
  ['판매가',             'price'],
  ['할인가',             'salesPrice'],
  ['재고수량',           'stockQuantity'],
  ['리뷰수',             'reviewCount'],
  ['평점',              'reviewScore'],
  ['품절여부',           'soldout'],
  ['상태',              'status'],
  ['배송속성',           'deliveryType'],
  ['전체카테고리ID',      'wholeCategoryId'],
  ['전체카테고리',        'wholeCategoryName'],
  ['상품주소',           'productUrl'],
  ['채널UID',           'channelUid'],
  ['오류메시지',         'errorMessage'],
  ['수집시간',           'timestamp']
];

const OPTION_COLUMNS = [
  ['상품코드',           'productId'],
  ['옵션코드',           'optionId'],
  ['옵션순번',           'optionSeq'],
  ['옵션그룹1',          'optionGroup1'],
  ['옵션명1',            'optionName1'],
  ['옵션그룹2',          'optionGroup2'],
  ['옵션명2',            'optionName2'],
  ['옵션그룹3',          'optionGroup3'],
  ['옵션명3',            'optionName3'],
  ['옵션가',             'optionPrice'],
  ['재고수량',           'stockQuantity'],
  ['옵션등록일',          'registerDate'],
  ['수집시간',           'timestamp']
];

const SUPPLEMENT_COLUMNS = [
  ['상품코드',           'productId'],
  ['옵션코드',           'optionId'],
  ['옵션순번',           'optionSeq'],
  ['옵션그룹1',          'optionGroup1'],
  ['옵션명1',            'optionName1'],
  ['옵션가',             'optionPrice'],
  ['재고수량',           'stockQuantity'],
  ['수집시간',           'timestamp']
];

// 하위 호환용 (JSON 키 정렬 등)
const CSV_COLUMNS = PRODUCT_COLUMNS;

/**
 * PRODUCT_COLUMNS 순서대로 결과 객체의 키를 정렬한다. JSON 내보내기 시 콜럼 순서 유지용.
 * @param {Object} item - 정렬할 상품 결과 객체
 * @returns {Object} 키가 정렬된 새 객체
 */
function sortResultKeys(item) {
  const ordered = {};
  PRODUCT_COLUMNS.forEach(function(col) {
    const key = col[1];
    if (key in item) ordered[key] = item[key];
  });
  Object.keys(item).forEach(function(k) {
    if (!(k in ordered)) ordered[k] = item[k];
  });
  return ordered;
}

/**
 * 데이터 배열을 주어진 컬럼 정의로 CSV 문자열로 변환한다.
 * @param {Object[]} data - 변환할 데이터 배열
 * @param {Array<[string, string]>} [columns] - [CSV 헤더, 키명] 튜플 배열 (default: PRODUCT_COLUMNS)
 * @returns {string} UTF-8 CSV 문자열
 */
function buildCSV(data, columns) {
  columns = columns || PRODUCT_COLUMNS;
  const safeData = data.filter(Boolean);
  const headers = columns.map(function(c) { return c[0]; });
  const rows = safeData.map(function(item) {
    return columns.map(function(col) {
      const key = col[1];
      const v = item[key];
      if (key === 'soldout') {
        return v === true ? 'Y' : (v === false ? 'N' : '');
      }
      return v != null ? v : '';
    });
  });
  function esc(v) {
    const s = String(v != null ? v : '');
    return (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0)
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  return [headers].concat(rows).map(function(r) { return r.map(esc).join(','); }).join('\r\n');
}

// 유틸리티
/**
 * 타임스탬프 문자열을 생성한다 (예: 20260305125530).
 * @returns {string} YYYYMMDDHHmmss 형식 안의 타임스킬프
 */
function buildTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return String(d.getFullYear())
    + pad(d.getMonth() + 1)
    + pad(d.getDate())
    + pad(d.getHours())
    + pad(d.getMinutes())
    + pad(d.getSeconds());
}

/**
 * 에러 상태의 상품 결과 객체를 생성한다. 모든 데이터 필드는 null로 채워진다.
 * @param {string} url - 실패한 상품 URL
 * @param {string} errorMessage - 오류 메시지
 * @returns {Object} 에러 상태의 상품 결과 객체
 */
function makeError(url, errorMessage) {
  const pid = extractProductNoFromUrl(url);
  return {
    productId:         pid,
    productNo:         pid,
    mallNo:            null,
    mallName:          null,
    channelId:         null,
    channelName:       null,
    brandId:           null,
    brandName:         null,
    categoryId:        null,
    categoryName:      null,
    productName:       null,
    price:             null,
    salesPrice:        null,
    stockQuantity:     null,
    reviewCount:       null,
    reviewScore:       null,
    soldout:           null,
    status:            'error',
    deliveryType:      null,
    wholeCategoryId:   null,
    wholeCategoryName: null,
    productUrl:        url,
    channelUid:        null,
    errorMessage:      errorMessage,
    timestamp:         new Date().toISOString()
  };
}

/**
 * ms 밀리초만큼 대기하는 Promise를 반환한다.
 * @param {number} ms - 대기 시간 (ms)
 * @returns {Promise<void>}
 */
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

/**
 * _delayMin~_delayMax 범위의 랜덤 대기 시간을 ms 단위로 반환한다.
 * @returns {number} 랜덤 대기 시간 (ms)
 */
function randomDelay() {
  return _delayMin + Math.floor(Math.random() * (_delayMax - _delayMin));
}

// 설치 초기화
chrome.runtime.onInstalled.addListener(function() {
  chrome.storage.local.set({ collectionResults: { products: [], options: [], supplements: [] }, isRunning: false, stopRequested: false });
  console.log('[BG] NSP-Extractor 설치됨');
  // 설치 시 저장된 스케줄 설정 복원
  chrome.storage.local.get('scheduleConfig', function({ scheduleConfig }) {
    if (scheduleConfig) applyScheduleAlarm(scheduleConfig);
  });
});

// Service Worker 재시작 시 스케줄 복원 (alarm은 브라우저 재시작 후에도 유지되나
// SW 컨텍스트 변수는 재초기화되므로 alarm 발화 시 설정을 storage에서 다시 읽음)
chrome.alarms.onAlarm.addListener(async function(alarm) {
  if (alarm.name !== 'nsp-schedule') return;

  try {
    // 설정 재로드
    await loadProxyConfig();
    await loadDelayConfig();

    const { scheduleConfig } = await chrome.storage.local.get('scheduleConfig');
    if (!scheduleConfig || !scheduleConfig.enabled) return;

    // URL 목록 로드 (storage에 저장된 기본 URL 파일 내용 사용)
    const { defaultFileContent, defaultFileName } = await chrome.storage.local.get(['defaultFileContent', 'defaultFileName']);
    if (!defaultFileContent || !defaultFileContent.trim()) {
      console.warn('[BG] 스케줄: 기본 URL 파일 없음');
      return;
    }

    const urls = defaultFileContent.split('\n')
      .map(function(l) { return l.trim(); })
      .filter(function(l) { return /^https:\/\/(smartstore|brand)\.naver\.com\/[^/]+\/products\/\d+/.test(l); });

    if (urls.length === 0) {
      console.warn('[BG] 스케줄: 유효한 URL 없음');
      return;
    }

    // 이미 수집 중이면 건너뜀
    const { isRunning } = await chrome.storage.local.get('isRunning');
    if (isRunning) {
      console.warn('[BG] 스케줄: 이미 수집 중 → 건너뜀');
      return;
    }

    // 프록시 적용 후 수집 실행
    await applyCurrentProxy();
    await runCollection(urls, defaultFileName || 'schedule');
  } catch (e) {
    console.error('[BG] 스케줄 수집 오류: ' + e.message);
  }
});

/**
 * 스케줄 설정에 따라 chrome.alarms를 등록하거나 해제한다.
 * @param {{enabled: boolean, time: string}} cfg - 스케줄 설정 (HH:MM 형식)
 * @returns {Promise<void>}
 */
async function applyScheduleAlarm(cfg) {
  // 기존 alarm 제거
  await chrome.alarms.clear('nsp-schedule');

  if (!cfg || !cfg.enabled || !cfg.time) {
    await chrome.alarms.clear('nsp-schedule');
    return;
  }

  // 다음 발화 시각 계산 (오늘 HH:MM이 이미 지났으면 내일로)
  const [hh, mm] = cfg.time.split(':').map(Number);
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  await chrome.alarms.create('nsp-schedule', {
    when:            target.getTime(),
    periodInMinutes: 24 * 60  // 매일 같은 시각 반복
  });
}

/**
 * Slack Files API에 파일을 업로드하고 file_id를 반환한다. (completeUploadExternal 단계 제외)
 * ⚠️ Content-Type 반드시 application/x-www-form-urlencoded 사용 (JSON으로 보내면 length/filename 인식 안 됨)
 * @param {string} token - Slack Bot Token (xoxb-...)
 * @param {Uint8Array} fileBytes - 업로드할 파일 이진 데이터
 * @param {string} fname - 파일명
 * @param {string} mimeType - MIME 타입 (e.g. 'text/csv', 'application/json')
 * @returns {Promise<{id: string, title: string}>} Slack file_id와 파일명
 */
async function prepareSlackUpload(token, fileBytes, fname, mimeType) {
  // Step 1: 업로드 URL 획득
  // ⚠️ Content-Type 반드시 application/x-www-form-urlencoded (JSON으로 보내면 length/filename 인식 안 됨)
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Bearer ' + token
    },
    body: 'filename=' + encodeURIComponent(fname) + '&length=' + fileBytes.byteLength
  });
  const urlJson = await urlRes.json();
  if (!urlJson.ok) throw new Error('getUploadURLExternal 실패: ' + urlJson.error);

  // Step 2: 파일 바이너리 업로드 (multipart/form-data)
  const formData = new FormData();
  formData.append('file', new Blob([fileBytes], { type: mimeType }), fname);

  const uploadRes = await fetch(urlJson.upload_url, {
    method: 'POST',
    body:   formData
  });
  if (!uploadRes.ok) {
    throw new Error('파일 업로드 실패 (HTTP ' + uploadRes.status + ')');
  }

  console.log('[BG] Slack 업로드 준비 완료: ' + fname + ' (id=' + urlJson.file_id + ')');
  return { id: urlJson.file_id, title: fname };
}

/**
 * 에 준비된 파일들을 한 번의 completeUploadExternal 호출로 완료하고 선택된 슬랙 채널에 공유한다.
 * @param {string} token - Slack Bot Token (xoxb-...)
 * @param {string} channel - 업로드할 슬랙 채널 ID
 * @param {{id: string, title: string}[]} fileEntries - prepareSlackUpload 반환값 배열
 * @param {string|null} initialComment - 첫 메시지 (없으면 null)
 * @returns {Promise<void>}
 */
async function completeSlackUpload(token, channel, fileEntries, initialComment) {
  // Step 3: 업로드 완료 + 채널 공유 — fileEntries = [{id, title}, ...]
  // files 배열에 여러 항목을 담으면 Slack이 단일 메시지에 모든 파일을 첨부
  const completeBody = {
    files:      fileEntries,
    channel_id: channel
  };
  if (initialComment) completeBody.initial_comment = initialComment;

  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json; charset=utf-8',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify(completeBody)
  });
  const completeJson = await completeRes.json();
  if (!completeJson.ok) throw new Error('completeUploadExternal 실패: ' + completeJson.error);

  console.log('[BG] Slack 전송 완료: ' + fileEntries.length + '개 파일 → 채널 ' + channel);
}

/**
 * 수집 결과를 Slack에 파일(상품/옵션/추가상품기준)으로 업로드하고 요약 메시지를 전송한다.
 * slackConfig.enabled가 false이거나 토큰/채널이 없으면 실행되지 않는다.
 * @param {{products: Object[], options: Object[], supplements: Object[]}} results - 수집 결과
 * @returns {Promise<void>}
 */
async function sendSlackNotification(results) {
  const { slackConfig } = await chrome.storage.local.get('slackConfig');
  if (!slackConfig || !slackConfig.enabled || !slackConfig.token || !slackConfig.channel) return;

  const token = slackConfig.token.trim();
  const channel = slackConfig.channel.trim();
  if (!token || !channel) return;

  const products = results.products || [];
  const options = results.options  || [];
  const supps = results.supplements || [];
  const total = products.length;
  const ok = products.filter(function(r) { return r && r.status === 'success'; }).length;
  const paused = products.filter(function(r) { return r && r.status === 'paused'; }).length;
  const deleted = products.filter(function(r) { return r && r.status === 'deleted'; }).length;
  const soldout = products.filter(function(r) { return r && r.status === 'soldout'; }).length;
  const err = products.filter(function(r) { return r && r.status === 'error'; }).length;

  const now = new Date();
  const pad = function(n) { return String(n).padStart(2, '0'); };
  const dateStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
    + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

  const summary = [
    '> ' + dateStr,
    '네이버 상품 - 총 ' + total + '개 수집 완료 (옵션 ' + options.length + '행, 추가상품 ' + supps.length + '행)',
    '성공: ' + ok + ', 판매중지: ' + paused + ', 삭제: ' + deleted + ', 품절: ' + soldout + ', 실패: ' + err
  ].join('\n');

  // 내보내기 설정 로드
  const { exportSettings = {} } = await chrome.storage.local.get('exportSettings');
  const fmt = exportSettings.format            || 'csv';
  const prefixProd = exportSettings.prefix            || '네이버상품';
  const prefixOpt = exportSettings.prefixOption      || '네이버옵션';
  const prefixSup = exportSettings.prefixSupplement  || '네이버추가상품';
  const ts = buildTimestamp();

  if (fmt === 'json') {
    // JSON: 단일 파일 — 바로 complete
    const jsonStr = JSON.stringify({
      products:    products.map(sortResultKeys),
      options:     options,
      supplements: supps
    }, null, 2);
    const fileBytes = new TextEncoder().encode(jsonStr);
    const fname = prefixProd + '_' + ts + '.json';
    const entry = await prepareSlackUpload(token, fileBytes, fname, 'application/json');
    await completeSlackUpload(token, channel, [entry], summary);
  } else {
    // CSV: 상품(항상) + 옵션(있을 때) + 추가상품(있을 때)
    // 각 파일을 개별 업로드한 뒤 complete 1회로 묶어 단일 메시지에 첨부
    const fileEntries = [];

    const prodBytes = new TextEncoder().encode('\uFEFF' + buildCSV(products, PRODUCT_COLUMNS));
    fileEntries.push(await prepareSlackUpload(token, prodBytes, prefixProd + '_' + ts + '.csv', 'text/csv'));

    if (options.length > 0) {
      const optBytes = new TextEncoder().encode('\uFEFF' + buildCSV(options, OPTION_COLUMNS));
      fileEntries.push(await prepareSlackUpload(token, optBytes, prefixOpt + '_' + ts + '.csv', 'text/csv'));
    }

    if (supps.length > 0) {
      const supBytes = new TextEncoder().encode('\uFEFF' + buildCSV(supps, SUPPLEMENT_COLUMNS));
      fileEntries.push(await prepareSlackUpload(token, supBytes, prefixSup + '_' + ts + '.csv', 'text/csv'));
    }

    // 모든 파일을 한 번의 complete 호출로 단일 메시지에 묶어 전송
    await completeSlackUpload(token, channel, fileEntries, summary);
    console.log('[BG] Slack CSV ' + fileEntries.length + '개 파일 단일 메시지 전송 완료');
  }
}