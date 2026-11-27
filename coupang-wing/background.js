/**
 * 쿠팡 Wing 쿠키 업데이트
 *
 * 역할:
 *  - 쿠팡 Wing 탭 새로고침 → wing.coupang.com 쿠키 추출 → Slack 파일 업로드
 *  - 두 가지 독립 스케줄:
 *      - ALARM_SEND: 새로고침 + 추출 + Slack 전송 (간격 또는 시각 모드)
 *      - ALARM_REFRESH: Slack 전송 없이 새로고침만 (간격 모드, 세션 유지용)
 *  - 설정 전체 내보내기 / 불러오기 (getAllSettings / setAllSettings)
 *
 * 스케줄 설정 형식:
 *  - sendScheduleConfig: { enabled, mode: 'interval'|'times', intervalMinutes, baseTime: 'HH:MM:SS', times: ['HH:MM'] }
 *  - refreshScheduleConfig: { enabled, intervalMinutes, baseTime: 'HH:MM:SS' }
 */

'use strict';

const TARGET_HOST = 'wing.coupang.com';

const ALARM_SEND = 'coupang-wing-send';
const ALARM_REFRESH = 'coupang-wing-refresh';

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
 * wing.coupang.com 도메인의 쿠키를 추출해 'name=value; ...' 형식으로 반환한다.
 * 쿠키가 없으면 null을 반환한다.
 * @returns {Promise<string|null>} 쿠키 문자열, 또는 쿠키가 없으면 null
 */
