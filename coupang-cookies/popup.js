'use strict';

const $ = id => document.getElementById(id);

// DOM 참조
const sendBtn = $('sendBtn');
const refreshBtn = $('refreshBtn');
const lastRunStatus = $('lastRunStatus');
const slackToken = $('slackToken');
const slackChannel = $('slackChannel');
const slackFilename = $('slackFilename');
const slackAdsChannel = $('slackAdsChannel');
const slackAdsFilename = $('slackAdsFilename');
const statusBadge = $('statusBadge');
const versionLabel = document.querySelector('.subtitle');

// 전송 스케줄
const sendScheduleEnabled = $('sendScheduleEnabled');
const sendScheduleBody = $('sendScheduleBody');
const modeIntervalBtn = $('modeIntervalBtn');
const modeTimesBtn = $('modeTimesBtn');
const sendIntervalPanel = $('sendIntervalPanel');
const sendTimesPanel = $('sendTimesPanel');
const sendIntervalInput = $('sendIntervalInput');
const sendBaseTimeInput = $('sendBaseTimeInput');
const sendIntervalCron = $('sendIntervalCron');
const sendTimeTags = $('sendTimeTags');
const sendNewTimeInput = $('sendNewTimeInput');
const sendAddTimeBtn = $('sendAddTimeBtn');
const sendAlarmInfo = $('sendAlarmInfo');

// 새로고침 스케줄
const refreshEnabled = $('refreshEnabled');
const refreshIntervalInput = $('refreshIntervalInput');
const refreshBaseTimeInput = $('refreshBaseTimeInput');
const refreshIntervalCron = $('refreshIntervalCron');
const refreshAlarmInfo = $('refreshAlarmInfo');

// 설정 저장/불러오기
const exportConfigBtn = $('exportConfigBtn');
const importConfigBtn = $('importConfigBtn');
const importConfigInput = $('importConfigInput');
const configMsg = $('configMsg');

let _slackConfig = { token: '', wingChannel: '', adsChannel: '', wingFilename: '', adsFilename: '' };
let _sendScheduleConfig = { enabled: false, mode: 'interval', intervalMinutes: 1440, baseTime: '00:00:00', times: [] };
let _refreshScheduleConfig = { enabled: false, intervalMinutes: 30, baseTime: '00:00:00' };

/**
 * 숫자를 2자리 문자열로 패딩한다.
 * @param {number} n - 패딩할 숫자
 * @returns {string} 2자리로 패딩된 문자열
 */
function pad(n) { return String(n).padStart(2, '0'); }

/**
 * 간격(분)과 시작 기준 시각으로 하루치 발화 시각 목록을 생성한다.
 * @param {number} minutes  - 반복 간격 (분)
 * @param {string} baseTime - 시작 기준 시각 (HH:MM:SS 또는 기존 HH:MM)
 * @returns {string} 발화 시각 목록 문자열 (최대 6개 표시 후 생략 표기)
 */
function toCronHint(minutes, baseTime) {
  if (!minutes || minutes <= 0) return '';
  const [bh, bm, bs = 0] = (baseTime || '00:00:00').split(':').map(Number);
  const base = (bh * 60 + bm) * 60 + bs;
  const occurrences = [];
  for (let off = 0; off < 1440; off += minutes) {
    const total = (base + off * 60) % 86400;
    occurrences.push(`${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`);
  }
  if (occurrences.length <= 8) return occurrences.join('  ');
  return occurrences.slice(0, 6).join('  ') + `  … (${occurrences.length}회/일)`;
}

/** Slack 전송 스케줄의 크론 힌트를 갱신한다. */
function updateSendIntervalCron() {
  const mins = Number(sendIntervalInput.value) || 0;
  const base = sendBaseTimeInput.value || '00:00:00';
  sendIntervalCron.textContent = toCronHint(mins, base);
}

/** 새로고침 스케줄의 크론 힌트를 갱신한다. */
function updateRefreshIntervalCron() {
  const mins = Number(refreshIntervalInput.value) || 0;
  const base = refreshBaseTimeInput.value || '00:00:00';
  refreshIntervalCron.textContent = toCronHint(mins, base);
}

/**
 * 팝업 상단의 상태 배지 텍스트와 색상을 설정한다.
 * @param {string}                    text  - 배지에 표시할 텍스트
 * @param {'green'|'orange'|'red'}    color - 배지 배경 색상 키
 */
function setBadge(text, color) {
  statusBadge.textContent = text;
  const colors = {
    green: 'rgba(255,255,255,0.3)',
    orange: 'rgba(255,165,0,0.3)',
    red: 'rgba(231,76,60,0.3)',
  };
  statusBadge.style.background = colors[color] || 'rgba(255,255,255,0.2)';
}

