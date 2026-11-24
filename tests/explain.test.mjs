import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, solve, encodeSolution, isSolved, E_ON, E_OFF,
} from '../js/logic.js';
import { rate, nextSteps } from '../js/rating.js';
import { explainStep, describeMarks } from '../js/explain.js';
import { computeHint, checkMarksAgainstSolution } from '../js/hintstep.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyMarks(P) {
  return { edges: new Uint8Array(P.numEdges) };
}

/** Apply a hint's ghost edge targets directly to player marks, exactly as a human following hints would. */
function applyHintToMarks(marks, hint) {
  let changed = false;
  for (const x of hint.targets.segOn) if (marks.edges[x] !== 1) { marks.edges[x] = 1; changed = true; }
  for (const x of hint.targets.segOff) if (marks.edges[x] !== 2) { marks.edges[x] = 2; changed = true; }
  return changed;
}

test('computeHint detects wrong marks before giving a logical hint', () => {
  const P = compile({ name: 'b3', rows: 3, cols: 3, clues: [{ r: 0, c: 0, t: 'B' }, { r: 2, c: 2, t: 'B' }] });
  const sol = solve(P, { limit: 2 }).solutions[0];
  P.solution = encodeSolution(P, sol);

  const marks = emptyMarks(P);
  // Put a wrong segment into center cell (1,1)
  const wrongEdge = P.ed[(0 * 3 + 1) * 4 + 2]; // (0,1)-(1,1)
  marks.edges[wrongEdge] = 1;
  const h = computeHint(P, marks);
  assert.equal(h.kind, 'wrong');
  assert.deepEqual(h.wrongEdges, [wrongEdge]);
  assert.equal(checkMarksAgainstSolution(P, marks).total, 1);
});

test('computeHint reports stuck when no rule applies', () => {
  const P = compile({ name: 'ambig', rows: 4, cols: 4, clues: [{ r: 1, c: 1, t: 'W' }] });
  const h = computeHint(P, emptyMarks(P));
  assert.equal(h.kind, 'stuck');
  assert.ok(h.undecided.length > 0);
});

test('following hints from an empty board solves every Beginner and Medium puzzle', () => {
  const rng = mulberry32(2026);
  let testedBegMed = 0;
  let sawImagine = false;

  for (let attempt = 0; attempt < 1200 && testedBegMed < 35; attempt++) {
    const rows = 4 + (attempt % 3); // 4, 5, 6
    const cols = 4 + ((attempt / 3 | 0) % 3);
    const empty = compile({ name: 'e', rows, cols, clues: [] });
    const solRes = solve(empty, { limit: 1, maxNodes: 2000, rng });
    if (solRes.count === 0) continue;
    const loopSt = solRes.solutions[0];
    const candidates = [];
    for (let i = 0; i < empty.N; i++) {
      const dirs = [];
      for (let d = 0; d < 4; d++) {
        const x = empty.ed[i * 4 + d];
        if (x >= 0 && loopSt.e[x] === E_ON) dirs.push(d);
      }
      if (dirs.length !== 2) continue;
      const straight = ((dirs[0] ^ dirs[1]) & 1) === 0;
      const ext0 = empty.ed2[i * 4 + dirs[0]], ext1 = empty.ed2[i * 4 + dirs[1]];
      const s0 = ext0 >= 0 && loopSt.e[ext0] === E_ON;
      const s1 = ext1 >= 0 && loopSt.e[ext1] === E_ON;
      if (straight && !(s0 && s1)) candidates.push({ r: (i / cols) | 0, c: i % cols, t: 'W' });
      else if (!straight && s0 && s1) candidates.push({ r: (i / cols) | 0, c: i % cols, t: 'B' });
    }
    if (candidates.length < 3) continue;
    for (let k = candidates.length - 1; k > 0; k--) {
      const j = (rng() * (k + 1)) | 0;
      [candidates[k], candidates[j]] = [candidates[j], candidates[k]];
    }
    const take = Math.max(2, Math.floor(candidates.length * (0.6 + 0.4 * rng())));
    const P = compile({ name: `hp_${attempt}`, rows, cols, clues: candidates.slice(0, take) });
    const exact = solve(P, { limit: 2, maxNodes: 20000 });
    if (exact.exceeded || exact.count !== 1) continue;
    P.solution = encodeSolution(P, exact.solutions[0]);
    const r = rate(P);
    if (!r.solved || (r.tier !== 'Beginner' && r.tier !== 'Medium')) continue;
    testedBegMed++;

    // Now play from an empty board purely by following computeHint()!
    const marks = emptyMarks(P);
    let steps = 0;
    while (!isSolved(P, marks.edges) && steps < 500) {
      const h = computeHint(P, marks);
      assert.equal(h.kind, 'step', `Hint got ${h.kind} on ${r.tier} puzzle ${P.name} after ${steps} steps`);
      const first = h.hints[0];
      assert.ok(first.text && first.text.length > 10, `empty hint text for ${h.rule}`);
      if (h.rule === 'imagineLocal' || h.rule === 'imagineTrace' || h.rule === 'imagineChain') {
        sawImagine = true;
        assert.ok(first.text.includes('Imagine'), `imagine hint should explain hypothesis: ${first.text}`);
        assert.ok(first.text.includes('So '), `imagine hint should state verdict: ${first.text}`);
      }
      const changed = applyHintToMarks(marks, first);
      assert.equal(changed, true, `Hint made no markable change for ${h.rule} on ${P.name}`);
      steps++;
    }
    assert.equal(isSolved(P, marks.edges), true, `Following hints did not solve ${P.name} in 500 steps`);
    assert.equal(checkMarksAgainstSolution(P, marks).total, 0);
  }

  assert.ok(testedBegMed >= 25, `expected >= 25 Beginner/Medium puzzles tested, got ${testedBegMed}`);
});

