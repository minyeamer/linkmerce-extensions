const $ = (id) => document.getElementById(id);

const queriesEl = $('queries');
const delayMinMsEl = $('delayMinMs');
const delayMaxMsEl = $('delayMaxMs');
const maxPagesEl = $('maxPages');
const useAllPagesEl = $('useAllPages');
const baseFilenameEl = $('baseFilename');
const exportFormatEl = $('exportFormat');
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const resumeBtn = $('resumeBtn');
const resetBtn = $('resetBtn');
const saveSettingsBtn = $('saveSettingsBtn');
const downloadLastCsvBtn = $('downloadLastCsvBtn');
const downloadLastJsonBtn = $('downloadLastJsonBtn');
const statusEl = $('status');
const statusBadge = $('statusBadge');
const progressSection = $('progressSection');
const progressText = $('progressText');
const progressBar = $('progressBar');
const lastResultMetaEl = $('lastResultMeta');

let progressPoller = null;

document.addEventListener('DOMContentLoaded', init);
startBtn.addEventListener('click', startCollection);
stopBtn.addEventListener('click', stopCollection);
resumeBtn.addEventListener('click', resumeCollection);
resetBtn.addEventListener('click', resetCollection);
saveSettingsBtn.addEventListener('click', saveSettings);
downloadLastCsvBtn.addEventListener('click', () => downloadLastResults('csv'));
downloadLastJsonBtn.addEventListener('click', () => downloadLastResults('json'));

/**
 * 팝업 초기화: 설정을 로드하고 진행 폴링 및 재개 상태를 확인한다.
 * @returns {Promise<void>}
 */
async function init() {
  const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
  const settings = response?.settings || {};
  delayMinMsEl.value = settings.delayMinMs ?? 1200;
  delayMaxMsEl.value = settings.delayMaxMs ?? 2200;
  maxPagesEl.value = settings.maxPages ?? 20;
  useAllPagesEl.checked = settings.useAllPages !== false;
  baseFilenameEl.value = settings.baseFilename || '검색결과';
  exportFormatEl.value = settings.exportFormat || 'csv';
  setIdle('설정을 불러왔습니다.');
  startProgressPolling();
  await refreshLastResultMeta();
  await checkResumeState();
}

/**
 * 현재 펼 값을 storage에 저장한다.
 * @returns {Promise<void>}
 */
async function saveSettings() {
  const settings = readSettings();
  await chrome.runtime.sendMessage({ action: 'saveSettings', settings });
  setIdle('설정을 저장했습니다.');
}

/**
 * 수집 중지를 요청하고 background에서 running=false가 되는 것을 연담(15초)한다.
 * @returns {Promise<void>}
 */
async function stopCollection() {
  stopBtn.disabled = true;
  await chrome.runtime.sendMessage({ action: 'stopCollection' });
  setIdle('중지 요청 전송됨. 현재 페이지 완료 후 중지됩니다...');

  // progress.running이 false로 바뀔 때까지 최대 15초 대기 후 자동으로 idle 복원
  // (waitForGoogleSearchLoad 등 블로킹 중에도 stopRequested가 storage에 저장되어
  //  background가 바로 탈출하므로 보통 1~2초 이내에 완료됨)
  const deadline = Date.now() + 15000;
  const waitIdle = setInterval(async () => {
    const { progress } = await chrome.storage.local.get('progress');
    if (!progress?.running || Date.now() >= deadline) {
      clearInterval(waitIdle);
      setButtonIdle();
      await checkResumeState();
      if (!progress?.running) {
        const msg = progress?.message || '수집이 중지되었습니다.';
        setIdle(msg);
      } else {
        // 15초가 지나도 안 멈추면 초기화 버튼 사용 안내
        setIdle('중지 응답 없음. "진행 상태 초기화" 버튼을 사용하세요.');
      }
    }
  }, 800);
}

/**
 * 수집 상태를 완전히 초기화한다. 정맴이 stuck 되었을 때 사용한다.
 * @returns {Promise<void>}
 */
