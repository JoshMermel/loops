#!/usr/bin/env node
// Independently re-verify every shipped puzzle in data/manifest.json before publishing.
//
// Usage:
//   node tools/audit_books.mjs [--book id[,id...]] [--jobs N] [--chunk 25] [--rate] [--all]
//
// Checks per puzzle:
//   - clues in bounds, distinct cells, valid type W|B
//   - stored solution is valid (isSolved)
//   - exactly ONE solution proved independently (sound rules, or complete exhaustive search without hitting node cap)
//   - with --rate: stored tier, rules, and score match a fresh rate(P)
// Checks per book / across books:
//   - manifest count equals CSV row count
//   - distinct puzzle names
//   - no duplicates within or across non-hidden books (via symmetryKey)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  parseCsv, compile, solve, decodeSolution, encodeSolution, isSolved, symmetryKey, E_ON,
} from '../js/logic.js';
import { rate, solvedByRules, FIRST_LOOKAHEAD } from '../js/rating.js';

const root = new URL('..', import.meta.url).pathname;
const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'manifest.json'), 'utf8'));
const loadBook = (entry) => parseCsv(fs.readFileSync(path.join(root, entry.file), 'utf8'));

if (process.argv.includes('--worker')) {
  const entry = manifest.books.find((b) => b.id === arg('worker'));
  const [from, to] = arg('range').split('-').map(Number);
  const withRating = process.argv.includes('--rate');
  const out = { checked: 0, bad: [], exhaustive: 0 };

  loadBook(entry).slice(from, to).forEach((raw, k) => {
    const name = raw.name;
    const fail = (why) => out.bad.push(`${entry.id} #${from + k + 1} ${name}: ${why}`);
    out.checked++;

    const seen = new Set();
    for (const c of raw.clues) {
      if (c.r < 0 || c.c < 0 || c.r >= raw.rows || c.c >= raw.cols) return fail('clue outside the board');
      const idx = c.r * raw.cols + c.c;
      if (seen.has(idx)) return fail('two clues on one cell');
      seen.add(idx);
      if (c.t !== 'W' && c.t !== 'B') return fail(`bad clue type "${c.t}"`);
    }

    let P;
    try { P = compile(raw); } catch (e) { return fail(`does not compile: ${e.message}`); }
    if (!raw.solution || raw.solution.length !== P.N) return fail('missing or wrong-length stored solution');

    const sol = decodeSolution(P, raw.solution);
    if (!isSolved(P, sol.e)) return fail('stored solution is not a valid Masyu solution');

    // Prove uniqueness independently (sound non-lookahead rules first, else complete exhaustive search)
    const byRules = solvedByRules(P, FIRST_LOOKAHEAD);
    if (byRules.solved) {
      if (encodeSolution(P, byRules.state) !== raw.solution) return fail('sound rules solved to a different solution');
    } else {
      out.exhaustive++;
      const r = solve(P, { limit: 2, maxNodes: 2000000 });
      if (r.exceeded) return fail('uniqueness not proved: exhaustive search hit node cap');
      if (r.count !== 1) return fail(`found ${r.count} solutions`);
      if (encodeSolution(P, r.solutions[0]) !== raw.solution) return fail('unique solution differs from stored solution');
    }

    if (withRating) {
      const q = rate(P);
      if (q.tier !== raw.tier || q.score !== raw.score || q.rules !== raw.rules) {
        return fail(`stored ${raw.tier}/${raw.rules}/${raw.score} but rates ${q.tier}/${q.rules}/${q.score}`);
      }
    }
  });

  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

// Main coordinator
const only = arg('book', '') ? arg('book').split(',') : null;
const includeHidden = process.argv.includes('--all');
const userChunk = arg('chunk', null);
const chunk = userChunk ? +userChunk : 25;
const jobs = Math.max(1, +arg('jobs', Math.max(2, os.availableParallelism() - 1)));
const withRating = process.argv.includes('--rate');

const booksToAudit = manifest.books.filter((b) => (only ? only.includes(b.id) : includeHidden || !b.hidden));
const problems = [], tasks = [];
const everywhere = new Map();
let total = 0;

for (const entry of booksToAudit) {
  const filePath = path.join(root, entry.file);
  if (!fs.existsSync(filePath)) { problems.push(`${entry.id}: missing file ${entry.file}`); continue; }
  const ps = loadBook(entry);
  total += ps.length;
  if (ps.length !== entry.count) problems.push(`${entry.id}: manifest count ${entry.count} !== file rows ${ps.length}`);
  const names = new Set(), hashes = new Map();
  for (const p of ps) {
    if (names.has(p.name)) problems.push(`${entry.id}: duplicate puzzle name ${p.name}`);
    names.add(p.name);
    const sk = symmetryKey(p);
    if (hashes.has(sk)) problems.push(`${entry.id}: ${p.name} duplicates ${hashes.get(sk)} (up to symmetry)`);
    else if (!entry.hidden && everywhere.has(sk)) problems.push(`${entry.id}: ${p.name} duplicates ${everywhere.get(sk)} (up to symmetry)`);
    hashes.set(sk, p.name);
    if (!entry.hidden && !everywhere.has(sk)) everywhere.set(sk, `${entry.id}:${p.name}`);
  }
  const bigBook = ps.length > 0 && ps[0].rows * ps[0].cols >= 225;
  const bookChunk = userChunk ? chunk
    : bigBook ? Math.min(chunk, 3)
    : booksToAudit.length === 1 ? Math.min(chunk, Math.max(4, Math.ceil(ps.length / jobs)))
    : chunk;
  for (let from = 0; from < ps.length; from += bookChunk) {
    tasks.push({ id: entry.id, range: `${from}-${Math.min(ps.length, from + bookChunk)}` });
  }
}

console.log(`Auditing ${total} puzzles across ${booksToAudit.length} books (${tasks.length} chunks, ${jobs} workers${withRating ? ', with --rate' : ''})...`);
let checked = 0, exhaustive = 0, running = 0;
const t0 = Date.now();

await new Promise((resolve) => {
  const next = () => {
    if (!tasks.length && !running) return resolve();
    while (running < jobs && tasks.length) {
      const t = tasks.shift();
      running++;
      const args = [new URL(import.meta.url).pathname, '--worker', t.id, '--range', t.range, ...(withRating ? ['--rate'] : [])];
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; });
      child.on('close', (code) => {
        running--;
        if (code !== 0) {
          problems.push(`worker failed on ${t.id} ${t.range} (exit ${code})`);
        } else {
          const res = JSON.parse(buf.trim());
          checked += res.checked;
          exhaustive += res.exhaustive;
          problems.push(...res.bad);
        }
        next();
      });
    }
  };
  next();
});

const sec = ((Date.now() - t0) / 1000).toFixed(2);
if (problems.length) {
  console.error(`\nAUDIT FAILED (${problems.length} problems in ${sec}s):`);
  for (const p of problems.slice(0, 40)) console.error('  -', p);
  process.exit(1);
}
console.log(`AUDIT PASSED: ${checked} puzzles verified (${exhaustive} via exhaustive search) in ${sec}s.`);
