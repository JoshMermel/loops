import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, parseCsv, solve, encodeSolution, isSolved, E_ON, E_OFF,
} from '../js/logic.js';
import { rate, nextSteps } from '../js/rating.js';
import { explainStep, describeMarks, targetsOf } from '../js/explain.js';
import { computeHint, advanceHint, checkMarksAgainstSolution } from '../js/hintstep.js';

const root = fileURLToPath(new URL('..', import.meta.url));

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
  // Use real puzzles from data/armory.csv that genuinely fire imagine rules
  const armory = parseCsv(fs.readFileSync(path.join(root, 'data', 'armory.csv'), 'utf8'));
  let checkedImagine = 0;
  for (const raw of armory) {
    if (!raw.rules.startsWith('imagine')) continue;
    const P = compile({ ...raw });
    const r = rate(P);
    const imgStep = r.steps.find((s) => s.rule === 'imagineLocal' || s.rule === 'imagineTrace' || s.rule === 'imagineChain');
    assert.ok(imgStep, `expected an imagine step on ${raw.name} (${raw.rules})`);
    const exp = explainStep(P, imgStep);
    assert.ok(exp.text.startsWith('Imagine '), `unexpected imagine text on ${raw.name}: ${exp.text}`);
    assert.ok(exp.text.includes('So '), `missing verdict on ${raw.name}: ${exp.text}`);
    assert.ok(exp.text.length > 40);
    assert.ok(!/\b(faceShade|faceCircle|whiteStraight|blackWall|forcedExits)\b/.test(exp.text), `leaked rule id: ${exp.text}`);
    checkedImagine++;
  }
  assert.ok(checkedImagine >= 3, `expected >= 3 imagine puzzles in armory, checked ${checkedImagine}`);

  // Also test targetsOf deduplication and describeMarks formatting
  const P0 = compile({ name: 'fmt', rows: 4, cols: 4, clues: [{ r: 1, c: 1, t: 'G' }, { r: 2, c: 2, t: 'G' }] });
  assert.deepEqual(targetsOf([
    ['e', 0, E_ON], ['e', 0, E_ON], ['e', 1, E_OFF], ['e', 1, E_OFF],
    ['g', 5, 1], ['g', 5, 1], ['g', 10, 2],
  ]), {
    segOn: [0], segOff: [1], grayWhite: [5], grayBlack: [10],
  });
  const txt = describeMarks(P0, { segOn: [0], segOff: [1], grayWhite: [5], grayBlack: [10] });
  assert.ok(txt.includes('draw '));
  assert.ok(txt.includes('cross out '));
  assert.ok(txt.includes('label B2 white'));
  assert.ok(txt.includes('label C3 black'));
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

