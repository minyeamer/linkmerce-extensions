/**
 * Coupang Cookies
 *
 * 역할:
 *  - Wing 로그인 → 광고센터 목표 페이지 검증 → Wing/Ads 쿠키를 별도 Slack 채널에 업로드
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

const WING_HOST = 'wing.coupang.com';
const ADS_HOST = 'advertising.coupang.com';
const ADS_RELAY_URL = 'https://advertising.coupang.com/relay/wing/home?from=WING_LNB';
const ADS_DASHBOARD_URL = 'https://advertising.coupang.com/marketing/dashboard/sales?off_site_source=wing.lnb.ads_center';

const ALARM_SEND = 'coupang-cookies-send';
const ALARM_REFRESH = 'coupang-cookies-refresh';

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
async function extractCoupangCookies(targetHost) {
  // 공통 부모 도메인 쿠키와 서비스 전용 쿠키만 포함한다.
  const allCookies = await chrome.cookies.getAll({ domain: 'coupang.com' });
  const cookies = allCookies.filter(cookie => {
    const domain = cookie.domain.replace(/^\./, '');
    return domain === targetHost || (!cookie.hostOnly && targetHost.endsWith('.' + domain));
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
      const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
      for (const element of elements) {
        if (element.disabled) continue;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      return null;
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
  async function openWingTab() {
    const newTab = await chrome.tabs.create({ url: `https://${WING_HOST}/`, active: true });
    await chrome.windows.update(newTab.windowId, { focused: true }).catch(() => {});
    return newTab;
  }

  let tab = await openWingTab();

  function isWingRoot(url) {
    try {
      const pageUrl = new URL(url);
      return pageUrl.origin === `https://${WING_HOST}`
        && pageUrl.pathname === '/'
        && !pageUrl.search
        && !pageUrl.hash;
    } catch {
      return false;
    }
  }

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

  async function navigateBackToWingRoot(state) {
    if (isWingRoot(state.url)) return state;

    console.log(`[BG] Non-root Coupang page detected (${state.url}); navigating back to Wing root.`);
    await chrome.tabs.update(tab.id, { url: `https://${WING_HOST}/` });
    const rootState = await waitForPageState(
      () => true,
      25_000,
      'Wing 루트로 다시 이동했지만 페이지 확인에 실패했습니다.'
    );
    if (!isWingRoot(rootState.url)) {
      throw new Error(`Wing 루트로 다시 이동했지만 다른 페이지가 열렸습니다. (${rootState.url})`);
    }
    if (rootState.loginButton) {
      throw new Error('Wing 루트로 다시 이동한 뒤에도 로그인 화면이 나타났습니다.');
    }
    console.log(`[BG] Wing root loaded with the login form absent (${rootState.url}).`);
    return rootState;
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
        initialState = await navigateBackToWingRoot(initialState);
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
      let loginResult = await waitForPageState(
        state => !state.loginButton || Boolean(state.loginError),
        25_000,
        '로그인 버튼을 눌렀지만 25초 안에 로그인 완료를 확인하지 못했습니다.'
      );
      if (loginResult.loginButton) {
        const autofillState = `자동완성 입력값 감지=${initialState.usernamePresent}/${initialState.passwordPresent}`;
        throw new Error(`${loginResult.loginError || 'Coupang did not complete the login.'} (${autofillState})`);
      }
      loginResult = await navigateBackToWingRoot(loginResult);
      console.log('[BG] Login form disappeared; continuing after login verification.');
    } else {
      console.log('[BG] #kc-login is absent; continuing as an authenticated session.');
      initialState = await navigateBackToWingRoot(initialState);
    }

    return await task(tab);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/**
 * Wing의 좌측 메뉴를 통해 광고센터 릴레이에 진입한 뒤 목표 대시보드 URL을 검증한다.
 * @param {number} wingTabId
 * @returns {Promise<{ tab: chrome.tabs.Tab, url: string }>}
 */
