// MAIN world — wraps window.fetch to intercept AI API calls and inject Gaussian Memory context + tools
// Runs at document_start before any page scripts execute

(function gaussianMemoryInjector() {
  'use strict';

  console.log('[Gaussian Memory] inject.js running in', window.location.href, '| fetch:', window.fetch.name);

  const PATTERNS = {
    claude: /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion/,
    claudeConv: /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+/,
    chatgpt: /\/backend-api\/(f\/)?conversation$/,   // ChatGPT send-message endpoint (POST, SSE)
    gemini: /(StreamGenerate|GenerateContent|batchexecute|assistant\.lamda)/,  // Gemini web RPC (nested-array f.req payload)
  };

  // NOTE: GM tool injection was removed (chat UIs can't return tool_results
  // in-band, which hung Claude). Both platforms now use context-injection +
  // turn capture only. No tool definitions / tool-call plumbing needed.

  // ── Message-passing infrastructure ─────────────────────────────────────────

  const pending = new Map(); // id → resolve (retrieve responses)

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const { type, id } = event.data || {};
    if (type === 'GM_RETRIEVE_RESULT' && id) {
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(event.data.result ?? event.data.memories ?? '');
      }
    }
  });

  function callBridge(msgType, payload, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => { pending.delete(id); resolve(''); }, timeoutMs);
      pending.set(id, (val) => { clearTimeout(timer); resolve(val); });
      window.postMessage({ ...payload, type: msgType, id }, '*');
    });
  }

  function retrieveMemories(query) {
    return callBridge('GM_RETRIEVE', { query, top_k: 5 }, 3000);
  }

  function storeMemory(text) {
    window.postMessage({ type: 'GM_STORE', text }, '*');
  }

  // Unified capture: store a whole user+assistant TURN, scrubbed of the injected
  // memory block, routed (via background.js) through memory_extract_and_store —
  // the same LLM-distillation path Claude Code uses. Avoids raw verbatim noise.
  const lastUserQuery = { claude: '', chatgpt: '' };
  function storeTurn(platform, userText, assistantText) {
    const u = (userText || '').replace(GM_HIDE_RE, '').trim();
    const a = (assistantText || '').replace(GM_HIDE_RE, '').trim();
    const log = `[User]: ${u.slice(0, 800)}\n[Assistant]: ${a.slice(0, 1500)}`;
    if (log.length < 150) return;   // not enough signal to bother extracting
    storeMemory(log);               // → GM_STORE → memory_extract_and_store
  }

  // ── DOM collapser — hides injected memory block from chat UI ───────────────

  const GM_HIDE_RE = /\[Gaussian Memory[^\]]*\][\s\S]*?\[End Memory Context\]\n*/g;

  function scrubAllTextNodes() {
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.includes('[Gaussian Memory')) {
        node.textContent = node.textContent.replace(GM_HIDE_RE, '');
      }
    }
  }

  // After injection, poll aggressively for 2s to catch React's async render
  function startScrubWindow() {
    let ticks = 0;
    const interval = setInterval(() => {
      scrubAllTextNodes();
      if (++ticks >= 20) clearInterval(interval); // 20 × 100ms = 2s
    }, 100);
  }

  // ── Conversation history scrubber — strips memory from GET responses ───────

  function scrubMessagesInObject(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(scrubMessagesInObject); return; }
    if ((obj.role === 'human' || obj.role === 'user') && obj.content) {
      if (typeof obj.content === 'string') {
        obj.content = obj.content.replace(GM_HIDE_RE, '');
      } else if (Array.isArray(obj.content)) {
        obj.content.forEach(block => {
          if (block.type === 'text' && typeof block.text === 'string') {
            block.text = block.text.replace(GM_HIDE_RE, '');
          }
        });
      }
    }
    // Also catch legacy string prompt fields at any depth
    if (typeof obj.text === 'string' && obj.text.includes('[Gaussian Memory')) {
      obj.text = obj.text.replace(GM_HIDE_RE, '');
    }
    Object.values(obj).forEach(val => {
      if (val && typeof val === 'object') scrubMessagesInObject(val);
    });
  }

  async function scrubConversationResponse(response) {
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return response;
    try {
      const json = await response.clone().json();
      scrubMessagesInObject(json);
      return new Response(JSON.stringify(json), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  }

  // ── Claude.ai helpers ──────────────────────────────────────────────────────

  function extractClaudeQuery(body) {
    try {
      if (typeof body.prompt === 'string') return body.prompt.slice(-500);
      if (Array.isArray(body.messages)) {
        const humanMsgs = body.messages.filter(m => m.role === 'human' || m.role === 'user');
        const last = humanMsgs[humanMsgs.length - 1];
        if (!last) return '';
        const c = last.content;
        if (typeof c === 'string') return c.slice(-500);
        if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join(' ').slice(-500);
      }
    } catch {}
    return '';
  }

  function injectClaudeMemories(body, memories) {
    if (!memories) return body;
    const block = `[Gaussian Memory — context from past sessions]\n${memories}\n[End Memory Context]\n\n`;

    if (typeof body.prompt === 'string') {
      const idx = body.prompt.lastIndexOf('\nHuman:');
      if (idx !== -1) {
        body.prompt = body.prompt.slice(0, idx) + '\n' + block + body.prompt.slice(idx + 1);
      } else {
        body.prompt = block + body.prompt;
      }
      return body;
    }

    if (Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const msg = body.messages[i];
        if (msg.role !== 'human' && msg.role !== 'user') continue;
        if (typeof msg.content === 'string') {
          msg.content = block + msg.content;
        } else if (Array.isArray(msg.content)) {
          const first = msg.content.find(b => b.type === 'text');
          if (first) first.text = block + first.text;
          else msg.content.unshift({ type: 'text', text: block });
        }
        break;
      }
    }
    return body;
  }

  // ── SSE parser — accumulates assistant text deltas for turn capture ────────

  function tapClaudeStream(response) {
    if (!response.body) return response;
    try {
      const [streamForCaller, streamForCapture] = response.body.tee();
      captureClaudeSSE(streamForCapture);
      return new Response(streamForCaller, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;   // tee/capture failed — never re-fetch (would duplicate the POST)
    }
  }

  function captureClaudeSSE(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let assistantText = '';

    function processSSELine(line) {
      if (!line.startsWith('data: ')) return;
      let json;
      try { json = JSON.parse(line.slice(6)); } catch { return; }

      const { type, delta } = json;
      if (type === 'content_block_delta' && delta?.type === 'text_delta') {
        assistantText += delta.text || '';
      }
      if (type === 'message_stop') {
        storeTurn('claude', lastUserQuery.claude, assistantText);
        assistantText = '';
      }
    }

    function read() {
      reader.read().then(({ done, value }) => {
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) processSSELine(line.trim());
        read();
      }).catch(() => {});
    }
    read();
  }

  // ── ChatGPT helpers ────────────────────────────────────────────────────────
  // ChatGPT web has no injectable tools array, so we do context-injection +
  // capture only: prepend retrieved memories to the outgoing user message, and
  // store the user message. Body is JSON: { messages: [{author:{role}, content:{parts:[...]}}] }

  function lastUserChatGPTMessage(body) {
    if (!Array.isArray(body.messages)) return null;
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      const role = m?.author?.role || m?.role;
      if (role === 'user') return m;
    }
    return null;
  }

  function extractChatGPTQuery(body) {
    try {
      const m = lastUserChatGPTMessage(body);
      const parts = m?.content?.parts;
      if (Array.isArray(parts)) {
        return parts.filter(p => typeof p === 'string').join(' ').slice(-500);
      }
    } catch {}
    return '';
  }

  function injectChatGPTMemories(body, memories) {
    if (!memories) return body;
    const block = `[Gaussian Memory — context from past sessions]\n${memories}\n[End Memory Context]\n\n`;
    const m = lastUserChatGPTMessage(body);
    if (m && m.content && Array.isArray(m.content.parts) && m.content.parts.length) {
      const i = m.content.parts.findIndex(p => typeof p === 'string');
      if (i !== -1) m.content.parts[i] = block + m.content.parts[i];
      else m.content.parts.unshift(block);
    }
    return body;
  }

  // Best-effort assistant capture from ChatGPT SSE (delta format varies; never throw)
  function tapChatGPTStream(response) {
    if (!response.body) return response;
    try {
      const [forCaller, forCapture] = response.body.tee();
      captureChatGPTSSE(forCapture);
      return new Response(forCaller, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    } catch { return response; }
  }

  function captureChatGPTSSE(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let assistant = '';
    let stored = false;
    function flush() {
      if (stored) return;            // store the turn exactly once ([DONE] or stream end)
      stored = true;
      storeTurn('chatgpt', lastUserQuery.chatgpt, assistant);
      assistant = '';
    }
    function handle(line) {
      if (!line.startsWith('data: ')) return;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') { flush(); return; }
      let json; try { json = JSON.parse(payload); } catch { return; }
      // Full-message format: message.content.parts (assistant)
      const role = json?.message?.author?.role;
      const parts = json?.message?.content?.parts;
      if (role === 'assistant' && Array.isArray(parts)) {
        const txt = parts.filter(p => typeof p === 'string').join('');
        if (txt.length > assistant.length) assistant = txt;  // ChatGPT resends growing full text
      }
      // Delta format: { v: "...", p: "/message/content/parts/0", o: "append" }
      else if (typeof json?.v === 'string' && (!json.p || json.p.includes('parts'))) {
        assistant += json.v;
      }
    }
    function read() {
      reader.read().then(({ done, value }) => {
        if (done) { flush(); return; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const l of lines) handle(l.trim());
        read();
      }).catch(() => {});
    }
    read();
  }

  // ── Fetch interceptor ──────────────────────────────────────────────────────

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function gaussianFetch(input, init) {
    const url = input instanceof Request ? input.url : String(input);

    // Scrub memory block from conversation history GET responses
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'GET' && PATTERNS.claudeConv.test(url) && !PATTERNS.claude.test(url)) {
      const response = await originalFetch(input, init);
      return scrubConversationResponse(response);
    }

    // ── Gemini: PROBE ONLY — log the payload shape so we can design injection ──
    // Gemini's web RPC sends the prompt buried in a URL-encoded nested-array
    // `f.req` blob, not JSON. Step 1 is just understanding it. Pass-through.
    if (method === 'POST' && PATTERNS.gemini.test(url)) {
      try {
        const req = input instanceof Request ? input.clone() : new Request(input, init);
        const ct = req.headers.get('content-type') || '';
        const raw = await req.text();
        console.log('[GM][gemini] URL:', url);
        console.log('[GM][gemini] content-type:', ct, '| body length:', raw.length);
        // Most Gemini calls are form-encoded with an f.req param holding the array
        let freq = null;
        try {
          const params = new URLSearchParams(raw);
          freq = params.get('f.req');
        } catch {}
        if (freq) {
          console.log('[GM][gemini] f.req (first 1500):', freq.slice(0, 1500));
          try {
            const outer = JSON.parse(freq);
            console.log('[GM][gemini] parsed f.req structure:', outer);
          } catch (e) { console.log('[GM][gemini] f.req not directly JSON:', e.message); }
        } else {
          console.log('[GM][gemini] no f.req param. raw (first 1500):', raw.slice(0, 1500));
        }
      } catch (e) {
        console.log('[GM][gemini] probe error:', e.message);
      }
      return originalFetch(input, init);   // never modify yet — probe only
    }

    // ── ChatGPT: context-injection + capture (no tools on their web) ──
    if (method === 'POST' && PATTERNS.chatgpt.test(url)) {
      try {
        const req = input instanceof Request ? input.clone() : new Request(input, init);
        const bodyText = await req.text();
        const body = JSON.parse(bodyText);

        const query = extractChatGPTQuery(body);
        if (query && query.trim().length >= 60) {
          lastUserQuery.chatgpt = query;   // captured as a turn after the response (extract path)
          const memories = await retrieveMemories(query);
          if (memories) injectChatGPTMemories(body, memories);
        }

        const headers = new Headers(req.headers);
        headers.delete('content-length');
        const response = await originalFetch(url, {
          method: req.method, headers, body: JSON.stringify(body),
          credentials: req.credentials, mode: req.mode, cache: req.cache,
        });
        startScrubWindow();
        return tapChatGPTStream(response);
      } catch (e) {
        console.log('[GM] chatgpt error:', e.message);
        return originalFetch(input, init);
      }
    }

    if (PATTERNS.claude.test(url)) {
      try {
        const req = input instanceof Request ? input.clone() : new Request(input, init);
        const bodyText = await req.text();
        const body = JSON.parse(bodyText);

        // NOTE: GM tool injection removed. Claude.ai is a chat UI, not an API
        // client — when the model emits a tool_use we can't return a tool_result
        // in-band, so it hangs ("Working…") until the next message. We rely purely
        // on context-injection + turn capture, identical to the ChatGPT path.

        // Retrieve and inject memory context for substantive queries
        const query = extractClaudeQuery(body);
        if (query && query.trim().length >= 60) {
          lastUserQuery.claude = query;   // captured as a turn after the response (extract path)
          const memories = await retrieveMemories(query);
          if (memories) injectClaudeMemories(body, memories);
        }

        const headers = new Headers(req.headers);
        headers.delete('content-length');
        const response = await originalFetch(url, {
          method: req.method,
          headers,
          body: JSON.stringify(body),
          credentials: req.credentials,
          mode: req.mode,
          cache: req.cache,
        });
        startScrubWindow();
        return tapClaudeStream(response);
      } catch(e) {
        console.log('[GM] error:', e.message);
        return originalFetch(input, init);   // pre-dispatch failure — send original unmodified
      }
    }

    return originalFetch(input, init);
  };
})();