test('advanceHint implements two-press progression, multi-firing cycling, dismiss recovery, and immediate wrong/stuck', () => {
  let calls = 0;
  const twoFirings = () => {
    calls++;
    return { kind: 'step', rule: 'blackWall', tier: 'Beginner', weight: 2, hints: [{ text: 'A' }, { text: 'B' }] };
  };

  // Press 1 -> stage 1 on firing 0
  let h = advanceHint(null, twoFirings);
  assert.equal(calls, 1);
  assert.equal(h.stage, 1);
  assert.equal(h.index, 0);
  assert.equal(h.visible, true);

  // Dismiss toast -> re-pressing restores stage 1 without advancing or recomputing
  h = advanceHint({ ...h, visible: false }, twoFirings);
  assert.equal(calls, 1);
  assert.equal(h.stage, 1);
  assert.equal(h.index, 0);
  assert.equal(h.visible, true);

  // Press 2 while visible -> stage 2 (full deduction) on firing 0
  h = advanceHint(h, twoFirings);
  assert.equal(h.stage, 2);
  assert.equal(h.index, 0);

  // Press 3 -> firing 1 resets to stage 1 (nudge first on new spot)
  h = advanceHint(h, twoFirings);
  assert.equal(h.stage, 1);
  assert.equal(h.index, 1);

  // Press 4 -> stage 2 on firing 1; Press 5 -> wraps to firing 0 stage 1
  h = advanceHint(h, twoFirings);
  assert.equal(h.stage, 2);
  assert.equal(h.index, 1);
  h = advanceHint(h, twoFirings);
  assert.equal(h.stage, 1);
  assert.equal(h.index, 0);

  // Single firing stays idempotent at stage 2
  const oneFiring = () => ({ kind: 'step', rule: 'deadEnd', tier: 'Beginner', weight: 4, hints: [{ text: 'Only' }] });
  let s = advanceHint(null, oneFiring);
  assert.equal(s.stage, 1);
  s = advanceHint(s, oneFiring);
  assert.equal(s.stage, 2);
  s = advanceHint(s, oneFiring);
  assert.equal(s.stage, 2);
  assert.equal(s.index, 0);

  // Full option jumps directly to stage 2 and stays at stage 2 while cycling
  const direct = advanceHint(null, twoFirings, { full: true });
  assert.equal(direct.stage, 2);
  const directNext = advanceHint(direct, twoFirings, { full: true });
  assert.equal(directNext.index, 1);
  assert.equal(directNext.stage, 2);

  // Dismissing at stage 2 restores stage 2 on the same firing (does not skip to next firing)
  const restored2 = advanceHint({ ...direct, visible: false }, twoFirings);
  assert.equal(restored2.stage, 2);
  assert.equal(restored2.index, 0);
  assert.equal(restored2.visible, true);

  // { full: true } on a dismissed stage 1 hint jumps to stage 2
  const jumped = advanceHint({ ...h, stage: 1, visible: false }, twoFirings, { full: true });
  assert.equal(jumped.stage, 2);
  assert.equal(jumped.visible, true);

  // Wrong / stuck always show immediately at stage 2 and restore cleanly after dismiss
  const wrong = advanceHint(null, () => ({ kind: 'wrong', wrongEdges: [3], total: 1 }));
  assert.equal(wrong.stage, 2);
  assert.equal(wrong.visible, true);
  assert.equal(advanceHint({ ...wrong, visible: false }, twoFirings).visible, true);
  const stuck = advanceHint(null, () => ({ kind: 'stuck', undecided: [0, 1] }));
  assert.equal(stuck.stage, 2);
  assert.equal(stuck.visible, true);
});

test('describeChainStep handles samePathExits & closingCell, and non-armory / unanchored rules explain cleanly', () => {
  const P = compile({ name: 'tr', rows: 5, cols: 5, clues: [] });
  const e0 = P.ed[(1 * 5 + 1) * 4 + 1];
  const e1 = P.ed[(2 * 5 + 2) * 4 + 2];

  // tryEdge trace containing both samePathExits and closingCell must not throw or emit "1–1"
  const te = explainStep(P, {
    rule: 'tryEdge', tier: 'Expert', weight: 90,
    sets: [['e', e0, E_OFF]],
    info: {
      edge: e0, hyp: E_ON, steps: 2,
      trace: [
        { rule: 'closingCell', info: { cell: 1 * 5 + 2, a: 0 * 5 + 2, b: 1 * 5 + 3 }, sets: [] },
        { rule: 'samePathExits', info: { cell: 2 * 5 + 2, a: 2 * 5 + 1, b: 1 * 5 + 2, edge: e1 }, sets: [['e', e1, E_ON]] },
      ],
    },
  });
  assert.ok(te.text.includes('C2') && te.text.includes('C3–C4'), `unexpected tryEdge trace text: ${te.text}`);
  assert.equal(te.text.includes('1–1'), false, `garbled edge name in trace: ${te.text}`);

  // All 3 rules absent from armory.csv produce valid explanations, nudges, and nudgeRoles
  for (const step of [
    { rule: 'samePathExits', tier: 'Medium', weight: 12, sets: [['e', e1, E_ON]], info: { cell: 2 * 5 + 2, a: 2 * 5 + 1, b: 1 * 5 + 2, edge: e1 } },
    { rule: 'blackBlockedTarget', tier: 'Medium', weight: 14, sets: [['e', e0, E_ON]], info: { cell: 2 * 5 + 2, target: 2 * 5 + 0, dir: 1, reason: 'whiteWall' } },
    { rule: 'crossingParity', tier: 'Hard', weight: 32, sets: [['e', e0, E_ON]], info: { edge: e0, val: E_ON, on: 1, area: [0, 1, 5, 6] } },
  ]) {
    const exp = explainStep(P, step);
    assert.ok(exp.text.length > 20 && exp.nudge.length > 15);
    assert.ok(Object.values(exp.nudgeRoles).some((arr) => arr.length > 0), `empty nudgeRoles for ${step.rule}`);
  }

  // Unanchored faceCircle with empty clues must not mention "highlighted circles"
  const fc = explainStep(P, {
    rule: 'faceCircle', tier: 'Hard', weight: 32,
    sets: [['e', e0, E_OFF]],
    info: { edge: e0, val: E_OFF, fA: 0, fB: 1, parA: 1, parB: 1, anchored: false, clues: [], chains: [], hops: 1, facesIn: [0, 1], facesOut: [] },
  });
  assert.equal(fc.nudge.includes('highlighted circles'), false, `unexpected circle mention: ${fc.nudge}`);
});

