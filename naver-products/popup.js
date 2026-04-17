'use strict';

// DOM 참조
const $ = id => document.getElementById(id);

// 공통
const statusBadge = $('statusBadge');
const statusMsg = $('statusMsg');

// 탭
const tabBtns = document.querySelectorAll('.tab-btn');

// 수집 탭
const fileInput = $('fileInput');
const loadFileBtn = $('loadFileBtn');
const clearFileBtn = $('clearFileBtn');
const fileInfo = $('fileInfo');
const fileNameLabel = $('fileNameLabel');
const urlInput = $('urlInput');
const urlCount = $('urlCount');
const pasteBtn = $('pasteBtn');
const clearInputBtn = $('clearInputBtn');
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const exportBtn = $('exportBtn');
const progressSection = $('progressSection');
const progressBar = $('progressBar');
const progressText = $('progressText');
const currentUrlText = $('currentUrlText');
const proxyStatus = $('proxyStatus');
const proxyStatusText = $('proxyStatusText');
const proxyActiveBadge = $('proxyActiveBadge');
const proxyActiveBadgeText = $('proxyActiveBadgeText');
const resultsSection = $('resultsSection');
const resultsBody = $('resultsBody');
const resultStats = $('resultStats');

// 설정 탭
const proxyEnabled = $('proxyEnabled');
const proxyEnabledLabel = $('proxyEnabledLabel');
const proxyInput = $('proxyInput');
const proxyCount = $('proxyCount');
const testProxyBtn = $('testProxyBtn');
const proxyTestResult = $('proxyTestResult');
const proxyRotateInterval = $('proxyRotateInterval');
const proxyErrorThreshold = $('proxyErrorThreshold');
const selectDefaultFileBtn = $('selectDefaultFileBtn');
const defaultFileInput = $('defaultFileInput');
const defaultFileInfo = $('defaultFileInfo');
const defaultFilePathInput = $('defaultFilePathInput');
const clearResultsBtn = $('clearResultsBtn');
const savedResultsInfo = $('savedResultsInfo');
// 설정 관리
const exportConfigBtn = $('exportConfigBtn');
const importConfigBtn = $('importConfigBtn');
const importConfigInput = $('importConfigInput');
// 내보내기 설정
const formatCsv = $('formatCsv');
const formatJson = $('formatJson');
const autoExport = $('autoExport');
const exportPrefix = $('exportPrefix');
const exportPrefixOption = $('exportPrefixOption');
const exportPrefixSupplement = $('exportPrefixSupplement');
// 딜레이 설정
const delayMinInput = $('delayMin');
const delayMaxInput = $('delayMax');
// 스케줄 설정
const scheduleEnabled = $('scheduleEnabled');
const scheduleEnabledLabel = $('scheduleEnabledLabel');
const scheduleTime = $('scheduleTime');
const scheduleNextInfo = $('scheduleNextInfo');
// Slack 설정
const slackEnabled = $('slackEnabled');
const slackEnabledLabel = $('slackEnabledLabel');
const slackToken = $('slackToken');
const slackChannel = $('slackChannel');

let isRunning = false;
let pollTimer = null;  // 진행 상황 polling 타이머
let timerTick = null;  // 경과/남은시간 1초 갱신 타이머
let proxyPollTimer = null; // 프록시 상태 주기 갱신 타이머 (수집 중 아닐 때도 동작)
let _collectionStartTime = null;  // 수집 시작 시각 (elapsed 계산용, storage에서 로드)
let _currentUrlSource = 'manual';  // 현재 URL 소스 (파일명 or 'manual')

// 탭 전환
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('tab-active'));
    btn.classList.add('tab-active');
    document.querySelectorAll('.tab-content').forEach(t => { t.style.display = 'none'; });
    $('tab-' + btn.dataset.tab).style.display = 'block';

    if (btn.dataset.tab === 'settings') loadSettingsTab();
    if (btn.dataset.tab === 'collect')  refreshProxyActiveBadge();
  });
});

// 초기화
document.addEventListener('DOMContentLoaded', async () => {
  // 이전 수집 결과 로드
  const { collectionResults = { products: [], options: [], supplements: [] }, isRunning: running, collectionStartTime } = await chrome.storage.local.get(['collectionResults', 'isRunning', 'collectionStartTime']);

  const products = collectionResults.products || [];
  if (products.length > 0) {
    renderResults(collectionResults);
    exportBtn.disabled = false;
    showMsg(`이전 수집 결과 ${products.length}개 상품이 있습니다.`, 'info');
  }

  // 수집 중이면 polling 재개
  if (running) {
    _collectionStartTime = collectionStartTime || Date.now();
    setRunning(true);
    progressSection.style.display = 'block';  // 진행 상황 섹션 표시
    // 현재 진행 상황 즉시 렌더링 (polling 첫 틱 이전에 빈 화면 방지)
    const { collectionProgress } = await chrome.storage.local.get('collectionProgress');
    if (collectionProgress) {
      updateProgress(collectionProgress.current, collectionProgress.total, collectionProgress.currentUrl);
    }
    startPolling();
  } else if (collectionStartTime) {
    // 수집 완료/중단 후에도 시작 시간 유지 → 경과시간 표시
    _collectionStartTime = collectionStartTime;
    if (collectionResults.length > 0) {
      progressSection.style.display = 'block';
      tickTimer();  // 완료 상태에서도 경과시간 1회 렌더링
    }
  }

  // 기본 URL 파일 자동 로드
  await tryLoadDefaultFile();

  // 프록시 설정 로드해서 토글 상태 반영
  const res = await chrome.runtime.sendMessage({ action: 'getProxyConfig' });
  if (res?.success && res.config.enabled && res.config.proxies?.length > 0) {
    showProxyBadge(res.config.proxies.length);
  }

  // 내보내기 버튼 레이블 초기화
  const exInit = await chrome.runtime.sendMessage({ action: 'getExportSettings' });
  if (exInit?.success) {
    updateExportBtnLabel(exInit.settings.format || 'csv');
    updatePrefixDisabled(exInit.settings.format || 'csv');
  }

  // 현재 활성 프록시 IP 표시
  await refreshProxyActiveBadge();

  // 프록시 배지 주기 갱신 (수집 중 여부와 무관하게 3초마다 최신 상태 반영)
  proxyPollTimer = setInterval(refreshProxyActiveBadge, 3000);
});

