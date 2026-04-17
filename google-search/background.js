/**
 * 구글 검색 자동화
 *
 * 변경 내용 (v0.3.0):
 *  - 전용 수집 탭을 chrome.storage에 등록 (collectorTabId)
 *    팝업 재시작/탭 전환 후에도 탭 ID 유지, 탭 닫힘 자동 감지
 *  - 모든 탭 조작 active:false — 사용자 현재 탭에 절대 간섭하지 않음
 *    CAPTCHA 대기 중에도 active:false 유지, 5초 폴링으로 해제 감지
 *  - stopCollection + resumeState 저장
 *    끊긴 쿼리/페이지부터 재개 수집 가능
 *  - 쿼리 완료마다 lastCollectedRows 누적 저장
 *    중단 시에도 완료된 쿼리 결과는 보존
 *  - waitForGoogleSearchLoad: 지정 tabId만 검증
 *    다른 탭 URL 오판 방지
 */

'use strict';

const GOOGLE_HOST_PATTERN = /^https:\/\/(www\.)?google\.(com|co\.kr)\/search/i;

const DEFAULT_SETTINGS = {
  delayMinMs: 1200,
  delayMaxMs: 2200,
  maxPages: 20,
  useAllPages: true,
  exportFormat: 'csv',
  baseFilename: '검색결과',
  captchaWaitMs: 120000,
};

// 설치 초기화

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const next = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (stored[key] === undefined) next[key] = value;
  }
  if (Object.keys(next).length) {
    await chrome.storage.local.set(next);
  }
});

// 전용 탭 닫힘 감지 -> storage 정리

chrome.tabs.onRemoved.addListener(async (removedTabId) => {
  const { collectorTabId } = await chrome.storage.local.get('collectorTabId');
  if (collectorTabId === removedTabId) {
    await chrome.storage.local.remove('collectorTabId');
  }
});

