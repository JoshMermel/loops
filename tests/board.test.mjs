import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../js/logic.js';
import { hitTestCoords, advanceDrag, advanceFaceDrag, tilesOutlinePath, CELL_SIZE } from '../js/board.js';
import { clueStates, earlyLoopEdges, trappedFullCells } from '../js/clues.js';
import { otherEnd } from '../js/lineends.js';
import { makeColorKeeper, assignPathColors } from '../js/pathcolors.js';

const S = CELL_SIZE;

test('hitTestCoords distinguishes lattice tracks from intersection centers and handles bounds', () => {
  const P = compile({ name: 't', rows: 4, cols: 4, clues: [] });

  // Directly on intersection (1, 1) -> cell 5 (not an edge)
  const hNode = hitTestCoords(P, 1 * S, 1 * S);
  assert.deepEqual(hNode, { kind: 'cell', cell: 5, edge: -1 });

  // Midpoint of horizontal track (1, 1)-(1, 2) -> edge 2*5 = 10
  const hHoriz = hitTestCoords(P, 1.5 * S, 1.05 * S);
  assert.equal(hHoriz.kind, 'edge');
  assert.equal(hHoriz.edge, 10);

  // Midpoint of vertical track (1, 1)-(2, 1) -> edge 2*5 + 1 = 11
  const hVert = hitTestCoords(P, 0.96 * S, 1.5 * S);
  assert.equal(hVert.kind, 'edge');
  assert.equal(hVert.edge, 11);

  // Outer perimeter track (0, 0)-(0, 1) IS a playable edge -> edge 0
  const hPerim = hitTestCoords(P, 0.5 * S, 0.04 * S);
  assert.equal(hPerim.kind, 'edge');
  assert.equal(hPerim.edge, 0);

  // Center of an empty dual square (1.5, 1.5) hits dual face (1, 1) -> index 1*(4-1)+1 = 4
  const hSquareMid = hitTestCoords(P, 1.5 * S, 1.5 * S);
  assert.equal(hSquareMid.kind, 'face');
  assert.equal(hSquareMid.face, 4);
  assert.equal(hSquareMid.edge, -1);

  // Close to an intersection crossroad (1.08, 1.08) stays a neutral vertex pivot, never hits a face or stray edge
  const hNearVertex = hitTestCoords(P, 1.08 * S, 1.08 * S);
  assert.equal(hNearVertex.kind, 'cell');
  assert.equal(hNearVertex.cell, 5);

  // Off-center along a track (1.18, 1.02) now cleanly hits the track thanks to the tighter vertex dead zone
  const hNearStart = hitTestCoords(P, 1.18 * S, 1.02 * S);
  assert.equal(hNearStart.kind, 'edge');
  assert.equal(hNearStart.edge, 10);

  // Outer-left/top dual square (0.5, 0.5) -> face 0; bottom-right dual square (2.5, 2.5) -> face 8
  assert.equal(hitTestCoords(P, 0.5 * S, 0.5 * S).face, 0);
  assert.equal(hitTestCoords(P, 2.5 * S, 2.5 * S).face, 8);

  // Outside board -> null
  assert.equal(hitTestCoords(P, -0.6 * S, 0), null);
  assert.equal(hitTestCoords(P, 3.6 * S, 0), null);
});

