const $ = id => document.getElementById(id);
const ids = ['urls', 'naverClientId', 'naverClientSecret', 'openaiKey', 'model', 'slackEnabled', 'slackToken', 'slackChannel', 'scheduleEnabled', 'scheduleTime'];

function values() {
  return {
    urls: $('urls').value,
    apiConfig: {
      naverClientId: $('naverClientId').value.trim(),
      naverClientSecret: $('naverClientSecret').value.trim(),
      openaiApiKey: $('openaiKey').value.trim(),
      model: $('model').value.trim() || 'gpt-4o-mini'
    },
    slackConfig: { enabled: $('slackEnabled').checked, token: $('slackToken').value.trim(), channel: $('slackChannel').value.trim() },
    scheduleConfig: { enabled: $('scheduleEnabled').checked, time: $('scheduleTime').value || '09:00' }
  };
}

function fill(settings) {
  $('urls').value = Array.isArray(settings.urls) ? settings.urls.join('\n') : (settings.urls || '');
  $('naverClientId').value = settings.apiConfig?.naverClientId || '';
  $('naverClientSecret').value = settings.apiConfig?.naverClientSecret || '';
  $('openaiKey').value = settings.apiConfig?.openaiApiKey || '';
  $('model').value = settings.apiConfig?.model || 'gpt-4o-mini';
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
    status.maximumPriceSource && `확인한 최대 할인가: ${status.maximumPrice?.toLocaleString()}원`,
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

ids.forEach(id => $(id).addEventListener(id.endsWith('Enabled') ? 'change' : 'input', () => save().catch(error => msg(error.message, true))));
$('save').onclick = async () => { try { await save(); msg('설정했습니다.'); } catch (error) { msg(error.message, true); } };
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
