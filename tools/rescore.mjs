#!/usr/bin/env node
// Re-rate every puzzle in the given CSV files (default: all books in data/ and pools in tools/library/)
// and rewrite their rules / tier / score columns in place. Run after changing costs/tiers in js/rating.js.
//
// Usage:
//   node tools/rescore.mjs [file.csv ...] [--dry] [--jobs N]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { compile, parseCsv, toCsv } from '../js/logic.js';
import { rate } from '../js/rating.js';
import { repoRoot, byOrder } from './_cli.mjs';

if (!isMainThread) {
  parentPort.on('message', ({ id, p }) => {
    const r = rate(compile(p));
    parentPort.postMessage({ id, rules: r.rules, tier: r.tier, score: r.score });
  });
} else {
  const root = repoRoot(import.meta.url);
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const ji = args.indexOf('--jobs');
  const rawJobs = ji >= 0 ? Number(args[ji + 1]) : os.availableParallelism();
  if (!Number.isFinite(rawJobs) || rawJobs < 1) {
    console.error(`Invalid --jobs value: ${args[ji + 1]}`);
    process.exit(1);
  }
  const jobs = Math.max(1, Math.trunc(rawJobs));
  let files = args.filter((a, i) => !a.startsWith('--') && !(ji >= 0 && i === ji + 1));

  if (!files.length) {
    const walk = (d) => (fs.existsSync(d)
      ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (
        e.isDirectory()
          ? (e.name.startsWith('_') ? [] : walk(path.join(d, e.name)))
          : e.name.endsWith('.csv') ? [path.join(d, e.name)] : []
      ))
      : []);
    files = [...walk(path.join(root, 'data')), ...walk(path.join(root, 'tools', 'library'))];
  }

  const isSorted = (ps) => ps.every((p, i) => !i || byOrder(ps[i - 1], p) <= 0);
  const dataDir = path.join(root, 'data') + path.sep;

  const books = [];
  const tasks = [];
  for (const f of files) {
    const ps = parseCsv(fs.readFileSync(f, 'utf8'));
    if (!ps.length) continue;
    const isShippedBook = path.resolve(f).startsWith(dataDir);
    const book = { f, ps, isShippedBook, wasSorted: isSorted(ps), changed: 0, left: ps.length };
    books.push(book);
    ps.forEach((p, i) => tasks.push({ book, i, cells: p.rows * p.cols }));
  }
  if (!tasks.length) { console.log('No CSV puzzles found.'); process.exit(0); }
  tasks.sort((a, b) => b.cells - a.cells);

  const finish = (book) => {
    const { f, ps, isShippedBook, wasSorted, changed } = book;
    // Never reorder shipped books in data/ (preserves sequential BOOK-001..N names)
    let note = '';
    if (wasSorted && !isShippedBook) {
      ps.sort(byOrder);
      note = ', kept sorted';
    } else if (isShippedBook && wasSorted && !isSorted(ps)) {
      note = ' (order shifted; rebuild books to re-sort & renumber)';
    }
    if (!dry) fs.writeFileSync(f, toCsv(ps), 'utf8');
    console.log(`${path.relative(root, f)}: ${ps.length} puzzles, ${changed} changed${note}`);
  };

  let next = 0;
  const pending = new Map();
  const workersDone = new WeakSet();
  const feed = (w) => {
    if (next >= tasks.length) { workersDone.add(w); w.terminate(); return; }
    const id = next++;
    pending.set(id, tasks[id]);
    w.postMessage({ id, p: tasks[id].book.ps[tasks[id].i] });
  };

  for (let k = 0; k < Math.min(jobs, tasks.length); k++) {
    const w = new Worker(new URL(import.meta.url));
    w.on('message', ({ id, rules, tier, score }) => {
      const t = pending.get(id);
      pending.delete(id);
      const p = t.book.ps[t.i];
      if (p.rules !== rules || p.tier !== tier || p.score !== score) t.book.changed++;
      p.rules = rules; p.tier = tier; p.score = score;
      if (!--t.book.left) finish(t.book);
      feed(w);
    });
    w.on('error', (e) => { console.error(e); process.exit(1); });
    w.on('exit', (code) => {
      if (!workersDone.has(w)) {
        console.error(`rescore worker exited unexpectedly (code ${code})`);
        process.exit(1);
      }
    });
    feed(w);
  }
}