// 메시지 핸들러

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'getSettings') {
    chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS)).then((settings) => {
      sendResponse({ ok: true, settings: { ...DEFAULT_SETTINGS, ...settings } });
    });
    return true;
  }

  if (message?.action === 'saveSettings') {
    chrome.storage.local.set(message.settings || {}).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.action === 'startCollection') {
    runCollection(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.action === 'resumeCollection') {
    resumeCollection(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.action === 'stopCollection') {
    // stopRequested 플래그 + progress.running=false를 즉시 저장
    // → 수집 루프가 waitForGoogleSearchLoad/waitForCaptchaResolved 에 블로킹되어 있어도
    //   팝업 폴러가 다음 틱에서 running=false를 감지해 UI를 idle로 복원할 수 있음
    chrome.storage.local.get('progress').then((data) => {
      const prev = data.progress || {};
      return chrome.storage.local.set({
        stopRequested: true,
        progress: { ...prev, running: false, message: '중지 요청됨. 현재 페이지 완료 후 중지...' },
      });
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.action === 'resetCollection') {
    // 모든 수집 상태 완전 초기화 (stuck 상태 탈출용)
    chrome.storage.local.remove([
      'stopRequested', 'resumeState', 'collectorTabId', 'progress',
    ]).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.action === 'getResumeState') {
    chrome.storage.local.get(['resumeState', 'lastCollectedMeta', 'lastCollectedRows']).then((data) => {
      sendResponse({
        ok: true,
        resumeState: data.resumeState || null,
        lastCollectedMeta: data.lastCollectedMeta || null,
        partialCount: Array.isArray(data.lastCollectedRows) ? data.lastCollectedRows.length : 0,
      });
    });
    return true;
  }

  if (message?.action === 'clearResumeState') {
    chrome.storage.local.remove(['resumeState', 'stopRequested']).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.action === 'downloadLastResults') {
    downloadLastResults(message.format)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.action === 'getLastResultsPayload') {
    getLastResultsPayload(message.format)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

// 전용 탭 관리

/**
 * 전용 수집 탭을 반환한다. 기존 탭이 살아있으면 재사용하고 없으면 새로 생성한다.
 * @param {string} initialUrl - 탭이 새로 생성될 때 열 URL
 * @returns {Promise<number>} 탭 ID
 */
async function getOrCreateCollectorTab(initialUrl) {
  const { collectorTabId } = await chrome.storage.local.get('collectorTabId');

  if (collectorTabId) {
    try {
      const existing = await chrome.tabs.get(collectorTabId);
      if (existing && !existing.discarded) {
        await chrome.tabs.update(collectorTabId, { url: initialUrl, active: false });
        return collectorTabId;
      }
    } catch {
      // 탭 없음 -> 새로 생성
    }
  }

  const tab = await chrome.tabs.create({ url: initialUrl, active: false });
  await chrome.storage.local.set({ collectorTabId: tab.id });
  return tab.id;
}

/**
 * 전용 수집 탭을 지정 URL로 이동시킨다. active:false로 유지한다.
 * @param {number} tabId - 이동할 탭 ID
 * @param {string} url - 이동할 URL
 * @returns {Promise<void>}
 */
async function navigateCollectorTab(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: false });
}

// 수집 진입점

/**
 * 새 수집을 시작한다. 기존 중지/재개 상태를 초기화하고 쿼리 목록을 처음부터 수집한다.
 * @param {{ queries: string[], settings: object }} payload - 검색할 키워드 목록과 설정
 * @returns {Promise<object>} 수집 완료 결과 또는 중지 결과
 */
async function runCollection(payload) {
  const settings = { ...DEFAULT_SETTINGS, ...(payload?.settings || {}) };
  const queries = Array.isArray(payload?.queries) ? payload.queries.filter(Boolean) : [];
  if (!queries.length) throw new Error('키워드가 비어 있습니다.');

  await chrome.storage.local.remove(['stopRequested', 'resumeState']);
  await chrome.storage.local.set({ lastCollectedRows: [] });

  const progress = { current: 0, total: queries.length, message: '시작 준비 중...', running: true };
  await chrome.storage.local.set({ progress });

  try {
    await collectQueries(queries, settings, 0, []);
    return finishCollection(settings);
  } catch (err) {
    // STOP_REQUESTED는 정상 중지이므로 에러 아님
    if (String(err).includes('STOP_REQUESTED')) {
      const { progress: p = {} } = await chrome.storage.local.get('progress');
      await chrome.storage.local.set({ progress: { ...p, running: false, message: '수집이 중지되었습니다.' } });
      return { stopped: true };
    }
    // 실제 에러: progress를 idle로 복원
    const { progress: p = {} } = await chrome.storage.local.get('progress');
    await chrome.storage.local.set({ progress: { ...p, running: false, message: `오류: ${String(err)}` } });
    throw err;
  }
}

/**
 * 이전에 중지된 수집을 이어서 시작한다. resumeState에 저장된 쿼리/페이지부터 재개한다.
 * @param {{ settings: object }} payload - 재개 시 적용할 설정
 * @returns {Promise<object>} 수집 완료 결과 또는 중지 결과
 */
async function resumeCollection(payload) {
  const settings = { ...DEFAULT_SETTINGS, ...(payload?.settings || {}) };
  const { resumeState, lastCollectedRows = [] } = await chrome.storage.local.get(['resumeState', 'lastCollectedRows']);

  if (!resumeState) throw new Error('재개할 검색 상태가 없습니다.');

  const { queries, startQueryIndex, startPageUrl, startPageNumber } = resumeState;

  await chrome.storage.local.remove(['stopRequested', 'resumeState']);

  const progress = {
    current: startQueryIndex,
    total: queries.length,
    message: `재개: "${queries[startQueryIndex]}" (${startPageNumber}페이지부터)...`,
    running: true,
  };
  await chrome.storage.local.set({ progress });

  try {
    await collectQueries(
      queries,
      settings,
      startQueryIndex,
      Array.isArray(lastCollectedRows) ? [...lastCollectedRows] : [],
      startPageUrl,
      startPageNumber,
    );
    return finishCollection(settings);
  } catch (err) {
    if (String(err).includes('STOP_REQUESTED')) {
      const { progress: p = {} } = await chrome.storage.local.get('progress');
      await chrome.storage.local.set({ progress: { ...p, running: false, message: '수집이 중지되었습니다.' } });
      return { stopped: true };
    }
    const { progress: p = {} } = await chrome.storage.local.get('progress');
    await chrome.storage.local.set({ progress: { ...p, running: false, message: `오류: ${String(err)}` } });
    throw err;
  }
}

// 쿼리 목록 순차 수집

/**
 * 쿼리 목록을 순차적으로 수집하고 결과를 누적·저장한다.
 * @param {string[]} queries - 검색할 키워드 목록
 * @param {object} settings - 수집 설정(딜레이, 최대 페이지 등)
 * @param {number} startIndex - 수집을 시작할 쿼리 인덱스
 * @param {object[]} accumulatedRows - 이미 수집된 행 배열(재개 시 전달)
 * @param {string|null} resumePageUrl - 재개 시 첫 번째 쿼리의 시작 URL
 * @param {number} resumePageNumber - 재개 시 첫 번째 쿼리의 시작 페이지 번호
 * @returns {Promise<void>}
 */
async function collectQueries(queries, settings, startIndex, accumulatedRows, resumePageUrl = null, resumePageNumber = 1) {
  const progress = { current: startIndex, total: queries.length, message: '검색 중...', running: true };

  for (let index = startIndex; index < queries.length; index += 1) {
    const { stopRequested } = await chrome.storage.local.get('stopRequested');
    if (stopRequested) {
      progress.message = `중지됨 (${index + 1}/${queries.length} 키워드)`;
      progress.running = false;
      await chrome.storage.local.set({ progress });
      await chrome.storage.local.set({
        resumeState: {
          queries,
          startQueryIndex: index,
          startPageUrl: null,
          startPageNumber: 1,
        },
      });
      return;
    }

    const query = queries[index];
    progress.current = index + 1;
    progress.message = `검색 중: "${query}" (${index + 1}/${queries.length})`;
    await chrome.storage.local.set({ progress });

    const isFirstQuery = index === startIndex;
    const pageUrlForThis = isFirstQuery ? resumePageUrl : null;
    const pageNumForThis = isFirstQuery ? resumePageNumber : 1;

    const queryRows = await collectQueryResults(query, settings, progress, queries, index, pageUrlForThis, pageNumForThis);
    accumulatedRows.push(...queryRows);

    await chrome.storage.local.set({ lastCollectedRows: accumulatedRows });
  }

  progress.running = false;
  progress.message = '검색 완료';
  await chrome.storage.local.set({ progress });
}

// 쿼리 단건 수집

/**
 * 키워드 한 개를 검색하여 결과 행 배열을 반환한다.
 * @param {string} query - 검색할 키워드
 * @param {object} settings - 수집 설정
 * @param {object} progress - 진행 상태 객체
 * @param {string[]} allQueries - 전체 쿼리 목록(resumeState 저장용)
 * @param {number} queryIndex - 현재 쿼리의 인덱스
 * @param {string|null} resumePageUrl - 재개 시 시작할 URL
 * @param {number} resumePageNumber - 재개 시 시작할 페이지 번호
 * @returns {Promise<object[]>} 수집된 행 배열
 */
async function collectQueryResults(query, settings, progress, allQueries, queryIndex, resumePageUrl = null, resumePageNumber = 1) {
  const startUrl = resumePageUrl
    || `https://www.google.com/search?hl=ko&gl=kr&q=${encodeURIComponent(query)}`;

  const tabId = await getOrCreateCollectorTab(startUrl);
  await waitForGoogleSearchLoad(tabId);

  const results = [];
  let pageNumber = resumePageNumber;

  while (true) {
    const { stopRequested } = await chrome.storage.local.get('stopRequested');
    if (stopRequested) {
      let currentUrl = null;
      try {
        const tab = await chrome.tabs.get(tabId);
        currentUrl = tab.url || null;
      } catch { /* ignore */ }

      await chrome.storage.local.set({
        resumeState: {
          queries: allQueries,
          startQueryIndex: queryIndex,
          startPageUrl: currentUrl,
          startPageNumber: pageNumber,
        },
      });
      break;
    }

    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, { action: 'extractSearchResults', pageNumber });
    } catch {
      await delay(800);
      try {
        response = await chrome.tabs.sendMessage(tabId, { action: 'extractSearchResults', pageNumber });
      } catch (err) {
        throw new Error(`페이지 메시지 실패: "${query}" ${pageNumber}페이지 - ${err}`);
      }
    }

    if (!response?.ok) {
      throw new Error(`페이지 파싱 실패: "${query}" ${pageNumber}페이지`);
    }

    if (response.captchaDetected) {
      const waitMs = Number(settings.captchaWaitMs || 120000);
      progress.message = `CAPTCHA 감지: "${query}" ${pageNumber}페이지\n`
        + `탭에서 직접 인증 후 자동 재개됩니다 (최대 ${Math.round(waitMs / 1000)}초)...`;
      await chrome.storage.local.set({ progress });

      const resolved = await waitForCaptchaResolved(tabId, waitMs);
      if (!resolved) {
        throw new Error(`CAPTCHA 시간 초과: "${query}" ${pageNumber}페이지`);
      }

      progress.message = `CAPTCHA 해제, 재시도: "${query}" ${pageNumber}페이지`;
      await chrome.storage.local.set({ progress });
      continue;
    }

    const pageRows = Array.isArray(response.rows) ? response.rows : [];
    if (!pageRows.length) break;

    results.push(...pageRows);
    const nextPageUrl = response.nextPageUrl;

    progress.message = `검색 중: "${query}" (${pageNumber}페이지, 누계 ${results.length}건)`;
    await chrome.storage.local.set({ progress });

    const reachedMax = !settings.useAllPages && pageNumber >= Number(settings.maxPages || 1);
    if (!nextPageUrl || reachedMax) break;

    pageNumber += 1;
    await navigateCollectorTab(tabId, nextPageUrl);
    await waitForGoogleSearchLoad(tabId);
    await delay(getRandomDelayMs(settings));
  }

  return results;
}

// 완료 처리

/**
 * 수집 완료 후 내보내기 파일을 생성하고 메타데이터를 저장한다.
 * @param {object} settings - 내보내기 설정(파일명, 형식)
 * @returns {Promise<{ rows: object[], filename: string, downloadInfo: object }>}
 */
async function finishCollection(settings) {
  const { lastCollectedRows: rows = [] } = await chrome.storage.local.get('lastCollectedRows');
  const filename = buildOutputFilename(settings.baseFilename || '검색결과', settings.exportFormat || 'csv');

  await chrome.storage.local.set({
    lastCollectedMeta: {
      filenameBase: settings.baseFilename || '검색결과',
      exportFormat: settings.exportFormat || 'csv',
      rowCount: rows.length,
      capturedAt: new Date().toISOString(),
    },
    resumeState: null,
  });

  const progress = { current: 0, total: 0, message: `저장 완료: ${filename}`, running: false };
  await chrome.storage.local.set({ progress });

  const downloadInfo = await exportRows(rows, settings.exportFormat || 'csv', filename);
  await chrome.storage.local.set({ lastDownloadInfo: downloadInfo });
  return { rows, filename, downloadInfo };
}

// CAPTCHA 해제 대기 (5초 폴링, active:false 유지)

/**
 * CAPTCHA가 해제될 때까지 폴링으로 대기한다. 5초 간격으로 확인하고 해제되면 true를 반환한다.
 * @param {number} tabId - 확인할 탭 ID
 * @param {number} timeoutMs - 최대 대기 시간(ms)
 * @returns {Promise<boolean>} CAPTCHA 해제 여부
 */
async function waitForCaptchaResolved(tabId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await delay(5000);

    // 중지 요청 시 즉시 탈출
    const { stopRequested } = await chrome.storage.local.get('stopRequested');
    if (stopRequested) return false;

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false;
    }
    if (tab.status !== 'complete') continue;
    if (!GOOGLE_HOST_PATTERN.test(tab.url || '')) continue;
    try {
      const check = await chrome.tabs.sendMessage(tabId, { action: 'extractSearchResults', pageNumber: 1 });
      if (check?.ok && !check.captchaDetected) return true;
    } catch { /* content_script 아직 로드 중 */ }
  }
  return false;
}