// 기본 URL 파일 자동 로드
// File System Access API를 사용: fileHandle을 IndexedDB에 보관
// → 팝업 열릴 때마다 fileHandle.getFile()로 최신 내용 읽기
// 지원하지 않는 환경이면 chrome.storage fallback

const IDB_DB_NAME = 'nsp-extractor-db';
const IDB_STORE_NAME = 'handles';
const IDB_KEY = 'defaultFileHandle';

/**
 * 파일 핸들 보관용 IndexedDB를 열고 데이터베이스를 반환한다.
 * @returns {Promise<IDBDatabase>} 열린 IndexedDB 데이터베이스
 */
function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE_NAME);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

/**
 * FileSystemFileHandle을 IndexedDB에 저장한다.
 * @param {FileSystemFileHandle} handle - 저장할 파일 핸들
 * @returns {Promise<void>}
 */
async function saveFileHandle(handle) {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    tx.objectStore(IDB_STORE_NAME).put(handle, IDB_KEY);
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

/**
 * IndexedDB에서 저장된 FileSystemFileHandle을 불러온다.
 * @returns {Promise<FileSystemFileHandle|null>} 저장된 핸들, 없으면 null
 */
async function loadFileHandle() {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readonly');
    const req = tx.objectStore(IDB_STORE_NAME).get(IDB_KEY);
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror = e => reject(e.target.error);
  });
}

/**
 * 이전에 선택된 기본 URL 파일을 자동으로 urlInput에 불러온다.
 * File System Access API 지원 환경에서는 fileHandle로 최신 내용을 읽고, 미지원 시 chrome.storage로 폴백한다.
 * @returns {Promise<void>}
 */
async function tryLoadDefaultFile() {
  if (urlInput.value.trim() !== '') return;  // 이미 내용 있으면 건드리지 않음

  // File System Access API 지원 여부 확인
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const handle = await loadFileHandle();
      if (!handle) {
        // fileHandle 없으면 chrome.storage fallback
        return await _tryLoadDefaultFileLegacy();
      }
      // 권한 확인 (없으면 사용자 제스처 없이는 획득 불가 → fallback)
      const perm = await handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') {
        return await _tryLoadDefaultFileLegacy();
      }
      const file = await handle.getFile();
      const content = await file.text();
      urlInput.value = content;
      showFileInfo(file.name);
      refreshCount();
      // chrome.storage에도 최신 내용 동기화 (스케줄 수집 등에서 사용)
      await chrome.storage.local.set({ defaultFileContent: content, defaultFileName: file.name });
      return;
    } catch (e) {
      // 권한 거부 등 → fallback
    }
  }
  await _tryLoadDefaultFileLegacy();
}

/**
 * 기본 URL 파일을 chrome.storage fallback 방식으로 불러온다. (File System Access API 미지원 환경용)
 * @returns {Promise<void>}
 */
async function _tryLoadDefaultFileLegacy() {
  const { defaultFileContent, defaultFileName } = await chrome.storage.local.get(['defaultFileContent', 'defaultFileName']);
  if (defaultFileContent) {
    urlInput.value = defaultFileContent;
    showFileInfo(defaultFileName || '기본 파일');
    refreshCount();
  }
}

// 파일 로드 (수집 탭)
loadFileBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  urlInput.value = text;
  showFileInfo(file.name);
  refreshCount();
  fileInput.value = '';  // 동일 파일 재선택 허용
});

clearFileBtn.addEventListener('click', () => {
  fileInfo.style.display = 'none';
  urlInput.value = '';
  _currentUrlSource = 'manual';
  refreshCount();
});

/**
 * 파일 정보 영역에 파일명을 표시하고 urlSource를 갱신한다.
 * @param {string} name - 표시할 파일명
 */
function showFileInfo(name) {
  fileNameLabel.textContent = '📄 ' + name;
  fileInfo.style.display = 'flex';
  _currentUrlSource = name;  // 파일 로드 시 소스 업데이트
}

// URL 카운트
urlInput.addEventListener('input', refreshCount);

/**
 * urlInput의 내용을 파싱해 URL 수를 urlCount 엘리먼트에 갱신한다.
 */
function refreshCount() {
  const n = parseUrls(urlInput.value).length;
  urlCount.textContent = `${n.toLocaleString()}개 URL 인식됨`;
}

