import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, solve, encodeSolution, decodeSolution } from '../js/logic.js';
import { parseSelection, layoutFor, planPrint, boardSvg, boardUnits, SITE_URL } from '../js/print.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('parseSelection parses ranges, singles, deduplicates, and rejects invalid inputs', () => {
  assert.deepEqual(parseSelection('1-3, 5, 2-4', 10), { ids: [1, 2, 3, 4, 5] });
  assert.deepEqual(parseSelection('7 - 9', 10), { ids: [7, 8, 9] });
  assert.ok(parseSelection('', 10).error);
  assert.ok(parseSelection('5-2', 10).error);
  assert.ok(parseSelection('0', 10).error);
  assert.ok(parseSelection('11', 10).error);
  assert.ok(parseSelection('abc', 10).error);
});

test('layoutFor and planPrint fit multiple boards per page for A4/Letter', () => {
  const p6 = Array.from({ length: 20 }, (_, i) => ({ rows: 6, cols: 6, tier: 'Medium', name: `P${i + 1}` }));
  const plan = planPrint({ puzzles: p6, ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], keyIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], size: 'comfortable' });
  assert.ok(plan.perPage >= 6, `expected >= 6 6x6 boards per page, got ${plan.perPage}`);
  assert.ok(plan.keyPerPage > plan.perPage, 'answer key should fit more boards per page');
  assert.ok(plan.puzzlePages >= 1);
  assert.ok(plan.keyPages >= 1);

  const p12 = [{ rows: 12, cols: 12, tier: 'Hard' }];
  const lay12 = layoutFor(p12, 7);
  assert.ok(lay12.cols >= 2 && lay12.rows >= 2, `expected >= 4 12x12 boards per page, got ${lay12.perPage}`);
  assert.ok(SITE_URL.startsWith('https://'));
});

test('boardSvg outputs fixed black-and-white SVG with white/black/gray circles and optional solution loop', () => {
  const P = compile({ name: 'p', rows: 3, cols: 3, clues: [{ r: 0, c: 0, t: 'B' }, { r: 2, c: 2, t: 'G' }, { r: 0, c: 1, t: 'W' }] });
  const sol = solve(P, { limit: 2 }).solutions[0];
  P.solution = encodeSolution(P, sol);

  const svgBlank = boardSvg(P, null);
  assert.ok(svgBlank.includes('class="white-circle"'));
  assert.ok(svgBlank.includes('class="black-circle"'));
  assert.ok(svgBlank.includes('class="gray-circle"'));
  assert.ok(!svgBlank.includes('class="loop"'));

  const svgSol = boardSvg(P, decodeSolution(P, P.solution));
  assert.ok(svgSol.includes('class="loop"'));

  // Full-board with given line and given wall renders full-dot, given-line, and given-wall
  const Pfb = compile({
    name: 'pfb', rows: 4, cols: 4, clues: [], fullBoard: true,
    givens: [{ r: 0, c: 0, dir: 'H', v: 1 }, { r: 1, c: 1, dir: 'V', v: 0 }],
  });
  const svgFb = boardSvg(Pfb, null);
  assert.ok(svgFb.includes('class="full-dot"'));
  assert.ok(svgFb.includes('class="given-line"'));
  assert.ok(svgFb.includes('class="given-wall"'));

  // Slitherlink puzzle renders slither-num digits cleanly
  const Psl = compile({
    name: 'psl', rows: 4, cols: 4, clues: [],
    slither: [{ r: 0, c: 0, n: 3 }, { r: 1, c: 2, n: 0 }],
  });
  const svgSl = boardSvg(Psl, null);
  assert.ok(svgSl.includes('class="slither-num"'));
  assert.ok(svgSl.includes('>3</text>') && svgSl.includes('>0</text>'));

  // Swiss cheese voids render interior void fill and boardUnits matches viewBox exactly
  const Psw = compile({
    name: 'psw', rows: 5, cols: 6, clues: [],
    voids: [{ r: 2, c: 2 }],
    midloop: [{ r: 0, c: 1, dir: 'H' }, { r: 4, c: 4, dir: 'C' }],
  });
  const svgSw = boardSvg(Psw, null);
  assert.ok(svgSw.includes('class="void-hole-print"'));
  assert.ok(svgSw.includes('class="midloop-dot"'));
  const vb = /viewBox="[^"]+ [^"]+ ([\d.]+) ([\d.]+)"/.exec(svgSw);
  assert.ok(vb);
  const [uw, uh] = boardUnits(Psw);
  assert.ok(Math.abs(Number(vb[1]) - uw) < 1e-6 && Math.abs(Number(vb[2]) - uh) < 1e-6);
});

test('style.css has no unscoped screen rules that collide with print SVG classes', () => {
  const svgs = [
    boardSvg(compile({ name: 'a', rows: 4, cols: 4, clues: [{ r: 0, c: 0, t: 'B' }, { r: 0, c: 1, t: 'W' }, { r: 2, c: 2, t: 'G' }] })),
    boardSvg(compile({ name: 'b', rows: 4, cols: 4, clues: [], fullBoard: true, givens: [{ r: 0, c: 0, dir: 'H', v: 1 }, { r: 1, c: 1, dir: 'V', v: 0 }] })),
    boardSvg(compile({ name: 'c', rows: 5, cols: 5, clues: [], voids: [{ r: 2, c: 2 }], slither: [{ r: 0, c: 0, n: 2 }], midloop: [{ r: 0, c: 1, dir: 'H' }] })),
  ];
  const printClasses = new Set();
  for (const s of svgs) {
    for (const m of s.matchAll(/class="([^"]+)"/g)) {
      for (const cls of m[1].split(/\s+/)) if (cls !== 'print-board') printClasses.add(cls);
    }
  }
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}@]+)\{/g)) {
    const selList = m[1].trim();
    if (!selList) continue;
    for (const sel of selList.split(',').map((x) => x.trim())) {
      if (!sel || sel.includes('#print-root') || sel.includes('#board') || sel.includes('.help-fig')) continue;
      for (const cls of printClasses) {
        const re = new RegExp(`\\.${cls}(?![a-zA-Z0-9_-])`);
        assert.equal(re.test(sel), false, `unscoped CSS selector "${sel}" collides with print SVG class ".${cls}"`);
      }
    }
  }
});