// 탭 로드 대기

/**
 * Google 검색 결과 페이지 로딩이 완료될 때까지 대기한다.
 * @param {number} tabId - 감시할 탭 ID
 * @param {number} [timeoutMs=30000] - 최대 대기 시간(ms)
 * @returns {Promise<void>}
 */
async function waitForGoogleSearchLoad(tabId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // 중지 요청 시 즉시 탈출
    const { stopRequested } = await chrome.storage.local.get('stopRequested');
    if (stopRequested) throw new Error('STOP_REQUESTED');

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error(`검색 탭(${tabId})이 닫혔습니다.`);
    }
    if (tab.status === 'complete' && GOOGLE_HOST_PATTERN.test(tab.url || '')) return;
    await delay(300);
  }
  throw new Error('Google 검색 페이지 로딩 시간 초과');
}

// 다운로드 / 내보내기

/**
 * 수집 결과를 CSV 또는 JSON 파일로 다운로드한다.
 * @param {object[]} rows - 다운로드할 행 배열
 * @param {'csv'|'json'} format - 내보내기 형식
 * @param {string} filename - 저장 파일명
 * @returns {Promise<{ downloadId: number|null, filename: string, count: number, state: string, content: string }>}
 */
async function exportRows(rows, format, filename) {
  const content = format === 'json' ? JSON.stringify(rows, null, 2) : toCsv(rows);
  const bom = format === 'json' ? '' : '\uFEFF';
  const mime = format === 'json' ? 'data:application/json;charset=utf-8,' : 'data:text/csv;charset=utf-8,';
  const dataUrl = mime + encodeURIComponent(bom + content);

  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  } catch (err) {
    console.warn('[BG] chrome.downloads.download 실패:', err);
  }

  return { downloadId, filename, count: rows.length, state: downloadId != null ? 'downloading' : 'ready', content };
}