// 초기화
document.addEventListener('DOMContentLoaded', async () => {
  versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;
  const [slackRes, sendRes, refreshRes, lastRunRes, lastRefreshRes] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'getSlackConfig' }),
    chrome.runtime.sendMessage({ action: 'getSendScheduleConfig' }),
    chrome.runtime.sendMessage({ action: 'getRefreshScheduleConfig' }),
    chrome.runtime.sendMessage({ action: 'getLastRun' }),
    chrome.runtime.sendMessage({ action: 'getLastRefresh' }),
  ]);

  if (slackRes?.config) {
    _slackConfig = slackRes.config;
    slackToken.value = _slackConfig.token || '';
    slackChannel.value = _slackConfig.wingChannel || '';
    slackFilename.value = _slackConfig.wingFilename || '';
    slackAdsChannel.value = _slackConfig.adsChannel || '';
    slackAdsFilename.value = _slackConfig.adsFilename || '';
  }

  if (sendRes?.config) {
    _sendScheduleConfig = sendRes.config;
    sendScheduleEnabled.checked = _sendScheduleConfig.enabled;
    applyModeUI(_sendScheduleConfig.mode || 'interval');
    sendIntervalInput.value = _sendScheduleConfig.intervalMinutes || 1440;
    sendBaseTimeInput.value = _sendScheduleConfig.baseTime || '00:00:00';
    updateSendPresetBtns(_sendScheduleConfig.intervalMinutes);
    updateSendIntervalCron();
    renderSendTimes();
  }

  if (refreshRes?.config) {
    _refreshScheduleConfig = refreshRes.config;
    refreshEnabled.checked = _refreshScheduleConfig.enabled;
    refreshIntervalInput.value = _refreshScheduleConfig.intervalMinutes || 30;
    refreshBaseTimeInput.value = _refreshScheduleConfig.baseTime || '00:00:00';
    updateRefreshPresetBtns(_refreshScheduleConfig.intervalMinutes);
    updateRefreshIntervalCron();
  }

  const latestRun = [lastRunRes?.data, lastRefreshRes?.data]
    .filter(Boolean)
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))[0];
  if (latestRun) showLastRun(latestRun);

  await refreshAlarmDisplay();
});

/**
 * Slack 전송 스케줄의 모드에 따라 UI 패널을 전환한다.
 * @param {'interval'|'times'} mode - 전환할 모드
 */
function applyModeUI(mode) {
  const isInterval = mode === 'interval';
  sendIntervalPanel.style.display = isInterval ? '' : 'none';
  sendTimesPanel.style.display = isInterval ? 'none' : '';
  modeIntervalBtn.classList.toggle('mode-tab-active', isInterval);
  modeTimesBtn.classList.toggle('mode-tab-active', !isInterval);
}

modeIntervalBtn.addEventListener('click', () => {
  _sendScheduleConfig.mode = 'interval';
  applyModeUI('interval');
  saveSendScheduleConfig();
});

modeTimesBtn.addEventListener('click', () => {
  _sendScheduleConfig.mode = 'times';
  applyModeUI('times');
  saveSendScheduleConfig();
});

/**
 * Slack 전송 간격 모드의 프리셋 버튼 활성 상태를 갱신한다.
 * @param {number} val - 현재 선택된 간격 (분)
 */
function updateSendPresetBtns(val) {
  document.querySelectorAll('#sendIntervalPanel .preset-btn').forEach(btn => {
    btn.classList.toggle('preset-btn-active', Number(btn.dataset.value) === Number(val));
  });
}

document.querySelectorAll('#sendIntervalPanel .preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const val = Number(btn.dataset.value);
    _sendScheduleConfig.intervalMinutes = val;
    sendIntervalInput.value = val;
    updateSendPresetBtns(val);
    updateSendIntervalCron();
    saveSendScheduleConfig();
  });
});

sendIntervalInput.addEventListener('change', () => {
  const val = Math.max(5, Number(sendIntervalInput.value) || 1440);
  sendIntervalInput.value = val;
  _sendScheduleConfig.intervalMinutes = val;
  updateSendPresetBtns(val);
  updateSendIntervalCron();
  saveSendScheduleConfig();
});

sendBaseTimeInput.addEventListener('change', () => {
  _sendScheduleConfig.baseTime = sendBaseTimeInput.value || '00:00:00';
  updateSendIntervalCron();
  saveSendScheduleConfig();
});

sendScheduleEnabled.addEventListener('change', saveSendScheduleConfig);