async function extractCoupangCookies() {
  // 공통 부모 도메인 쿠키와 서비스 전용 쿠키만 포함한다.
  const allCookies = await chrome.cookies.getAll({ domain: 'coupang.com' });
  const cookies = allCookies.filter(cookie => {
    const domain = cookie.domain.replace(/^\./, '');
    return domain === TARGET_HOST || (!cookie.hostOnly && TARGET_HOST.endsWith('.' + domain));
  });
  // 같은 이름이면 서비스 전용 도메인, 더 구체적인 경로를 우선한다.
  cookies.sort((a, b) => b.domain.length - a.domain.length || b.path.length - a.path.length);
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
 * Dispatch one browser-level click to an element in the temporary Coupang tab.
 * This lets Chrome's native password autofill participate in the same click
 * flow as a real mouse action. Coordinates are read in the page viewport, so
 * desktop window size and position do not affect the target.
 * @param {number} tabId
 * @param {string} selector
 * @returns {Promise<{ clicked: boolean, reason?: string }>}
 */
async function clickCoupangElement(tabId, selector) {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    const expression = `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) return null;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`;
    const evaluated = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    const point = evaluated?.result?.value;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { clicked: false, reason: 'button-not-visible' };
    }

    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
    return { clicked: true };
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

/**
 * 작업용 새 탭에서 로그인 상태를 확인하고 필요한 경우 저장된 자동완성 값으로 로그인한다.
 * @returns {Promise<boolean>} 작업 성공 여부
 */
async function withAuthenticatedCoupangTab(task) {
  const tab = await chrome.tabs.create({ url: `https://${TARGET_HOST}/`, active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});

  async function inspectLoginPage() {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        ready: document.readyState === 'complete',
        url: location.href,
        title: document.title,
        loginButton: Boolean(document.querySelector('#kc-login')),
        usernamePresent: Boolean(document.querySelector('#username')?.value?.trim()),
        passwordPresent: Boolean(document.querySelector('#password')?.value),
        loginButtonDisabled: Boolean(document.querySelector('#kc-login')?.disabled),
        loginError: document.querySelector('[role="alert"], .alert-error, .kc-feedback-text')?.textContent?.trim() || '',
        bodyText: document.body?.innerText?.slice(0, 500) || '',
      }),
    });
    if (!result?.result) throw new Error('Coupang 탭의 페이지 상태를 읽을 수 없습니다.');
    return result.result;
  }

  async function waitForPageState(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    let inspectFailureSince = 0;
    let lastInspectError = null;
    while (Date.now() < deadline) {
      let currentTab;
      try {
        currentTab = await chrome.tabs.get(tab.id);
      } catch {
        throw new Error('The Coupang task tab was closed before the operation finished.');
      }
      let state = null;
      if (currentTab.status === 'complete') {
        try {
          state = await inspectLoginPage();
          inspectFailureSince = 0;
          lastInspectError = null;
        } catch (error) {
          // Redirects between Wing and xauth can briefly invalidate an injection.
          // Retry that race, but fail quickly with the actual browser error if it persists.
          if (!inspectFailureSince) inspectFailureSince = Date.now();
          lastInspectError = error;
          if (Date.now() - inspectFailureSince >= 5_000) {
            const latestTab = await chrome.tabs.get(tab.id).catch(() => null);
            throw new Error(`쿠팡 페이지 검사 실패 (${latestTab?.url || 'URL 확인 불가'}): ${error.message}`);
          }
        }
      }
      if (state?.ready && predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(lastInspectError ? `${message} 마지막 검사 오류: ${lastInspectError.message}` : message);
  }

  try {
    let initialState = await waitForPageState(
      () => true,
      25_000,
      '쿠팡 탭이 25초 안에 로드되지 않았습니다.'
    );
    // The login form is the source of truth. Do not infer login state from a
    // hostname: Wing redirects logged-out sessions to xauth, and redirects can
    // change while this temporary tab is loading.
    if (initialState.loginButton) {
      if (initialState.loginButtonDisabled) {
        throw new Error('로그인 페이지는 확인했지만 로그인 버튼이 비활성 상태입니다.');
      }

      // Chrome's password manager does not treat HTMLElement.focus() as a
      // user gesture. Click the username field through browser input first,
      // just as when opening the page manually, so native autofill can run.
      const usernameClick = await clickCoupangElement(tab.id, '#username');
      if (!usernameClick.clicked) {
        throw new Error(`로그인 아이디 입력란에 포커스하지 못했습니다. ${usernameClick.reason || ''}`.trim());
      }

      const autofillDeadline = Date.now() + 10_000;
      while (Date.now() < autofillDeadline) {
        const latestState = await inspectLoginPage();
        initialState = latestState;
        if (!latestState.loginButton || (latestState.usernamePresent && latestState.passwordPresent)) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!initialState.loginButton) {
        // The user or browser completed login while the form was settling.
        return await task(tab);
      }
      if (!initialState.usernamePresent || !initialState.passwordPresent) {
        throw new Error(`Chrome 자동완성이 아이디/비밀번호를 채우지 않아 로그인 제출을 중단했습니다. (감지=${initialState.usernamePresent}/${initialState.passwordPresent})`);
      }
      console.log(`[BG] Login form detected; dispatching one browser-level #kc-login click (DOM autofill visible=${initialState.usernamePresent}/${initialState.passwordPresent}).`);
      const clickResult = await clickCoupangElement(tab.id, '#kc-login');
      if (!clickResult.clicked) {
        throw new Error(`로그인 버튼을 누르지 못했습니다: ${clickResult.reason || '브라우저 입력 실패'}`);
      }
      const loginResult = await waitForPageState(
        state => !state.loginButton || Boolean(state.loginError),
        25_000,
        '로그인 버튼을 눌렀지만 25초 안에 로그인 완료를 확인하지 못했습니다.'
      );
      if (loginResult.loginButton) {
        const autofillState = `자동완성 입력값 감지=${initialState.usernamePresent}/${initialState.passwordPresent}`;
        throw new Error(`${loginResult.loginError || 'Coupang did not complete the login.'} (${autofillState})`);
      }
      console.log('[BG] Login form disappeared; continuing in the same task tab.');
    } else {
      console.log('[BG] #kc-login is absent; continuing as an authenticated session.');
    }

    return await task(tab);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function refreshCoupangTab() {
  return withAuthenticatedCoupangTab(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    return true;
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
  const filename = (slackConfig.filename.trim() || 'coupang_wing') + '.txt';
  const fileBytes = new TextEncoder().encode(cookieString);
  await uploadFileToSlack(token, channel, fileBytes, filename, null);
}

/**
 * Slack 전송 없이 쿠팡 Wing 탭만 새로고침한다. (세션 유지용)
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
    log.tabFound = await refreshCoupangTab();
    log.success = log.tabFound;
  } catch (e) {
    log.error = e.message;
    throw e;
  } finally {
    await chrome.storage.local.set({ lastRefresh: log });
  }
  return log;
}

/**
 * 쿠팡 Wing 탭 새로고침 → 쿠키 추출 → Slack 전송을 순서대로 실행한다.
 * 대상 탭이나 쿠키가 없으면 전송을 중단한다. 로그인 유효성은 별도로 검증하지 않는다.
 * 결과는 storage의 lastRun 키에 저장된다.
 * @returns {Promise<{ timestamp: string, success: boolean, error: string|null, cookieCount: number }>} 실행 로그
 */
async function extractAndSend() {
  const log = {
    timestamp: formatTimestamp(),
    success: false,
    error: null,
    cookieCount: 0,
  };

  try {
    await withAuthenticatedCoupangTab(async () => {
      const cookieString = await extractCoupangCookies();
      if (!cookieString) {
        throw new Error('No Coupang Wing cookies were found after login verification.');
      }

      log.cookieCount = cookieString.split('; ').length;
      await sendCookiesToSlack(cookieString);
      log.success = true;
    });
  } catch (e) {
    log.error = e.message;
    throw e;
  } finally {
    await chrome.storage.local.set({ lastRun: log });
  }

  return log;
}
/**
 * 기준 시각의 초까지 반영하여 다음 실행 시각을 계산한다.
 * @param {number} minutes - 반복 간격 (분)
 * @param {string} baseTime - 기준 시각 (HH:MM:SS 또는 기존 HH:MM)
 * @param {Date} [now] - 현재 시각
 * @returns {number} 다음 실행 시각 (밀리초 타임스탬프)
 */
function nextIntervalTime(minutes, baseTime, now = new Date()) {
  const period = minutes * 60_000;
  if (!baseTime) return now.getTime() + period;
  const [hours, minutesOfHour, seconds = 0] = baseTime.split(':').map(Number);
  const base = ((hours * 60 + minutesOfHour) * 60 + seconds) * 1000;
  const current = ((now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds()) * 1000
    + now.getMilliseconds();
  const elapsed = (current - base + 86_400_000) % 86_400_000;
  return now.getTime() + period - elapsed % period;
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

    const when = nextIntervalTime(mins, config.baseTime);
    const delay = (when - Date.now()) / 60_000;
    chrome.alarms.create(ALARM_SEND, { when, periodInMinutes: mins });
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

// 새로고침 스케줄 알람 설정
// refreshScheduleConfig: { enabled, intervalMinutes, baseTime: 'HH:MM:SS' }
async function scheduleRefreshAlarm(config) {
  await chrome.alarms.clear(ALARM_REFRESH);
  if (!config?.enabled) return;

  const mins = Number(config.intervalMinutes);
  if (!mins || mins <= 0) return;

  const when = nextIntervalTime(mins, config.baseTime);
  const delay = (when - Date.now()) / 60_000;
  chrome.alarms.create(ALARM_REFRESH, { when, periodInMinutes: mins });
  console.log(`[BG] 새로고침 알람 설정: 매 ${mins}분 (첫 발화까지 ${delay}분)`);
}

// 알람 리스너
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

// 메시지 핸들러
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
            config: sendScheduleConfig || { enabled: false, mode: 'interval', intervalMinutes: 1440, baseTime: '00:00:00', times: [] },
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
            config: refreshScheduleConfig || { enabled: false, intervalMinutes: 30, baseTime: '00:00:00' },
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
              sendScheduleConfig: stored.sendScheduleConfig || { enabled: false, mode: 'interval', intervalMinutes: 1440, baseTime: '00:00:00', times: [] },
              refreshScheduleConfig: stored.refreshScheduleConfig || { enabled: false, intervalMinutes: 30, baseTime: '00:00:00' },
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