test('clueStates marks broken (bad) circles and leaves valid/satisfied circles unmarked', () => {
  const P = compile({
    name: 'cs', rows: 4, cols: 4,
    clues: [{ r: 1, c: 1, t: 'W' }, { r: 0, c: 3, t: 'B' }],
  });
  const m = { edges: new Uint8Array(P.numEdges) };
  assert.deepEqual(clueStates(P, m), ['', '']);

  // White circle (1,1) going straight horizontally (1,0)-(1,1)-(1,2) and turning down at (1,2)-(2,2) -> unmarked ('')
  m.edges[P.ed[(1 * 4 + 1) * 4 + 3]] = 1;
  m.edges[P.ed[(1 * 4 + 1) * 4 + 1]] = 1;
  m.edges[P.ed[(1 * 4 + 2) * 4 + 2]] = 1;
  assert.equal(clueStates(P, m)[0], '');

  // If white circle instead turns at (1,1) -> bad
  const mBadW = { edges: new Uint8Array(P.numEdges) };
  mBadW.edges[P.ed[(1 * 4 + 1) * 4 + 0]] = 1;
  mBadW.edges[P.ed[(1 * 4 + 1) * 4 + 1]] = 1;
  assert.equal(clueStates(P, mBadW)[0], 'bad');

  // Black circle at (0,3) extending 2 left and 2 down -> unmarked ('')
  m.edges[P.ed[3 * 4 + 3]] = 1;
  m.edges[P.ed2[3 * 4 + 3]] = 1;
  m.edges[P.ed[3 * 4 + 2]] = 1;
  m.edges[P.ed2[3 * 4 + 2]] = 1;
  assert.equal(clueStates(P, m)[1], '');

  // Cross out straight continuation of black circle's leg -> bad
  m.edges[P.ed2[3 * 4 + 2]] = 2;
  assert.equal(clueStates(P, m)[1], 'bad');

  // Single segment into a border white circle facing off-board opposite edge -> bad immediately
  const P2 = compile({ name: 'cs_bw', rows: 4, cols: 4, clues: [{ r: 0, c: 1, t: 'W' }] });
  const mBW = { edges: new Uint8Array(P2.numEdges) };
  mBW.edges[P2.ed[(0 * 4 + 1) * 4 + 2]] = 1; // down from top-border white circle
  assert.equal(clueStates(P2, mBW)[0], 'bad');

  // Gray circle error highlight rules:
  // - Labeled gray uses the chosen label's rule
  // - Unlabeled gray is bad ONLY when incompatible with BOTH white and black
  const Pg = compile({ name: 'cs_g', rows: 5, cols: 5, clues: [{ r: 2, c: 2, t: 'G' }] });
  const mid = 2 * 5 + 2;
  const mg = { edges: new Uint8Array(Pg.numEdges), grays: new Uint8Array(1) };
  assert.equal(clueStates(Pg, mg)[0], '');
  // Turn at (2,2) with no extensions crossed out: unlabeled -> OK (compatible with black)
  mg.edges[Pg.ed[mid * 4 + 0]] = 1;
  mg.edges[Pg.ed[mid * 4 + 1]] = 1;
  assert.equal(clueStates(Pg, mg)[0], '');
  // Label it White -> bad (turn disagrees with White label)
  mg.grays[0] = 1;
  assert.equal(clueStates(Pg, mg)[0], 'bad');
  // Label it Black -> OK
  mg.grays[0] = 2;
  assert.equal(clueStates(Pg, mg)[0], '');
  // Unlabel it, then cross out straight extension of leg up -> incompatible with BOTH white (turns) and black (short leg) -> bad!
  mg.grays[0] = 0;
  mg.edges[Pg.ed2[mid * 4 + 0]] = 2;
  assert.equal(clueStates(Pg, mg)[0], 'bad');
});