async function resetCollection() {
  if (!confirm('진행 중인 수집 상태를 모두 초기화합니다.\n(수집 탭도 연결 해제됩니다)\n계속할까요?')) return;
  resetBtn.disabled = true;
  await chrome.runtime.sendMessage({ action: 'resetCollection' });
  setButtonIdle();
  progressSection.style.display = 'none';
  resumeBtn.style.display = 'none';
  setIdle('초기화 완료. 새로 수집을 시작할 수 있습니다.');
  resetBtn.disabled = false;
}

/**
 * 중지된 수집을 이어서 시작한다.
 * @returns {Promise<void>}
 */
async function resumeCollection() {
  resumeBtn.style.display = 'none';
  startBtn.style.display = 'none';
  stopBtn.style.display = 'inline-block';
  stopBtn.disabled = false;

  const settings = readSettings();
  setRunning('이어서 수집 중...');
  progressSection.style.display = 'block';

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'resumeCollection',
      payload: { settings },
    });

    if (!response?.ok) throw new Error(response?.error || '알 수 없는 오류');

    const count = response.downloadInfo?.count ?? 0;
    const filename = response.downloadInfo?.filename || response.filename || '';
    setIdle(`저장 완료: ${count}건\n파일: ${filename}`);
    await refreshLastResultMeta();
  } catch (error) {
    setIdle(`실패: ${String(error)}`);
  } finally {
    setButtonIdle();
    await checkResumeState();
  }
}

/**
 * 새 수집을 시작한다. 임시 재개 상태를 지운 다음 쿼리와 설정을 background로 전달한다.
 * @returns {Promise<void>}
 */
async function startCollection() {
  const queries = parseQueries(queriesEl.value);
  if (!queries.length) {
    setIdle('키워드를 한 줄에 하나씩 입력해 주세요.');
    return;
  }

  // 재개 상태 초기화 후 새로 시작
  await chrome.runtime.sendMessage({ action: 'clearResumeState' });
  resumeBtn.style.display = 'none';

  const settings = readSettings();
  setRunning(`총 ${queries.length}개 키워드를 검색합니다...`);
  progressSection.style.display = 'block';
  updateProgress(0, queries.length);
  startBtn.style.display = 'none';
  stopBtn.style.display = 'inline-block';
  stopBtn.disabled = false;

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'startCollection',
      payload: { queries, settings },
    });

    if (!response?.ok) {
      throw new Error(response?.error || '알 수 없는 오류');
    }

    const count = response.downloadInfo?.count ?? 0;
    const filename = response.downloadInfo?.filename || response.filename || '';
    setIdle(`저장 완료: ${count}건\n파일: ${filename}`);
    updateProgress(queries.length, queries.length);
    await refreshLastResultMeta();
  } catch (error) {
    setIdle(`실패: ${String(error)}`);
  } finally {
    setButtonIdle();
    await checkResumeState();
  }
}

/**
 * 최근 수집 결과를 지정 형식으로 다운로드한다.
 * @param {'csv'|'json'} format - 다운로드 형식
 * @returns {Promise<void>}
 */
async function downloadLastResults(format) {
  try {
    setRunning(`최근 결과를 ${format.toUpperCase()}로 내려받는 중...`);
    const response = await chrome.runtime.sendMessage({ action: 'downloadLastResults', format });
    if (!response?.ok) {
      throw new Error(response?.error || '최근 결과 다운로드 실패');
    }
    const count = response.downloadInfo?.count ?? 0;
    const filename = response.downloadInfo?.filename || response.filename || '';
    setIdle(`최근 결과 저장 완료: ${count}건\n파일: ${filename}`);
    await refreshLastResultMeta();
  } catch (error) {
    setIdle(`최근 결과 다운로드 실패: ${String(error)}`);
  }
}

/**
 * 입력된 텍스트를 줄 단위로 분리해 빈 항목을 제거한 배열로 반환한다.
 * @param {string} text - 입력장 원시 텍스트
 * @returns {string[]}
 */
