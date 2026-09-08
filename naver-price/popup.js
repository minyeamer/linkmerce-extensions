const $ = id => document.getElementById(id);
const ids = [
  'urls', 'naverClientId', 'naverClientSecret', 'aiProvider', 'generativeAiKey', 'model',
  'slackEnabled', 'slackToken', 'slackChannel', 'scheduleEnabled', 'scheduleTime'
];

const defaultModel = provider => provider === 'google' ? 'gemini-3.1-flash-lite' : 'gpt-4o-mini';
let lastAiProvider = 'google';

function syncModelPlaceholder() {
  $('model').placeholder = defaultModel($('aiProvider').value);
}

function values() {
  const aiProvider = $('aiProvider').value === 'google' ? 'google' : 'openai';
  return {
    urls: $('urls').value,
    apiConfig: {
      naverClientId: $('naverClientId').value.trim(),
      naverClientSecret: $('naverClientSecret').value.trim(),
      aiProvider,
      generativeAiApiKey: $('generativeAiKey').value.trim(),
      model: $('model').value.trim() || defaultModel(aiProvider)
    },
    slackConfig: {
      enabled: $('slackEnabled').checked,
      token: $('slackToken').value.trim(),
      channel: $('slackChannel').value.trim()
    },
    scheduleConfig: { enabled: $('scheduleEnabled').checked, time: $('scheduleTime').value || '09:00' }
  };
}

function fill(settings) {
  const api = settings.apiConfig || {};
  $('urls').value = Array.isArray(settings.urls) ? settings.urls.join('\n') : (settings.urls || '');
  $('naverClientId').value = api.naverClientId || '';
  $('naverClientSecret').value = api.naverClientSecret || '';
  $('aiProvider').value = api.aiProvider === 'openai' ? 'openai' : 'google';
  $('generativeAiKey').value = api.generativeAiApiKey || '';
  $('model').value = api.model || defaultModel($('aiProvider').value);
  lastAiProvider = $('aiProvider').value;
  syncModelPlaceholder();
  $('slackEnabled').checked = !!settings.slackConfig?.enabled;
  $('slackToken').value = settings.slackConfig?.token || '';
  $('slackChannel').value = settings.slackConfig?.channel || '';
  $('scheduleEnabled').checked = !!settings.scheduleConfig?.enabled;
  $('scheduleTime').value = settings.scheduleConfig?.time || '09:00';
}

function msg(text, error = false) {
  $('message').textContent = text;
  $('message').style.color = error ? '#c33' : '#246';
}

function showStatus(status) {
  if (!status) { $('status').textContent = '대기'; return; }
  $('status').textContent = status.running ? `진행 ${status.done}/${status.total}` : (status.error ? '오류' : (status.finishedAt ? '완료' : '대기'));
  const details = [
    status.stage,
    status.currentUrl && `상품 ${status.current}/${status.total}`,
    status.imageTotal ? `이미지 ${status.currentImage}/${status.imageTotal}` : '',
    status.totalPayAmountSource && `확인한 최대 할인가: ${status.totalPayAmount?.toLocaleString()}원`,
    status.filename && `CSV: 다운로드/${status.filename}`,
    status.error && `오류: ${status.error}`,
    status.errors?.length ? `상품 오류 ${status.errors.length}건` : ''
  ].filter(Boolean);
  if (details.length) msg(details.join('\n'), !!status.error || !!status.errors?.length);
}

async function refresh() {
  const result = await chrome.runtime.sendMessage({ action: 'getSettings' });
  if (!window.loaded) { fill(result.settings); window.loaded = true; }
  showStatus(result.status);
}

async function save() {
  const result = await chrome.runtime.sendMessage({ action: 'saveSettings', settings: values() });
  if (!result.success) throw new Error(result.error);
}

ids.forEach(id => $(id).addEventListener(id.endsWith('Enabled') || id === 'aiProvider' ? 'change' : 'input', () => {
  if (id === 'aiProvider') {
    const provider = $('aiProvider').value;
    if (!$('model').value || $('model').value === defaultModel(lastAiProvider)) $('model').value = defaultModel(provider);
    lastAiProvider = provider;
    syncModelPlaceholder();
  }
  save().catch(error => msg(error.message, true));
}));
$('save').onclick = async () => { try { await save(); msg('설정되었습니다.'); } catch (error) { msg(error.message, true); } };
$('run').onclick = async () => {
  try {
    await save();
    const result = await chrome.runtime.sendMessage({ action: 'run' });
    if (!result.success) throw new Error(result.error);
    msg('검증을 시작했습니다. 팝업을 닫아도 계속됩니다.');
    setTimeout(refresh, 150);
  } catch (error) { msg(error.message, true); }
};
$('export').onclick = async () => {
  const result = await chrome.runtime.sendMessage({ action: 'exportSettings' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([JSON.stringify(result.settings, null, 2)], { type: 'application/json' }));
  anchor.download = 'naver-price-config.json';
  anchor.click();
};
$('import').onclick = () => $('importFile').click();
$('importFile').onchange = async event => {
  try {
    const settings = JSON.parse(await event.target.files[0].text());
    const result = await chrome.runtime.sendMessage({ action: 'importSettings', settings });
    if (!result.success) throw new Error(result.error);
    window.loaded = false;
    await refresh();
    msg('설정을 불러왔습니다.');
  } catch (error) { msg(error.message, true); }
};

refresh();
setInterval(() => refresh().catch(() => {}), 1000);