test('earlyLoopEdges flags closed loops that miss clues or leave other segments, and ignores open paths or full single loops', () => {
  const P = compile({
    name: 'el', rows: 4, cols: 4,
    clues: [{ r: 0, c: 0, t: 'B' }, { r: 3, c: 3, t: 'B' }],
  });
  const edge = (r1, c1, r2, c2) => {
    const a = r1 * 4 + c1, b = r2 * 4 + c2;
    for (let d = 0; d < 4; d++) if (P.nb[a * 4 + d] === b) return P.ed[a * 4 + d];
    return -1;
  };
  const m = { edges: new Uint8Array(P.numEdges) };

  // Open 3-edge path around (0,0)-(0,1)-(1,1)-(1,0): not closed -> no early loop
  const sq = [edge(0, 0, 0, 1), edge(0, 1, 1, 1), edge(1, 1, 1, 0), edge(1, 0, 0, 0)];
  m.edges[sq[0]] = 1; m.edges[sq[1]] = 1; m.edges[sq[2]] = 1;
  assert.equal(earlyLoopEdges(P, m).size, 0);

  // Close the 2x2 box while clue (3,3) is unvisited -> all 4 edges flagged
  m.edges[sq[3]] = 1;
  const bad1 = earlyLoopEdges(P, m);
  assert.equal(bad1.size, 4);
  for (const x of sq) assert.equal(bad1.has(x), true);

  // Add an open segment elsewhere -> only the closed box is flagged, not the open segment
  const stray = edge(3, 2, 3, 3);
  m.edges[stray] = 1;
  const bad2 = earlyLoopEdges(P, m);
  assert.equal(bad2.size, 4);
  assert.equal(bad2.has(stray), false);

  // Full outer border loop visiting BOTH clues with no other segments -> NOT flagged
  const full = { edges: new Uint8Array(P.numEdges) };
  for (let c = 0; c < 3; c++) { full.edges[edge(0, c, 0, c + 1)] = 1; full.edges[edge(3, c, 3, c + 1)] = 1; }
  for (let r = 0; r < 3; r++) { full.edges[edge(r, 0, r + 1, 0)] = 1; full.edges[edge(r, 3, r + 1, 3)] = 1; }
  assert.equal(earlyLoopEdges(P, full).size, 0);

  // Adding a stray segment inside that full loop makes it an early/extra loop -> full loop edges flagged
  full.edges[edge(1, 1, 1, 2)] = 1;
  assert.equal(earlyLoopEdges(P, full).size, 12);

  // Full-board zero-circle puzzle: a 2x2 closed sub-loop misses intersections -> flagged as early loop!
  const Pfb = compile({ name: 'fb_el', rows: 4, cols: 4, clues: [], fullBoard: true });
  const mfb = { edges: new Uint8Array(Pfb.numEdges) };
  for (const x of [Pfb.ed[0 * 4 + 1], Pfb.ed[1 * 4 + 2], Pfb.ed[5 * 4 + 3], Pfb.ed[4 * 4 + 0]]) mfb.edges[x] = 1;
  assert.equal(earlyLoopEdges(Pfb, mfb).size, 4, 'sub-loop on fullBoard must be flagged even with 0 circles');

  // trappedFullCells flags an empty intersection with < 2 exits left on a fullBoard puzzle
  const mTrap = { edges: new Uint8Array(Pfb.numEdges) };
  mTrap.edges[Pfb.ed[0 * 4 + 1]] = 2; // corner (0,0) now has only 1 exit left!
  assert.deepEqual([...trappedFullCells(Pfb, mTrap)], [0]);
});

test('advanceDrag includes the starting segment when dragging from A4-A5 to A5-A6 (upper or lower half) or around corners', () => {
  const P = compile({ name: 'drag', rows: 8, cols: 8, clues: [] });
  const cell = (r, c) => r * 8 + c;
  const edgeBetween = (a, b) => {
    for (let d = 0; d < 4; d++) if (P.nb[a * 4 + d] === b) return P.ed[a * 4 + d];
    return -1;
  };
  const runDrag = (coords) => {
    const startHit = hitTestCoords(P, coords[0][0] * S, coords[0][1] * S);
    const g = { startHit, curCell: startHit.cell, dragged: false, firstStep: true, lastEdge: -1, trail: [] };
    const steps = [];
    let begins = 0;
    for (let i = 1; i < coords.length; i++) {
      advanceDrag(
        P, g, coords[i][0] * S, coords[i][1] * S,
        (a, b, first) => steps.push({ e: edgeBetween(a, b), first }),
        () => steps.pop(),
        () => { begins++; },
      );
    }
    return { g, steps, begins };
  };

  const eA4A5 = edgeBetween(cell(3, 0), cell(4, 0));
  const eA5A6 = edgeBetween(cell(4, 0), cell(5, 0));
  const eA5B5 = edgeBetween(cell(4, 0), cell(4, 1));

  // Click lower half of A4-A5 (y=3.6), drag to A5-A6 (y=4.4) -> beginDrag fires once, BOTH A4-A5 and A5-A6 applied
  const r1 = runDrag([[0, 3.6], [0, 4.0], [0, 4.4]]);
  assert.equal(r1.begins, 1);
  assert.deepEqual(r1.steps, [{ e: eA4A5, first: true }, { e: eA5A6, first: false }]);

  // Click upper half of A4-A5 (y=3.4), drag to A5-A6 (y=4.4) -> BOTH A4-A5 and A5-A6 applied
  const r2 = runDrag([[0, 3.4], [0, 4.0], [0, 4.4]]);
  assert.deepEqual(r2.steps, [{ e: eA4A5, first: true }, { e: eA5A6, first: false }]);

  // Fast swipe from lower half of A4-A5 (y=3.6) straight to A6 (y=5.0) -> BOTH A4-A5 and A5-A6 applied
  const r3 = runDrag([[0, 3.6], [0, 5.0]]);
  assert.deepEqual(r3.steps, [{ e: eA4A5, first: true }, { e: eA5A6, first: false }]);

  // Corner drag: A4-A5 -> A5-B5 -> BOTH applied
  const r4 = runDrag([[0, 3.6], [0.4, 4.0]]);
  assert.deepEqual(r4.steps, [{ e: eA4A5, first: true }, { e: eA5B5, first: false }]);

  // Jittering across the midpoint of A4-A5 (3.48 -> 3.52) stays a tap (not a drag)
  const r5 = runDrag([[0, 3.48], [0, 3.52]]);
  assert.equal(r5.g.dragged, false);
  assert.equal(r5.steps.length, 0);

  // Jittering across the center of a dual square (1.48, 1.5 -> 1.52, 1.5) stays a tap (not a drag)
  const r6 = runDrag([[1.48, 1.5], [1.52, 1.5]]);
  assert.equal(r6.g.dragged, false);
  assert.equal(r6.steps.length, 0);

  // Dragging from a dual square center across the board never draws stray lines
  const r7 = runDrag([[1.5, 1.5], [2.5, 1.5], [2.0, 2.0]]);
  assert.equal(r7.g.dragged, false);
  assert.equal(r7.steps.length, 0);
});