/**
 * 저장된 최근 수집 결과를 다운로드한다.
 * @param {'csv'|'json'|undefined} formatOverride - 형식 강제 지정(없으면 저장된 설정 사용)
 * @returns {Promise<{ filename: string, meta: object, downloadInfo: object }>}
 */
async function downloadLastResults(formatOverride) {
  const { lastCollectedRows = [], lastCollectedMeta = {} } = await chrome.storage.local.get(['lastCollectedRows', 'lastCollectedMeta']);
  if (!lastCollectedRows.length) throw new Error('저장된 결과가 없습니다.');

  const format = formatOverride || lastCollectedMeta.exportFormat || 'csv';
  const filename = buildOutputFilename(lastCollectedMeta.filenameBase || '검색결과', format);
  const downloadInfo = await exportRows(lastCollectedRows, format, filename);
  await chrome.storage.local.set({ lastDownloadInfo: downloadInfo });
  return { filename, meta: lastCollectedMeta, downloadInfo };
}

/**
 * 저장된 최근 수집 결과의 내용을 반환한다. 직접 다운로드하지 않고 데이터만 가져올 때 사용한다.
 * @param {'csv'|'json'|undefined} formatOverride - 형식 강제 지정(없으면 저장된 설정 사용)
 * @returns {Promise<{ filename: string, format: string, mimeType: string, content: string, rowCount: number, meta: object }>}
 */