test('computeHint catches wrong Auto-X caused by wrong manual shade and solution-less contradictions', () => {
  const P = compile({ name: 'b3', rows: 3, cols: 3, clues: [{ r: 0, c: 0, t: 'B' }, { r: 2, c: 2, t: 'B' }] });
  const sol = solve(P, { limit: 2 }).solutions[0];
  P.solution = encodeSolution(P, sol);

  // Wrong auto-X on a true solution edge (e.g. triggered by wrong manual Outside shade with Auto-X + Auto-Shade)
  const marks = { edges: new Uint8Array(P.numEdges), autoE: new Uint8Array(P.numEdges) };
  const trueEdge = P.ed[0 * 4 + 1]; // (0,0)-(0,1) is ON in solution
  marks.edges[trueEdge] = 2;
  marks.autoE[trueEdge] = 1;
  const h = computeHint(P, marks);
  assert.equal(h.kind, 'wrong');
  assert.equal(h.fromShade, true);
  assert.deepEqual(h.wrongEdges, [trueEdge]);

  // Solution-less puzzle with contradictory marks reports kind: 'wrong', contradiction: true
  const PnoSol = compile({ name: 'nosol', rows: 3, cols: 3, clues: [{ r: 0, c: 0, t: 'B' }] });
  const badMarks = { edges: new Uint8Array(PnoSol.numEdges) };
  badMarks.edges[PnoSol.ed[0 * 4 + 1]] = 2; // cross out right exit of corner black circle -> impossible
  const h2 = computeHint(PnoSol, badMarks);
  assert.equal(h2.kind, 'wrong');
  assert.equal(h2.contradiction, true);

  // Solution-less puzzle with topological odd-open-end pocket contradiction (propagate still returns true!)
  const Ptopo = compile({ name: 'topo_contra', rows: 6, cols: 6, clues: [{ r: 2, c: 4, t: 'W' }, { r: 4, c: 4, t: 'W' }] });
  const mTopo = { edges: new Uint8Array(Ptopo.numEdges) };
  mTopo.edges[Ptopo.ed[(1 * 6 + 1) * 4 + 2]] = 1; // (1,1)-(2,1) ON
  mTopo.edges[Ptopo.ed[(0 * 6 + 1) * 4 + 1]] = 2; // seal top-left 2x2 pocket with 1 open end at (1,1)
  mTopo.edges[Ptopo.ed[(1 * 6 + 1) * 4 + 1]] = 2;
  mTopo.edges[Ptopo.ed[(1 * 6 + 0) * 4 + 2]] = 2;
  const hTopo = computeHint(Ptopo, mTopo);
  assert.equal(hTopo.kind, 'wrong');
  assert.equal(hTopo.contradiction, true);

  // Corrupted P.solution of length N must not wrongly flag valid player marks
  const Pcorrupt = compile({ name: 'corrupt', rows: 3, cols: 3, clues: [{ r: 0, c: 0, t: 'B' }, { r: 2, c: 2, t: 'B' }], solution: 'z'.repeat(9) });
  const mValid = { edges: new Uint8Array(Pcorrupt.numEdges) };
  mValid.edges[Pcorrupt.ed[0 * 4 + 1]] = 1;
  assert.equal(checkMarksAgainstSolution(Pcorrupt, mValid).total, 0);
  assert.equal(computeHint(Pcorrupt, mValid).kind, 'step');
});