/**
 * 텍스트에서 유효한 네이버 상품 URL만 입후로 실행 보유 배열로 반환한다.
 * @param {string} text - 줄 구분 URL 텍스트
 * @returns {string[]} 유효한 URL 배열
 */
function parseUrls(text) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => /^https:\/\/(smartstore|brand)\.naver\.com\/[^/]+\/products\/\d+/.test(l));
}

// 붙여넣기
pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = (urlInput.value.trimEnd() + '\n' + text).trimStart();
    refreshCount();
  } catch {
    showMsg('클립보드 접근 실패. 직접 붙여넣기(Ctrl+V)를 사용하세요.', 'warning');
  }
});

clearInputBtn.addEventListener('click', () => {
  urlInput.value = '';
  fileInfo.style.display = 'none';
  _currentUrlSource = 'manual';
  refreshCount();
});

// 수집 시작
startBtn.addEventListener('click', async () => {
  if (isRunning) return;

  const urls = parseUrls(urlInput.value);
  if (urls.length === 0) {
    showMsg('유효한 네이버 상품 URL을 입력해주세요.\n예) https://smartstore.naver.com/store/products/12345', 'error');
    return;
  }

  setRunning(true);
  progressSection.style.display = 'block';
  updateProgress(0, urls.length, '');
  showMsg(`${urls.length.toLocaleString()}개 URL 수집 시작... (상품당 약 2~4초 소요)`, 'info');

  // storage에서 실제 시작 시간 읽기 (background.js가 먼저 set함)
  const { collectionStartTime: st } = await chrome.storage.local.get('collectionStartTime');
  _collectionStartTime = st || Date.now();

  // 진행 상황 polling 시작
  startPolling();

  try {
    const res = await chrome.runtime.sendMessage({
      action: 'startCollection',
      urls,
      urlSource: _currentUrlSource
    });

    stopPolling();

    // polling이 이미 완료 처리를 했을 수 있으므로 isRunning 확인
    if (!isRunning) return;  // polling에서 이미 처리 완료

    if (res?.success) {
      const data = res.data || { products: [], options: [], supplements: [] };
      const products = data.products || [];
      renderResults(data);
      exportBtn.disabled = products.length === 0;

      if (res.stopped) {
        showMsg(`⏹ 중단됨. ${products.length}개 상품 처리 완료. 저장 가능.`, 'warning');
        setBadge('idle', '중단됨');
      } else {
        const ok = products.filter(r => r?.status === 'success').length;
        const sp = products.filter(r => ['paused','deleted','soldout'].includes(r?.status)).length;
        const err = products.filter(r => r?.status === 'error').length;
        showMsg(`✅ 완료! 성공: ${ok}개 | 특수상태: ${sp}개 | 실패: ${err}개`, 'success');
        setBadge('done', '완료');
      }
    } else {
      showMsg(`❌ 오류: ${res?.error || '알 수 없는 오류'}`, 'error');
      setBadge('error', '오류');
    }
  } catch (err) {
    stopPolling();
    showMsg(`❌ 오류: ${err.message}`, 'error');
    setBadge('error', '오류');
  } finally {
    setRunning(false);
  }
});

// 수집 즉시 중단
stopBtn.addEventListener('click', async () => {
  showMsg('⏹ 중단 요청 중...', 'warning');
  stopBtn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({ action: 'stopCollection' });
    stopPolling();

    const data = res?.data || { products: [], options: [], supplements: [] };
    const products = data.products || [];
    if (products.length > 0) {
      renderResults(data);
      exportBtn.disabled = false;
    }

    showMsg(`⏹ 즉시 중단. ${products.length}개 상품 처리 완료. 저장 가능.`, 'warning');
    setBadge('idle', '중단됨');
  } catch (e) {
    showMsg('중단 요청 실패: ' + e.message, 'error');
  } finally {
    setRunning(false);
    stopBtn.disabled = false;
  }
});

// CSV/JSON 내보내기
exportBtn.addEventListener('click', async () => {
  try {
    const { exportSettings = {} } = await chrome.storage.local.get('exportSettings');
    const format = exportSettings.format          || 'csv';
    const prefix = exportSettings.prefix          || '네이버상품';
    const prefixOption = exportSettings.prefixOption    || '네이버옵션';
    const prefixSupplement = exportSettings.prefixSupplement || '네이버추가상품';

    const res = await chrome.runtime.sendMessage({
      action: 'exportData',
      format,
      prefix,
      prefixOption,
      prefixSupplement
    });
    if (res?.success) {
      showMsg(`💾 저장됨: ${res.filename}`, 'success');
    } else {
      showMsg(`❌ 내보내기 실패: ${res?.error}`, 'error');
    }
  } catch (err) {
    showMsg(`❌ 오류: ${err.message}`, 'error');
  }
});

// 진행 상황 Polling
// sendMessage로 진행 상황 메시지를 받는 방식의 한계 (팝업 닫혔다 열리면 리스너 끊김)
// → chrome.storage를 주기적으로 읽는 polling 방식으로 대체

/**
 * chrome.storage를 1초마다 폴링해 수집 진행 상황과 결과를 실시간 반영한다.
 */
