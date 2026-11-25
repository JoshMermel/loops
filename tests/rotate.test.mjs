import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compile, parseCsv, decodeSolution, encodeSolution, solve, isSolved, puzzleHash } from '../js/logic.js';
import { facesFromSolvedLoop, numFacesOf, reconcileAutoX, reconcileAutoShade } from '../js/marks.js';
import { computeHint } from '../js/hintstep.js';
import { rotatePuzzleCW, rotateMarksCW, unrotateMarksCW, chooseLayout } from '../js/rotate.js';

const loadFirst = (file) => {
  const text = fs.readFileSync(new URL(`../data/${file}`, import.meta.url), 'utf8');
  return compile(parseCsv(text)[0]);
};

test('rotatePuzzleCW produces a valid rotated puzzle with matching solution and stable hashKey', () => {
  const baseP = loadFirst('12x20-medium.csv');
  const rotP = rotatePuzzleCW(baseP);

  assert.equal(rotP.rows, baseP.cols);
  assert.equal(rotP.cols, baseP.rows);
  assert.equal(rotP.clues.length, baseP.clues.length);
  assert.equal(puzzleHash(rotP), puzzleHash(baseP));

  const sol = decodeSolution(rotP, rotP.solution);
  assert.equal(isSolved(rotP, sol.e), true);

  // Rotating 4 times returns identical clues and solution
  let cur = baseP;
  for (let k = 0; k < 4; k++) cur = rotatePuzzleCW(cur);
  assert.equal(cur.rows, baseP.rows);
  assert.equal(cur.cols, baseP.cols);
  assert.equal(cur.solution, baseP.solution);
  assert.deepEqual(
    [...cur.clues].sort((a, b) => a.r - b.r || a.c - b.c),
    [...baseP.clues].sort((a, b) => a.r - b.r || a.c - b.c),
  );
});

test('rotateMarksCW and unrotateMarksCW round-trip edges, autoE, faces, and autoF exactly', () => {
  const baseP = loadFirst('bonus-skyscraper.csv'); // 20x6
  const rotP = rotatePuzzleCW(baseP);

  const solBase = decodeSolution(baseP, baseP.solution);
  const facesBase = facesFromSolvedLoop(baseP, solBase.e);
  const m = {
    edges: Uint8Array.from(solBase.e, (v, x) => (baseP.edgeA[x] < 0 ? 0 : v === 1 ? 1 : 2)),
    autoE: new Uint8Array(baseP.numEdges),
    faces: facesBase.slice(),
    autoF: new Uint8Array(numFacesOf(baseP)),
  };
  for (let x = 0; x < baseP.numEdges; x++) if (baseP.edgeA[x] >= 0 && x % 7 === 0) m.autoE[x] = 1;
  for (let f = 0; f < m.faces.length; f++) if (f % 5 === 0) m.autoF[f] = 1;

  const rotM = rotateMarksCW(baseP, rotP, m);
  assert.equal(isSolved(rotP, rotM.edges), true);
  // Dual face Inside/Outside coloring must match exact rotated solution faces
  const expectedRotFaces = facesFromSolvedLoop(rotP, rotM.edges);
  assert.deepEqual(rotM.faces, expectedRotFaces);

  // Round-trip back to canonical
  const backM = unrotateMarksCW(baseP, rotP, rotM);
  assert.deepEqual(backM.edges, m.edges);
  assert.deepEqual(backM.autoE, m.autoE);
  assert.deepEqual(backM.faces, m.faces);
  assert.deepEqual(backM.autoF, m.autoF);

  // Also verify grays/autoG round-trip cleanly on a non-square board with gray pearls
  const gBase = compile({ name: 'grot', rows: 6, cols: 4, clues: [{ r: 0, c: 0, t: 'G' }, { r: 2, c: 3, t: 'G' }, { r: 5, c: 1, t: 'W' }] });
  const gRot = rotatePuzzleCW(gBase);
  const gm = {
    edges: new Uint8Array(gBase.numEdges),
    autoE: new Uint8Array(gBase.numEdges),
    faces: new Uint8Array(numFacesOf(gBase)),
    autoF: new Uint8Array(numFacesOf(gBase)),
    grays: Uint8Array.from([2, 1]),
    autoG: Uint8Array.from([0, 1]),
  };
  const gRotM = rotateMarksCW(gBase, gRot, gm);
  assert.deepEqual(gRotM.grays, gm.grays);
  assert.deepEqual(gRotM.autoG, gm.autoG);
  const gBackM = unrotateMarksCW(gBase, gRot, gRotM);
  assert.deepEqual(gBackM.grays, gm.grays);
  assert.deepEqual(gBackM.autoG, gm.autoG);

  // Verify fullBoard + givens rotate 90° CW cleanly (4 rotations = identity, symmetryKey invariant)
  const fBase = compile({
    name: 'frot', rows: 4, cols: 6, fullBoard: true,
    clues: [{ r: 0, c: 2, t: 'W' }],
    givens: [{ r: 1, c: 2, dir: 'H', v: 1 }, { r: 2, c: 4, dir: 'V', v: 0 }],
  });
  const fRot = rotatePuzzleCW(fBase);
  assert.equal(fRot.fullBoard, true);
  assert.equal(fRot.givens.length, 2);
  assert.equal(puzzleHash(fRot), puzzleHash(fBase));
  let cur = fBase;
  for (let k = 0; k < 4; k++) cur = rotatePuzzleCW(cur);
  assert.deepEqual(
    cur.givens.map(({ r, c, dir, v }) => ({ r, c, dir, v })).sort((a, b) => a.r - b.r || a.c - b.c),
    fBase.givens.map(({ r, c, dir, v }) => ({ r, c, dir, v })).sort((a, b) => a.r - b.r || a.c - b.c),
  );
});

