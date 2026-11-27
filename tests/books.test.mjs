import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, parseCsv, isSolved, WHITE, BLACK } from '../js/logic.js';
import { computeHint, checkMarksAgainstSolution } from '../js/hintstep.js';
import { reconcileAutoGray } from '../js/marks.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('manifest.json matches every shipped CSV file, count, and section hierarchy', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'manifest.json'), 'utf8'));
  assert.ok(manifest.groups.length >= 3);
  assert.ok(manifest.books.length >= 10);
  const armory = manifest.books.find((b) => b.id === 'armory');
  assert.ok(armory && armory.hidden === true, 'hidden armory book must be registered');
  assert.ok(manifest.books.some((b) => b.id === manifest.default), `manifest.default (${manifest.default}) must exist in books`);

  const ids = new Set();
  const files = new Set();
  for (const b of manifest.books) {
    assert.equal(ids.has(b.id), false, `duplicate book id ${b.id}`);
    assert.equal(files.has(b.file), false, `duplicate book file ${b.file}`);
    ids.add(b.id);
    files.add(b.file);
    const full = path.join(root, b.file);
    assert.ok(fs.existsSync(full), `missing book file ${b.file}`);
    const ps = parseCsv(fs.readFileSync(full, 'utf8'));
    assert.equal(ps.length, b.count, `manifest count mismatch for ${b.id}`);
    if (!b.hidden) {
      const g = manifest.groups.find((x) => x.name === b.group);
      assert.ok(g, `book ${b.id} references unknown group "${b.group}"`);
      if (b.sub) {
        const s = g.subs && g.subs[b.sub];
        assert.ok(s, `book ${b.id} references unknown sub "${b.sub}" under "${b.group}"`);
        if (b.sub2) {
          const s2 = s.subs && s.subs[b.sub2];
          assert.ok(s2, `book ${b.id} references unknown sub2 "${b.sub2}" under "${b.group}/${b.sub}"`);
        }
      }
    }
  }

  // Every CSV in data/ must be registered in manifest.json (no orphan files)
  const diskCsvs = fs.readdirSync(path.join(root, 'data')).filter((f) => f.endsWith('.csv'));
  for (const f of diskCsvs) {
    assert.ok(files.has(`data/${f}`), `orphan CSV file data/${f} is not registered in manifest.json`);
  }

  // Every visible group & subcategory in manifest.groups must have at least one visible book
  const visible = manifest.books.filter((b) => !b.hidden);
  for (const g of manifest.groups) {
    assert.ok(visible.some((b) => b.group === g.name), `empty manifest group "${g.name}"`);
    for (const subName of Object.keys(g.subs || {})) {
      assert.ok(visible.some((b) => b.group === g.name && b.sub === subName), `empty manifest sub "${g.name}/${subName}"`);
    }
  }
});

