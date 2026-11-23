import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, solve, encodeSolution, decodeSolution } from '../js/logic.js';
import { parseSelection, layoutFor, planPrint, boardSvg, SITE_URL } from '../js/print.js';

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

test('boardSvg outputs fixed black-and-white SVG with white/black circles and optional solution loop', () => {
  const P = compile({ name: 'p', rows: 3, cols: 3, clues: [{ r: 0, c: 0, t: 'B' }, { r: 2, c: 2, t: 'B' }, { r: 0, c: 1, t: 'W' }] });
  const sol = solve(P, { limit: 2 }).solutions[0];
  P.solution = encodeSolution(P, sol);

  const svgBlank = boardSvg(P, null);
  assert.ok(svgBlank.includes('class="white-circle"'));
  assert.ok(svgBlank.includes('class="black-circle"'));
  assert.ok(!svgBlank.includes('class="loop"'));

  const svgSol = boardSvg(P, decodeSolution(P, P.solution));
  assert.ok(svgSol.includes('class="loop"'));
});