test('advanceDrag avoids accidental 90° turns on wobbly straight drags, ignores face drift, and supports backtrack', () => {
  const P = compile({ name: 'wobble', rows: 6, cols: 6, clues: [] });
  const cell = (r, c) => r * 6 + c;
  const edgeBetween = (a, b) => {
    for (let d = 0; d < 4; d++) if (P.nb[a * 4 + d] === b) return P.ed[a * 4 + d];
    return -1;
  };
  const runDrag = (coords) => {
    const startHit = hitTestCoords(P, coords[0][0] * S, coords[0][1] * S);
    const g = { startHit, curCell: startHit.cell, dragged: false, firstStep: true, lastEdge: -1, trail: [] };
    const active = [];
    for (let i = 1; i < coords.length; i++) {
      advanceDrag(
        P, g, coords[i][0] * S, coords[i][1] * S,
        (a, b) => active.push(edgeBetween(a, b)),
        () => active.pop(),
      );
    }
    return { g, active };
  };

  const e10_11 = edgeBetween(cell(1, 0), cell(1, 1));
  const e11_12 = edgeBetween(cell(1, 1), cell(1, 2));
  const e11_01 = edgeBetween(cell(1, 1), cell(0, 1));

  // Wobbly horizontal drag across (1,1) drifting 0.20 S (9 px) high right at the intersection -> stays straight!
  const w1 = runDrag([
    [0.0, 1.0], [0.4, 0.9], [0.85, 0.82], [0.95, 0.80], [1.05, 0.80], [1.20, 0.82], [1.35, 0.85], [1.80, 0.95],
  ]);
  assert.deepEqual(w1.active, [e10_11, e11_12]);

  // Even a brief 0.35 S upward wobble right over (1,1) does NOT trigger a 90° turn
  const w2 = runDrag([
    [0.0, 1.0], [0.5, 1.0], [1.0, 0.65], [1.4, 1.0],
  ]);
  assert.deepEqual(w2.active, [e10_11, e11_12]);

  // Drifting into the middle of a dual square (1.5, 1.5) mid-drag pauses cleanly without snapping to a corner
  const w3 = runDrag([
    [0.0, 1.0], [0.5, 1.0], [1.5, 1.5], [1.4, 1.05],
  ]);
  assert.deepEqual(w3.active, [e10_11, e11_12]);

  // Intentional 90° turn upward (0.45 S past (1,1)) commits cleanly
  const t1 = runDrag([
    [0.0, 1.0], [0.5, 1.0], [1.0, 0.55],
  ]);
  assert.deepEqual(t1.active, [e10_11, e11_01]);

  // Backtrack: draw (1,0)->(1,1)->(1,2), pull back past (1,1) to undo (1,1)-(1,2), then turn up to (0,1)
  const b1 = runDrag([
    [0.0, 1.0], [0.5, 1.0], [1.5, 1.0], [1.15, 1.0], [1.0, 0.55],
  ]);
  assert.deepEqual(b1.active, [e10_11, e11_01]);

  // Pulling back into the 0.20..0.24 vertex-snap band must still backtrack cleanly (not fire reverse forward)
  const b3 = runDrag([
    [0.0, 1.0], [0.5, 1.0], [0.22, 1.0],
  ]);
  assert.deepEqual(b3.active, []);
  assert.equal(b3.g.curCell, cell(1, 0));

  // Pulling all the way back to (1,0) undoes both segments cleanly
  const b2 = runDrag([
    [0.0, 1.0], [0.5, 1.0], [1.5, 1.0], [0.8, 1.0], [0.1, 1.0],
  ]);
  assert.deepEqual(b2.active, []);
  assert.equal(b2.g.curCell, cell(1, 0));
});

