// Isolated-world bridge — relays messages between inject.js (MAIN world) and background.js

function safeSend(msg, cb) {
  try {
    if (cb) chrome.runtime.sendMessage(msg, cb);
    else chrome.runtime.sendMessage(msg);
  } catch (e) {
    if (cb) cb({ result: '', memories: '' });
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.type?.startsWith('GM_')) return;

  if (event.data.type === 'GM_RETRIEVE') {
    safeSend(
      { type: 'RETRIEVE', query: event.data.query, top_k: event.data.top_k },
      (response) => {
        window.postMessage({ type: 'GM_RETRIEVE_RESULT', id: event.data.id, memories: response?.result || '' }, '*');
      }
    );
  }

  if (event.data.type === 'GM_STORE') {
    safeSend({ type: 'STORE', text: event.data.text, domain: event.data.domain });
  }

  if (event.data.type === 'GM_TOOL_CALL') {
    safeSend(
      { type: 'TOOL_CALL', tool: event.data.tool, args: event.data.args },
      (response) => {
        window.postMessage({ type: 'GM_TOOL_RESULT', id: event.data.id, result: response?.result || '' }, '*');
      }
    );
  }
});