function startPolling() {
  stopPolling();
  startTimerTick();  // 경과/남은시간 1초 tick 시작
  pollTimer = setInterval(async () => {
    try {
      const {
        collectionResults = { products: [], options: [], supplements: [] },
        isRunning: running,
        collectionProgress
      } = await chrome.storage.local.get(['collectionResults', 'isRunning', 'collectionProgress']);

      if (collectionProgress) {
        updateProgress(collectionProgress.current, collectionProgress.total, collectionProgress.currentUrl);
      }

      // 수집 결과 실시간 반영
      const products = collectionResults.products || [];
      if (products.length > 0) {
        renderResults(collectionResults);
        exportBtn.disabled = false;
      }

      if (!running && isRunning) {
        // background에서 수집 완료됨 → UI 완료 처리
        stopPolling();
        setRunning(false);
        const ok = products.filter(r => r?.status === 'success').length;
        const sp = products.filter(r => ['paused','deleted','soldout'].includes(r?.status)).length;
        const err = products.filter(r => r?.status === 'error').length;
        showMsg(`✅ 완료! 성공: ${ok}개 | 특수상태: ${sp}개 | 실패: ${err}개`, 'success');
        setBadge('done', '완료');
      }
    } catch (e) { /* ignore */ }
  }, 1000);
}

/**
 * 진행 상황 polling과 타이머 tick을 모두 중지한다.
 */
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  stopTimerTick();
}

/**
 * 헤더 배지에 활성 프록시 수를 추가로 표시한다.
 * @param {number} count - 활성 프록시 수
 */
function showProxyBadge(count) {
  // 헤더 배지 옆에 프록시 표시
  statusBadge.title = `프록시 ${count}개 활성`;
}

/**
 * background에서 프록시 상태를 조회해 수집 탭과 활성 배지를 갱신한다.
 * @returns {Promise<void>}
 */
async function refreshProxyActiveBadge() {
  try {
    const pxRes = await chrome.runtime.sendMessage({ action: 'getProxyStatus' });
    updateProxyActiveBadge(pxRes);
    // 수집 탭의 프록시 상태 바도 동기화
    if (pxRes?.enabled && pxRes?.total > 0 && pxRes?.host) {
      proxyStatus.style.display = 'block';
      proxyStatusText.textContent = `🌐 프록시 ${pxRes.current + 1}/${pxRes.total}: ${pxRes.host}`;
      showProxyBadge(pxRes.total);
    } else {
      proxyStatus.style.display = 'none';
      proxyActiveBadge.style.display = 'none';
    }
  } catch (e) { /* ignore */ }
}

/**
 * 프록시 활성 배지의 텍스트와 표시 여부를 갱신한다.
 * @param {{enabled: boolean, total: number, host: string|null, current: number, requestCount: number, errorCount: number, rotateInterval: number, errorThreshold: number}} pxRes - 프록시 상태
 */
function updateProxyActiveBadge(pxRes) {
  if (pxRes?.enabled && pxRes?.total > 0 && pxRes?.host) {
    proxyActiveBadge.style.display = 'flex';
    const rotateInfo = pxRes.rotateInterval > 0
      ? ` | 반복교체: ${pxRes.requestCount}/${pxRes.rotateInterval}`
      : '';
    const errorInfo = ` | 오류: ${pxRes.errorCount}/${pxRes.errorThreshold}`;
    proxyActiveBadgeText.textContent = `🌐 프록시 ${pxRes.current + 1}/${pxRes.total}: ${pxRes.host}${rotateInfo}${errorInfo}`;
  } else {
    proxyActiveBadge.style.display = 'none';
  }
}

// background.js에서 progressUpdate 메시지도 여전히 수신 (빠른 업데이트)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'progressUpdate') {
    updateProgress(msg.current, msg.total, msg.currentUrl);
  }
});

// 결과 테이블 렌더링
const PREVIEW_LIMIT = 10;

/**
 * 수집 결과 데이터를 팝업 테이블에 렌더링한다.
 * @param {{products: Object[], options: Object[], supplements: Object[]}} data - 수집 결과
 */
