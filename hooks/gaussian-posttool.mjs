#!/usr/bin/env node
// PostToolUse hook — semantic diff storage via memory_store_diff.
import { loadEnv, readStdin, detectProject, callTool, redact } from './gaussian-lib.mjs';

const input = await readStdin();
let data = {};
try { data = JSON.parse(input); } catch { process.exit(0); }
const toolName = data.tool_name || '';

const { worker, token } = loadEnv();
if (!worker) process.exit(0);

const project = detectProject();
// redact() runs before truncation so a credential can't survive by being clipped
// mid-pattern. Covers all three capture paths below: command, output, and file content.
const squash = (s, lines) => redact(String(s)).split('\n').slice(0, lines).join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);

// Skip Edit (captured better by the Stop-hook session extraction), and any Bash command
// that is read-only, a memory/gaussian call, routine vcs/package/file ops, or a deploy.
const skip = [
  /^\s*(ls|cat|head|tail|echo|pwd|cd|grep|find|sort|cut|wc|sed|awk|jq|which|type|diff|less|more|man|open|pbcopy|pbpaste)/,
  /memory_retrieve|memory_list|memory_stats|memory_decay|gaussian-memory/,
  /^\s*(git add|git commit|git status|git diff|git log|git push|git pull|git checkout|git stash|npm install|pip install|mkdir|touch|chmod|rm |mv |cp )/,
  /^\s*(sleep|wait|true|false|exit)/,
  /wrangler deploy|npx wrangler/,
];

if (toolName === 'Write') {
  const filePath = (data.tool_input && data.tool_input.file_path) || '';
  if (!filePath) process.exit(0);
  const content = squash((data.tool_input && data.tool_input.content) || '', 6);
  await callTool(worker, token, 'memory_store_diff',
    { file_path: filePath, old_string: '', new_string: content, project }, 4000);
} else if (toolName === 'Bash') {
  const cmd = (data.tool_input && data.tool_input.command) || '';
  if (skip.some(re => re.test(cmd))) process.exit(0);
  const resp = data.tool_response;
  const rawOut = (resp && typeof resp === 'object') ? (resp.stdout || '') : (resp || '');
  const output = squash(rawOut, 5);
  if (output.length < 15) process.exit(0);
  await callTool(worker, token, 'memory_store_diff',
    { command: squash(cmd, 2), output, project }, 4000);
}

process.exit(0);