test('every armory rule produces a non-spoiling nudge and at least one nudgeRoles highlight (with imagine chain replay)', () => {
  const armory = parseCsv(fs.readFileSync(path.join(root, 'data', 'armory.csv'), 'utf8'));
  const seenRules = new Set();
  let sawImagineChain = false;
  for (const raw of armory) {
    const P = compile({ ...raw });
    const r = rate(P);
    const marks = { edges: new Uint8Array(P.numEdges) };
    // Also verify real computeHint on armory initial/live steps and imagine chain replay
    for (const s of r.steps) {
      if (s.weight <= 1) continue; // skip free bookkeeping rules
      const exp = explainStep(P, s);
      seenRules.add(s.rule);
      assert.ok(exp.nudge && exp.nudge.length > 15, `missing nudge for ${s.rule}`);
      assert.notEqual(exp.nudge, exp.text, `nudge should not duplicate full text for ${s.rule}`);
      const cellCount = Object.values(exp.nudgeRoles).reduce((acc, arr) => acc + arr.length, 0);
      const faceCount = exp.faces ? ((exp.faces.focus?.length || 0) + (exp.faces.clue?.length || 0)) : 0;
      assert.ok(cellCount + faceCount > 0, `nudge must highlight at least one cell or face for ${s.rule}`);
      assert.equal(exp.nudgeRoles.problem.length, 0, `nudgeRoles.problem should be empty for ${s.rule}`);
      assert.equal(exp.nudgeRoles.exit.length, 0, `nudgeRoles.exit should be empty for ${s.rule}`);
      assert.ok(!/\b(So draw|So cross out|must go two cells|must use)\b/.test(exp.nudge), `nudge leaked answer for ${s.rule}: ${exp.nudge}`);
    }
    if (raw.rules.startsWith('imagine')) {
      for (let step = 0; step < 200 && !isSolved(P, marks.edges); step++) {
        const h = computeHint(P, marks);
        if (h.kind !== 'step') break;
        if (h.rule.startsWith('imagine') && h.hints[0].chain.length > 0) { sawImagineChain = true; break; }
        applyHintToMarks(marks, h.hints[0]);
      }
    }
  }
  assert.ok(seenRules.size >= 25, `expected >= 25 rules covered across armory, saw ${seenRules.size}`);
  assert.equal(sawImagineChain, true, 'expected at least one armory imagine step to populate dashed chain edges');
});