function renderResults(data) {
  resultsSection.style.display = 'block';
  resultsBody.innerHTML = '';

  // v3.4.0: data = {products, options, supplements}
  const products = (data && data.products) ? data.products.filter(Boolean) : [];
  const optCnt = (data && data.options)      ? data.options.length      : 0;
  const supCnt = (data && data.supplements)  ? data.supplements.length  : 0;

  const ok = products.filter(r => r.status === 'success').length;
  const sp = products.filter(r => ['paused','deleted','soldout'].includes(r.status)).length;
  const totalRows = products.length + optCnt + supCnt;
  resultStats.textContent = `${products.length}상품 (옵션 ${optCnt} + 추가 ${supCnt} = ${totalRows}행) · 성공 ${ok}개${sp > 0 ? ' · 특수 ' + sp + '개' : ''}`;

  const previewData = products.slice(0, PREVIEW_LIMIT);

  previewData.forEach((item, idx) => {
    const tr = document.createElement('tr');

    const price = (item.salesPrice > 0 ? item.salesPrice : item.price) || 0;
    const priceStr = price > 0 ? price.toLocaleString() + '원' : '-';
    const stock = item.stockQuantity >= 0 ? item.stockQuantity.toLocaleString() : '-';

    let tagClass = 'tag-error', tagText = '❌ 실패';
    if (item.status === 'success')  { tagClass = 'tag-success'; tagText = '✅ 성공'; }
    if (item.status === 'paused')   { tagClass = 'tag-special'; tagText = '⏸ 중지'; }
    if (item.status === 'deleted')  { tagClass = 'tag-special'; tagText = '🗑 삭제'; }
    if (item.status === 'soldout')  { tagClass = 'tag-special'; tagText = '📦 품절'; }

    const nameDisplay = item.productName || '';
    const title = nameDisplay ? ` title="${escHtml(nameDisplay)}"` : '';
    tr.innerHTML = `
      <td${title}>${escHtml(item.productId || String(idx + 1))}</td>
      <td>${escHtml(item.mallName || '-')}</td>
      <td>${priceStr}</td>
      <td>${stock}</td>
      <td class="${tagClass}" style="text-align:right">${tagText}${item.errorMessage ? ' ' + escHtml(item.errorMessage.slice(0, 18)) : ''}</td>
    `;
    resultsBody.appendChild(tr);
  });

  // 상위 10개 초과 시 안내 행 추가
  if (products.length > PREVIEW_LIMIT) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" style="text-align:center;color:#888;font-size:11px;padding:6px">
      + ${(products.length - PREVIEW_LIMIT).toLocaleString()}개 더 있음 — 전체 확인은 💾 저장
    </td>`;
    resultsBody.appendChild(tr);
  }
}

// 진행 상황 업데이트
/**
 * 수집 진행 상황을 프로그레스 바와 URL 텍스트에 반영한다.
 * @param {number} current - 현재 처리 완료 수
 * @param {number} total - 전체 상품 수
 * @param {string} currentUrl - 현재 처리 중인 URL
 */
function updateProgress(current, total, currentUrl) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBar.style.width = pct + '%';
  currentUrlText.textContent = currentUrl || '';
  renderTimerText(current, total);
}

/**
 * 경과/남은 시간 텍스트를 렌더링한다. 1초 tick과 polling 양쪽에서 호출된다.
 * @param {number} current - 현재 완료 수
 * @param {number} total - 전체 URL 수
 */
function renderTimerText(current, total) {
  const fmt = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  const elapsed = _collectionStartTime ? Math.floor((Date.now() - _collectionStartTime) / 1000) : 0;
  const rate = (elapsed > 0 && current > 0) ? elapsed / current : 0;
  const remain = (rate > 0 && current < total) ? Math.round(rate * (total - current)) : 0;
  const done = (total > 0 && current >= total);

  let timeStr;
  if (current === 0) {
    timeStr = '00:00<--:--';
  } else if (done) {
    // 완료: 경과시간만 표시
    timeStr = fmt(elapsed) + ' (완료)';
  } else {
    timeStr = fmt(elapsed) + '<' + fmt(remain);
  }
  progressText.textContent = `${current.toLocaleString()}/${total.toLocaleString()} [${timeStr}]`;
}

/**
 * 1초마다 chrome.storage를 읽어 타이머 텍스트를 갱신하는 내부 타이머를 시작한다.
 */
function startTimerTick() {
  stopTimerTick();
  timerTick = setInterval(async () => {
    try {
      const { collectionProgress } = await chrome.storage.local.get('collectionProgress');
      if (collectionProgress) {
        renderTimerText(collectionProgress.current, collectionProgress.total);
      }
    } catch (e) { /* ignore */ }
  }, 1000);
}

/**
 * 내부 타이머를 중지한다.
 */
function stopTimerTick() {
  if (timerTick) { clearInterval(timerTick); timerTick = null; }
}

/**
 * 수집 완료/중단 직후 팝업이 열릴 때 타이머 텍스트를 1회 즉시 렌더링한다.
 */
function tickTimer() {
  chrome.storage.local.get('collectionProgress', ({ collectionProgress }) => {
    if (collectionProgress) {
      renderTimerText(collectionProgress.current, collectionProgress.total);
    }
  });
}

// UI 상태 관리
/**
 * 수집 실행 상태를 설정하고 시작/중단 버튼과 배지를 전환한다.
 * @param {boolean} running - true면 수집 중, false면 유휴
 */
function setRunning(running) {
  isRunning = running;
  startBtn.style.display = running ? 'none' : 'flex';
  stopBtn.style.display = running ? 'flex' : 'none';
  startBtn.disabled = running;
  if (running) {
    setBadge('running', '수집 중');
    if (!_collectionStartTime) _collectionStartTime = Date.now();
  }
}

/**
 * 상태 배지의 CSS 클래스와 텍스트를 설정한다.
 * @param {'running'|'done'|'idle'|'error'} type - 배지 타입
 * @param {string} text - 표시할 텍스트
 */
function setBadge(type, text) {
  statusBadge.className = `badge badge-${type}`;
  statusBadge.textContent = text;
}

/**
 * 상태 메시지와 타입을 표시한다.
 * @param {string} text - 표시할 메시지
 * @param {'info'|'success'|'error'|'warning'} [type='info'] - 메시지 타입
 */
function showMsg(text, type = 'info') {
  const map = { info: 'msg-info', success: 'msg-success', error: 'msg-error', warning: 'msg-warning' };
  statusMsg.className = `status-msg ${map[type] || 'msg-info'}`;
  statusMsg.textContent = text;
  statusMsg.style.display = 'block';
}

// 설정 탭 로직
/**
 * 설정 탭을 로드하고 각 설정 항목의 현재 값을 UI에 반영한다.
 * @returns {Promise<void>}
 */
async function loadSettingsTab() {
  // 프록시 설정 로드
  const res = await chrome.runtime.sendMessage({ action: 'getProxyConfig' });
  if (res?.success) {
    const cfg = res.config;
    proxyEnabled.checked = !!cfg.enabled;
    proxyEnabledLabel.textContent = cfg.enabled ? '활성' : '비활성';
    if (Array.isArray(cfg.proxies)) {
      proxyInput.value = cfg.proxies.map(p => {
        let s = p.host + ':' + p.port;
        if (p.username) s += ':' + p.username + ':' + (p.password || '');
        return s;
      }).join('\n');
      proxyCount.textContent = cfg.proxies.length + '개 프록시';
    }
    proxyRotateInterval.value = cfg.rotateInterval ?? 10;
    proxyErrorThreshold.value = cfg.errorThreshold ?? 3;
  }

  // 기본 파일 이름/경로 표시
  const { defaultFileName, defaultFilePath } = await chrome.storage.local.get(['defaultFileName', 'defaultFilePath']);
  defaultFileInfo.textContent = defaultFileName ? '📄 ' + defaultFileName : '설정된 파일 없음';
  defaultFilePathInput.value = defaultFilePath || '';

  // 내보내기 설정 로드
  const exRes = await chrome.runtime.sendMessage({ action: 'getExportSettings' });
  if (exRes?.success) {
    const s = exRes.settings;
    if (s.format === 'json') { formatJson.checked = true; } else { formatCsv.checked = true; }
    autoExport.checked = !!s.autoExport;
    if (s.prefix)           exportPrefix.value = s.prefix;
    if (s.prefixOption)     exportPrefixOption.value = s.prefixOption;
    if (s.prefixSupplement) exportPrefixSupplement.value = s.prefixSupplement;
    updateExportBtnLabel(s.format || 'csv');
    updatePrefixDisabled(s.format || 'csv');
  }

  // 딜레이 설정 로드
  const { delayConfig } = await chrome.storage.local.get('delayConfig');
  delayMinInput.value = ((delayConfig?.min ?? 1200) / 1000).toFixed(1);
  delayMaxInput.value = ((delayConfig?.max ?? 2200) / 1000).toFixed(1);

  // 스케줄 설정 로드
  const schRes = await chrome.runtime.sendMessage({ action: 'getScheduleConfig' });
  if (schRes?.success) {
    const cfg = schRes.config;
    scheduleEnabled.checked = !!cfg.enabled;
    scheduleEnabledLabel.textContent = cfg.enabled ? '활성' : '비활성';
    if (cfg.time) scheduleTime.value = cfg.time;
    updateScheduleNextInfo(cfg);
  }

  // Slack 설정 로드
  const slackRes = await chrome.runtime.sendMessage({ action: 'getSlackConfig' });
  if (slackRes?.success) {
    const cfg = slackRes.config;
    slackEnabled.checked = !!cfg.enabled;
    slackEnabledLabel.textContent = cfg.enabled ? '활성' : '비활성';
    slackToken.value = cfg.token       || '';
    slackChannel.value = cfg.channel     || '';
  }

  // 저장된 결과 정보
  const { collectionResults = { products: [], options: [], supplements: [] } } = await chrome.storage.local.get('collectionResults');
  const savedProducts = collectionResults.products || [];
  savedResultsInfo.textContent = savedProducts.length > 0
    ? `${savedProducts.length}개 상품 저장됨`
    : '저장된 결과 없음';
}

/**
 * 딜레이 설정을 읽어 백그라운드에 저장한다.
 */
function saveDelaySettings() {
  const min = Math.round((parseFloat(delayMinInput.value) || 1.2) * 1000);
  const max = Math.round((parseFloat(delayMaxInput.value) || 2.2) * 1000);
  chrome.runtime.sendMessage({ action: 'saveDelay', min, max });
}
delayMinInput.addEventListener('change', saveDelaySettings);
delayMaxInput.addEventListener('change', saveDelaySettings);

// 프록시 활성화 토글 → 즉시 저장
proxyEnabled.addEventListener('change', () => {
  proxyEnabledLabel.textContent = proxyEnabled.checked ? '활성' : '비활성';
  saveProxySettings();
});

// 프록시 입력 실시간 카운트 + 자동 저장 (디바운스 500ms)
let _proxyInputTimer = null;
proxyInput.addEventListener('input', () => {
  const count = parseProxyList(proxyInput.value).length;
  proxyCount.textContent = count + '개 프록시';
  clearTimeout(_proxyInputTimer);
  _proxyInputTimer = setTimeout(saveProxySettings, 500);
});

// 프록시 교체주기 변경 시 즉시 저장
proxyRotateInterval.addEventListener('change', saveProxySettings);
proxyErrorThreshold.addEventListener('change', saveProxySettings);

/**
 * 텍스트 입력에서 프록시 목록을 파싱한다.
 * @param {string} text - 줄당 하나씩 IP:포트 또는 IP:포트:아이디:비밀번호 형식
 * @returns {{host: string, port: number, username: string, password: string}[]}
 */
function parseProxyList(text) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l && /^\d{1,3}(\.\d{1,3}){3}:\d+/.test(l))
    .map(l => {
      const parts = l.split(':');
      return {
        host:     parts[0],
        port:     parseInt(parts[1], 10),
        username: parts[2] || '',
        password: parts[3] || ''
      };
    });
}

/**
 * 프록시 설정을 백그라운드에 저장하고 활성 배지를 갱신한다.
 * @returns {Promise<void>}
 */
async function saveProxySettings() {
  const proxies = parseProxyList(proxyInput.value);
  const config = {
    enabled:         proxyEnabled.checked,
    proxies:         proxies,
    rotateInterval:  parseInt(proxyRotateInterval.value, 10) || 0,
    errorThreshold:  parseInt(proxyErrorThreshold.value,  10) >= 0 ? parseInt(proxyErrorThreshold.value, 10) : 3
  };
  await chrome.runtime.sendMessage({ action: 'saveProxyConfig', config });
  proxyCount.textContent = proxies.length + '개 프록시';
  await refreshProxyActiveBadge();
}

// 현재 IP 확인 (프록시 적용 여부 테스트)
testProxyBtn.addEventListener('click', async () => {
  proxyTestResult.style.display = 'block';
  proxyTestResult.textContent = '확인 중...';
  proxyTestResult.className = 'proxy-test-result msg-info';
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    const data = await res.json();
    proxyTestResult.textContent = `현재 외부 IP: ${data.ip}`;
    proxyTestResult.className = 'proxy-test-result msg-success';
  } catch (e) {
    proxyTestResult.textContent = 'IP 확인 실패: ' + e.message;
    proxyTestResult.className = 'proxy-test-result msg-error';
  }
});

// 기본 파일 선택
selectDefaultFileBtn.addEventListener('click', async () => {
  // File System Access API 우선 사용 (매번 최신 내용 읽기 가능)
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Text files', accept: { 'text/plain': ['.txt'] } }],
        multiple: false
      });
      const file = await handle.getFile();
      const content = await file.text();
      await saveFileHandle(handle);
      // 경로 힌트: FSA API는 절대경로 미제공 → 사용자가 defaultFilePathInput에 직접 입력하도록 안내
      // 단, 이미 경로가 입력돼 있다면 파일명 일치 확인 후 유지
      const existingPath = defaultFilePathInput.value.trim();
      const pathFileName = existingPath ? existingPath.replace(/\\/g, '/').split('/').pop() : '';
      if (!existingPath || pathFileName !== file.name) {
        // 경로가 비어있거나 파일명이 다르면 파일명만으로 경로 초기화
        defaultFilePathInput.value = '';
        await chrome.storage.local.set({ defaultFilePath: '' });
      }
      await chrome.storage.local.set({ defaultFileContent: content, defaultFileName: file.name });
      defaultFileInfo.textContent = '📄 ' + file.name;
      showMsg(`✅ 기본 파일 저장됨: ${file.name} (팝업 열 때마다 최신 내용 자동 로드)`, 'success');
      // 수집 탭 입력란도 즉시 반영
      if (urlInput.value.trim() === '') {
        urlInput.value = content;
        showFileInfo(file.name);
        refreshCount();
      }
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;  // 사용자가 취소
      // API 미지원 등 → 구형 방식으로 fallback
    }
  }
  defaultFileInput.click();
});

defaultFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const content = await file.text();
  // file.path는 일반 브라우저/확장팝업에서는 undefined → 빈 문자열
  const filePath = file.path || '';
  await chrome.storage.local.set({ defaultFileContent: content, defaultFileName: file.name, defaultFilePath: filePath });
  defaultFileInfo.textContent = '📄 ' + file.name;
  defaultFilePathInput.value = filePath;
  showMsg(`✅ 기본 파일 저장됨: ${file.name}`, 'success');
  defaultFileInput.value = '';
});

// 경로 직접 입력 시 저장
defaultFilePathInput.addEventListener('change', async () => {
  const p = defaultFilePathInput.value.trim();
  await chrome.storage.local.set({ defaultFilePath: p });
  if (p) showMsg(`✅ 파일 경로 저장됨: ${p}`, 'success');
});

// 결과 초기화
clearResultsBtn.addEventListener('click', async () => {
  if (!confirm('저장된 결과를 모두 삭제할까요?')) return;
  await chrome.runtime.sendMessage({ action: 'clearResults' });
  savedResultsInfo.textContent = '저장된 결과 없음';
  resultsSection.style.display = 'none';
  exportBtn.disabled = true;
  showMsg('🗑 결과가 초기화되었습니다.', 'info');
});

// 내보내기 설정 변경 시 자동 저장
document.querySelectorAll('input[name="exportFormat"]').forEach(radio => {
  radio.addEventListener('change', () => saveExportSettings());
});
autoExport.addEventListener('change', () => saveExportSettings());
exportPrefix.addEventListener('input', () => saveExportSettings());
exportPrefixOption.addEventListener('input', () => saveExportSettings());
exportPrefixSupplement.addEventListener('input', () => saveExportSettings());

/**
 * 내보내기 설정을 백그라운드에 저장하고 버튼 레이블을 갱신한다.
 * @returns {Promise<void>}
 */
async function saveExportSettings() {
  const format = document.querySelector('input[name="exportFormat"]:checked')?.value || 'csv';
  const prefix = exportPrefix.value.trim()           || '네이버상품';
  const prefixOption = exportPrefixOption.value.trim()     || '네이버옵션';
  const prefixSupplement = exportPrefixSupplement.value.trim() || '네이버추가상품';
  const settings = { format, autoExport: autoExport.checked, prefix, prefixOption, prefixSupplement };
  await chrome.runtime.sendMessage({ action: 'saveExportSettings', settings });
  updateExportBtnLabel(format);
  updatePrefixDisabled(format);
}

/**
 * 내보내기 버튼의 레이블을 포맷에 맞게 업데이트한다.
 * @param {'csv'|'json'} format - 내보내기 포맷
 */
function updateExportBtnLabel(format) {
  exportBtn.textContent = format === 'json' ? '💾 JSON 저장' : '💾 CSV 저장';
}

/**
 * JSON 포맷 선택 시 옵션/추가상품 접두어 입력란을 비활성화한다.
 * @param {'csv'|'json'} format - 내보내기 포맷
 */
function updatePrefixDisabled(format) {
  const isJson = format === 'json';
  exportPrefixOption.disabled = isJson;
  exportPrefixSupplement.disabled = isJson;
}

// 스케줄 설정 이벤트
scheduleEnabled.addEventListener('change', () => {
  scheduleEnabledLabel.textContent = scheduleEnabled.checked ? '활성' : '비활성';
  saveScheduleSettings();
});

scheduleTime.addEventListener('change', saveScheduleSettings);

/**
 * 스케줄 설정을 백그라운드에 저장하고 다음 실행 시각 정보를 갱신한다.
 * @returns {Promise<void>}
 */
async function saveScheduleSettings() {
  const config = {
    enabled: scheduleEnabled.checked,
    time:    scheduleTime.value || '09:00'
  };
  await chrome.runtime.sendMessage({ action: 'saveScheduleConfig', config });
  updateScheduleNextInfo(config);
}

/**
 * 스케줄 다음 실행 시각을 계산해 UI에 표시한다.
 * @param {{enabled: boolean, time: string}} cfg - 스케줄 설정
 */
function updateScheduleNextInfo(cfg) {
  if (!cfg || !cfg.enabled || !cfg.time) {
    scheduleNextInfo.style.display = 'none';
    return;
  }
  const [hh, mm] = cfg.time.split(':').map(Number);
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  const pad = n => String(n).padStart(2, '0');
  const dateStr = (target.getMonth() + 1) + '/' + target.getDate() + ' '
    + pad(target.getHours()) + ':' + pad(target.getMinutes());
  scheduleNextInfo.textContent = '⏰ 다음 실행: ' + dateStr;
  scheduleNextInfo.style.display = 'block';
}

// Slack 설정 이벤트
slackEnabled.addEventListener('change', () => {
  slackEnabledLabel.textContent = slackEnabled.checked ? '활성' : '비활성';
  saveSlackSettings();
});

let _slackSaveTimer = null;
/**
 * Slack 설정 저장을 700ms 디바운스하여 호출한다.
 */
function debouncedSaveSlack() {
  clearTimeout(_slackSaveTimer);
  _slackSaveTimer = setTimeout(saveSlackSettings, 700);
}
slackToken.addEventListener('input',   debouncedSaveSlack);
slackChannel.addEventListener('input', debouncedSaveSlack);

/**
 * Slack 설정을 백그라운드에 저장한다.
 * @returns {Promise<void>}
 */
async function saveSlackSettings() {
  const config = {
    enabled:    slackEnabled.checked,
    token:      slackToken.value.trim(),
    channel:    slackChannel.value.trim()
  };
  await chrome.runtime.sendMessage({ action: 'saveSlackConfig', config });
}

// 설정 내보내기 / 불러오기
exportConfigBtn.addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getAllSettings' });
    if (!res?.success) throw new Error(res?.error || '설정 읽기 실패');
    const json = JSON.stringify(res.settings, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    const ts = now.getFullYear() + pad(now.getMonth()+1) + pad(now.getDate())
                    + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    const fname = 'nsp-extractor-config_' + ts + '.json';
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
    showMsg(`✅ 설정 내보내기 완료: ${fname}`, 'success');
  } catch (e) {
    showMsg('❌ 설정 내보내기 실패: ' + e.message, 'error');
  }
});

importConfigBtn.addEventListener('click', () => importConfigInput.click());

importConfigInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  importConfigInput.value = '';
  try {
    const text = await file.text();
    const settings = JSON.parse(text);
    // 최소한의 유효성 검사
    if (typeof settings !== 'object' || Array.isArray(settings)) throw new Error('올바른 설정 파일이 아닙니다');

    const res = await chrome.runtime.sendMessage({ action: 'setAllSettings', settings });
    if (!res?.success) throw new Error(res?.error || '설정 적용 실패');

    // UI 즉시 반영 (설정 탭 재로드)
    await loadSettingsTab();
    const ver = settings._version ? ` (v${settings._version})` : '';
    const KEY_LABEL = {
      proxyConfig:     '프록시',
      exportSettings:  '내보내기',
      delayConfig:     '딜레이',
      scheduleConfig:  '스케줄',
      slackConfig:     'Slack',
      defaultFilePath: '기본 파일경로'
    };
    const applied = (res.applied || [])
      .filter(k => !k.startsWith('_'))
      .map(k => KEY_LABEL[k] || k);
    let msg = `✅ 설정 불러오기 완료${ver}: ${applied.join(', ')}`;
    if (settings.defaultFilePath) {
      msg += `\n📁 기본 URL 파일을 다시 선택해주세요: ${settings.defaultFilePath}`;
    }
    showMsg(msg, 'success');
  } catch (e) {
    showMsg('❌ 설정 불러오기 실패: ' + e.message, 'error');
  }
});

// 유틸리티
/**
 * HTML 특수문자를 이스케이프한다.
 * @param {*} str - 이스케이프할 값
 * @returns {string} 이스케이프된 HTML 안전 문자열
 */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
