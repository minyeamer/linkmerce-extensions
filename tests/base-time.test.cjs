const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// 날짜를 고정하여 실제 대기 없이 초와 밀리초 경계의 예약 결과를 확인한다.
function loadBackground(id, now) {
  const alarms = new Map();
  const storage = {};
  let onMessage;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  }
  const event = { addListener() {} };
  const context = vm.createContext({ Date: FixedDate, console: { log() {} }, chrome: {
    alarms: {
      clear: async name => alarms.delete(name),
      create: (name, config) => alarms.set(name, config),
      onAlarm: event,
    },
    storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, storage[key]])),
      set: async values => Object.assign(storage, values),
    } },
    runtime: {
      onMessage: { addListener: fn => { onMessage = fn; } },
      onInstalled: event, onStartup: event,
      getManifest: () => ({ version: 'test' }),
    },
  } });
  vm.runInContext(fs.readFileSync(`${id}/background.js`, 'utf8'), context);
  return { context, alarms, message: request => new Promise(resolve => onMessage(request, {}, resolve)) };
}

// 입력값과 이벤트를 대체하여 팝업의 저장 및 불러오기 경로를 확인한다.
function loadPopup(id) {
  const elements = new Map();
  const handlers = new Map();
  const messages = [];
  const get = name => {
    if (!elements.has(name)) elements.set(name, {
      value: '', checked: false, style: {}, classList: { toggle() {} },
      addEventListener: (event, fn) => handlers.set(`${name}:${event}`, fn),
      appendChild() {},
    });
    return elements.get(name);
  };
  const context = vm.createContext({ document: {
    getElementById: get, querySelectorAll: () => [],
    addEventListener() {},
  }, chrome: { runtime: { sendMessage: async request => {
    messages.push(request);
    return { success: true, applied: ['sendScheduleConfig', 'refreshScheduleConfig'] };
  } } } });
  vm.runInContext(fs.readFileSync(`${id}/popup.js`, 'utf8'), context);
  return { context, get, handlers, messages };
}

for (const id of ['coupang-ads', 'coupang-wing', 'naver-cookies']) {
  for (const [name, now, baseTime, interval, expected] of [
    ['초가 있는 기준 시각', [8, 0, 10, 250], '08:00:30', 30, [8, 0, 30]],
    ['기준 시각을 지난 경우', [8, 0, 31, 0], '08:00:30', 30, [8, 30, 30]],
    ['기존 HH:MM 호환', [8, 0, 10, 250], '08:00', 30, [8, 30, 0]],
    ['정확히 기준 시각인 경우', [8, 0, 30, 0], '08:00:30', 30, [8, 30, 30]],
    ['다음 실행 1밀리초 전', [8, 0, 29, 999], '08:00:30', 30, [8, 0, 30]],
    ['다음 날로 넘어가는 경우', [23, 59, 50, 0], '00:00:15', 1440, [24, 0, 15]],
  ]) {
    test(`${id}: ${name}에 전송 및 새로고침 예약을 맞춘다`, async () => {
      const date = new Date(2026, 10, 23, ...now);
      const app = loadBackground(id, date);
      const config = { enabled: true, mode: 'interval', intervalMinutes: interval, baseTime };
      await app.message({ action: 'saveSendScheduleConfig', config });
      await app.message({ action: 'saveRefreshScheduleConfig', config });
      const target = new Date(2026, 10, 23, ...expected).getTime();
      for (const type of ['send', 'refresh']) {
        const alarm = app.alarms.get(`${id}-${type}`);
        assert.equal(alarm.when, target);
        assert.equal(alarm.periodInMinutes, interval);
      }
    });
  }

  test(`${id}: JSON 설정 및 브라우저 재시작 복원에서 초를 보존한다`, async () => {
    const app = loadBackground(id, new Date(2026, 10, 23, 8, 0, 10));
    const settings = {
      sendScheduleConfig: { enabled: true, mode: 'interval', intervalMinutes: 30, baseTime: '08:00:25' },
      refreshScheduleConfig: { enabled: true, intervalMinutes: 15, baseTime: '08:00:45' },
    };
    assert.equal((await app.message({ action: 'setAllSettings', settings })).success, true);
    const exported = await app.message({ action: 'getAllSettings' });
    assert.equal(exported.settings.sendScheduleConfig.baseTime, '08:00:25');
    assert.equal(exported.settings.refreshScheduleConfig.baseTime, '08:00:45');
    app.alarms.clear();
    await vm.runInContext('restoreAlarms()', app.context);
    assert.equal(new Date(app.alarms.get(`${id}-send`).when).getSeconds(), 25);
    assert.equal(new Date(app.alarms.get(`${id}-refresh`).when).getSeconds(), 45);
  });

  test(`${id}: 팝업의 초 입력과 저장 및 예상 시각 표시를 지원한다`, async () => {
    const app = loadPopup(id);
    const html = fs.readFileSync(`${id}/popup.html`, 'utf8');
    for (const type of ['send', 'refresh']) {
      assert.match(html, new RegExp(`id="${type}BaseTimeInput" step="1"`));
      app.get(`${type}BaseTimeInput`).value = '08:00:35';
      app.get(`${type}IntervalInput`).value = '30';
      await app.handlers.get(`${type}BaseTimeInput:change`)();
    }
    assert.equal(app.messages.find(m => m.action === 'saveSendScheduleConfig').config.baseTime, '08:00:35');
    assert.equal(app.messages.find(m => m.action === 'saveRefreshScheduleConfig').config.baseTime, '08:00:35');
    assert.match(app.get('sendIntervalCron').textContent, /^08:00:35  08:30:35/);
    assert.equal(vm.runInContext("toCronHint(1440, '08:00')", app.context), '08:00:00');
    assert.equal(vm.runInContext("toCronHint(720, '23:59:59')", app.context), '23:59:59  11:59:59');
  });

  test(`${id}: 팝업의 JSON 불러오기에서 초를 복원한다`, async () => {
    const app = loadPopup(id);
    const settings = {
      sendScheduleConfig: { enabled: true, mode: 'interval', intervalMinutes: 30, baseTime: '08:00:25', times: [] },
      refreshScheduleConfig: { enabled: true, intervalMinutes: 15, baseTime: '08:00:45' },
    };
    await app.handlers.get('importConfigInput:change')({ target: { files: [{ text: async () => JSON.stringify(settings) }] } });
    assert.equal(app.get('sendBaseTimeInput').value, '08:00:25');
    assert.equal(app.get('refreshBaseTimeInput').value, '08:00:45');
    assert.match(app.get('configMsg').textContent, /불러오기 완료/);
  });
}
