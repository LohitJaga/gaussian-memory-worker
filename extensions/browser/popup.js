const $ = id => document.getElementById(id);

chrome.storage.local.get(['workerUrl', 'authToken', 'enabled'], (cfg) => {
  $('workerUrl').value = cfg.workerUrl || '';
  $('authToken').value = cfg.authToken || '';
  $('enabled').checked = cfg.enabled !== false;
});

$('save').addEventListener('click', () => {
  const url = $('workerUrl').value.trim();
  if (url && !url.startsWith('https://')) {
    $('status').textContent = 'Worker URL must start with https://';
    $('status').style.color = '#ef4444';
    return;
  }
  chrome.storage.local.set({
    workerUrl: url,
    authToken: $('authToken').value.trim(),
    enabled: $('enabled').checked,
  }, () => {
    $('status').textContent = 'Saved';
    $('status').style.color = '#22c55e';
    setTimeout(() => { $('status').textContent = ''; }, 2000);
  });
});