test('advanceFaceDrag paints squares across fast swipes, avoids diagonal corner grazing, and fires once per square', () => {
  const P = compile({ name: 'fdrag', rows: 5, cols: 5, clues: [] }); // 4x4 dual squares
  const runFaceDrag = (coords) => {
    const startHit = hitTestCoords(P, coords[0][0] * S, coords[0][1] * S);
    assert.equal(startHit.kind, 'face');
    const g = {
      startHit,
      lastGx: coords[0][0] * S,
      lastGy: coords[0][1] * S,
      paintedFaces: new Set([startHit.face]),
      dragged: false,
    };
    const painted = [startHit.face];
    for (let i = 1; i < coords.length; i++) {
      advanceFaceDrag(P, g, coords[i][0] * S, coords[i][1] * S, (f) => painted.push(f));
    }
    return { g, painted };
  };

  // Fast horizontal swipe across row 0 from (0.5, 0.5) straight to (3.5, 0.5) paints faces 0, 1, 2, 3 in order
  const h = runFaceDrag([[0.5, 0.5], [3.5, 0.5]]);
  assert.deepEqual(h.painted, [0, 1, 2, 3]);
  assert.equal(h.g.dragged, true);

  // Moving back over already-painted squares does not fire duplicates
  const back = runFaceDrag([[0.5, 0.5], [1.5, 0.5], [0.5, 0.5]]);
  assert.deepEqual(back.painted, [0, 1]);

  // Diagonal drag from (0.5, 0.5) to (1.5, 1.5) hits only faces 0 and 5 (never grazes off-diagonal 1 or 4)
  const diag = runFaceDrag([[0.5, 0.5], [1.5, 1.5]]);
  assert.deepEqual(diag.painted, [0, 5]);
});

test('otherEnd finds far endpoint of an open path and ignores closed loops or branches', () => {
  const P = compile({ name: 'oe', rows: 3, cols: 3, clues: [] });
  const edges = new Uint8Array(P.numEdges);
  // Path: 0 - 1 - 4 - 5
  edges[P.ed[0 * 4 + 1]] = 1;
  edges[P.ed[1 * 4 + 2]] = 1;
  edges[P.ed[4 * 4 + 1]] = 1;
  assert.equal(otherEnd(P, edges, 0), 5);
  assert.equal(otherEnd(P, edges, 5), 0);
  assert.equal(otherEnd(P, edges, 1), -1); // middle of path

  // Branch at 4 -> returns -1
  edges[P.ed[4 * 4 + 2]] = 1;
  assert.equal(otherEnd(P, edges, 0), -1);
});

