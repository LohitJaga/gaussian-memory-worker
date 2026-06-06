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

async function autoStore(text, context) {
  if (!WORKER || !TOKEN || !text || text.length < 40) return;
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
  };
};