async function openVerifiedAdsDashboard(wingTabId) {
  const dismissedDialogs = await dismissWingDialogs(wingTabId);
  if (dismissedDialogs) console.log(`[BG] Closed ${dismissedDialogs} Wing dialog(s) before opening Ads Center.`);

  const beforeTabs = await chrome.tabs.query({});
  const beforeIds = new Set(beforeTabs.map(tab => tab.id));
  const linkSelector = `a[href="${ADS_RELAY_URL}"]`;
  let clickResult = { clicked: false, reason: 'click-not-attempted' };
  try {
    clickResult = await clickCoupangElement(wingTabId, linkSelector);
  } catch (error) {
    clickResult.reason = error.message;
  }
  let adsTab = null;

  if (clickResult.clicked) {
    const tabDeadline = Date.now() + 12_000;
    while (Date.now() < tabDeadline) {
      const tabs = await chrome.tabs.query({});
      adsTab = tabs.find(candidate => !beforeIds.has(candidate.id)
        && /^https:\/\/(advertising\.coupang\.com|xauth\.coupang\.com)\//.test(candidate.url || '')) || null;
      if (adsTab) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } else {
    console.warn(`[BG] Wing Ads link click unavailable (${clickResult.reason || 'link not found'}); opening Ads directly.`);
  }

  if (!adsTab) {
    console.warn('[BG] Wing did not open an Ads tab; opening the requested dashboard URL directly.');
    adsTab = await chrome.tabs.create({ url: ADS_DASHBOARD_URL, active: true });
  }

  try {
    await waitForTabComplete(adsTab.id, 30_000);
    await new Promise(resolve => setTimeout(resolve, 1_500));

    async function inspectAdsPage() {
      const [pageCheck] = await chrome.scripting.executeScript({
        target: { tabId: adsTab.id },
        func: () => ({
          url: location.href,
          title: document.title,
          bodyText: document.body?.innerText?.slice(0, 2000) || '',
          hasWingLoginLink: Boolean(document.querySelector('a[href^="/user/login?_cap_client=WING"]')),
          hasLoginForm: Boolean(document.querySelector('#kc-login, input[type="password"]')),
        }),
      });
      if (!pageCheck?.result) throw new Error('광고센터 페이지 상태를 읽지 못했습니다.');
      return pageCheck.result;
    }

    async function clickWingLoginLink(page) {
      if (!page.hasWingLoginLink) return page;
      const currentUrl = page.url;
      let loginClick = { clicked: false, reason: 'click-not-attempted' };
      try {
        loginClick = await clickCoupangElement(adsTab.id, 'a[href^="/user/login?_cap_client=WING"]');
      } catch (error) {
        loginClick.reason = error.message;
      }
      if (!loginClick.clicked) {
        const [linkResult] = await chrome.scripting.executeScript({
          target: { tabId: adsTab.id },
          func: () => document.querySelector('a[href^="/user/login?_cap_client=WING"]')?.getAttribute('href') || '',
        });
        const href = linkResult?.result;
        if (!href) {
          throw new Error(`광고센터의 Wing 로그인 링크를 클릭하지 못했습니다. (${loginClick.reason || '링크를 찾을 수 없음'})`);
        }
        const loginUrl = new URL(href, currentUrl).href;
        console.warn(`[BG] Wing login link could not be clicked (${loginClick.reason}); navigating to its URL.`);
        await chrome.tabs.update(adsTab.id, { url: loginUrl });
      }
      const changedTab = await waitForTabUrlChange(adsTab.id, currentUrl, 30_000);
      adsTab = changedTab;
      await new Promise(resolve => setTimeout(resolve, 1_500));
      return inspectAdsPage();
    }

    function isDeniedOrLogin(page) {
      return page.hasLoginForm
        || /\baccess\s+denied\b|쿠팡\s*광고센터\s*로그인/i.test(`${page.title}\n${page.bodyText}`);
    }

    let page = await inspectAdsPage();
    if (isDeniedOrLogin(page) && !page.hasWingLoginLink) {
      throw new Error('광고센터에서 Access Denied 또는 Wing 로그인 링크가 없는 로그인 화면이 표시됩니다.');
    }

    // The direct URL fallback can land on Ads' three-choice login page.
    if (page.hasWingLoginLink) page = await clickWingLoginLink(page);
    if (isDeniedOrLogin(page) && !page.hasWingLoginLink) {
      throw new Error('광고센터 목표 URL은 열렸지만 Access Denied 또는 로그인 화면이 표시됩니다.');
    }

    // The relay or Wing SSO may choose a different landing path. Always finish
    // at the explicitly requested dashboard URL and verify the resulting page.
    let currentTab = await chrome.tabs.get(adsTab.id);
    if (currentTab.url !== ADS_DASHBOARD_URL) {
      console.log(`[BG] Ads redirect ended at ${currentTab.url}; navigating to the requested dashboard.`);
      await chrome.tabs.update(adsTab.id, { url: ADS_DASHBOARD_URL });
      await waitForTabComplete(adsTab.id, 30_000, ADS_DASHBOARD_URL, currentTab.url);
      await new Promise(resolve => setTimeout(resolve, 1_500));
      adsTab = await chrome.tabs.get(adsTab.id);
      page = await inspectAdsPage();
    }

    // If opening the requested URL itself presents the Wing SSO choice, use it
    // once, then correct the post-login landing path back to the dashboard.
    if (page.hasWingLoginLink) {
      page = await clickWingLoginLink(page);
      currentTab = await chrome.tabs.get(adsTab.id);
      if (currentTab.url !== ADS_DASHBOARD_URL) {
        await chrome.tabs.update(adsTab.id, { url: ADS_DASHBOARD_URL });
        await waitForTabComplete(adsTab.id, 30_000, ADS_DASHBOARD_URL, currentTab.url);
        await new Promise(resolve => setTimeout(resolve, 1_500));
        adsTab = await chrome.tabs.get(adsTab.id);
        page = await inspectAdsPage();
      }
    }

    currentTab = await chrome.tabs.get(adsTab.id);
    if (currentTab.url !== ADS_DASHBOARD_URL || page.url !== ADS_DASHBOARD_URL) {
      throw new Error(`광고센터 목표 페이지 도착을 확인하지 못했습니다. (${currentTab.url || page.url || 'URL 없음'})`);
    }
    if (isDeniedOrLogin(page)) {
      throw new Error('광고센터 목표 URL은 열렸지만 Access Denied 또는 로그인 화면이 표시됩니다.');
    }
    console.log(`[BG] Ads dashboard URL verified: ${adsTab.url}`);
    return { tab: adsTab, url: adsTab.url };
  } catch (error) {
    await chrome.tabs.remove(adsTab.id).catch(() => {});
    throw error;
  }
}

/** Wing 페이지의 표시 중인 dialog 닫기 버튼을 모두 닫는다. 없으면 정상 진행한다. */
async function dismissWingDialogs(tabId) {
  const closeSelector = '[role="dialog"] .header-close';
  const maxDialogs = 10;
  const pollMs = 200;
  const quietWindowMs = 1_000;
  const lateDialogWaitMs = 3_000;
  let dismissed = 0;

  async function visibleCloseButtonCount(markAndClick = '') {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector, marker) => {
        const visible = [...document.querySelectorAll(selector)].filter(element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity) !== 0
            && !element.disabled;
        });
        if (marker && visible[0]) {
          visible[0].setAttribute('data-coupang-dialog-close-check', marker);
          visible[0].click();
        }
        return visible.length;
      },
      args: [closeSelector, markAndClick],
    });
    if (!Number.isInteger(result?.result)) throw new Error('Could not inspect Wing dialog close buttons.');
    return result.result;
  }

  async function isMarkedCloseButtonVisible(marker) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector, markerValue) => [...document.querySelectorAll(selector)].some(element => {
        if (element.getAttribute('data-coupang-dialog-close-check') !== markerValue) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity) !== 0;
      }),
      args: [closeSelector, marker],
    });
    return result?.result === true;
  }

  // Wait for late overlays; proceed normally when none appears.
  const waitDeadline = Date.now() + lateDialogWaitMs;
  let absentSince = null;
  while (Date.now() < waitDeadline) {
    if (await visibleCloseButtonCount() > 0) break;
    if (absentSince === null) absentSince = Date.now();
    if (Date.now() - absentSince >= quietWindowMs) return dismissed;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  while (dismissed < maxDialogs) {
    const before = await visibleCloseButtonCount();
    if (before === 0) {
      const quietDeadline = Date.now() + quietWindowMs;
      let stillQuiet = true;
      while (Date.now() < quietDeadline) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        if (await visibleCloseButtonCount() > 0) {
          stillQuiet = false;
          break;
        }
      }
      if (stillQuiet) return dismissed;
      continue;
    }

    // Try the element handler, then a browser-level click if it remains visible.
    const marker = `coupang-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await visibleCloseButtonCount(marker);
    let disappeared = false;
    let verifyDeadline = Date.now() + 1_200;
    while (Date.now() < verifyDeadline) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      if (!await isMarkedCloseButtonVisible(marker)) {
        disappeared = true;
        break;
      }
    }
    if (!disappeared) {
      const clickResult = await clickCoupangElement(tabId, closeSelector);
      if (clickResult.clicked) {
        verifyDeadline = Date.now() + 1_500;
        while (Date.now() < verifyDeadline) {
          await new Promise(resolve => setTimeout(resolve, pollMs));
          if (!await isMarkedCloseButtonVisible(marker)) {
            disappeared = true;
            break;
          }
        }
      }
    }
    if (!disappeared) throw new Error('Wing dialog close button was clicked, but the dialog is still visible.');
    dismissed++;
  }

  if (await visibleCloseButtonCount() > 0) throw new Error(`More than ${maxDialogs} Wing dialogs appeared.`);
  return dismissed;
}

/** Wing 로그인 링크 클릭 후 Ads 탭 URL이 바뀌고 로딩이 끝날 때까지 기다린다. */
async function waitForTabUrlChange(tabId, previousUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (!current) throw new Error('광고센터 로그인 중 Ads 탭이 닫혔습니다.');
    let hostname = '';
    let pathname = '';
    try {
      const currentUrl = new URL(current.url);
      hostname = currentUrl.hostname;
      pathname = currentUrl.pathname;
    } catch {}
    const stillOnLoginRoute = /^\/user\/login(?:\/|$)/.test(pathname);
    if (hostname === ADS_HOST && current.url !== previousUrl && current.status === 'complete' && !stillOnLoginRoute) return current;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Wing 세션을 사용한 광고센터 로그인을 확인하지 못했습니다.');
}

/** 지정 탭의 다음 로딩 완료를 기다린다. */
async function waitForTabComplete(tabId, timeoutMs, expectedUrl = '', previousUrl = '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (!current) throw new Error('광고센터 작업 탭이 이동 중 닫혔습니다.');
    let hostname = '';
    try { hostname = new URL(current.url).hostname; } catch {}
    const navigationSettled = !expectedUrl
      || current.url === expectedUrl
      || (previousUrl && current.url !== previousUrl);
    if (hostname === ADS_HOST && current.status === 'complete' && navigationSettled) return current;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('쿠팡 광고센터 페이지 로딩 시간이 초과되었습니다.');
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
async function sendCookiesToSlack(cookieString, service, slackConfig) {
  const channel = service === 'wing' ? slackConfig.wingChannel : slackConfig.adsChannel;
  const configuredFilename = service === 'wing' ? slackConfig.wingFilename : slackConfig.adsFilename;
  const defaultFilename = service === 'wing' ? 'coupang_wing_cookies' : 'coupang_ads_cookies';
  if (!slackConfig?.token?.trim() || !channel?.trim()) {
    const channelName = service === 'wing' ? 'Wing' : '광고센터';
    throw new Error(`Slack 설정이 완료되지 않았습니다. (${channelName} 채널 ID 필요)`);
  }

  const token = slackConfig.token.trim();
  const filename = `${(configuredFilename || '').trim() || defaultFilename}.txt`;
  const fileBytes = new TextEncoder().encode(cookieString);
  await uploadFileToSlack(token, channel.trim(), fileBytes, filename, null);
}

async function getSlackConfig() {
  const { slackConfig } = await chrome.storage.local.get('slackConfig');
  return {
    token: slackConfig?.token || '',
    wingChannel: slackConfig?.wingChannel || slackConfig?.channel || '',
    adsChannel: slackConfig?.adsChannel || '',
    wingFilename: slackConfig?.wingFilename || slackConfig?.filename || 'coupang_wing_cookies',
    adsFilename: slackConfig?.adsFilename || 'coupang_ads_cookies',
  };
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
    await withAuthenticatedCoupangTab(async wingTab => {
      const result = await openVerifiedAdsDashboard(wingTab.id);
      log.adsUrl = result.url;
      log.success = true;
      await chrome.tabs.remove(result.tab.id).catch(() => {});
    });
    log.tabFound = true;
  } catch (e) {
    log.error = e.message;
    throw e;
  } finally {
    await chrome.storage.local.set({ lastRefresh: log });
  }
  return log;
}

/**
 * Wing 로그인 후 광고센터 목표 URL로 이동해 두 서비스 쿠키를 추출하고 각각 Slack에 전송한다.
 * 결과는 storage의 lastRun 키에 저장된다.
 * @returns {Promise<{ timestamp: string, success: boolean, error: string|null, cookieCount: number }>} 실행 로그
 */
async function extractAndSend() {
  const log = {
    timestamp: formatTimestamp(),
    success: false,
    error: null,
    cookieCount: 0,
    wingCookieCount: 0,
    adsCookieCount: 0,
    adsUrl: null,
  };

  try {
    const slackConfig = await getSlackConfig();
    if (!slackConfig.token.trim() || !slackConfig.wingChannel.trim() || !slackConfig.adsChannel.trim()) {
      throw new Error('Slack 설정에 Bot Token, Wing 채널 ID, 광고센터 채널 ID를 입력하세요.');
    }

    await withAuthenticatedCoupangTab(async wingTab => {
      const wingCookieString = await extractCoupangCookies(WING_HOST);
      if (!wingCookieString) {
        throw new Error('로그인 확인 후 Coupang Wing 쿠키를 찾지 못했습니다.');
      }

      const adsResult = await openVerifiedAdsDashboard(wingTab.id);
      log.adsUrl = adsResult.url;
      try {
        const adsCookieString = await extractCoupangCookies(ADS_HOST);
        if (!adsCookieString) {
          throw new Error('광고센터 목표 페이지에서 쿠키를 찾지 못했습니다.');
        }

        log.wingCookieCount = wingCookieString.split('; ').length;
        log.adsCookieCount = adsCookieString.split('; ').length;
        log.cookieCount = log.wingCookieCount + log.adsCookieCount;
        await sendCookiesToSlack(wingCookieString, 'wing', slackConfig);
        await sendCookiesToSlack(adsCookieString, 'ads', slackConfig);
      } finally {
        await chrome.tabs.remove(adsResult.tab.id).catch(() => {});
      }
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
          sendResponse({ success: true, config: await getSlackConfig() });
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
              slackConfig: await getSlackConfig(),
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