test('gray pearl hints: end-to-end solving, wrong manual gray label detection, and nudges', () => {
  // 1. Wrong manual gray label is detected before logical hints
  const P1 = compile({
    name: 'g_wrong', rows: 4, cols: 4,
    clues: [{ r: 0, c: 0, t: 'G' }, { r: 3, c: 3, t: 'B' }, { r: 0, c: 2, t: 'W' }, { r: 2, c: 0, t: 'W' }],
  });
  const sol1 = solve(P1, { limit: 2 }).solutions[0];
  P1.solution = encodeSolution(P1, sol1);
  // Corner (0,0) must be Black (2) in solution; label it White (1) manually
  const m1 = { edges: new Uint8Array(P1.numEdges), grays: new Uint8Array(P1.grays.length), autoG: new Uint8Array(P1.grays.length) };
  m1.grays[0] = 1;
  const chk = checkMarksAgainstSolution(P1, m1);
  assert.equal(chk.total, 1);
  assert.deepEqual(chk.wrongClues, [0]);
  const hWrong = computeHint(P1, m1);
  assert.equal(hWrong.kind, 'wrong');
  assert.deepEqual(hWrong.wrongClues, [0]);

  // If marked autoG=1 without wrong edges, checkMarksAgainstSolution skips autoG (manual labels only)
  m1.autoG[0] = 1;
  assert.equal(checkMarksAgainstSolution(P1, m1).wrongClues.length, 0);

  // 2. Explanations and non-spoiling nudges for gray rules and gray imagine hypothesis
  const Pg = compile({
    name: 'g_exp', rows: 5, cols: 5,
    clues: [{ r: 0, c: 0, t: 'G' }, { r: 2, c: 2, t: 'G' }],
  });
  for (const step of [
    { rule: 'grayMustBeBlack', tier: 'Beginner', weight: 2, sets: [['g', 0, 2]], info: { cell: 0, reason: 'corner' } },
    { rule: 'grayMustBeWhite', tier: 'Beginner', weight: 3, sets: [['g', 12, 1]], info: { cell: 12, axis: 'v' } },
    { rule: 'grayWhiteNoTurn', tier: 'Medium', weight: 12, sets: [['g', 12, 2]], info: { cell: 12 } },
    {
      rule: 'imagineLocal', tier: 'Medium', weight: 20, sets: [['g', 12, 2]],
      info: { grayCell: 12, hyp: 1, deduce: 2, steps: [], contra: { kind: 'grayBroken', cell: 12 } },
    },
  ]) {
    const exp = explainStep(Pg, step);
    assert.ok(exp.text.length > 20, `short text for ${step.rule}: ${exp.text}`);
    assert.ok(exp.nudge && exp.nudge.length > 15, `short nudge for ${step.rule}: ${exp.nudge}`);
    assert.ok(Object.values(exp.nudgeRoles).some((arr) => arr.length > 0), `empty nudgeRoles for ${step.rule}`);
    assert.ok(!exp.nudge.includes('So label'), `nudge leaked answer for ${step.rule}: ${exp.nudge}`);
  }

  // 3. Follow hints end-to-end on random unique mixed-gray boards
  const rng = mulberry32(4242);
  let solvedGray = 0;
  for (let attempt = 0; attempt < 400 && solvedGray < 15; attempt++) {
    const rows = 4 + (attempt % 2);
    const cols = 4 + ((attempt >> 1) % 2);
    const empty = compile({ name: 'e', rows, cols, clues: [] });
    const solRes = solve(empty, { limit: 1, maxNodes: 2000, rng });
    if (solRes.count === 0) continue;
    const loopSt = solRes.solutions[0];
    const clues = [];
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
      if (straight && !(s0 && s1)) clues.push({ r: (i / cols) | 0, c: i % cols, t: rng() < 0.55 ? 'G' : 'W' });
      else if (!straight && s0 && s1) clues.push({ r: (i / cols) | 0, c: i % cols, t: rng() < 0.55 ? 'G' : 'B' });
    }
    if (!clues.some((c) => c.t === 'G')) continue;
    const P = compile({ name: `gh_${attempt}`, rows, cols, clues });
    const exact = solve(P, { limit: 2, maxNodes: 20000 });
    if (exact.exceeded || exact.count !== 1) continue;
    const r = rate(P);
    if (!r.solved) continue;
    P.solution = encodeSolution(P, exact.solutions[0]);

    const marks = { edges: new Uint8Array(P.numEdges), grays: new Uint8Array(P.grays.length), autoG: new Uint8Array(P.grays.length) };
    let steps = 0;
    while (!isSolved(P, marks.edges) && steps < 400) {
      const h = computeHint(P, marks);
      assert.equal(h.kind, 'step', `got ${h.kind} on ${P.name} at step ${steps}`);
      const t = h.hints[0].targets;
      let changed = applyHintToMarks(marks, h.hints[0]);
      for (const cell of t.grayWhite) {
        const k = P.grayAt[cell];
        if (k >= 0 && marks.grays[k] !== 1) { marks.grays[k] = 1; changed = true; }
      }
      for (const cell of t.grayBlack) {
        const k = P.grayAt[cell];
        if (k >= 0 && marks.grays[k] !== 2) { marks.grays[k] = 2; changed = true; }
      }
      assert.equal(changed, true, `hint made no change for ${h.rule} on ${P.name}`);
      steps++;
    }
    assert.equal(isSolved(P, marks.edges), true, `did not solve ${P.name}`);
    assert.equal(checkMarksAgainstSolution(P, marks).total, 0);
    solvedGray++;
  }
  assert.ok(solvedGray >= 12, `expected >= 12 solved gray hint runs, got ${solvedGray}`);
});

