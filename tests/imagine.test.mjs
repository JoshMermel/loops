import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, parseCsv, initialState, decodeSolution, E_ON, E_OFF, E_UNKNOWN, LOOP,
} from '../js/logic.js';
import { rate } from '../js/rating.js';
import {
  classifyImagine, minImagineCost, bestImagine, replayImagine,
} from '../js/imagine.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const armory = parseCsv(fs.readFileSync(path.join(root, 'data', 'armory.csv'), 'utf8'));

test('classifyImagine tiers and minImagineCost lower-bound invariant hold on synthetic and real chains', () => {
  const P = compile({ name: 'cls', rows: 6, cols: 6, clues: [{ r: 1, c: 1, t: 'B' }] });
  const st = initialState(P);
  const frontEdge = P.ed[(1 * 6 + 1) * 4 + 1]; // incident to LOOP clue (1,1)
  const farEdge = P.ed[(4 * 6 + 4) * 4 + 1];   // non-frontier
  const stepAt = (r, c) => ({ rule: 'forcedExits', sets: [['e', P.ed[(r * 6 + c) * 4 + 1], E_ON]], info: { cell: r * 6 + c } });

  // 1-step frontier local -> imagineLocal
  const cLocal = classifyImagine(P, st, frontEdge, [stepAt(1, 2)], { kind: 'stranded', cell: 1 * 6 + 2 }, false);
  assert.equal(cLocal.rule, 'imagineLocal');
  assert.ok(minImagineCost(1, false, true) <= cLocal.cost);

  // 2-step frontier connected thread -> imagineTrace
  const cTrace = classifyImagine(P, st, frontEdge, [stepAt(1, 2), stepAt(1, 3)], { kind: 'stranded', cell: 1 * 6 + 3 }, false);
  assert.equal(cTrace.rule, 'imagineTrace');
  assert.ok(minImagineCost(2, false, true) <= cTrace.cost);

  // 4-step frontier or non-frontier or area -> imagineChain
  const cLong = classifyImagine(P, st, frontEdge, [stepAt(1, 2), stepAt(1, 3), stepAt(1, 4), stepAt(2, 4)], { kind: 'stranded', cell: 2 * 6 + 4 }, false);
  assert.equal(cLong.rule, 'imagineChain');
  assert.ok(minImagineCost(4, false, true) <= cLong.cost);

  const cNonFront = classifyImagine(P, st, farEdge, [stepAt(4, 4)], { kind: 'stranded', cell: 4 * 6 + 4 }, false);
  assert.equal(cNonFront.rule, 'imagineChain');
  assert.ok(minImagineCost(1, false, false) <= cNonFront.cost);

  const cArea = classifyImagine(P, st, frontEdge, [stepAt(1, 2)], { kind: 'chokepoint', area: [] }, true);
  assert.equal(cArea.rule, 'imagineChain');
  assert.ok(minImagineCost(1, true, true) <= cArea.cost);
});

test('bestImagine and replayImagine produce sound deductions consistent with costCap and minImagineCost on armory puzzles', () => {
  const raw = armory.find((p) => p.rules === 'imagineChain');
  assert.ok(raw, 'expected an imagineChain puzzle in data/armory.csv');
  const P = compile({ ...raw });
  const sol = decodeSolution(P, P.solution);
  const r = rate(P);
  assert.equal(r.solved, true);
  const imgIdx = r.steps.findIndex((s) => s.rule.startsWith('imagine'));
  assert.ok(imgIdx >= 0, 'expected an imagine step during rating');

  // Reconstruct the exact state just before the first imagine step with ONLY edges (omitting UNKNOWN->LOOP bookkeeping)
  const stUnprop = initialState(P);
  for (let i = 0; i < imgIdx; i++) {
    for (const [k, idx, v] of r.steps[i].sets) {
      if (k === 'e') stUnprop.e[idx] = v;
    }
  }
  const hit = bestImagine(P, stUnprop, { costCap: Infinity });
  assert.ok(hit, 'bestImagine should find a contradiction even when UNKNOWN->LOOP bookkeeping was omitted');
  assert.equal(sol.e[hit.edge], hit.deduce, 'imagined deduction must match the unique solution');

  const isFront = stUnprop.cell[P.edgeA[hit.edge]] === LOOP || stUnprop.cell[P.edgeB[hit.edge]] === LOOP;
  assert.ok(
    minImagineCost(hit.steps.length, hit.area, isFront) <= hit.cost,
    `minImagineCost lower bound violated on ${raw.name}`,
  );

  // Replaying the pruned chain reproduces the exact contradiction
  const rep = replayImagine(P, stUnprop, hit);
  assert.ok(rep && rep.broke, 'replayImagine must reproduce contradiction');

  // costCap strictly below hit.cost returns null; costCap above hit.cost finds an equal-or-cheaper valid hit
  assert.equal(bestImagine(P, stUnprop, { costCap: hit.cost }), null);
  const capped = bestImagine(P, stUnprop, { costCap: hit.cost + 1 });
  assert.ok(capped && capped.cost <= hit.cost);
  assert.equal(sol.e[capped.edge], capped.deduce);
  assert.equal(stUnprop.e[hit.edge], E_UNKNOWN, 'bestImagine must not mutate caller state');
  assert.ok(hit.deduce === E_ON || hit.deduce === E_OFF);
});
