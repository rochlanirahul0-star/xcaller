/**
 * Nightly database backup. Kept deliberately dumb: one file, newest 14 kept.
 *   node scripts/backup.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'data', 'jarvis-chat.db');
const DIR = path.join(ROOT, 'data', 'backups');
const KEEP = 14;

if (!fs.existsSync(SRC)) { console.error('no database at', SRC); process.exit(1); }
fs.mkdirSync(DIR, { recursive: true });

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const out = path.join(DIR, `jarvis-chat-${stamp}.db`);

const db = new DatabaseSync(SRC);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();

const made = fs.statSync(out);
console.log(`backup written: ${out} (${(made.size / 1024).toFixed(1)} KB)`);

const all = fs.readdirSync(DIR).filter((f) => f.startsWith('jarvis-chat-')).sort();
while (all.length > KEEP) {
  const old = all.shift();
  fs.unlinkSync(path.join(DIR, old));
  console.log('pruned old backup:', old);
}
