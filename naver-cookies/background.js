/**
 * 네이버 쿠키 업데이트
 *
 * 역할:
 *  - 네이버 탭 새로고침 → .naver.com 쿠키 추출 → Slack 파일 업로드
 *  - 두 가지 독립 스케줄:
 *      - ALARM_SEND: 새로고침 + 추출 + Slack 전송 (간격 또는 시각 모드)
 *      - ALARM_REFRESH: Slack 전송 없이 새로고침만 (간격 모드, 세션 유지용)
 *  - 설정 전체 내보내기 / 불러오기 (getAllSettings / setAllSettings)
 *
 * 스케줄 설정 형식:
 *  - sendScheduleConfig: { enabled, mode: 'interval'|'times', intervalMinutes, baseTime: 'HH:MM', times: ['HH:MM'] }
 *  - refreshScheduleConfig: { enabled, intervalMinutes, baseTime: 'HH:MM' }
 */

'use strict';

const ALARM_SEND = 'naver-cookies-send';
const ALARM_REFRESH = 'naver-cookies-refresh';

/**
 * 숫자를 2자리 문자열로 패딩한다.
 * @param {number} n - 패딩할 숫자
 * @returns {string} 2자리로 패딩된 문자열
 */
function pad(n) { return String(n).padStart(2, '0'); }

/**
 * Date 객체를 'YYYY-MM-DD HH:MM' 형식의 문자열로 변환한다.
 * @param {Date} [date] - 변환할 날짜 (생략 시 현재 시각)
 * @returns {string} 포맷된 타임스탬프 문자열
 */
function formatTimestamp(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * .naver.com 도메인의 쿠키를 추출해 'name=value; ...' 형식으로 반환한다.
 * 쿠키가 없으면 null을 반환한다.
 * @returns {Promise<string|null>} 쿠키 문자열, 또는 쿠키가 없으면 null
 */
async function extractNaverCookies() {
  const cookies = await chrome.cookies.getAll({ domain: 'naver.com' });
  if (!cookies.length) return null;

  const seen = new Set();
  const unique = [];
  for (const c of cookies) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      unique.push(c);
    }
  }

  unique.sort((a, b) => a.name.localeCompare(b.name));
  return unique.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * 열린 네이버 탭을 새로고침하고 로딩 완료를 기다립니다. (최대 30초)
 * 열린 네이버 탭이 없으면 false를 반환한다.
 * @returns {Promise<boolean>} 새로고침 성공 여부
 */
async function refreshNaverTab() {
  const tabs = await chrome.tabs.query({ url: ['*://*.naver.com/*'] });
  if (!tabs.length) return false;

  const tab = tabs[0];
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, 30_000);

    function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        setTimeout(() => resolve(true), 2000);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tab.id);
  });
}

/**
 * Slack Files API (v2) 2단계 방식으로 텍스트 파일을 채널에 업로드한다.
 * @param {string}      token          - Slack Bot Token (xoxb-...)
 * @param {string}      channel        - 업로드할 채널 ID
 * @param {Uint8Array}  fileBytes      - 업로드할 파일 바이트 배열
 * @param {string}      fname          - 업로드할 파일명
 * @param {string|null} initialComment - 파일과 함께 전송할 메시지 (없으면 null)
 * @returns {Promise<Object>} Slack API completeUploadExternal 응답 객체
 */
