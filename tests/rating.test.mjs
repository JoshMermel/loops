import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, solve, initialState, isSolved, encodeSolution, E_ON, E_OFF, OFF, LOOP,
} from '../js/logic.js';
import { RULES, rate, solvedByRules, nextSteps, applySets, TIERS } from '../js/rating.js';
import { findFaceShade, findFaceCircle } from '../js/faceparity.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('RULES table structure matches expected schema', () => {
  assert.ok(RULES.length >= 20);
  for (const r of RULES) {
    assert.equal(r.name, r.id);
    assert.equal(r.cost, r.weight);
    assert.ok(TIERS.includes(r.tier), `bad tier for ${r.id}`);
    assert.ok(Number.isInteger(r.cost) && r.cost >= 1, `bad cost for ${r.id}`);
    assert.equal(typeof r.apply, 'function');
    assert.equal(typeof r.find, 'function');
  }
});

test('Beginner puzzle: 3x3 opposite black corners solves cleanly at Beginner', () => {
  const P = compile({ name: 'b3', rows: 3, cols: 3, clues: [{ r: 0, c: 0, t: 'B' }, { r: 2, c: 2, t: 'B' }] });
  const r = rate(P);
  assert.equal(r.solved, true);
  assert.equal(r.tier, 'Beginner');
  assert.ok(r.score > 0);
  assert.equal(isSolved(P, r.state.e), true);
  assert.equal(solvedByRules(P).solved, true);
});

test('threeWhites fires on three consecutive white circles', () => {
  // 4x5 board with 3 horizontal white circles in row 1 cols 1,2,3
  const P = compile({
    name: 'w3row', rows: 4, cols: 5,
    clues: [{ r: 1, c: 1, t: 'W' }, { r: 1, c: 2, t: 'W' }, { r: 1, c: 3, t: 'W' }],
  });
  const st = initialState(P);
  const step = nextSteps(P, st);
  assert.equal(step.rule, 'threeWhites');
  assert.equal(step.tier, 'Beginner');
  // Every firing edge for the three whites must be vertical ON, horizontal OFF
  const s2 = initialState(P);
  applySets(s2, step.firings[0].sets);
  for (const c of [1, 2, 3]) {
    const i = 1 * 5 + c;
    assert.equal(s2.e[P.ed[i * 4 + 0]], E_ON);
    assert.equal(s2.e[P.ed[i * 4 + 2]], E_ON);
    assert.equal(s2.e[P.ed[i * 4 + 1]], E_OFF);
    assert.equal(s2.e[P.ed[i * 4 + 3]], E_OFF);
  }
});

test('blackAdjacent fires on two touching black circles', () => {
  // 5x5 board with two black circles in the center (2,2) and (2,3)
  const P = compile({
    name: 'bb_mid', rows: 5, cols: 5,
    clues: [{ r: 2, c: 2, t: 'B' }, { r: 2, c: 3, t: 'B' }],
  });
  const st = initialState(P);
  // First step should be blackWall (since (2,3) is 1 cell from right edge c=4!) -> let's use 5x6 so neither is near edge
  const P2 = compile({
    name: 'bb_mid6', rows: 5, cols: 6,
    clues: [{ r: 2, c: 2, t: 'B' }, { r: 2, c: 3, t: 'B' }],
  });
  const st2 = initialState(P2);
  const step = nextSteps(P2, st2);
  assert.equal(step.rule, 'blackAdjacent');
  assert.equal(step.tier, 'Beginner');
});

test('whiteMustTurn fires when one end of a white circle continues straight', () => {
  const P = compile({
    name: 'w_turn', rows: 5, cols: 5,
    clues: [{ r: 2, c: 2, t: 'W' }],
  });
  const st = initialState(P);
  // Draw horizontal through (2,2) and extend straight left to (2,0)
  st.e[P.ed[(2 * 5 + 2) * 4 + 3]] = E_ON;
  st.e[P.ed[(2 * 5 + 2) * 4 + 1]] = E_ON;
  st.e[P.ed[(2 * 5 + 1) * 4 + 3]] = E_ON;
  const step = nextSteps(P, st);
  assert.equal(step.rule, 'whiteMustTurn');
  assert.deepEqual(step.firings[0].sets, [['e', P.ed[(2 * 5 + 3) * 4 + 1], E_OFF]]);
});