test('pathcolors keeps colors stable when extending, joining, splitting, or avoiding alike nearby colors', () => {
  const keeper = makeColorKeeper(16);
  const on = new Uint8Array(16);
  on[0] = 1; // path A (oldest)
  on[6] = 1; // path B
  const roots1 = (x) => (x < 4 ? 0 : 6);
  const c1 = assignPathColors(keeper, on, roots1, 8, null);
  const colA = c1.get(0), colB = c1.get(6);
  assert.notEqual(colA, colB);

  // Extending path A keeps both colors unchanged
  on[2] = 1;
  const c2 = assignPathColors(keeper, on, roots1, 8, null);
  assert.equal(c2.get(0), colA);
  assert.equal(c2.get(6), colB);

  // Joining path A and path B inherits the older path's color (colA)
  on[4] = 1;
  const cJoin = assignPathColors(keeper, on, () => 0, 8, null);
  assert.equal(cJoin.get(0), colA);

  // Splitting back apart keeps colA on the older half and assigns a distinct color to the new piece
  on[4] = 0;
  const cSplit = assignPathColors(keeper, on, roots1, 8, null);
  assert.equal(cSplit.get(0), colA);
  assert.notEqual(cSplit.get(6), colA);

  // Near alike-color avoidance: when colors 0 & 1 are alike (1.0) and color 2 is distinct (0.0),
  // an adjacent component avoids picking 1 next to 0
  const kNear = makeColorKeeper(16);
  const onN = new Uint8Array(16);
  onN[0] = 1; // edge 0
  const alike = [
    [1, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
  ];
  const near = { cols: 4, alike: (i, j) => alike[i][j] };
  const cn1 = assignPathColors(kNear, onN, () => 0, 3, near);
  onN[2] = 1; // adjacent edge on same row
  const cn2 = assignPathColors(kNear, onN, (x) => x, 3, near);
  assert.equal(cn2.get(0), cn1.get(0));
  assert.equal(alike[cn2.get(0)][cn2.get(2)], 0, 'adjacent path should avoid alike color');
});

test('shaped boards: unified interior-hole hit-testing, exterior cutout rejection, void-safe drag, and tilesOutlinePath', () => {
  // 6x6 Donut: 2x2 center voids (2,2),(2,3),(3,2),(3,3) -> hole covers dual squares (1..3, 1..3)
  const donut = compile({
    name: 'donut_b', rows: 6, cols: 6, clues: [],
    voids: [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 3, c: 2 }, { r: 3, c: 3 }],
  });
  const holeRep = donut.holeList[0][0];

  // Dead center of hole, directly on a void vertex, and on a missing internal track ALL hit the same hole rep!
  const hCenter = hitTestCoords(donut, 2.5 * S, 2.5 * S);
  const hOnVoid = hitTestCoords(donut, 2.0 * S, 2.0 * S);
  const hMissingTrack = hitTestCoords(donut, 2.5 * S, 2.0 * S);
  const hInnerRimGap = hitTestCoords(donut, 1.5 * S, 2.0 * S);
  for (const h of [hCenter, hOnVoid, hMissingTrack, hInnerRimGap]) {
    assert.equal(h?.kind, 'face');
    assert.equal(h?.face, holeRep, 'entire donut hole must act as one big click target');
  }

  // Active rim track (1,2)-(1,3) still hits as an edge, and active rim intersection (1,2) still hits as a cell
  const hRimEdge = hitTestCoords(donut, 2.5 * S, 1.0 * S);
  assert.equal(hRimEdge.kind, 'edge');
  assert.equal(hRimEdge.edge, 2 * (1 * 6 + 2));
  const hRimCell = hitTestCoords(donut, 2.0 * S, 1.0 * S);
  assert.equal(hRimCell.kind, 'cell');
  assert.equal(hRimCell.cell, 1 * 6 + 2);

  // Exterior cutout (6x6 Cross): clicking inside a cut-off corner returns null
  const crossVoids = [];
  for (const r of [0, 1, 4, 5]) for (const c of [0, 1, 4, 5]) crossVoids.push({ r, c });
  const cross = compile({ name: 'cross_b', rows: 6, cols: 6, clues: [], voids: crossVoids });
  assert.equal(hitTestCoords(cross, 0.5 * S, 0.5 * S), null);
  assert.equal(hitTestCoords(cross, 0.0 * S, 0.0 * S), null);

  // Dragging across the donut hole never fires a nonexistent void edge
  const startHit = hitTestCoords(donut, 1.0 * S, 2.0 * S); // active cell (2,1) left of hole
  const g = { startHit, curCell: startHit.cell, dragged: false, firstStep: true, lastEdge: -1, trail: [] };
  const steps = [];
  advanceDrag(donut, g, 4.0 * S, 2.0 * S, (a, b) => steps.push([a, b]));
  for (const [a, b] of steps) {
    assert.equal(donut.isVoid[a], 0);
    assert.equal(donut.isVoid[b], 0);
  }

  // tilesOutlinePath emits 2 closed subpaths (outer + hole) for Donut and 1 subpath for Cross
  const dDonut = tilesOutlinePath(6, 6, (r, c) => !donut.isVoid[r * 6 + c], 0, 0, S, S, 8);
  assert.equal((dDonut.match(/Z/g) || []).length, 2, 'donut silhouette should have outer + inner loop');
  const dCross = tilesOutlinePath(6, 6, (r, c) => !cross.isVoid[r * 6 + c], 0, 0, S, S, 8);
  assert.equal((dCross.match(/Z/g) || []).length, 1, 'cross silhouette should have 1 single outer loop');
});
