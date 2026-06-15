#!/usr/bin/env node
'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

const [,, cmd, ...args] = process.argv;

function readJsonOrEmpty(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(question, ans => { rl.close(); r(ans.trim()); }));
}

function post(url, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── ingest ────────────────────────────────────────────────────────────────────

async function ingest(file) {
  const workerUrl = process.env.GAUSSIAN_WORKER_URL;
  const token = process.env.GAUSSIAN_AUTH_TOKEN;
  if (!workerUrl || !token) {
    console.error('Set GAUSSIAN_WORKER_URL and GAUSSIAN_AUTH_TOKEN environment variables first.');
    process.exit(1);
  }
  if (!file || !fs.existsSync(file)) {
    console.error(`Usage: npx gaussian-memory ingest <file.md>`);
    process.exit(1);
  }

  const raw = fs.readFileSync(file, 'utf8');

  // Strip YAML frontmatter
  const text = raw.replace(/^---[\s\S]*?---\n?/, '');
  const lines = text.split('\n');

  // Parse: extract header + content into atomic memory strings
  const memories = [];
  let currentHeader = '';
  let inCodeBlock = false;

  for (const line of lines) {
    // Track fenced code blocks — skip contents entirely
    if (/^```/.test(line)) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;

    // Skip tables and horizontal rules
    if (/^\|/.test(line) || /^[-*_]{3,}$/.test(line.trim())) continue;

    if (/^#{1,4}\s/.test(line)) {
      currentHeader = line.replace(/^#+\s*/, '').trim();
    } else if (/^[-*]\s+\[[ x]\]\s+/i.test(line)) {
      // Checkbox list item — strip checkbox marker
      const bullet = line.replace(/^[-*]\s+\[[ x]\]\s+/i, '').trim();
      if (bullet.length >= 20) memories.push(currentHeader ? `${currentHeader}: ${bullet}` : bullet);
    } else if (/^[-*]\s+/.test(line) || /^\s{2,}[-*]\s+/.test(line)) {
      // Bullet (top-level or nested)
      const bullet = line.replace(/^\s*[-*]\s+/, '').trim();
      if (bullet.length >= 20) memories.push(currentHeader ? `${currentHeader}: ${bullet}` : bullet);
    } else if (/^\d+\.\s+/.test(line)) {
      // Ordered list
      const bullet = line.replace(/^\d+\.\s+/, '').trim();
      if (bullet.length >= 20) memories.push(currentHeader ? `${currentHeader}: ${bullet}` : bullet);
    } else if (line.trim().length > 40 && currentHeader && !/^#/.test(line)) {
      // Plain paragraph line under a header
      memories.push(line.trim());
    }
  }

  if (!memories.length) {
    console.error('No content found. Use ## headers with - bullet points.');
    process.exit(1);
  }

  console.log(`Ingesting ${memories.length} items from ${path.basename(file)}...`);

  let stored = 0, skipped = 0;
  for (const memText of memories) {
    process.stdout.write(`  ${memText.slice(0, 65).padEnd(67)} `);
    try {
      const res = await post(workerUrl, token, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'memory_auto_store', arguments: { text: memText } }
      });
      const result = res?.result?.content?.[0]?.text ?? '';
      const action = result.match(/^(SPAWNED|MERGED|SKIP)/)?.[1] ?? 'SKIP';
      if (action === 'SPAWNED') stored++;
      else skipped++;
      console.log(`→ ${action}`);
    } catch (e) {
      skipped++;
      console.log(`→ error`);
    }
  }
  console.log(`\nDone. ${stored} stored, ${skipped} skipped/merged.`);
}

// ── init ──────────────────────────────────────────────────────────────────────

async function init() {
  console.log('\nGaussian Memory — one-command setup\n');

  // Check wrangler
  try { execSync('npx wrangler --version', { stdio: 'pipe' }); }
  catch { console.error('wrangler not found. Run: npm install -g wrangler'); process.exit(1); }

  console.log('Creating Cloudflare resources (this takes ~30s)...\n');

  // D1
  process.stdout.write('  Creating D1 database... ');
  let d1Id;
  try {
    const out = execSync('npx wrangler d1 create gaussian-memory 2>&1', { encoding: 'utf8' });
    d1Id = out.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
    console.log(`done (${d1Id})`);
  } catch (e) {
    const m = e.stdout?.match(/database_id\s*=\s*"([^"]+)"/) || e.message?.match(/database_id\s*=\s*"([^"]+)"/);
    d1Id = m?.[1];
    if (!d1Id) {
      try {
        const list = execSync('npx wrangler d1 list 2>&1', { encoding: 'utf8' });
        d1Id = list.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[^|]*│[^|]*gaussian-memory/)?.[1]
            || list.match(/gaussian-memory[^|]*│[^|]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1];
      } catch {}
    }
    console.log(d1Id ? `exists (${d1Id})` : 'failed — check wrangler auth');
  }

  // Vectorize
  process.stdout.write('  Creating Vectorize index... ');
  try {
    execSync('npx wrangler vectorize create gaussian-memory-index --dimensions=768 --metric=cosine 2>&1', { stdio: 'pipe' });
    console.log('done');
  } catch { console.log('exists or failed — continuing'); }

  // KV
  process.stdout.write('  Creating KV namespace... ');
  let kvId;
  try {
    const out = execSync('npx wrangler kv namespace create gaussian-memory-kv 2>&1', { encoding: 'utf8' });
    kvId = out.match(/id\s*=\s*"([^"]+)"/)?.[1];
    console.log(`done (${kvId})`);
  } catch (e) {
    const m = e.stdout?.match(/id\s*=\s*"([^"]+)"/) || e.message?.match(/id\s*=\s*"([^"]+)"/);
    kvId = m?.[1];
    if (!kvId) {
      try {
        const list = execSync('npx wrangler kv namespace list 2>&1', { encoding: 'utf8' });
        const parsed = JSON.parse(list.match(/\[.*\]/s)?.[0] ?? '[]');
        kvId = parsed.find(ns => ns.title?.includes('gaussian-memory-kv'))?.id;
      } catch {}
    }
    console.log(kvId ? `exists (${kvId})` : 'failed — check wrangler auth');
  }

  // R2
  process.stdout.write('  Creating R2 bucket (cold storage)... ');
  try {
    execSync('npx wrangler r2 bucket create gaussian-memory-cold 2>&1', { stdio: 'pipe' });
    console.log('done');
  } catch { console.log('exists or failed — continuing'); }

  // Patch wrangler.toml (create from example if not present — wrangler.toml is gitignored)
  const tomlPath = path.join(__dirname, '..', 'wrangler.toml');
  const examplePath = path.join(__dirname, '..', 'wrangler.example.toml');
  if (!fs.existsSync(tomlPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, tomlPath);
  }
  if (d1Id || kvId) {
    let toml = fs.readFileSync(tomlPath, 'utf8');
    if (d1Id) toml = toml.replace('YOUR_D1_DATABASE_ID', d1Id);
    if (kvId) toml = toml.replace('YOUR_KV_NAMESPACE_ID', kvId);
    fs.writeFileSync(tomlPath, toml);
    console.log('\n  wrangler.toml updated with real IDs.');
  }

  // Run D1 schema
  process.stdout.write('  Running D1 schema migrations... ');
  try {
    execSync('npx wrangler d1 execute gaussian-memory --remote --file=schema.sql 2>&1', { stdio: 'pipe' });
    console.log('done');
  } catch { console.log('check schema.sql path'); }

  // Column migrations — safe to run on existing installs (ALTER TABLE errors = already exists)
  process.stdout.write('  Applying column migrations... ');
  for (const col of [
    "ALTER TABLE memories ADD COLUMN valid_from INTEGER",
    "ALTER TABLE memories ADD COLUMN valid_to INTEGER",
  ]) {
    try { execSync(`npx wrangler d1 execute gaussian-memory --remote --command "${col}" 2>&1`, { stdio: 'pipe' }); }
    catch { /* column already exists — ignore */ }
  }
  try {
    execSync('npx wrangler d1 execute gaussian-memory --remote --command "UPDATE memories SET valid_from = timestamp WHERE valid_from IS NULL" 2>&1', { stdio: 'pipe' });
  } catch {}
  console.log('done');

  // Deploy
  process.stdout.write('\n  Deploying worker... ');
  try {
    const out = execSync('npx wrangler deploy 2>&1', { encoding: 'utf8' });
    const url = out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
    console.log(url ? `deployed → ${url}` : 'done');

    // AUTH_TOKEN
    console.log('\n  Setting AUTH_TOKEN secret...');
    const token = require('crypto').randomBytes(32).toString('hex');
    const r = spawnSync('npx', ['wrangler', 'secret', 'put', 'AUTH_TOKEN'], {
      input: token, encoding: 'utf8', stdio: ['pipe','pipe','pipe']
    });
    console.log('  AUTH_TOKEN set.\n');

    // Auto-install Claude Code hooks if ~/.claude exists
    const claudeDir = path.join(process.env.HOME, '.claude');
    const hooksDir = path.join(claudeDir, 'hooks');
    const settingsPath = path.join(claudeDir, 'settings.json');
    const mcpJsonPath = path.join(claudeDir, 'mcp.json');
    const repoHooks = path.join(__dirname, '..', 'hooks');

    if (fs.existsSync(claudeDir)) {
      // Hook safety UX — show what will be installed, ask for confirmation
      console.log('\n  Claude Code hooks to install:');
      console.log('    UserPromptSubmit → gaussian-retrieve.sh  (inject memories before each prompt)');
      console.log('    PostToolUse      → gaussian-posttool.sh  (capture tool observations, async)');
      console.log('    Stop             → gaussian-store.sh     (store session memories on exit)');
      console.log('\n  These hooks write to ~/.claude/settings.json and run on every Claude Code session.');
      const confirmHooks = await ask('\n  Install hooks? [Y/n] ');
      if (confirmHooks.toLowerCase() === 'n') {
        console.log('  Skipping hooks. Install manually — see hooks/README.md');
      } else {
        process.stdout.write('  Installing Claude Code hooks... ');
        fs.mkdirSync(hooksDir, { recursive: true });
        for (const f of ['gaussian-retrieve.sh', 'gaussian-posttool.sh', 'gaussian-store.sh']) {
          const src = path.join(repoHooks, f);
          const dst = path.join(hooksDir, f);
          if (fs.existsSync(src)) {
            fs.writeFileSync(dst, fs.readFileSync(src, 'utf8'));
            fs.chmodSync(dst, '755');
          }
        }

        // Patch settings.json — merge into existing hooks rather than replacing
        const settings = readJsonOrEmpty(settingsPath);
        if (!settings.hooks) settings.hooks = {};
        const gaussianHooks = {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/gaussian-retrieve.sh', statusMessage: 'Recalling memories...' }] }],
          PostToolUse:      [{ hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/gaussian-posttool.sh', timeout: 15, async: true }] }],
          Stop:             [{ hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/gaussian-store.sh', timeout: 30, async: true }] }],
        };
        for (const [event, val] of Object.entries(gaussianHooks)) {
          const existing = settings.hooks[event];
          if (!existing) {
            settings.hooks[event] = val;
          } else if (!JSON.stringify(existing).includes('gaussian')) {
            settings.hooks[event] = [...existing, ...val];
          }
        }
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('done');
      }

      // Write MCP config to ~/.claude/mcp.json with Bearer token
      if (url) {
        process.stdout.write('  Writing ~/.claude/mcp.json with Bearer auth... ');
        const mcpConfig = readJsonOrEmpty(mcpJsonPath);
        if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
        mcpConfig.mcpServers['gaussian-memory'] = {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${token}` },
        };
        fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2));
        console.log('done');
      }
    }

    // Write env vars to a sourceable file
    if (!url) {
      console.error('\nWarning: could not detect worker URL from deploy output.');
      console.error('Check `npx wrangler deploy` output and set GAUSSIAN_WORKER_URL manually in ~/.gaussian-memory-env');
      return;
    }
    const envFile = path.join(process.env.HOME, '.gaussian-memory-env');
    fs.writeFileSync(envFile, `export GAUSSIAN_WORKER_URL="${url}"\nexport GAUSSIAN_AUTH_TOKEN="${token}"\n`, { mode: 0o600 });
    fs.chmodSync(envFile, 0o600);

    // Auto-install OpenCode plugin + MCP server if ~/opencode.json exists
    const opencodeJson = path.join(process.env.HOME, 'opencode.json');
    const pluginPkg = path.join(__dirname, '..', 'hooks', 'opencode-gaussian-memory.mjs');
    const pluginDst = path.join(process.env.HOME, '.opencode', 'gaussian-memory.mjs');
    if (fs.existsSync(opencodeJson) || fs.existsSync(path.join(process.env.HOME, '.config', 'opencode'))) {
      process.stdout.write('  Installing OpenCode plugin + MCP server... ');
      try {
        // Copy plugin file
        if (fs.existsSync(pluginPkg)) {
          fs.mkdirSync(path.dirname(pluginDst), { recursive: true });
          fs.copyFileSync(pluginPkg, pluginDst);
        }
        // Patch opencode.json
        const oconfig = readJsonOrEmpty(opencodeJson);
        if (!oconfig.$schema) oconfig.$schema = 'https://opencode.ai/config.json';
        if (!oconfig.plugin) oconfig.plugin = [];
        if (!oconfig.plugin.includes(pluginDst)) oconfig.plugin.push(pluginDst);
        if (!oconfig.mcp) oconfig.mcp = {};
        oconfig.mcp['gaussian-memory'] = { type: 'remote', url, headers: { Authorization: `Bearer ${token}` } };
        fs.writeFileSync(opencodeJson, JSON.stringify(oconfig, null, 2));
        console.log('done');
      } catch (e) {
        console.log('failed:', e.message);
      }
    }

    // Auto-install Cursor hooks + MCP config if ~/.cursor exists
    const cursorDir = path.join(process.env.HOME, '.cursor');
    if (fs.existsSync(cursorDir)) {
      process.stdout.write('  Installing Cursor hooks + MCP config... ');
      try {
        // Copy sessionEnd hook script
        const cursorHooksDir = path.join(cursorDir, 'hooks');
        fs.mkdirSync(cursorHooksDir, { recursive: true });
        const hookSrc = path.join(__dirname, '..', 'hooks', 'cursor-gaussian-store.sh');
        const hookDst = path.join(cursorHooksDir, 'gaussian-store.sh');
        let hookCopied = false;
        if (fs.existsSync(hookSrc)) {
          fs.writeFileSync(hookDst, fs.readFileSync(hookSrc, 'utf8'));
          fs.chmodSync(hookDst, '755');
          hookCopied = true;
        }

        // Only register hooks.json/mcp.json if the hook script was actually copied —
        // otherwise we'd point Cursor at a script that doesn't exist.
        if (hookCopied) {
          // Write hooks.json — merge alongside existing sessionEnd hooks
          const cursorHooksJson = path.join(cursorDir, 'hooks.json');
          const hooksConfig = readJsonOrEmpty(cursorHooksJson);
          if (!hooksConfig.version) hooksConfig.version = 1;
          if (!hooksConfig.hooks) hooksConfig.hooks = {};
          const gaussianCursorHook = { type: 'command', command: 'bash ~/.cursor/hooks/gaussian-store.sh', timeout: 30 };
          const existingSessionEnd = hooksConfig.hooks.sessionEnd;
          if (!existingSessionEnd) {
            hooksConfig.hooks.sessionEnd = [gaussianCursorHook];
          } else if (!JSON.stringify(existingSessionEnd).includes('gaussian')) {
            hooksConfig.hooks.sessionEnd = [...existingSessionEnd, gaussianCursorHook];
          }
          fs.writeFileSync(cursorHooksJson, JSON.stringify(hooksConfig, null, 2));

          // Write mcp.json
          if (url) {
            const cursorMcpJson = path.join(cursorDir, 'mcp.json');
            const mcpCursorConfig = readJsonOrEmpty(cursorMcpJson);
            if (!mcpCursorConfig.mcpServers) mcpCursorConfig.mcpServers = {};
            mcpCursorConfig.mcpServers['gaussian-memory'] = { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
            fs.writeFileSync(cursorMcpJson, JSON.stringify(mcpCursorConfig, null, 2));
          }
        }
        console.log('done');
      } catch (e) {
        console.log('failed:', e.message);
      }
    }

    // Cold start onboarding survey
    console.log('\n' + '━'.repeat(60));
    console.log('Quick setup — a few questions to seed your memory (Enter to skip any):\n');

    async function askFree(prompt, domain, key) {
      const answer = await ask(`  ${prompt}\n  > `);
      if (!answer || answer.length < 10) return false;
      try {
        await post(url, token, {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'memory_store', arguments: { text: answer, domain, memory_type: 'semantic', topic_key: key } }
        });
        return true;
      } catch { return false; }
    }

    async function askChoice(prompt, choices, domain, key) {
      console.log(`  ${prompt}`);
      choices.forEach((c, i) => console.log(`    ${String.fromCharCode(97 + i)}) ${c.label}`));
      const raw = await ask('  > ');
      const idx = raw.trim().toLowerCase().charCodeAt(0) - 97;
      if (idx < 0 || idx >= choices.length) return false;
      const text = choices[idx].memory;
      try {
        await post(url, token, {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'memory_store', arguments: { text, domain, memory_type: 'procedural', topic_key: key } }
        });
        return true;
      } catch { return false; }
    }

    let seeded = 0;
    if (await askFree('What are you currently building or working on?', 'project-context', 'current-project')) seeded++;
    if (await askFree('Main programming language and tech stack?', 'technical-identity', 'tech-stack')) seeded++;
    if (await askFree('Current goals? (e.g. ship MVP, job search, learning)', 'career-goals', 'goals')) seeded++;

    if (await askChoice('When you hit ambiguity mid-task:', [
      { label: 'Guess and go — I\'ll correct you if wrong', memory: 'When hitting ambiguity mid-task: prefer to guess and proceed, user will correct if wrong. Do not stop to ask clarifying questions.' },
      { label: 'Stop and ask — I\'d rather wait than redo work',  memory: 'When hitting ambiguity mid-task: stop and ask before proceeding. User prefers waiting over redoing work.' },
    ], 'working-style', 'ambiguity-pref')) seeded++;

    if (await askChoice('What annoys you most in AI responses?', [
      { label: 'Over-explains things I already know',     memory: 'User frustration trigger: AI over-explaining things they already know. Keep explanations minimal, assume competence.' },
      { label: 'Too confident — doesn\'t flag uncertainty', memory: 'User frustration trigger: AI being overconfident. Always flag uncertainty and tradeoffs explicitly.' },
      { label: 'Asks too many clarifying questions',      memory: 'User frustration trigger: too many clarifying questions. Bias toward action over asking.' },
      { label: 'Ignores context I already gave',          memory: 'User frustration trigger: AI ignoring previously given context. Always reference and respect prior context.' },
    ], 'working-style', 'frustration-trigger')) seeded++;

    if (await askChoice('Response style preference:', [
      { label: 'Concise — just the answer, no explanation', memory: 'Response style: concise. Give the answer directly, skip explanations and reasoning unless asked.' },
      { label: 'Detailed — show reasoning and tradeoffs',   memory: 'Response style: detailed. Show reasoning, tradeoffs, and explain the why behind decisions.' },
    ], 'working-style', 'response-style')) seeded++;

    if (await askFree('Anything else to always remember? (optional)', 'working-style', 'misc-pref')) seeded++;

    if (seeded > 0) console.log(`\n  ${seeded} seed memories stored.`);

    // Auto-append source line to shell profile
    const shellProfile = process.env.SHELL?.includes('zsh')
      ? path.join(process.env.HOME, '.zshrc')
      : path.join(process.env.HOME, '.bashrc');
    let profileContent = '';
    try { profileContent = fs.readFileSync(shellProfile, 'utf8'); } catch {}
    if (!profileContent.includes('gaussian-memory-env')) {
      fs.appendFileSync(shellProfile, `\n# Gaussian Memory\nsource ~/.gaussian-memory-env\n`);
      console.log(`\n  Auto-added source line to ${path.basename(shellProfile)}.`);
    } else {
      console.log(`\n  Shell profile already sources gaussian-memory-env — skipping.`);
    }

    console.log('\n' + '━'.repeat(60));
    console.log('Setup complete.\n');
    console.log('Run this to activate in your current shell:');
    console.log(`  source ~/.gaussian-memory-env`);
    if (!fs.existsSync(claudeDir)) {
      console.log('\nFor Claude Code hooks, see hooks/README.md');
    }
    console.log('━'.repeat(60));
  } catch (e) {
    console.log('deploy failed:', e.message);
  }
}

// ── backup ────────────────────────────────────────────────────────────────────

async function backup() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.resolve(process.cwd(), `gaussian-backup-${ts}.sql`);
  process.stdout.write(`Exporting D1 database to ${path.basename(outFile)}... `);
  const result = spawnSync('npx', ['wrangler', 'd1', 'export', 'gaussian-memory', '--remote', '--output', outFile], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    console.error('failed:', result.stderr || result.stdout || 'unknown error');
    console.error('Make sure wrangler is authenticated: npx wrangler login');
    process.exit(1);
  }
  console.log('done');
  console.log(`\nBackup saved: ${outFile}`);
  console.log(`Restore with: npx wrangler d1 execute gaussian-memory --remote --file <backup.sql>`);
}

// ── dispatch ──────────────────────────────────────────────────────────────────

switch (cmd) {
  case 'ingest': ingest(args[0]); break;
  case 'init':   init(); break;
  case 'backup': backup(); break;
  default:
    console.log('Usage:');
    console.log('  npx gaussian-memory init              — deploy worker + configure resources');
    console.log('  npx gaussian-memory ingest <file.md>  — seed memories from markdown file');
    console.log('  npx gaussian-memory backup            — export D1 database to SQL file');
    process.exit(0);
}