test('following hints from an empty board solves shipped Beginner and Medium puzzles across sizes and variants', () => {
  const bookIds = [
    'intro', 'intro-slither', 'intro-midloop', 'intro-castle', 'intro-hamilton',
    '8x8-beginner', '8x8-medium', '12x12-beginner', '12x12-medium',
    '16x16-beginner', '16x16-medium', '12x20-beginner', '12x20-medium',
    '16x24-beginner', '16x24-medium',
    'slither-7x7-beginner', 'slither-7x7-medium',
    'slither-10x10-beginner', 'slither-10x10-medium',
    'slither-12x12-beginner', 'slither-12x12-medium',
    'slither-10x16-beginner', 'slither-10x16-medium',
    'hybrid-slither-masyu', 'hybrid-slither-gray',
    'hybrid-slither-full', 'hybrid-slither2-full', 'hybrid-slither3-full',
    'full-swiss-10x10', 'full-sym-8x8', 'hybrid-gray-full',
    'slither-swiss-10x10', 'slither-sky-6x18', 'slither-sym-9x9', 'slither-all3-8x8',
    'midloop-7x7-beginner', 'midloop-7x7-medium',
    'midloop-10x10-beginner', 'midloop-10x10-medium',
    'midloop-12x12-beginner', 'midloop-12x12-medium',
    'midloop-10x16-beginner', 'midloop-10x16-medium',
    'midloop-even-7x7', 'midloop-odd-9x9', 'midloop-swiss-10x10', 'midloop-sky-6x18', 'midloop-sym-9x9',
    'hybrid-midloop-masyu', 'hybrid-midloop-gray', 'hybrid-midloop-slither', 'hybrid-midloop-slither2', 'hybrid-midloop-full',
    'castle-7x7-beginner', 'castle-7x7-medium',
    'castle-10x10-beginner', 'castle-10x10-medium',
    'castle-12x12-beginner', 'castle-12x12-medium',
    'castle-10x16-beginner', 'castle-10x16-medium',
    'castle-allgray-8x8', 'castle-allwhite-8x8', 'castle-allblack-8x8',
    'castle-swiss-10x10', 'castle-sky-6x18', 'castle-sym-9x9',
    'hybrid-castle-masyu', 'hybrid-castle-gray', 'hybrid-castle-slither', 'hybrid-castle-midloop', 'hybrid-castle-full',
    'bonus-gray', 'swiss-10x10',
  ];
  for (const id of bookIds) {
    const ps = parseCsv(fs.readFileSync(path.join(root, 'data', `${id}.csv`), 'utf8'));
    const sample = [
      ps.find((p) => p.tier === 'Beginner'),
      ps.find((p) => p.tier === 'Medium'),
    ].filter(Boolean);
    assert.ok(sample.length >= 1, `no Beginner/Medium puzzle found in ${id}`);
    for (const raw of sample) {
      const P = compile({ ...raw });
      const marks = {
        edges: new Uint8Array(P.numEdges),
        grays: new Uint8Array(P.grays.length),
        autoG: new Uint8Array(P.grays.length),
      };
      if (P.hasGivens) {
        for (const gv of P.givens) marks.edges[gv.edge] = gv.v ? 1 : 2;
      }
      let steps = 0;
      while (!isSolved(P, marks.edges) && steps < 800) {
        const h = computeHint(P, marks);
        assert.equal(h.kind, 'step', `Hint got ${h.kind} on ${id}/${P.name} (${P.tier}) at step ${steps}`);
        const t = h.hints[0].targets;
        let changed = false;
        for (const x of t.segOn) if (marks.edges[x] !== 1) { marks.edges[x] = 1; changed = true; }
        for (const x of t.segOff) if (marks.edges[x] !== 2) { marks.edges[x] = 2; changed = true; }
        for (const cell of t.grayWhite || []) {
          const k = P.grayAt[cell];
          if (k >= 0 && marks.grays[k] !== WHITE) { marks.grays[k] = WHITE; marks.autoG[k] = 0; changed = true; }
        }
        for (const cell of t.grayBlack || []) {
          const k = P.grayAt[cell];
          if (k >= 0 && marks.grays[k] !== BLACK) { marks.grays[k] = BLACK; marks.autoG[k] = 0; changed = true; }
        }
        reconcileAutoGray(P, marks);
        assert.equal(changed, true);
        steps++;
      }
      assert.equal(isSolved(P, marks.edges), true, `Hints did not finish ${id}/${P.name}`);
      assert.equal(checkMarksAgainstSolution(P, marks).total, 0);
    }
  }
});

test('docs/how_to_solve.md and docs/how_to_solve.html exist with all referenced images and launch assets', () => {
  const mdPath = path.join(root, 'docs', 'how_to_solve.md');
  const htmlPath = path.join(root, 'docs', 'how_to_solve.html');
  assert.ok(fs.existsSync(mdPath));
  assert.ok(fs.existsSync(htmlPath));
  assert.ok(fs.existsSync(path.join(root, 'LICENSE')));
  assert.ok(fs.existsSync(path.join(root, 'og-image.png')));
  assert.ok(fs.existsSync(path.join(root, 'apple-touch-icon.png')));
  const md = fs.readFileSync(mdPath, 'utf8');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const imgs = [...md.matchAll(/src="(images\/[^"]+)"/g)].map((m) => m[1]);
  const htmlImgs = [...html.matchAll(/src="(images\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(imgs.length >= 30, `expected >= 30 rule illustrations, got ${imgs.length}`);
  assert.deepEqual(htmlImgs, imgs, 'docs/how_to_solve.html and .md image lists should match');
  for (const rel of imgs) {
    assert.ok(fs.existsSync(path.join(root, 'docs', rel)), `missing doc image docs/${rel}`);
  }
  for (const anchor of ['variant-gray', 'variant-full', 'variant-swiss', 'variant-slitherlink', 'variant-midloop', 'variant-castlewall']) {
    assert.ok(html.includes(`id="${anchor}"`), `missing #${anchor} anchor in docs/how_to_solve.html`);
  }
});
