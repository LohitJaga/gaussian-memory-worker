// Service worker — holds credentials, proxies memory calls to the Gaussian Memory worker

async function getConfig() {
  return new Promise(resolve =>
    chrome.storage.local.get(['workerUrl', 'authToken', 'enabled', 'project'], resolve)
  );
}

async function callWorker(workerUrl, authToken, tool, args) {
  const payload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: tool, arguments: args },
  };
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const resp = await fetch(workerUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
  const data = await resp.json();
  const content = data?.result?.content;
  if (Array.isArray(content) && content[0]?.text) return content[0].text;
  return '';
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'RETRIEVE') {
    getConfig().then(cfg => {
      if (!cfg.workerUrl || cfg.enabled === false) return sendResponse({ memories: '' });
      const args = { query: msg.query, top_k: msg.top_k || 5 };
      // No project scoping — retrieves from 'default' pool shared with Claude Code
      callWorker(cfg.workerUrl, cfg.authToken || '', 'memory_retrieve', args)
        .then(result => sendResponse({ result }))
        .catch(() => sendResponse({ result: '' }));
    });
    return true;
  }

  if (msg.type === 'STORE') {
    getConfig().then(cfg => {
      if (!cfg.workerUrl || cfg.enabled === false) return;
      // No project — lands in 'default', same pool as RETRIEVE and Claude Code
      callWorker(cfg.workerUrl, cfg.authToken || '', 'memory_auto_store', { text: msg.text }).catch(() => {});
    });
    return false;
  }

  if (msg.type === 'TOOL_CALL') {
    getConfig().then(cfg => {
      if (!cfg.workerUrl || cfg.enabled === false) return sendResponse({ result: 'Memory system disabled' });
      const args = { ...msg.args };
      // No project override — storage lands in 'default' pool shared with Claude Code
      callWorker(cfg.workerUrl, cfg.authToken || '', msg.tool, args)
        .then(result => sendResponse({ result }))
        .catch(e => sendResponse({ result: `Error: ${e.message}` }));
    });
    return true;
  }
});