/**
 * 현재 UI의 Slack 전송 스케줄 설정을 storage에 저장하고 알람을 재설정한다.
 * @returns {Promise<void>}
 */
async function saveSendScheduleConfig() {
  _sendScheduleConfig.enabled = sendScheduleEnabled.checked;
  _sendScheduleConfig.baseTime = sendBaseTimeInput.value || '00:00:00';
  await chrome.runtime.sendMessage({ action: 'saveSendScheduleConfig', config: _sendScheduleConfig });
  await refreshAlarmDisplay();
}

/** Slack 전송 시각 목록(time tags)을 현재 설정 기준으로 다시 렌더링한다. */
function renderSendTimes() {
  sendTimeTags.innerHTML = '';
  for (const t of _sendScheduleConfig.times) {
    const tag = document.createElement('span');
    tag.className = 'time-tag';
    tag.textContent = t + ' ';

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.dataset.time = t;
    removeBtn.addEventListener('click', () => {
      _sendScheduleConfig.times = _sendScheduleConfig.times.filter(x => x !== t);
      renderSendTimes();
      saveSendScheduleConfig();
    });

    tag.appendChild(removeBtn);
    sendTimeTags.appendChild(tag);
  }
}

sendAddTimeBtn.addEventListener('click', () => {
  const time = sendNewTimeInput.value;
  if (time && !_sendScheduleConfig.times.includes(time)) {
    _sendScheduleConfig.times.push(time);
    _sendScheduleConfig.times.sort();
    renderSendTimes();
    saveSendScheduleConfig();
  }
});

/**
 * 새로고침 스케줄의 프리셋 버튼 활성 상태를 갱신한다.
 * @param {number} val - 현재 선택된 간격 (분)
 */
function updateRefreshPresetBtns(val) {
  document.querySelectorAll('#refreshBody .preset-btn').forEach(btn => {
    btn.classList.toggle('preset-btn-active', Number(btn.dataset.value) === Number(val));
  });
}

document.querySelectorAll('#refreshBody .preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const val = Number(btn.dataset.value);
    _refreshScheduleConfig.intervalMinutes = val;
    refreshIntervalInput.value = val;
    updateRefreshPresetBtns(val);
    updateRefreshIntervalCron();
    saveRefreshScheduleConfig();
  });
});

refreshIntervalInput.addEventListener('change', () => {
  const val = Math.max(5, Number(refreshIntervalInput.value) || 30);
  refreshIntervalInput.value = val;
  _refreshScheduleConfig.intervalMinutes = val;
  updateRefreshPresetBtns(val);
  updateRefreshIntervalCron();
  saveRefreshScheduleConfig();
});

refreshBaseTimeInput.addEventListener('change', () => {
  _refreshScheduleConfig.baseTime = refreshBaseTimeInput.value || '00:00:00';
  updateRefreshIntervalCron();
  saveRefreshScheduleConfig();
});

refreshEnabled.addEventListener('change', saveRefreshScheduleConfig);

/**
 * 현재 UI의 새로고침 스케줄 설정을 storage에 저장하고 알람을 재설정한다.
 * @returns {Promise<void>}
 */
async function saveRefreshScheduleConfig() {
  _refreshScheduleConfig.enabled = refreshEnabled.checked;
  _refreshScheduleConfig.baseTime = refreshBaseTimeInput.value || '00:00:00';
  await chrome.runtime.sendMessage({ action: 'saveRefreshScheduleConfig', config: _refreshScheduleConfig });
  await refreshAlarmDisplay();
}

slackToken.addEventListener('change', saveSlackConfig);
slackChannel.addEventListener('change', saveSlackConfig);
slackFilename.addEventListener('change', saveSlackConfig);
slackAdsChannel.addEventListener('change', saveSlackConfig);
slackAdsFilename.addEventListener('change', saveSlackConfig);

/**
 * Slack 설정 입력값을 storage에 저장한다.
 * @returns {Promise<void>}
 */
async function saveSlackConfig() {
  _slackConfig = {
    token: slackToken.value.trim(),
    wingChannel: slackChannel.value.trim(),
    adsChannel: slackAdsChannel.value.trim(),
    wingFilename: slackFilename.value.trim(),
    adsFilename: slackAdsFilename.value.trim(),
  };
  await chrome.runtime.sendMessage({ action: 'saveSlackConfig', config: _slackConfig });
}

/**
 * 현재 등록된 알람 정보를 조회해 다음 실행 시각을 UI에 표시한다.
 * @returns {Promise<void>}
 */