test('fullBoard & given edges/walls hints: end-to-end solving, checkerPocket explanations, and given-edge safety', () => {
  // 1. checkerPocket rect and hyp explanations + non-spoiling nudges
  const Pc = compile({
    name: 'fb_exp', rows: 4, cols: 6, fullBoard: true, clues: [],
    givens: [{ r: 0, c: 2, dir: 'H', v: 0 }],
  });
  const e0 = Pc.ed[(0 * 6 + 0) * 4 + 2], e1 = Pc.ed[(0 * 6 + 1) * 4 + 2], e2 = Pc.ed[(0 * 6 + 2) * 4 + 2];
  const expRect = explainStep(Pc, {
    rule: 'checkerPocket', tier: 'Medium', weight: 18,
    sets: [['e', e0, E_ON], ['e', e2, E_ON], ['e', e1, E_OFF]],
    info: { mode: 'rect', area: [0, 1, 2], needLight: 4, needDark: 2, diff: 2 },
  });
  assert.ok(expRect.text.includes('Checkerboard parity'));
  assert.ok(expRect.nudge.length > 15 && !expRect.nudge.includes('cross out'));
  assert.ok(expRect.nudgeRoles.area.length === 3);

  const expHyp = explainStep(Pc, {
    rule: 'checkerParity', tier: 'Hard', weight: 36,
    sets: [['e', e1, E_OFF]],
    info: { mode: 'hyp', edge: e1, hyp: E_ON, area: [0, 1, 2], needLight: 4, needDark: 2 },
  });
  assert.ok(expHyp.text.includes('checkerboard counts'));
  assert.ok(expHyp.nudgeRoles.focus.length === 2);

  // 2. Follow computeHint() from initial givens to solve unique full-board no-circle puzzles
  const rng = mulberry32(5511);
  let solvedFB = 0;
  for (let attempt = 0; attempt < 250 && solvedFB < 10; attempt++) {
    const empty = compile({ name: 'ef', rows: 4, cols: 6, clues: [], fullBoard: true });
    const solRes = solve(empty, { limit: 1, maxNodes: 3000, rng });
    if (solRes.count === 0) continue;
    const truth = solRes.solutions[0];
    const givens = [];
    for (let x = 0; x < empty.numEdges; x++) {
      if (empty.edgeA[x] < 0) continue;
      if (rng() < 0.32) {
        const i = x >> 1;
        givens.push({ r: (i / 6) | 0, c: i % 6, dir: (x & 1) ? 'V' : 'H', v: truth.e[x] === E_ON ? 1 : 0 });
      }
    }
    const P = compile({ name: `fbh_${attempt}`, rows: 4, cols: 6, clues: [], fullBoard: true, givens });
    const exact = solve(P, { limit: 2, maxNodes: 20000 });
    if (exact.exceeded || exact.count !== 1) continue;
    const r = rate(P);
    if (!r.solved) continue;
    P.solution = encodeSolution(P, exact.solutions[0]);

    const marks = { edges: new Uint8Array(P.numEdges) };
    for (const gv of P.givens) marks.edges[gv.edge] = gv.v ? 1 : 2;
    let steps = 0;
    while (!isSolved(P, marks.edges) && steps < 300) {
      const h = computeHint(P, marks);
      assert.equal(h.kind, 'step', `got ${h.kind} on ${P.name} at step ${steps}`);
      assert.equal(applyHintToMarks(marks, h.hints[0]), true);
      steps++;
    }
    assert.equal(isSolved(P, marks.edges), true);
    assert.equal(checkMarksAgainstSolution(P, marks).total, 0);
    solvedFB++;
  }
  assert.ok(solvedFB >= 8, `expected >= 8 solved fullBoard hint runs, got ${solvedFB}`);
});