test('imagine explanation describes the chain of consequences, not just the verdict', () => {
  // Construct a board where an imagine step fires: e.g. 5x5 with whites/blacks forcing a short chain
  const P = compile({
    name: 'img_test', rows: 5, cols: 5,
    clues: [
      { r: 0, c: 2, t: 'W' },
      { r: 2, c: 0, t: 'W' },
      { r: 2, c: 4, t: 'W' },
      { r: 4, c: 2, t: 'W' },
      { r: 2, c: 2, t: 'B' },
    ],
  });
  const st = { cell: new Int8Array(P.N), e: new Int8Array(P.numEdges), cycle: false };
  for (const i of P.clueCells) st.cell[i] = 2;
  // Advance past Beginner steps until imagine fires (or check rate steps)
  const r = rate(P);
  const imgStep = r.steps.find((s) => s.rule === 'imagineLocal' || s.rule === 'imagineTrace' || s.rule === 'imagineChain');
  if (imgStep) {
    const exp = explainStep(P, imgStep);
    assert.ok(exp.text.startsWith('Imagine '));
    assert.ok(exp.text.includes('So '));
    assert.ok(exp.text.length > 40);
  }
  // Also test describeMarks formatting
  const txt = describeMarks(P, { segOn: [0], segOff: [1] });
  assert.ok(txt.includes('draw '));
  assert.ok(txt.includes('cross out '));
});

test('faceCircle and faceShade explanations include shading text and Inside/Outside face overlays', () => {
  const P = compile({
    name: 'fp_exp', rows: 5, cols: 5,
    clues: [{ r: 0, c: 2, t: 'W' }, { r: 1, c: 1, t: 'W' }],
  });
  const st = { cell: new Int8Array(P.N), e: new Int8Array(P.numEdges), cycle: false };
  for (const i of P.clueCells) st.cell[i] = 2;
  // Advance past Beginner whiteStraight on (0,2)
  st.e[P.ed[(0 * 5 + 2) * 4 + 1]] = E_ON;
  st.e[P.ed[(0 * 5 + 2) * 4 + 3]] = E_ON;
  const step = nextSteps(P, st);
  assert.equal(step.rule, 'faceCircle');
  const exp = explainStep(P, { rule: step.rule, tier: step.tier, weight: step.weight, sets: step.firings[0].sets, info: step.firings[0].info }, st);
  assert.ok(exp.text.includes('Circle shading'), `unexpected text: ${exp.text}`);
  assert.ok(exp.faces && (exp.faces.in.length > 0 || exp.faces.out.length > 0));

  // Basic Auto-Shade border shading -> faceShade
  const P2 = compile({ name: 'fs_exp', rows: 5, cols: 5, clues: [] });
  const st2 = { cell: new Int8Array(P2.N), e: new Int8Array(P2.numEdges), cycle: false };
  st2.e[P2.ed[(0 * 5 + 1) * 4 + 1]] = E_ON;
  st2.e[P2.ed[(0 * 5 + 2) * 4 + 1]] = E_OFF;
  // Note: mark (0,2) and (0,1) as LOOP via bookkeeping, then faceShade should fire if no cheaper rule fires
  const exp2 = explainStep(P2, {
    rule: 'faceShade', tier: 'Medium', weight: 18,
    sets: [['e', P2.ed[(0 * 5 + 2) * 4 + 2], E_ON]],
    info: { edge: P2.ed[(0 * 5 + 2) * 4 + 2], val: E_ON, parA: 1, parB: 0, facesIn: [1], facesOut: [2] },
  }, st2);
  assert.ok(exp2.text.includes('Inside/outside shading'), `unexpected text: ${exp2.text}`);
  assert.ok(exp2.faces && exp2.faces.in.length === 1 && exp2.faces.out.length === 1);
});