function parseQueries(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 폼 입력값을 읽어 설정 객체로 반환한다.
 * @returns {{ delayMinMs: number, delayMaxMs: number, maxPages: number, useAllPages: boolean, baseFilename: string, exportFormat: string }}
 */
function readSettings() {
  const delayMinMs = Number(delayMinMsEl.value || 1200);
  const delayMaxMs = Number(delayMaxMsEl.value || delayMinMs);
  return {
    delayMinMs,
    delayMaxMs: Math.max(delayMinMs, delayMaxMs),
    maxPages: Number(maxPagesEl.value || 20),
    useAllPages: useAllPagesEl.checked,
    baseFilename: baseFilenameEl.value.trim() || '검색결과',
    exportFormat: exportFormatEl.value || 'csv',
  };
}

/**
 * 팝업 상태를 '실행중'으로 변경한다.
 * @param {string} message - 상태에 표시할 메시지
 */
function setRunning(message) {
  statusBadge.textContent = '실행중';
  statusBadge.className = 'badge badge-running';
  statusEl.textContent = message;
}

/**
 * 팝업 상태를 '대기중'으로 변경한다.
 * @param {string} message - 상태에 표시할 메시지
 */
function setIdle(message) {
  statusBadge.textContent = '대기중';
  statusBadge.className = 'badge badge-idle';
  statusEl.textContent = message;
}

/**
 * 진행 현황 UI(텍스트와 프로그레스 바)를 업데이트한다.
 * @param {number} current - 현재 처리된 쿼리 수
 * @param {number} total - 전체 쿼리 수
 */
function updateProgress(current, total) {
  progressText.textContent = `${current} / ${total}`;
  progressBar.style.width = `${total ? (current / total) * 100 : 0}%`;
}

/**
 * storage의 progress 값을 700ms 주기로 폴링하여 UI를 갱신한다.
 */
function startProgressPolling() {
  if (progressPoller) clearInterval(progressPoller);
  progressPoller = setInterval(async () => {
    const { progress, lastCollectedMeta } = await chrome.storage.local.get(['progress', 'lastCollectedMeta']);
    if (progress) {
      progressSection.style.display = 'block';
      updateProgress(progress.current || 0, progress.total || 0);
      // 실행 중일 때만 statusEl을 덮어씀 (완료 메시지 유지)
      if (progress.running) {
        statusEl.textContent = progress.message || '';
      }
      // 버튼 상태 동기화
      if (progress.running) {
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
      } else {
        // running=false 인데 stopBtn이 아직 보이면 idle로 복원
        if (stopBtn.style.display !== 'none' && !stopBtn.disabled) {
          // stopCollection 자체 타이머가 처리하지 못한 경우 보완
          setButtonIdle();
        }
      }
    }
    updateLastResultMeta(lastCollectedMeta);
  }, 700);
}

/** 재개 상태를 확인해 resumeBtn 표시 여부 결정 */
async function checkResumeState() {
  const { resumeState, partialCount } = await chrome.runtime.sendMessage({ action: 'getResumeState' });
  if (resumeState) {
    const qi = resumeState.startQueryIndex;
    const total = resumeState.queries?.length || 0;
    const page = resumeState.startPageNumber || 1;
    resumeBtn.title = `${qi + 1}/${total} 쿼리, ${page}페이지부터 재개 (수집된 ${partialCount}건 포함)`;
    resumeBtn.style.display = 'inline-block';
    resumeBtn.textContent = `이어서 수집 (${qi + 1}/${total}번째 쿼리부터)`;
  } else {
    resumeBtn.style.display = 'none';
  }
}

/** 버튼을 대기 상태로 복원 */
function setButtonIdle() {
  startBtn.style.display = 'inline-block';
  stopBtn.style.display = 'none';
  stopBtn.disabled = false;
}

/**
 * 저장된 수집 메타를 벽렀 표시 영역에 갱신한다.
 * @returns {Promise<void>}
 */
async function refreshLastResultMeta() {
  const { lastCollectedMeta } = await chrome.storage.local.get(['lastCollectedMeta']);
  updateLastResultMeta(lastCollectedMeta);
}

/**
 * 수집 메타로 작업 타임스탬프와 캬 수를 표시한다.
 * @param {{ rowCount: number, capturedAt: string }|null|undefined} meta
 */
function updateLastResultMeta(meta) {
  if (!meta?.rowCount) {
    lastResultMetaEl.textContent = '저장된 결과 없음';
    return;
  }
  const capturedAt = meta.capturedAt ? new Date(meta.capturedAt).toLocaleString() : '시간 미상';
  lastResultMetaEl.textContent = `${meta.rowCount}건 · ${capturedAt}`;
}