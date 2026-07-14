// Pulls locomo10.json from snap-research/locomo into bench/locomo/data/ (gitignored —
// it's their dataset, not ours to redistribute). Idempotent: skips if already present.
//
// Usage: node bench/locomo/fetch-dataset.mjs

import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const DATA_DIR = join(import.meta.dirname, 'data');
const DEST = join(DATA_DIR, 'locomo10.json');
const REPO = 'https://github.com/snap-research/locomo.git';

if (existsSync(DEST)) {
  console.log(`Already present: ${DEST}`);
  process.exit(0);
}

mkdirSync(DATA_DIR, { recursive: true });
const tmpClone = join(DATA_DIR, '.locomo-src-tmp');
rmSync(tmpClone, { recursive: true, force: true });

console.log(`Cloning ${REPO} (shallow)...`);
execFileSync('git', ['clone', '--depth', '1', REPO, tmpClone], { stdio: 'inherit' });

const src = join(tmpClone, 'data', 'locomo10.json');
if (!existsSync(src)) {
  console.error(`Expected dataset not found at ${src} — upstream repo layout may have changed.`);
  process.exit(1);
}
copyFileSync(src, DEST);
rmSync(tmpClone, { recursive: true, force: true });
console.log(`Wrote ${DEST}`);