test('soundness fuzz: every rule deduction matches the unique exact solution on random unique boards', () => {
  const rng = mulberry32(777);
  let checkedUnique = 0;
  let solvedCount = 0;
  const rulesSeen = new Set();

  // Sample random valid loops on 4x4, 5x5, 6x6 and place valid circles on them
  for (let attempt = 0; attempt < 900 && checkedUnique < 45; attempt++) {
    const rows = 4 + (attempt % 3); // 4, 5, 6
    const cols = 4 + ((attempt / 3 | 0) % 3);
    const empty = compile({ name: 'e', rows, cols, clues: [] });
    const solRes = solve(empty, { limit: 1, maxNodes: 2000, rng });
    if (solRes.count === 0) continue;
    const loopSt = solRes.solutions[0];
    // Find all cells that can legally hold a W or B circle on this loop
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
    // Shuffle and take a random subset (65%..100%)
    for (let k = candidates.length - 1; k > 0; k--) {
      const j = (rng() * (k + 1)) | 0;
      [candidates[k], candidates[j]] = [candidates[j], candidates[k]];
    }
    const take = Math.max(2, Math.floor(candidates.length * (0.65 + 0.35 * rng())));
    const clues = candidates.slice(0, take);
    const P = compile({ name: `fuzz_${attempt}`, rows, cols, clues });
    const exact = solve(P, { limit: 2, maxNodes: 30000 });
    if (exact.exceeded || exact.count !== 1) continue;
    checkedUnique++;
    const truth = exact.solutions[0];

    // Step through the human rater and verify EVERY single deduction agrees with `truth`!
    const r = rate(P);
    for (const s of r.steps) {
      rulesSeen.add(s.rule);
      for (const [kind, idx, val] of s.sets) {
        if (kind === 'e') {
          assert.equal(val, truth.e[idx], `UNSOUND edge deduction by ${s.rule} on ${P.name} edge ${idx}: deduced ${val}, truth ${truth.e[idx]}`);
        } else {
          assert.equal(val, truth.cell[idx], `UNSOUND cell deduction by ${s.rule} on ${P.name} cell ${idx}: deduced ${val}, truth ${truth.cell[idx]}`);
        }
      }
    }
    if (r.solved) {
      solvedCount++;
      assert.equal(encodeSolution(P, r.state), encodeSolution(P, truth));
    }
  }

  assert.ok(checkedUnique >= 30, `expected >= 30 unique random boards, got ${checkedUnique}`);
  assert.ok(solvedCount >= checkedUnique * 0.85, `expected rules to solve most small unique boards, solved ${solvedCount}/${checkedUnique}`);
  assert.ok(rulesSeen.size >= 8, `expected diverse rules to fire, saw: ${[...rulesSeen].join(', ')}`);
});

test('stuck puzzle scores Expert with UNDETERMINED penalty', () => {
  // Ambiguous board (multiple solutions): human rules cannot solve it, must return Expert + penalty
  const P = compile({ name: 'ambig', rows: 4, cols: 4, clues: [{ r: 1, c: 1, t: 'W' }] });
  const r = rate(P);
  assert.equal(r.solved, false);
  assert.equal(r.rules, 'unsolved');
  assert.equal(r.tier, 'Expert');
  assert.ok(r.score >= 100);
});