async function getLastResultsPayload(formatOverride) {
  const { lastCollectedRows = [], lastCollectedMeta = {} } = await chrome.storage.local.get(['lastCollectedRows', 'lastCollectedMeta']);
  if (!lastCollectedRows.length) throw new Error('저장된 결과가 없습니다.');

  const format = formatOverride || lastCollectedMeta.exportFormat || 'csv';
  const filename = buildOutputFilename(lastCollectedMeta.filenameBase || '검색결과', format);
  const content = format === 'json' ? JSON.stringify(lastCollectedRows, null, 2) : toCsv(lastCollectedRows);
  return { filename, format, mimeType: format === 'json' ? 'application/json' : 'text/csv', content, rowCount: lastCollectedRows.length, meta: lastCollectedMeta };
}

// 유틸

/**
 * 지정 시간만큼 비동기 대기한다.
 * @param {number} ms - 대기 시간(ms)
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 설정의 최소/최대 범위 내에서 랜덤 딜레이 값을 반환한다.
 * @param {object} settings - delayMinMs, delayMaxMs가 포함된 설정 객체
 * @returns {number} 랜덤 딜레이(ms)
 */
function getRandomDelayMs(settings) {
  const min = Number(settings.delayMinMs ?? 1200);
  const max = Number(settings.delayMaxMs ?? min);
  const safeMin = Number.isFinite(min) ? Math.max(0, min) : 1200;
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : safeMin;
  if (safeMin === safeMax) return safeMin;
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

/**
 * 파일명 베이스와 형식으로 안전한 출력 파일명을 생성한다.
 * @param {string} baseFilename - 파일명 기반 문자열
 * @param {'csv'|'json'} format - 파일 형식
 * @returns {string} 확장자가 붙은 파일명
 */
function buildOutputFilename(baseFilename, format) {
  const safe = String(baseFilename || '검색결과').trim().replace(/[\\/:*?"<>|]+/g, '_') || '검색결과';
  return `${safe}.${format === 'json' ? 'json' : 'csv'}`;
}

/**
 * 행 배열을 CSV 문자열로 변환한다.
 * @param {object[]} rows - 변환할 행 배열
 * @returns {string} CSV 문자열
 */
function toCsv(rows) {
  const columns = ['query', 'page', 'rank', 'title', 'url', 'display_url', 'snippet', 'collected_at'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [columns.join(','), ...rows.map((row) => columns.map((k) => esc(row[k])).join(','))].join('\n');
}
