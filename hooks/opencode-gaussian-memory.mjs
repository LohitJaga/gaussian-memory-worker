import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';

function loadEnv() {
  try {
    const content = readFileSync(`${homedir()}/.gaussian-memory-env`, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^export\s+(\w+)="([^"]+)"/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnv();

const WORKER = process.env.GAUSSIAN_WORKER_URL;
const TOKEN = process.env.GAUSSIAN_AUTH_TOKEN;

const SKIP_PATTERN = /^(call |run |check |show |list |get |what |how |why |do |can |is |ok|yea|nah|hm|sure|nice|done|yes|no|lol|wait|so |and |but )/i;

async function autoStore(text, context) {
  if (!WORKER || !TOKEN || !text || text.length < 80) return;
  if (SKIP_PATTERN.test(text.trim())) return;
  try {
    await fetch(WORKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'memory_auto_store', arguments: { text, context } }
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

export const server = async () => {
  return {
    // Nudge model to store session summary before ending
    'experimental.chat.system.transform': async (_, output) => {
      output.system.push(
        'You have access to Gaussian Memory MCP tools. Before ending any conversation, call memory_extract_and_store with a 2-3 sentence summary of key decisions, facts, and context from the session.'
      );
    },

    // Store assistant messages
    'chat.message': async ({ sessionID }, output) => {
      const text = output.parts?.filter(p => p.type === 'text')?.map(p => p.text)?.join(' ')?.trim();
      autoStore(text, `opencode session ${sessionID}`);
    },

    // Store user messages
    'chat.input': async ({ sessionID, content }) => {
      const text = typeof content === 'string' ? content : content?.find?.(p => p.type === 'text')?.text;
      autoStore(text, `opencode user session ${sessionID}`);
    },

    // Session-end extraction — fires when session goes idle
    'session.idle': async (input) => {
      try { writeFileSync(`${homedir()}/.opencode/session-idle-fired.txt`, `fired at ${new Date().toISOString()}\nkeys: ${Object.keys(input ?? {}).join(', ')}\n`); } catch {}
      if (!WORKER || !TOKEN) return;
      // Build transcript from messages if available
      const messages = input?.messages ?? input?.session?.messages ?? [];
      const transcript = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => {
          const text = typeof m.content === 'string' ? m.content
            : m.content?.filter(p => p.type === 'text')?.map(p => p.text)?.join(' ') ?? '';
          return `${m.role}: ${text.slice(0, 500)}`;
        })
        .join('\n');
      if (!transcript || transcript.length < 100) return;
      try {
        await fetch(WORKER, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'memory_extract_and_store', arguments: { text: transcript } }
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {}
    },
  };
};
