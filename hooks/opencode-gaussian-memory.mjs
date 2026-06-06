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

async function callWorker(tool, args, timeout = 5000) {
  if (!WORKER || !TOKEN) return;
  try {
    await fetch(WORKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {}
}

async function autoStore(text, context) {
  if (!text || text.length < 80) return;
  if (SKIP_PATTERN.test(text.trim())) return;
  callWorker('memory_auto_store', { text, context });
}

async function extractAndStore(input) {
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
  callWorker('memory_extract_and_store', { text: transcript }, 15000);
}

function debugWrite(msg) {
  try { writeFileSync(`${homedir()}/.opencode/session-idle-fired.txt`, `${msg} at ${new Date().toISOString()}\n`, { flag: 'a' }); } catch {}
}

export const server = async () => {
  return {
    'experimental.chat.system.transform': async (_, output) => {
      output.system.push(
        'You have access to Gaussian Memory MCP tools. Before ending any conversation, call memory_extract_and_store with a 2-3 sentence summary of key decisions, facts, and context from the session.'
      );
    },

    'chat.message': async ({ sessionID }, output) => {
      const text = output.parts?.filter(p => p.type === 'text')?.map(p => p.text)?.join(' ')?.trim();
      autoStore(text, `opencode session ${sessionID}`);
    },

    'chat.input': async ({ sessionID, content }) => {
      const text = typeof content === 'string' ? content : content?.find?.(p => p.type === 'text')?.text;
      autoStore(text, `opencode user session ${sessionID}`);
    },

    'session.compacted': async (input) => {
      debugWrite(`compacted keys=${Object.keys(input ?? {}).join(',')}`);
      extractAndStore(input);
    },

    'session.idle': async (input) => {
      debugWrite(`idle keys=${Object.keys(input ?? {}).join(',')}`);
      extractAndStore(input);
    },
  };
};