test('faceShade only uses border-anchored lines/X while faceCircle adds white diagonals and black 3-to-1 corners', () => {
  // 5x5 board: border white at (0,2) forces faces (0,1) & (0,2) = IN; interior white at (1,1) flips (0,1)=IN -> (1,0)=OUT;
  // that puts OUT on both sides of left border edge (1,0)-(2,0) -> MUST be E_OFF!
  const P1 = compile({
    name: 'fp_w', rows: 5, cols: 5,
    clues: [{ r: 0, c: 2, t: 'W' }, { r: 1, c: 1, t: 'W' }],
  });
  const st1 = initialState(P1);
  // With no edges marked yet, faceShade (plain line/X shading) must find nothing
  assert.equal(findFaceShade(P1, st1).length, 0);
  const f1 = findFaceCircle(P1, st1);
  const eLeft12 = P1.ed[(1 * 5 + 0) * 4 + 2]; // (1,0)-(2,0)
  const hit1 = f1.find((x) => x.info.edge === eLeft12);
  assert.ok(hit1, 'expected white-circle diagonal parity to deduce left border edge (1,0)-(2,0)');
  assert.deepEqual(hit1.sets, [['e', eLeft12, E_OFF]]);
  assert.equal(hit1.info.anchored, true);

  // Plain border shading test: top border (0,1)-(0,2) ON -> face(0,1)=IN; top border (0,2)-(0,3) OFF -> face(0,2)=OUT;
  // so vertical edge (0,2)-(1,2) separates IN and OUT -> faceShade must force it E_ON!
  const Pshade = compile({ name: 'fp_shade', rows: 5, cols: 5, clues: [] });
  const stShade = initialState(Pshade);
  stShade.e[Pshade.ed[(0 * 5 + 1) * 4 + 1]] = E_ON;
  stShade.e[Pshade.ed[(0 * 5 + 2) * 4 + 1]] = E_OFF;
  const fShade = findFaceShade(Pshade, stShade);
  const eMid = Pshade.ed[(0 * 5 + 2) * 4 + 2]; // (0,2)-(1,2)
  const hitShade = fShade.find((x) => x.info.edge === eMid);
  assert.ok(hitShade, 'expected faceShade to force vertical edge between IN and OUT border squares');
  assert.deepEqual(hitShade.sets, [['e', eMid, E_ON]]);

  // Black-circle 3-to-1 law: 5x5 board with black circle at (2,2), surrounding faces NW=(1,1), NE=(1,2), SW=(2,1), SE=(2,2).
  // Suppose border lines/X's make NW=IN, SE=IN, NE=OUT -> 3-to-1 law forces SW=IN, so edge (2,1)-(2,2) between NW(IN) and SW(IN) MUST be E_OFF!
  const P2 = compile({
    name: 'fp_b', rows: 5, cols: 5,
    clues: [{ r: 2, c: 2, t: 'B' }],
  });
  const st2 = initialState(P2);
  // Anchor NW=(1,1)=IN, NE=(1,2)=OUT, SE=(2,2)=IN using known edges from border:
  // Top border (0,1)-(0,2) ON -> (0,1)=IN; (1,1)-(1,2) OFF -> (1,1)=IN (NW)
  // Top border (0,2)-(0,3) OFF -> (0,2)=OUT; (1,2)-(1,3) OFF -> (1,2)=OUT (NE)
  // Right border (2,4)-(3,4) ON -> (2,3)=IN; (2,3)-(3,3) OFF -> (2,2)=IN (SE)
  st2.e[P2.ed[(0 * 5 + 1) * 4 + 1]] = E_ON;
  st2.e[P2.ed[(1 * 5 + 1) * 4 + 1]] = E_OFF;
  st2.e[P2.ed[(0 * 5 + 2) * 4 + 1]] = E_OFF;
  st2.e[P2.ed[(1 * 5 + 2) * 4 + 1]] = E_OFF;
  st2.e[P2.ed[(2 * 5 + 4) * 4 + 2]] = E_ON;
  st2.e[P2.ed[(2 * 5 + 3) * 4 + 2]] = E_OFF;
  const f2 = findFaceCircle(P2, st2);
  const eLeftB = P2.ed[(2 * 5 + 2) * 4 + 3]; // (2,1)-(2,2)
  const hit2 = f2.find((x) => x.info.edge === eLeftB);
  assert.ok(hit2, 'expected black-circle 3-to-1 rule to force SW=IN and cross out (2,1)-(2,2)');
  assert.deepEqual(hit2.sets, [['e', eLeftB, E_OFF]]);
});

test('difficulty tier assignments match the calibrated rule ladder', () => {
  const tier = (id) => RULES.find((r) => r.id === id)?.tier;
  assert.equal(tier('threeWhites'), 'Beginner');
  assert.equal(tier('whiteBothStraight'), 'Medium');
  assert.equal(tier('closingCell'), 'Medium');
  assert.equal(tier('samePathExits'), 'Medium');
  assert.equal(tier('twoWhitesStraight'), 'Medium');
  assert.equal(tier('whiteNoTurnAxis'), 'Medium');
  assert.equal(tier('faceShade'), 'Medium');
  assert.equal(tier('imagineLocal'), 'Medium');
  assert.equal(tier('faceCircle'), 'Hard');
  assert.equal(tier('twoEndsJoin'), 'Hard');
  assert.equal(tier('chokepoint'), 'Hard');
  assert.equal(tier('parityPocket'), 'Hard');
  assert.equal(tier('imagineTrace'), 'Hard');
  assert.equal(tier('imagineChain'), 'Expert');
  assert.equal(tier('tryEdge'), 'Expert');
});
