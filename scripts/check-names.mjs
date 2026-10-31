// Scans git-tracked files for private words listed in ~/.ibmi-agent-kit/private-names.txt.
// Usage: node scripts/check-names.mjs [--list <path>]. Prints file:line: word, never the line.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const i = process.argv.indexOf('--list');
const listPath = i > 0 && process.argv[i + 1]
  ? process.argv[i + 1]
  : join(homedir(), '.ibmi-agent-kit', 'private-names.txt');

if (!existsSync(listPath)) {
  console.log(`check-names: skipped, no list at ${listPath}`);
  process.exit(0);
}

const words = readFileSync(listPath, 'utf8').split(/\r?\n/).map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = words.map((w) => ({ w, re: new RegExp(`(?<![\\p{L}\\p{N}_])${esc(w)}(?![\\p{L}\\p{N}_])`, 'iu') }));
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0').filter(Boolean);

let hits = 0;
for (const f of files) {
  let buf;
  try { buf = readFileSync(f); } catch { continue; }
  if (buf.includes(0)) continue; // binary
  const lines = buf.toString('utf8').split(/\r?\n/);
  lines.forEach((line, n) => {
    for (const { w, re } of patterns) {
      if (re.test(line)) { console.log(`${f}:${n + 1}: ${w}`); hits++; }
    }
  });
}
if (hits) process.exit(1);
console.log('check-names: no hits');
