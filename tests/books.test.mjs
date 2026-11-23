import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compile, parseCsv, isSolved } from '../js/logic.js';
import { computeHint, checkMarksAgainstSolution } from '../js/hintstep.js';

const root = new URL('..', import.meta.url).pathname;

test('manifest.json matches every shipped CSV file and count', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'manifest.json'), 'utf8'));
  assert.ok(manifest.groups.length >= 3);
  assert.ok(manifest.books.length >= 10);
  const armory = manifest.books.find((b) => b.id === 'armory');
  assert.ok(armory && armory.hidden === true, 'hidden armory book must be registered');
  for (const b of manifest.books) {
    const full = path.join(root, b.file);
    assert.ok(fs.existsSync(full), `missing book file ${b.file}`);
    const ps = parseCsv(fs.readFileSync(full, 'utf8'));
    assert.equal(ps.length, b.count, `manifest count mismatch for ${b.id}`);
  }
});

test('following hints from an empty board solves shipped Beginner and Medium puzzles across sizes', () => {
  for (const id of ['intro', '6x6', '8x8', '10x10', '12x12']) {
    const ps = parseCsv(fs.readFileSync(path.join(root, 'data', `${id}.csv`), 'utf8'));
    const sample = [
      ps.find((p) => p.tier === 'Beginner'),
      ps.find((p) => p.tier === 'Medium'),
    ].filter(Boolean);
    assert.ok(sample.length >= 1);
    for (const raw of sample) {
      const P = compile({ ...raw });
      const marks = { edges: new Uint8Array(P.numEdges) };
      let steps = 0;
      while (!isSolved(P, marks.edges) && steps < 800) {
        const h = computeHint(P, marks);
        assert.equal(h.kind, 'step', `Hint got ${h.kind} on ${id}/${P.name} (${P.tier}) at step ${steps}`);
        const t = h.hints[0].targets;
        let changed = false;
        for (const x of t.segOn) if (marks.edges[x] !== 1) { marks.edges[x] = 1; changed = true; }
        for (const x of t.segOff) if (marks.edges[x] !== 2) { marks.edges[x] = 2; changed = true; }
        assert.equal(changed, true);
        steps++;
      }
      assert.equal(isSolved(P, marks.edges), true, `Hints did not finish ${id}/${P.name}`);
      assert.equal(checkMarksAgainstSolution(P, marks).total, 0);
    }
  }
});

test('docs/how_to_solve.md exists and all referenced images exist', () => {
  const mdPath = path.join(root, 'docs', 'how_to_solve.md');
  assert.ok(fs.existsSync(mdPath));
  const md = fs.readFileSync(mdPath, 'utf8');
  const imgs = [...md.matchAll(/src="(images\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(imgs.length >= 18, `expected >= 18 rule illustrations, got ${imgs.length}`);
  for (const rel of imgs) {
    assert.ok(fs.existsSync(path.join(root, 'docs', rel)), `missing doc image docs/${rel}`);
  }
});