test('hints and auto-marks work identically on rotated puzzles', () => {
  const baseP = loadFirst('12x20-medium.csv');
  const rotP = rotatePuzzleCW(baseP);
  const m = {
    edges: new Uint8Array(rotP.numEdges),
    autoE: new Uint8Array(rotP.numEdges),
    faces: new Uint8Array(numFacesOf(rotP)),
    autoF: new Uint8Array(numFacesOf(rotP)),
  };
  reconcileAutoX(rotP, m, true, { useShade: true });
  reconcileAutoShade(rotP, m, true);
  const hint = computeHint(rotP, m);
  assert.equal(hint.kind, 'step');
  assert.ok(hint.hints.length > 0);
});

test('chooseLayout auto-rotates tall boards on landscape screens without horizontal overflow', () => {
  // Laptop viewport: 1340 x 580
  assert.deepEqual(chooseLayout(16, 16, 1340, 580), { rotated: false, px: 35 });
  assert.deepEqual(chooseLayout(20, 12, 1340, 580), { rotated: true, px: 46 });
  assert.deepEqual(chooseLayout(24, 16, 1340, 580), { rotated: true, px: 35 });
  assert.deepEqual(chooseLayout(20, 6, 1340, 580), { rotated: true, px: 48 });
  assert.deepEqual(chooseLayout(40, 6, 1340, 580), { rotated: true, px: 33 });

  // Narrower laptop / split window (876 x 520): 6x40 rotated would overflow horizontally (876/40.5 < 26),
  // so it MUST stay portrait and overflow vertically instead!
  const narrowSky = chooseLayout(40, 6, 876, 520);
  assert.equal(narrowSky.rotated, false);
  assert.equal(narrowSky.px, 48);

  // Phone portrait (366 x 480): stays portrait, scrolls vertically at full readable width
  assert.deepEqual(chooseLayout(20, 6, 366, 480), { rotated: false, px: 48 });
  assert.deepEqual(chooseLayout(20, 12, 366, 480), { rotated: false, px: 29 });

  // Portrait monitor (776 x 1020): 12x20 stays portrait at full 48px
  assert.deepEqual(chooseLayout(20, 12, 776, 1020), { rotated: false, px: 48 });

  // Manual override respected on non-square boards, ignored on square boards
  assert.deepEqual(chooseLayout(20, 6, 1340, 580, false), { rotated: false, px: 28 });
  assert.deepEqual(chooseLayout(16, 16, 1340, 580, true), { rotated: false, px: 35 });
});

test('rotatePuzzleCW rotates shaped board voids cleanly and preserves exact solution', () => {
  const base = compile({
    name: 'sh_rot', rows: 5, cols: 7,
    voids: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 2, c: 3 }],
    clues: [{ r: 0, c: 2, t: 'B' }, { r: 4, c: 6, t: 'B' }, { r: 2, c: 1, t: 'W' }],
  });
  const sol = solve(base, { limit: 1 });
  assert.ok(sol.count >= 1);
  base.solution = encodeSolution(base, sol.solutions[0]);
  const rot = rotatePuzzleCW(base);
  assert.equal(rot.rows, 7);
  assert.equal(rot.cols, 5);
  assert.equal(rot.voids.length, 3);
  assert.equal(rot.isVoid[0 * 5 + 4], 1); // (0,0) -> (0,4)
  assert.equal(rot.isVoid[1 * 5 + 4], 1); // (0,1) -> (1,4)
  assert.equal(rot.isVoid[3 * 5 + 2], 1); // (2,3) -> (3,2)
  assert.equal(isSolved(rot, decodeSolution(rot, rot.solution).e), true);
});

test('rotatePuzzleCW rotates Slitherlink face numbers cleanly and preserves exact solution', () => {
  const base = compile({
    name: 'sl_rot', rows: 4, cols: 5,
    clues: [{ r: 0, c: 0, t: 'B' }],
    slither: [{ r: 0, c: 0, n: 2 }, { r: 2, c: 3, n: 2 }, { r: 1, c: 2, n: 0 }],
  });
  const sol = solve(base, { limit: 1 });
  assert.ok(sol.count >= 1);
  base.solution = encodeSolution(base, sol.solutions[0]);
  const rot = rotatePuzzleCW(base);
  assert.equal(rot.rows, 5);
  assert.equal(rot.cols, 4);
  assert.equal(rot.slither.length, 3);
  // Original face (r, c) in (fr=3, fc=4) -> rotated face (c, fr-1-r) in (4, 3):
  // (0,0)->(0,2)=2, (2,3)->(3,0)=2, (1,2)->(2,1)=0
  assert.equal(rot.slitherNum[0 * 3 + 2], 2);
  assert.equal(rot.slitherNum[3 * 3 + 0], 2);
  assert.equal(rot.slitherNum[2 * 3 + 1], 0);
  assert.equal(isSolved(rot, decodeSolution(rot, rot.solution).e), true);
});
