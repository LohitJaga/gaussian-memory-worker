// One-off driver: loops memory_build_entities against the live Worker until it
// returns "Done." Runs standalone over HTTP so it doesn't consume per-call
// conversation turns — call once via `node`, let it run to completion.
//
// Usage: node bench/tools/backfill_entities.mjs

import { loadEnv, callTool } from '../lib/client.mjs';

async function main() {
  const env = loadEnv();
  console.log(`Backfilling entities → ${env.url}\n`);
  let calls = 0;
  const t0 = Date.now();

  while (true) {
    const res = await callTool('memory_build_entities', {}, env);
    calls++;
    if (!res.ok) {
      console.error(`  ! call ${calls} failed: ${res.error} — retrying after 2s`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    if (calls % 10 === 0 || res.text.startsWith('Done.')) {
      console.log(`  [${calls}] ${res.text}`);
    }
    if (res.text.startsWith('Done.')) break;
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\nBackfill complete after ${calls} calls (${mins} min).`);
}

main().catch(e => { console.error(e); process.exit(1); });