async function refreshAlarmDisplay() {
  const res = await chrome.runtime.sendMessage({ action: 'getAlarms' });
  if (!res?.success) return;

  if (res.sendAlarm) {
    const next = new Date(res.sendAlarm.scheduledTime);
    sendAlarmInfo.textContent = `다음 전송: ${next.toLocaleString('ko-KR')}`;
  } else {
    sendAlarmInfo.textContent = sendScheduleEnabled.checked ? '간격 또는 시각을 설정하세요' : '';
  }

  if (res.refreshAlarm) {
    const next = new Date(res.refreshAlarm.scheduledTime);
    refreshAlarmInfo.textContent = `다음 새로고침: ${next.toLocaleString('ko-KR')}`;
  } else {
    refreshAlarmInfo.textContent = refreshEnabled.checked ? '간격을 설정하세요' : '';
  }
}

// 수동 전송
sendBtn.addEventListener('click', async () => {
  sendBtn.disabled = true;
  sendBtn.textContent = '\u23f3 \ucd94\ucd9c \uc911...';
  setBadge('\uc2e4\ud589 \uc911', 'orange');

  try {
    const res = await chrome.runtime.sendMessage({ action: 'extractAndSend' });
    if (res?.success) {
      setBadge('\uc644\ub8cc', 'green');
      showLastRun(res.data);
    } else {
      setBadge('\uc2e4\ud328', 'red');
      showLastRun({ success: false, error: res?.error || '\uc791\uc5c5 \uc751\ub2f5\uc774 \uc5c6\uc2b5\ub2c8\ub2e4.', timestamp: new Date().toLocaleString('ko-KR') });
    }
  } catch (e) {
    setBadge('\uc2e4\ud328', 'red');
    showLastRun({ success: false, error: e.message, timestamp: new Date().toLocaleString('ko-KR') });
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = '\u{1F680} \ucd94\ucd9c & \uc804\uc1a1';
  }
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = '\u23f3 \uc0c8\ub85c\uace0\uce68 \uc911...';
  setBadge('\uc0c8\ub85c\uace0\uce68', 'orange');

  try {
    const res = await chrome.runtime.sendMessage({ action: 'refreshOnly' });
    if (res?.success) {
      setBadge('\uc644\ub8cc', 'green');
      showLastRun({
        success: true, type: 'refresh',
        timestamp: res.data?.timestamp,
        message: res.data?.adsUrl ? '\uad11\uace0\uc13c\ud130 \ubaa9\ud45c \ud398\uc774\uc9c0 \ub3c4\ucc29 \ud655\uc778 \uc644\ub8cc' : '\uad11\uace0\uc13c\ud130 \ubaa9\ud45c \ud398\uc774\uc9c0 \uac80\uc99d\uc5d0 \uc2e4\ud328',
        adsUrl: res.data?.adsUrl,
      });
    } else {
      setBadge('\uc2e4\ud328', 'red');
      showLastRun({ success: false, error: res?.error || '\uc791\uc5c5 \uc751\ub2f5\uc774 \uc5c6\uc2b5\ub2c8\ub2e4.', timestamp: new Date().toLocaleString('ko-KR') });
    }
  } catch (e) {
    setBadge('\uc2e4\ud328', 'red');
    showLastRun({ success: false, error: e.message, timestamp: new Date().toLocaleString('ko-KR') });
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '\u{1F504} \uc0c8\ub85c\uace0\uce68\ub9cc';
  }
});

exportConfigBtn.addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getAllSettings' });
    if (!res?.success) throw new Error(res?.error || '설정 읽기 실패');

    const json = JSON.stringify(res.settings, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const ts = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
                + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    const fname = `coupang-cookies-config_${ts}.json`;
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
    showConfigMsg(`✅ 내보내기 완료: ${fname}`, 'success');
  } catch (e) {
    showConfigMsg('❌ 내보내기 실패: ' + e.message, 'error');
  }
});

// 설정 불러오기
importConfigBtn.addEventListener('click', () => importConfigInput.click());

importConfigInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  importConfigInput.value = '';

  try {
    const text = await file.text();
    const settings = JSON.parse(text);
    if (typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('올바른 설정 파일이 아닙니다');
    }

    // Ads v0.2.x exported a single Slack channel; merge it as the Ads destination.
    if (/^0\.2\./.test(String(settings._version || '')) && settings.slackConfig?.channel) {
      const currentRes = await chrome.runtime.sendMessage({ action: 'getSlackConfig' });
      const current = currentRes?.config || {};
      settings.slackConfig = {
        token: current.token || settings.slackConfig.token || '',
        wingChannel: current.wingChannel || '',
        adsChannel: settings.slackConfig.channel,
        wingFilename: current.wingFilename || '',
        adsFilename: settings.slackConfig.filename || 'coupang_ads_cookies',
      };
      delete settings.sendScheduleConfig;
      delete settings.refreshScheduleConfig;
    }

    const res = await chrome.runtime.sendMessage({ action: 'setAllSettings', settings });
    if (!res?.success) throw new Error(res?.error || '설정 적용 실패');

    // UI 즉시 반영
    if (settings.slackConfig) {
      _slackConfig = {
        token: settings.slackConfig.token || '',
        wingChannel: settings.slackConfig.wingChannel || settings.slackConfig.channel || '',
        adsChannel: settings.slackConfig.adsChannel || '',
        wingFilename: settings.slackConfig.wingFilename || settings.slackConfig.filename || '',
        adsFilename: settings.slackConfig.adsFilename || '',
      };
      slackToken.value = _slackConfig.token || '';
      slackChannel.value = _slackConfig.wingChannel || '';
      slackFilename.value = _slackConfig.wingFilename || '';
      slackAdsChannel.value = _slackConfig.adsChannel || '';
      slackAdsFilename.value = _slackConfig.adsFilename || '';
    }
    if (settings.sendScheduleConfig) {
      _sendScheduleConfig = settings.sendScheduleConfig;
      sendScheduleEnabled.checked = _sendScheduleConfig.enabled;
      applyModeUI(_sendScheduleConfig.mode || 'interval');
      sendIntervalInput.value = _sendScheduleConfig.intervalMinutes || 1440;
      sendBaseTimeInput.value = _sendScheduleConfig.baseTime || '00:00:00';
      updateSendPresetBtns(_sendScheduleConfig.intervalMinutes);
      updateSendIntervalCron();
      renderSendTimes();
    }
    if (settings.refreshScheduleConfig) {
      _refreshScheduleConfig = settings.refreshScheduleConfig;
      refreshEnabled.checked = _refreshScheduleConfig.enabled;
      refreshIntervalInput.value = _refreshScheduleConfig.intervalMinutes || 30;
      refreshBaseTimeInput.value = _refreshScheduleConfig.baseTime || '00:00:00';
      updateRefreshPresetBtns(_refreshScheduleConfig.intervalMinutes);
      updateRefreshIntervalCron();
    }

    await refreshAlarmDisplay();
    const ver = settings._version ? ` (v${settings._version})` : '';
    showConfigMsg(`✅ 불러오기 완료${ver}: ${res.applied.join(', ')}`, 'success');
  } catch (e) {
    showConfigMsg('❌ 불러오기 실패: ' + e.message, 'error');
  }
});

/**
 * 마지막 실행 결과를 상태 박스에 표시한다.
 * @param {{ success: boolean, type?: string, message?: string, timestamp?: string, cookieCount?: number, error?: string }} run - 실행 결과 객체
 */
function showLastRun(run) {
  if (!run) return;
  lastRunStatus.style.display = 'block';
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);

  if (run.type === 'refresh') {
    const statusClass = run.success ? 'status-success' : 'status-error';
    const message = run.success ? (run.message || '로그인 확인 및 새로고침 완료') : (run.error || '새로고침 실패');
    lastRunStatus.innerHTML =
      `<span class="label">마지막 새로고침:</span> <span class="${statusClass}">${escapeHtml(message)}</span><br>`
      + `<span class="text-muted">${escapeHtml(run.timestamp || '')}${run.adsUrl ? ` | ${escapeHtml(run.adsUrl)}` : ''}</span>`;
    return;
  }

  if (run.success) {
    lastRunStatus.innerHTML =
      `<span class="label">마지막 전송:</span> <span class="status-success">✅ 성공</span><br>`
      + `<span class="text-muted">${escapeHtml(run.timestamp)} | Wing ${run.wingCookieCount ?? 0}개 / 광고센터 ${run.adsCookieCount ?? 0}개${run.adsUrl ? ` | ${escapeHtml(run.adsUrl)}` : ''}</span>`;
  } else {
    lastRunStatus.innerHTML =
      `<span class="label">마지막 실행:</span> <span class="status-error">❌ 실패</span><br>`
      + `<span class="text-muted">${run.timestamp || ''} | ${run.error || '알 수 없는 오류'}</span>`;
  }
}

/**
 * 설정 내보내기/불러오기 결과 메시지를 표시한다.
 * @param {string}                   msg  - 표시할 메시지
 * @param {'success'|'error'|string} type - 메시지 유형
 */
function showConfigMsg(msg, type) {
  configMsg.textContent = msg;
  configMsg.style.display = 'block';
  configMsg.className = 'mt6 ' + (type === 'success' ? 'status-success' : type === 'error' ? 'status-error' : 'text-muted');
}