test('Slitherlink & hybrid hints: end-to-end solving, explanations, nudges, and wrong-mark detection', () => {
  const rng = mulberry32(7331);
  let solvedPure = 0, solvedHybrid = 0;
  for (let attempt = 0; attempt < 350 && (solvedPure < 6 || solvedHybrid < 6); attempt++) {
    const hybrid = attempt % 2 === 1;
    if (!hybrid && solvedPure >= 6) continue;
    if (hybrid && solvedHybrid >= 6) continue;
    const rows = 4, cols = 5;
    const empty = compile({ name: 'sle', rows, cols, clues: [] });
    const solRes = solve(empty, { limit: 1, maxNodes: 3000, rng });
    if (!solRes.count) continue;
    const truth = solRes.solutions[0];
    const slither = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const f4 = (r * (cols - 1) + c) * 4;
        let cnt = 0;
        for (let d = 0; d < 4; d++) if (truth.e[empty.faceEdges[f4 + d]] === E_ON) cnt++;
        if (cnt <= 3 && rng() < (hybrid ? 0.45 : 0.72)) slither.push({ r, c, n: cnt });
      }
    }
    if (!slither.length) continue;
    const clues = [];
    if (hybrid) {
      for (let i = 0; i < empty.N; i++) {
        const dirs = [];
        for (let d = 0; d < 4; d++) { const x = empty.ed[i * 4 + d]; if (x >= 0 && truth.e[x] === E_ON) dirs.push(d); }
        if (dirs.length !== 2) continue;
        const straight = ((dirs[0] ^ dirs[1]) & 1) === 0;
        const ext0 = empty.ed2[i * 4 + dirs[0]], ext1 = empty.ed2[i * 4 + dirs[1]];
        const s0 = ext0 >= 0 && truth.e[ext0] === E_ON, s1 = ext1 >= 0 && truth.e[ext1] === E_ON;
        if (straight && !(s0 && s1) && rng() < 0.35) clues.push({ r: (i / cols) | 0, c: i % cols, t: 'W' });
        else if (!straight && s0 && s1 && rng() < 0.35) clues.push({ r: (i / cols) | 0, c: i % cols, t: 'B' });
      }
      if (!clues.length) continue;
    }
    const P = compile({ name: `slh_${attempt}`, rows, cols, clues, slither });
    const exact = solve(P, { limit: 2, maxNodes: 20000 });
    if (exact.exceeded || exact.count !== 1) continue;
    const r = rate(P);
    if (!r.solved) continue;
    P.solution = encodeSolution(P, exact.solutions[0]);

    const marks = { edges: new Uint8Array(P.numEdges) };
    let steps = 0;
    while (!isSolved(P, marks.edges) && steps < 300) {
      const h = computeHint(P, marks);
      assert.equal(h.kind, 'step', `got ${h.kind} on ${P.name} at step ${steps}`);
      const h0 = h.hints[0];
      assert.ok(h0.text && h0.text.length > 15, `missing text for ${h.rule}`);
      assert.ok(h0.nudge && h0.nudge.length > 12, `missing nudge for ${h.rule}`);
      const hasHighlight = Object.values(h0.nudgeRoles).some((a) => a.length > 0)
        || (h0.faces && (h0.faces.focus?.length > 0 || h0.faces.clue?.length > 0));
      assert.equal(hasHighlight, true, `missing nudge highlight for ${h.rule}`);
      assert.equal(applyHintToMarks(marks, h0), true);
      steps++;
    }
    assert.equal(isSolved(P, marks.edges), true);
    if (hybrid) solvedHybrid++; else solvedPure++;
  }
  assert.ok(solvedPure >= 5, `expected >= 5 solved pure Slitherlink hint runs, got ${solvedPure}`);
  assert.ok(solvedHybrid >= 5, `expected >= 5 solved Slitherlink+Masyu hint runs, got ${solvedHybrid}`);

  // Direct wrong-mark detection, slitherBroken over-count text, and singular pluralization check
  const Pwrong = compile({
    name: 'sl_wrong', rows: 4, cols: 4, clues: [],
    slither: [{ r: 0, c: 0, n: 0 }, { r: 1, c: 1, n: 3 }, { r: 2, c: 2, n: 1 }],
  });
  const mBad = { edges: new Uint8Array(Pwrong.numEdges) };
  mBad.edges[Pwrong.faceEdges[0 * 4 + 0]] = 1; // violates 0 square!
  const hw = computeHint(Pwrong, mBad);
  assert.equal(hw.kind, 'wrong');
  assert.equal(hw.contradiction, true);

  const expOver = explainStep(Pwrong, {
    rule: 'imagineLocal', tier: 'Medium', weight: 22,
    sets: [['e', Pwrong.faceEdges[0], E_OFF]],
    info: { edge: Pwrong.faceEdges[0], hyp: E_ON, deduce: E_OFF, steps: [], broke: { kind: 'slitherBroken', face: 0, n: 0, over: true } },
  });
  assert.ok(expOver.text.includes('too many segments'), `expected over-count text, got: ${expOver.text}`);
  assert.ok(expOver.faces && expOver.faces.clue.includes(0));

  const expSing = explainStep(Pwrong, {
    rule: 'imagineLocal', tier: 'Medium', weight: 24,
    sets: [['e', Pwrong.faceEdges[0], E_OFF]],
    info: {
      edge: Pwrong.faceEdges[0], hyp: E_ON, deduce: E_OFF,
      steps: [{ rule: 'slitherCount', info: { face: 8, n: 1, mode: 'done' }, sets: [] }],
      broke: { kind: 'slitherBroken', face: 4, n: 1, over: false },
    },
  });
  assert.equal(expSing.text.includes('1 segments'), false, `pluralization bug: ${expSing.text}`);
});