async function uploadFileToSlack(token, channel, fileBytes, fname, initialComment) {
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${token}`,
    },
    body: `filename=${encodeURIComponent(fname)}&length=${fileBytes.byteLength}`,
  });
  const urlJson = await urlRes.json();
  if (!urlJson.ok) throw new Error(`getUploadURLExternal 실패: ${urlJson.error}`);

  const formData = new FormData();
  formData.append('file', new Blob([fileBytes], { type: 'text/plain' }), fname);
  const uploadRes = await fetch(urlJson.upload_url, { method: 'POST', body: formData });
  if (!uploadRes.ok) throw new Error(`파일 업로드 실패 (HTTP ${uploadRes.status})`);

  const completeBody = { files: [{ id: urlJson.file_id, title: fname }], channel_id: channel };
  if (initialComment) completeBody.initial_comment = initialComment;
  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(completeBody),
  });
  const completeJson = await completeRes.json();
  if (!completeJson.ok) throw new Error(`completeUploadExternal 실패: ${completeJson.error}`);

  console.log(`[BG] Slack 파일 업로드 완료: ${fname} → 채널 ${channel}`);
  return completeJson;
}

/**
 * storage의 Slack 설정을 읽어 쿠키 문자열을 텍스트 파일로 업로드한다.
 * Slack 설정이 불완전하면 에러를 throw한다.
 * @param {string} cookieString - 전송할 쿠키 문자열 ('name=value; ...' 형식)
 * @returns {Promise<void>}
 */
async function sendCookiesToSlack(cookieString) {
  const { slackConfig } = await chrome.storage.local.get('slackConfig');
  if (!slackConfig?.token || !slackConfig?.channel || !slackConfig?.filename) {
    throw new Error('Slack 설정이 완료되지 않았습니다. (토큰, 채널, 파일명 필요)');
  }

  const token = slackConfig.token.trim();
  const channel = slackConfig.channel.trim();
  const filename = (slackConfig.filename.trim() || 'naver_cookies') + '.txt';
  const fileBytes = new TextEncoder().encode(cookieString);
  await uploadFileToSlack(token, channel, fileBytes, filename, null);
}

/**
 * Slack 전송 없이 네이버 탭만 새로고침한다. (세션 유지용)
 * 결과는 storage의 lastRefresh 키에 저장된다.
 * @returns {Promise<{ timestamp: string, type: string, success: boolean, tabFound: boolean, error: string|null }>} 실행 로그
 */
async function refreshOnly() {
  const log = {
    timestamp: formatTimestamp(),
    type: 'refresh',
    success: false,
    tabFound: false,
    error: null,
  };
  try {
    log.tabFound = await refreshNaverTab();
    log.success = true;
  } catch (e) {
    log.error = e.message;
    throw e;
  } finally {
    await chrome.storage.local.set({ lastRefresh: log });
  }
  return log;
}

/**
 * 네이버 탭 새로고침 → 쿠키 추출 → Slack 전송을 순서대로 실행한다.
 * NID_SES 쿠키가 없으면 전송을 중단하고 에러를 throw한다.
 * 결과는 storage의 lastRun 키에 저장된다.
 * @returns {Promise<{ timestamp: string, success: boolean, error: string|null, cookieCount: number, hasNidSes: boolean }>} 실행 로그
 */
async function extractAndSend() {
  const log = {
    timestamp: formatTimestamp(),
    success: false,
    error: null,
    cookieCount: 0,
    hasNidSes: false,
  };

  try {
    await refreshNaverTab();

    const cookieString = await extractNaverCookies();
    if (!cookieString) {
      throw new Error('네이버 쿠키를 찾을 수 없습니다. 네이버에 로그인되어 있는지 확인하세요.');
    }

    log.cookieCount = cookieString.split('; ').length;
    log.hasNidSes = cookieString.includes('NID_SES=');

    if (!log.hasNidSes) {
      throw new Error('NID_SES 쿠키가 없습니다. 네이버에 로그인되어 있는지 확인하세요.');
    }

    await sendCookiesToSlack(cookieString);
    log.success = true;
  } catch (e) {
    log.error = e.message;
    throw e;
  } finally {
    await chrome.storage.local.set({ lastRun: log });
  }

  return log;
}

/**
 * Slack 전송 스케줄 알람을 설정한다.
 * interval 모드에서는 baseTime 기준으로 다음 발화까지의 지연을 계산한다.
 * times 모드에서는 가장 가까운 다음 시각에 one-shot 알람을 설정한다.
 * @param {{ enabled: boolean, mode: 'interval'|'times', intervalMinutes: number, baseTime: string, times: string[] }} config - Slack 전송 스케줄 설정
 * @returns {Promise<void>}
 */
async function scheduleSendAlarm(config) {
  await chrome.alarms.clear(ALARM_SEND);
  if (!config?.enabled) return;

  if (config.mode === 'interval') {
    const mins = Number(config.intervalMinutes);
    if (!mins || mins <= 0) return;

    // 기준 시각이 있으면 다음 발화까지의 정확한 지연을 계산
    let delay = mins;
    if (config.baseTime) {
      const [bh, bm] = config.baseTime.split(':').map(Number);
      const now = new Date();
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const baseMins = bh * 60 + bm;
      const elapsed = (nowMins - baseMins + 1440) % 1440; // 기준 시각 이후 경과 분
      const sinceLast = elapsed % mins; // 마지막 발화 이후 경과 분
      delay = sinceLast === 0 ? mins : mins - sinceLast;
      delay = Math.max(1, delay);
    }

    chrome.alarms.create(ALARM_SEND, { delayInMinutes: delay, periodInMinutes: mins });
    console.log(`[BG] 전송 알람 설정: 매 ${mins}분 (첫 발화까지 ${delay}분)`);
    return;
  }

  // times 모드: 오늘/내일 가장 빠른 다음 시각에 one-shot 알람
  const times = (config.times || []).filter(Boolean).sort();
  if (!times.length) return;

  const now = new Date();
  let nextTime = null;

  for (const t of times) {
    const [h, m] = t.split(':').map(Number);
    const candidate = new Date(now);
    candidate.setHours(h, m, 0, 0);
    if (candidate > now) { nextTime = candidate; break; }
  }

  if (!nextTime) {
    const [h, m] = times[0].split(':').map(Number);
    nextTime = new Date(now);
    nextTime.setDate(nextTime.getDate() + 1);
    nextTime.setHours(h, m, 0, 0);
  }

  chrome.alarms.create(ALARM_SEND, { when: nextTime.getTime() });
  console.log(`[BG] 전송 알람 설정 (times 모드): ${formatTimestamp(nextTime)}`);
}

// ─── 새로고침 스케줄 알람 설정 ───────────────────────────────────────────────
// refreshScheduleConfig: { enabled, intervalMinutes, baseTime: 'HH:MM' }
async function scheduleRefreshAlarm(config) {
  await chrome.alarms.clear(ALARM_REFRESH);
  if (!config?.enabled) return;

  const mins = Number(config.intervalMinutes);
  if (!mins || mins <= 0) return;

  let delay = mins;
  if (config.baseTime) {
    const [bh, bm] = config.baseTime.split(':').map(Number);
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const baseMins = bh * 60 + bm;
    const elapsed = (nowMins - baseMins + 1440) % 1440;
    const sinceLast = elapsed % mins;
    delay = sinceLast === 0 ? mins : mins - sinceLast;
    delay = Math.max(1, delay);
  }

  chrome.alarms.create(ALARM_REFRESH, { delayInMinutes: delay, periodInMinutes: mins });
  console.log(`[BG] 새로고침 알람 설정: 매 ${mins}분 (첫 발화까지 ${delay}분)`);
}

// ─── 알람 리스너 ─────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_SEND) {
    console.log('[BG] [SEND] 스케줄 쿠키 추출 & 전송 시작');
    try {
      await extractAndSend();
    } catch (e) {
      console.error('[BG] [SEND] 실패:', e.message);
    }
    // times 모드는 one-shot이므로 실행 후 다음 알람 재설정
    const { sendScheduleConfig } = await chrome.storage.local.get('sendScheduleConfig');
    if (sendScheduleConfig?.mode !== 'interval') {
      await scheduleSendAlarm(sendScheduleConfig);
    }
  } else if (alarm.name === ALARM_REFRESH) {
    console.log('[BG] [REFRESH] 스케줄 새로고침 시작');
    try {
      await refreshOnly();
    } catch (e) {
      console.error('[BG] [REFRESH] 실패:', e.message);
    }
  }
});

// ─── 메시지 핸들러 ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    try {
      switch (request.action) {

        // 수동 액션

        case 'extractAndSend': {
          const result = await extractAndSend();
          sendResponse({ success: true, data: result });
          break;
        }

        case 'refreshOnly': {
          const result = await refreshOnly();
          sendResponse({ success: true, data: result });
          break;
        }

        // 로그 조회

        case 'getLastRun': {
          const { lastRun } = await chrome.storage.local.get('lastRun');
          sendResponse({ success: true, data: lastRun || null });
          break;
        }

        case 'getLastRefresh': {
          const { lastRefresh } = await chrome.storage.local.get('lastRefresh');
          sendResponse({ success: true, data: lastRefresh || null });
          break;
        }

        // Slack 설정

        case 'saveSlackConfig': {
          await chrome.storage.local.set({ slackConfig: request.config });
          sendResponse({ success: true });
          break;
        }

        case 'getSlackConfig': {
          const { slackConfig } = await chrome.storage.local.get('slackConfig');
          sendResponse({ success: true, config: slackConfig || { token: '', channel: '', filename: '' } });
          break;
        }

        // Slack 전송 스케줄 설정

        case 'saveSendScheduleConfig': {
          await chrome.storage.local.set({ sendScheduleConfig: request.config });
          await scheduleSendAlarm(request.config);
          sendResponse({ success: true });
          break;
        }

        case 'getSendScheduleConfig': {
          const { sendScheduleConfig } = await chrome.storage.local.get('sendScheduleConfig');
          sendResponse({
            success: true,
            config: sendScheduleConfig || { enabled: false, mode: 'interval', intervalMinutes: 1440, baseTime: '00:00', times: [] },
          });
          break;
        }

        // 새로고침 스케줄 설정

        case 'saveRefreshScheduleConfig': {
          await chrome.storage.local.set({ refreshScheduleConfig: request.config });
          await scheduleRefreshAlarm(request.config);
          sendResponse({ success: true });
          break;
        }

        case 'getRefreshScheduleConfig': {
          const { refreshScheduleConfig } = await chrome.storage.local.get('refreshScheduleConfig');
          sendResponse({
            success: true,
            config: refreshScheduleConfig || { enabled: false, intervalMinutes: 30, baseTime: '00:00' },
          });
          break;
        }

        // 알람 조회

        case 'getAlarms': {
          const [sendAlarm, refreshAlarm] = await Promise.all([
            chrome.alarms.get(ALARM_SEND),
            chrome.alarms.get(ALARM_REFRESH),
          ]);
          sendResponse({ success: true, sendAlarm: sendAlarm || null, refreshAlarm: refreshAlarm || null });
          break;
        }

        // 설정 내보내기 / 불러오기

        case 'getAllSettings': {
          const keys = ['slackConfig', 'sendScheduleConfig', 'refreshScheduleConfig'];
          const stored = await chrome.storage.local.get(keys);
          sendResponse({
            success: true,
            settings: {
              _version: chrome.runtime.getManifest().version,
              _exportedAt: new Date().toISOString(),
              slackConfig: stored.slackConfig || { token: '', channel: '', filename: '' },
              sendScheduleConfig: stored.sendScheduleConfig || { enabled: false, mode: 'interval', intervalMinutes: 1440, baseTime: '00:00', times: [] },
              refreshScheduleConfig: stored.refreshScheduleConfig || { enabled: false, intervalMinutes: 30, baseTime: '00:00' },
            },
          });
          break;
        }

        case 'setAllSettings': {
          const s = request.settings || {};
          const toSave = {};
          if (s.slackConfig) toSave.slackConfig = s.slackConfig;
          if (s.sendScheduleConfig) toSave.sendScheduleConfig = s.sendScheduleConfig;
          if (s.refreshScheduleConfig) toSave.refreshScheduleConfig = s.refreshScheduleConfig;
          await chrome.storage.local.set(toSave);
          if (toSave.sendScheduleConfig) await scheduleSendAlarm(toSave.sendScheduleConfig);
          if (toSave.refreshScheduleConfig) await scheduleRefreshAlarm(toSave.refreshScheduleConfig);
          sendResponse({ success: true, applied: Object.keys(toSave) });
          break;
        }

        default:
          sendResponse({ success: false, error: '알 수 없는 액션: ' + request.action });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true; // async sendResponse
});

/**
 * storage에 저장된 설정으로 두 알람을 복원한다.
 * 확장 프로그램 설치 또는 브라우저 재시작 시 호출된다.
 * @returns {Promise<void>}
 */
async function restoreAlarms() {
  const { sendScheduleConfig, refreshScheduleConfig } = await chrome.storage.local.get([
    'sendScheduleConfig', 'refreshScheduleConfig',
  ]);
  await scheduleSendAlarm(sendScheduleConfig);
  await scheduleRefreshAlarm(refreshScheduleConfig);
}

chrome.runtime.onInstalled.addListener(restoreAlarms);
chrome.runtime.onStartup.addListener(restoreAlarms);