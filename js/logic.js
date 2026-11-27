// Single-loop puzzle core (Masyu, Slitherlink, Mid-loop, Castle Wall, Hamilton cycle, and hybrids; pure logic, no DOM).
//
// Shared rules: draw one single closed loop along the orthogonal grid lines (no crossings, no branches).
// Modular constraint layers compose freely on the same board:
//   * Masyu circles (W/B/G on intersections)
//   * Slitherlink numbers (S0..S3 inside dual squares)
//   * Full board (Hamiltonian cycle visiting every active intersection) + givens (H1/H0/V1/V0) + voids (X)
//
// Coordinates: vertex (r, c) has index r*cols + c. Directions: 0=U 1=R 2=D 3=L.
// Edges: edge 2*i is vertex i's right edge (i <-> i+1), 2*i+1 is vertex i's bottom edge (i <-> i+cols).
// Edge states: 0 unknown, 1 on (loop segment), 2 off (no segment).
// Cell states: 0 unknown, 1 off (not on the loop), 2 loop (on the loop; all circles start as LOOP).
import {
  compileSlither, serializeSlither, parseSlitherToken, symmetrySlither,
  isSlitherSatisfied, propagateSlitherFace, firstUnsatisfiedSlitherOnClose,
} from './variants/slitherlink.js';
import {
  compileMidloop, serializeMidloop, parseMidloopToken, symmetryMidloop,
  isMidloopSatisfied, propagateMidloopDot, firstUnsatisfiedMidloopOnClose,
} from './variants/midloop.js';
import {
  compileCastle, serializeCastle, parseCastleToken, symmetryCastle,
  isCastleSatisfied, propagateCastleClue, propagateCastleParity, propagateCastleMedium,
  firstUnsatisfiedCastleOnClose,
} from './variants/castlewall.js';

/** Column letters like a spreadsheet: 0 -> A, 25 -> Z, 26 -> AA. */
export function colName(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export const DR = [-1, 0, 1, 0];
export const DC = [0, 1, 0, -1];

export const NONE = 0, WHITE = 1, BLACK = 2, GRAY = 3;
export const UNKNOWN = 0, OFF = 1, LOOP = 2;
export const E_UNKNOWN = 0, E_ON = 1, E_OFF = 2;

/**
 * Puzzle = { name, rows, cols, clues: [{ r, c, t: 'W'|'B'|'G' }], solution?, rules?, tier?, score? }.
 * compile() attaches the lookup tables every other function uses.
 */
export function compile(p) {
  const { rows, cols } = p;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2) {
    throw new Error(`invalid board size ${rows}x${cols}`);
  }
  const N = rows * cols;
  const numEdges = 2 * N;

  // Optional cutout voids (intersections removed from the board) + Castle Wall blocked tiles
  const rawVoids = Array.isArray(p.voids) ? p.voids : [];
  const rawCastle = Array.isArray(p.castle) ? p.castle : [];
  const isVoid = new Uint8Array(N);
  const voids = [];
  for (const v of rawVoids) {
    if (!Number.isInteger(v.r) || !Number.isInteger(v.c) || v.r < 0 || v.c < 0 || v.r >= rows || v.c >= cols) {
      throw new Error(`void out of bounds at ${v.r},${v.c}`);
    }
    const i = v.r * cols + v.c;
    if (isVoid[i]) throw new Error(`duplicate void at ${v.r},${v.c}`);
    isVoid[i] = 1;
    voids.push({ r: v.r, c: v.c });
  }
  let castleVoidCount = 0;
  for (const cw of rawCastle) {
    if (!Number.isInteger(cw.r) || !Number.isInteger(cw.c) || cw.r < 0 || cw.c < 0 || cw.r >= rows || cw.c >= cols) {
      throw new Error(`Castle Wall tile out of bounds at ${cw.r},${cw.c}`);
    }
    const i = cw.r * cols + cw.c;
    if (isVoid[i]) throw new Error(`Castle Wall tile overlaps void or duplicate tile at ${cw.r},${cw.c}`);
    isVoid[i] = 1;
    castleVoidCount++;
  }
  const hasVoids = voids.length > 0 || castleVoidCount > 0;
  const activeCount = N - voids.length - castleVoidCount;
  let activeLight = 0, activeDark = 0;
  for (let i = 0; i < N; i++) {
    if (isVoid[i]) continue;
    const r = (i / cols) | 0, c = i % cols;
    if (((r + c) & 1) === 0) activeLight++;
    else activeDark++;
  }

  const clue = new Uint8Array(N); // 0 none, 1 white, 2 black, 3 gray
  const clueAt = new Int16Array(N).fill(-1);
  const grayAt = new Int16Array(N).fill(-1);
  const whites = [], blacks = [], grays = [], clueCells = [];
  if (!Array.isArray(p.clues)) throw new Error('puzzle clues must be an array');
  p.clues.forEach((cl, k) => {
    if (!Number.isInteger(cl.r) || !Number.isInteger(cl.c) || cl.r < 0 || cl.c < 0 || cl.r >= rows || cl.c >= cols) {
      throw new Error(`clue out of bounds at ${cl.r},${cl.c}`);
    }
    const i = cl.r * cols + cl.c;
    if (isVoid[i]) throw new Error(`clue on void cell ${cl.r},${cl.c}`);
    if (clueAt[i] >= 0) throw new Error(`two clues on cell ${cl.r},${cl.c}`);
    if (cl.t !== 'W' && cl.t !== 'B' && cl.t !== 'G') throw new Error(`unknown clue type "${cl.t}" at ${cl.r},${cl.c}`);
    clueAt[i] = k;
    clue[i] = cl.t === 'W' ? WHITE : cl.t === 'B' ? BLACK : GRAY;
    clueCells.push(i);
    if (cl.t === 'W') whites.push(i);
    else if (cl.t === 'B') blacks.push(i);
    else { grayAt[i] = grays.length; grays.push(i); }
  });

  const edgeA = new Int16Array(numEdges).fill(-1);
  const edgeB = new Int16Array(numEdges).fill(-1);
  const nb = new Int16Array(N * 4).fill(-1);
  const ed = new Int16Array(N * 4).fill(-1);
  for (let i = 0; i < N; i++) {
    if (isVoid[i]) continue;
    const r = (i / cols) | 0, c = i % cols;
    for (let d = 0; d < 4; d++) {
      const nr = r + DR[d], nc = c + DC[d];
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      const j = nr * cols + nc;
      if (isVoid[j]) continue;
      const x = d === 1 ? 2 * i : d === 2 ? 2 * i + 1 : d === 3 ? 2 * j : 2 * j + 1;
      if (edgeA[x] < 0) { edgeA[x] = Math.min(i, j); edgeB[x] = Math.max(i, j); }
      nb[i * 4 + d] = j;
      ed[i * 4 + d] = x;
    }
  }

  // Two steps away in direction d (for black circles' straight-2 and white circles' turn check)
  const step2 = new Int16Array(N * 4).fill(-1);
  const ed2 = new Int16Array(N * 4).fill(-1);
  for (let i = 0; i < N; i++) {
    if (isVoid[i]) continue;
    for (let d = 0; d < 4; d++) {
      const j = nb[i * 4 + d];
      if (j < 0) continue;
      const j2 = nb[j * 4 + d];
      if (j2 >= 0) {
        step2[i * 4 + d] = j2;
        ed2[i * 4 + d] = ed[j * 4 + d];
      }
    }
  }

  // Optional full-board flag & given edges (v=1 given segment, v=0 given wall/X)
  const fullBoard = Boolean(p.fullBoard);
  const rawGivens = Array.isArray(p.givens) ? p.givens : [];
  const givens = [];
  let givenE = null;
  if (rawGivens.length) {
    givenE = new Int8Array(numEdges);
    for (const gv of rawGivens) {
      const { r, c, dir, v } = gv;
      if (dir !== 'H' && dir !== 'V') throw new Error(`bad given dir "${dir}"`);
      if (v !== 0 && v !== 1) throw new Error(`bad given value "${v}"`);
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0
        || (dir === 'H' ? (r >= rows || c >= cols - 1) : (r >= rows - 1 || c >= cols))) {
        throw new Error(`given edge out of bounds at ${r},${c},${dir}`);
      }
      const edge = dir === 'H' ? 2 * (r * cols + c) : 2 * (r * cols + c) + 1;
      if (edgeA[edge] < 0) throw new Error(`given edge touches void at ${r},${c},${dir}`);
      if (givenE[edge] !== 0) throw new Error(`duplicate given on edge ${r},${c},${dir}`);
      givenE[edge] = v ? E_ON : E_OFF;
      givens.push({ r, c, dir, v, edge });
    }
  }

  // Dual-face topology for shaped boards:
  // Missing (void-incident) edges never carry loop segments, so their flanking dual squares always
  // share Inside/Outside parity. Components touching the outer boundary collapse into exterior cutouts
  // (`faceExterior`); enclosed components form interior holes (`holeList`, `faceHoleId`, `faceRep`).
  let faceExterior = null, faceHoleId = null, faceRep = null, holeList = null;
  if (hasVoids && rows > 1 && cols > 1) {
    const fr = rows - 1, fc = cols - 1, F = fr * fc, EXT = F;
    const par = new Int32Array(F + 1);
    for (let f = 0; f <= F; f++) par[f] = f;
    const find = (u) => { while (par[u] !== u) { par[u] = par[par[u]]; u = par[u]; } return u; };
    const unite = (u, v) => {
      const ru = find(u), rv = find(v);
      if (ru === rv) return;
      if (rv === EXT) par[ru] = rv;
      else par[rv] = ru;
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < fc; c++) {
        if (edgeA[2 * (r * cols + c)] >= 0) continue;
        const a = r > 0 ? (r - 1) * fc + c : EXT;
        const b = r < fr ? r * fc + c : EXT;
        unite(a, b);
      }
    }
    for (let r = 0; r < fr; r++) {
      for (let c = 0; c < cols; c++) {
        if (edgeA[2 * (r * cols + c) + 1] >= 0) continue;
        const a = c > 0 ? r * fc + (c - 1) : EXT;
        const b = c < fc ? r * fc + c : EXT;
        unite(a, b);
      }
    }
    faceExterior = new Uint8Array(F);
    faceHoleId = new Int16Array(F).fill(-1);
    faceRep = new Int16Array(F);
    holeList = [];
    const rootToHole = new Map();
    const extRoot = find(EXT);
    for (let f = 0; f < F; f++) {
      const root = find(f);
      if (root === extRoot) {
        faceExterior[f] = 1;
        faceRep[f] = -1;
        continue;
      }
      const r = (f / fc) | 0, c = f % fc;
      const touchesVoid = isVoid[r * cols + c] || isVoid[r * cols + c + 1]
        || isVoid[(r + 1) * cols + c] || isVoid[(r + 1) * cols + c + 1];
      if (touchesVoid) {
        let hid = rootToHole.get(root);
        if (hid === undefined) {
          hid = holeList.length;
          rootToHole.set(root, hid);
          holeList.push([]);
        }
        holeList[hid].push(f);
        faceHoleId[f] = hid;
      }
    }
    for (let f = 0; f < F; f++) {
      if (faceExterior[f]) continue;
      const hid = faceHoleId[f];
      faceRep[f] = hid >= 0 ? holeList[hid][0] : f;
    }
  }

  const compiled = Object.assign(p, {
    N, numEdges, clue, clueAt, grayAt, clueCells, whites, blacks, grays,
    voids, isVoid, hasVoids, activeCount, activeLight, activeDark,
    faceExterior, faceHoleId, faceRep, holeList,
    fullBoard, givens, hasGivens: givens.length > 0, givenE,
    nb, ed, step2, ed2, edgeA, edgeB,
    _ecOff: null, _ecData: null, _syms: null,
  });
  compileSlither(compiled, p);
  compileMidloop(compiled, p);
  compileCastle(compiled, p);
  return compiled;
}

export function initialState(P) {
  const cell = new Int8Array(P.N);
  if (P.fullBoard) {
    for (let i = 0; i < P.N; i++) cell[i] = P.isVoid && P.isVoid[i] ? OFF : LOOP;
  } else {
    if (P.hasVoids) for (let i = 0; i < P.N; i++) if (P.isVoid[i]) cell[i] = OFF;
    for (const i of P.clueCells) cell[i] = LOOP;
    if (P.hasMidloop) {
      for (let k = 0; k < P.midloop.length; k++) {
        const m = P.midloop[k];
        cell[m.a] = LOOP;
        cell[m.b] = LOOP;
      }
    }
  }
  const e = new Int8Array(P.numEdges);
  if (P.hasGivens) {
    for (const gv of P.givens) {
      e[gv.edge] = gv.v ? E_ON : E_OFF;
      if (gv.v) {
        cell[P.edgeA[gv.edge]] = LOOP;
        cell[P.edgeB[gv.edge]] = LOOP;
      }
    }
  }
  const hasGray = P.grays && P.grays.length > 0;
  // Share immutable P.clue when there are no gray pearls (zero allocation overhead on standard puzzles).
  const clue = hasGray ? P.clue.slice() : P.clue;
  return { cell, e, clue, hasGray, cycle: false };
}

export function cloneState(st) {
  return {
    cell: st.cell.slice(),
    e: st.e.slice(),
    clue: st.hasGray && st.clue ? st.clue.slice() : st.clue,
    hasGray: Boolean(st.hasGray),
    cycle: st.cycle,
  };
}

/** Endpoints of an edge index, or [-1, -1] if off-board. */
export function edgeCells(P, x) {
  return [P.edgeA[x], P.edgeB[x]];
}

// Reusable scratch buffers for propagate() (never called recursively)
let scratchVis = new Uint8Array(0);
let scratchLoopCells = new Int16Array(0);
let scratchCellQ = new Int16Array(0);
let scratchInCellQ = new Uint8Array(0);
let scratchClueQ = new Int16Array(0);
let scratchInClueQ = new Uint8Array(0);
let scratchFaceQ = new Int16Array(0);
let scratchInFaceQ = new Uint8Array(0);
let scratchMidQ = new Int16Array(0);
let scratchInMidQ = new Uint8Array(0);
let scratchMidCap = 0;
let scratchCwQ = new Int16Array(0);
let scratchInCwQ = new Uint8Array(0);
let scratchCwDirty = new Uint8Array(0);
let scratchCwDirtyList = new Int16Array(0);
let scratchCwRunDirty = new Uint8Array(0);
let scratchCwRunList = new Int16Array(0);
let scratchCwCap = 0;
let scratchQCap = 0;

/** Number of edge assignments or cell=OFF deductions made by the most recent propagate() call. */
export let lastPropChanges = 0;

function ensureMidScratch(M) {
  if (scratchInMidQ.length < M) scratchInMidQ = new Uint8Array(M);
  if (scratchMidCap <= M) {
    let cap = 64;
    while (cap <= M) cap <<= 1;
    scratchMidCap = cap;
    scratchMidQ = new Int16Array(cap);
  }
}

function ensureCwScratch(K) {
  if (scratchInCwQ.length < K) {
    scratchInCwQ = new Uint8Array(K);
    scratchCwDirty = new Uint8Array(K);
    scratchCwDirtyList = new Int16Array(K);
    scratchCwRunDirty = new Uint8Array(K);
    scratchCwRunList = new Int16Array(K);
  }
  if (scratchCwCap <= K) {
    let cap = 32;
    while (cap <= K) cap <<= 1;
    scratchCwCap = cap;
    scratchCwQ = new Int16Array(cap);
  }
}

function ensurePropScratch(N) {
  if (scratchVis.length < N) {
    scratchVis = new Uint8Array(N);
    scratchLoopCells = new Int16Array(N);
    scratchInCellQ = new Uint8Array(N);
    scratchInClueQ = new Uint8Array(N);
    scratchInFaceQ = new Uint8Array(N);
  }
  if (scratchQCap <= N) {
    let cap = 64;
    while (cap <= N) cap <<= 1;
    scratchQCap = cap;
    scratchCellQ = new Int16Array(cap);
    scratchClueQ = new Int16Array(cap);
    scratchFaceQ = new Int16Array(cap);
  }
}

/** Lazily build compact CSR table of clues within distance 1 of each edge's endpoints. */
function getEdgeClues(P) {
  if (P._ecData) return P;
  const { numEdges, edgeA, edgeB, nb, clue } = P;
  const off = new Int32Array(numEdges + 1);
  const tmp = [];
  const seen = new Int16Array(10);
  for (let x = 0; x < numEdges; x++) {
    off[x] = tmp.length;
    const a = edgeA[x];
    if (a < 0) continue;
    const b = edgeB[x];
    let nSeen = 0;
    const add = (j) => {
      if (j < 0 || clue[j] === NONE) return;
      for (let k = 0; k < nSeen; k++) if (seen[k] === j) return;
      seen[nSeen++] = j;
      tmp.push(j);
    };
    add(a); add(b);
    const a4 = a * 4, b4 = b * 4;
    add(nb[a4]); add(nb[a4 + 1]); add(nb[a4 + 2]); add(nb[a4 + 3]);
    add(nb[b4]); add(nb[b4 + 1]); add(nb[b4 + 2]); add(nb[b4 + 3]);
  }
  off[numEdges] = tmp.length;
  P._ecOff = off;
  P._ecData = Int16Array.from(tmp);
  return P;
}

/**
 * Sound constraint propagation for the exact solver. Returns false on a contradiction.
 * Does not model a human; human-style rules live in js/rating.js.
 * Optional `seedEdge` / `seedCell` restricts the initial worklist to the local neighborhood
 * of a single newly assigned edge/cell (used by `solve()` after a prior fixed point).
 */
export function propagate(P, st, seedEdge = -1, seedCell = -1) {
  const { N, cols, nb, ed, ed2, edgeA, edgeB, whites, blacks, grays } = P;
  if (P.fullBoard && P.activeLight !== P.activeDark) return false;
  const cell = st.cell, e = st.e;
  const clue = st.clue || P.clue;

  ensurePropScratch(N);
  const vis = scratchVis;
  const loopCells = scratchLoopCells;
  const qCell = scratchCellQ, inCellQ = scratchInCellQ;
  const qClue = scratchClueQ, inClueQ = scratchInClueQ;
  const qFace = scratchFaceQ, inFaceQ = scratchInFaceQ;
  const qMask = scratchQCap - 1;
  let cHead = 0, cTail = 0;
  let kHead = 0, kTail = 0;
  let fHead = 0, fTail = 0;
  let ok = true;
  let needLoopCheck = false;
  let changes = 0;

  if (!P._ecData) getEdgeClues(P);
  const ecOff = P._ecOff, ecData = P._ecData;
  const hasSlither = Boolean(P.hasSlither);
  const slitherNum = P.slitherNum;
  const efOff = P._efOff, efData = P._efData;
  const hasMidloop = Boolean(P.hasMidloop);
  if (hasMidloop) ensureMidScratch(P.midloop.length);
  const qMid = scratchMidQ, inMidQ = scratchInMidQ;
  const midMask = scratchMidCap - 1;
  const midByRow = P.midloopByRow, midByCol = P.midloopByCol;
  let mHead = 0, mTail = 0;

  const hasCastle = Boolean(P.hasCastle);
  if (hasCastle && P.castleImpossible) return false;
  const ecwOff = P._ecwOff, ecwData = P._ecwData;
  const cwByRow = P.castleByRow, cwByCol = P.castleByCol;
  const cwLen = hasCastle ? P.castle.length : 0;
  if (hasCastle) ensureCwScratch(cwLen);
  const qCw = scratchCwQ, inCwQ = scratchInCwQ;
  const cwDirty = scratchCwDirty, cwDirtyList = scratchCwDirtyList;
  let cwDirtyLen = 0;
  const cwMask = scratchCwCap - 1;
  let cwHead = 0, cwTail = 0;
  const pushCw = (k) => {
    if (!inCwQ[k]) {
      inCwQ[k] = 1;
      qCw[cwTail] = k;
      cwTail = (cwTail + 1) & cwMask;
    }
  };
  const markCwDirty = (k) => {
    if (!cwDirty[k]) {
      cwDirty[k] = 1;
      cwDirtyList[cwDirtyLen++] = k;
    }
  };
  const markCellCw = (u) => {
    const r = (u / cols) | 0, col = u - r * cols;
    const rl = cwByRow[r];
    for (let j = 0; j < rl.length; j++) markCwDirty(rl[j]);
    const cl = cwByCol[col];
    for (let j = 0; j < cl.length; j++) markCwDirty(cl[j]);
  };

  const pushCell = (i) => {
    if (!inCellQ[i]) {
      inCellQ[i] = 1;
      qCell[cTail] = i;
      cTail = (cTail + 1) & qMask;
    }
  };
  const pushClue = (i) => {
    if (!inClueQ[i]) {
      inClueQ[i] = 1;
      qClue[kTail] = i;
      kTail = (kTail + 1) & qMask;
    }
  };
  const pushFace = (f) => {
    if (f >= 0 && slitherNum[f] >= 0 && !inFaceQ[f]) {
      inFaceQ[f] = 1;
      qFace[fTail] = f;
      fTail = (fTail + 1) & qMask;
    }
  };
  const pushMid = (k) => {
    if (!inMidQ[k]) {
      inMidQ[k] = 1;
      qMid[mTail] = k;
      mTail = (mTail + 1) & midMask;
    }
  };
  const frMax = P.rows - 1, fcMax = P.cols - 1, pCols = P.cols;
  const pushVertexMid = (v) => {
    const r = (v / pCols) | 0, c = v - r * pCols;
    const rl = midByRow[r];
    for (let j = 0; j < rl.length; j++) pushMid(rl[j]);
    const cl = midByCol[c];
    for (let j = 0; j < cl.length; j++) pushMid(cl[j]);
  };
  const pushEdgeMid = (x, a) => {
    const r = (a / pCols) | 0, c = a - r * pCols;
    const rl = midByRow[r];
    for (let j = 0; j < rl.length; j++) pushMid(rl[j]);
    const cl = midByCol[c];
    for (let j = 0; j < cl.length; j++) pushMid(cl[j]);
    if ((x & 1) === 0) {
      const cl2 = midByCol[c + 1];
      for (let j = 0; j < cl2.length; j++) pushMid(cl2[j]);
    } else {
      const rl2 = midByRow[r + 1];
      for (let j = 0; j < rl2.length; j++) pushMid(rl2[j]);
    }
  };
  const wakeEdge = (x) => {
    const a = edgeA[x];
    if (a < 0) return;
    const b = edgeB[x];
    pushCell(a);
    pushCell(b);
    const end = ecOff[x + 1];
    for (let k = ecOff[x]; k < end; k++) pushClue(ecData[k]);
    if (hasSlither) {
      const fEnd = efOff[x + 1];
      for (let k = efOff[x]; k < fEnd; k++) pushFace(efData[k]);
    }
    if (hasMidloop) pushEdgeMid(x, a);
    if (hasCastle) {
      const cEnd = ecwOff[x + 1];
      for (let k = ecwOff[x]; k < cEnd; k++) pushCw(ecwData[k]);
      markCellCw(a);
      markCellCw(b);
    }
  };

  const setCell = (i, v) => {
    const cur = cell[i];
    if (cur === v) return;
    if (cur !== UNKNOWN) { ok = false; return; }
    cell[i] = v;
    if (v === LOOP) needLoopCheck = true;
    else {
      changes++;
      if (hasMidloop) pushVertexMid(i);
    }
    pushCell(i);
  };
  const setEdge = (x, v) => {
    if (x < 0) { if (v === E_ON) ok = false; return; }
    const cur = e[x];
    if (cur === v) return;
    if (cur !== E_UNKNOWN) { ok = false; return; }
    e[x] = v;
    changes++;
    if (v === E_ON) needLoopCheck = true;
    wakeEdge(x);
  };
  const setEdgeOk = (x, v) => { setEdge(x, v); return ok; };
  const setCellOk = (i, v) => { setCell(i, v); return ok; };
  const setGray = (i, v) => {
    const cur = clue[i];
    if (cur === v) return;
    if (cur !== GRAY) { ok = false; return; }
    clue[i] = v;
    changes++;
    pushClue(i);
    const i4 = i * 4;
    for (let d = 0; d < 4; d++) {
      const j = nb[i4 + d];
      if (j >= 0 && clue[j] !== NONE) pushClue(j);
    }
  };

  if (seedEdge >= 0) {
    if (e[seedEdge] === E_ON) needLoopCheck = true;
    wakeEdge(seedEdge);
  } else if (seedCell >= 0) {
    if (cell[seedCell] === LOOP) needLoopCheck = true;
    pushCell(seedCell);
    if (hasMidloop) pushVertexMid(seedCell);
  } else {
    needLoopCheck = true;
    for (let i = 0; i < N; i++) pushCell(i);
    for (let wi = 0; wi < whites.length; wi++) pushClue(whites[wi]);
    for (let bi = 0; bi < blacks.length; bi++) pushClue(blacks[bi]);
    if (grays) for (let gi = 0; gi < grays.length; gi++) pushClue(grays[gi]);
    if (hasSlither) for (let si = 0; si < P.slither.length; si++) pushFace(P.slither[si].f);
    if (hasMidloop) for (let mi = 0; mi < P.midloop.length; mi++) pushMid(mi);
    if (hasCastle) for (let ci = 0; ci < cwLen; ci++) if (P.castle[ci].dir) { pushCw(ci); markCwDirty(ci); }
  }

  while (ok) {
    // Inner local fixed-point worklist (Steps 1-4): only revisits cells/clues/faces/midloop/castle clues whose neighborhood changed.
    while (ok && (cHead !== cTail || kHead !== kTail || fHead !== fTail || mHead !== mTail || cwHead !== cwTail)) {
      while (ok && cHead !== cTail) {
        const i = qCell[cHead];
        cHead = (cHead + 1) & qMask;
        inCellQ[i] = 0;

        const s = cell[i];
        const i4 = i * 4;
        if (s === OFF) {
          if (clue[i] !== NONE) { ok = false; break; }
          const x0 = ed[i4], x1 = ed[i4 + 1], x2 = ed[i4 + 2], x3 = ed[i4 + 3];
          if (x0 >= 0 && e[x0] !== E_OFF) setEdge(x0, E_OFF);
          if (x1 >= 0 && e[x1] !== E_OFF) setEdge(x1, E_OFF);
          if (x2 >= 0 && e[x2] !== E_OFF) setEdge(x2, E_OFF);
          if (x3 >= 0 && e[x3] !== E_OFF) setEdge(x3, E_OFF);
          continue;
        }
        let on = 0, unk = 0;
        const x0 = ed[i4], x1 = ed[i4 + 1], x2 = ed[i4 + 2], x3 = ed[i4 + 3];
        if (x0 >= 0) { const v = e[x0]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
        if (x1 >= 0) { const v = e[x1]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
        if (x2 >= 0) { const v = e[x2]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
        if (x3 >= 0) { const v = e[x3]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
        if (on > 2) { ok = false; break; }
        if (s === UNKNOWN) {
          if (on >= 1) setCell(i, LOOP);
          else if (unk < 2) setCell(i, OFF);
          continue;
        }
        // s === LOOP
        if (on + unk < 2) { ok = false; break; }
        if (unk > 0) {
          if (on === 2) {
            if (x0 >= 0 && e[x0] === E_UNKNOWN) setEdge(x0, E_OFF);
            if (x1 >= 0 && e[x1] === E_UNKNOWN) setEdge(x1, E_OFF);
            if (x2 >= 0 && e[x2] === E_UNKNOWN) setEdge(x2, E_OFF);
            if (x3 >= 0 && e[x3] === E_UNKNOWN) setEdge(x3, E_OFF);
          } else if (on + unk === 2) {
            if (x0 >= 0 && e[x0] === E_UNKNOWN) setEdge(x0, E_ON);
            if (x1 >= 0 && e[x1] === E_UNKNOWN) setEdge(x1, E_ON);
            if (x2 >= 0 && e[x2] === E_UNKNOWN) setEdge(x2, E_ON);
            if (x3 >= 0 && e[x3] === E_UNKNOWN) setEdge(x3, E_ON);
          }
        }
      }
      if (!ok) break;

      while (ok && kHead !== kTail) {
        const i = qClue[kHead];
        kHead = (kHead + 1) & qMask;
        inClueQ[i] = 0;

        const i4 = i * 4;
        const ct = clue[i];
        if (ct === GRAY) {
          // Gray circle: secretly either white or black. Resolve when only one color remains possible.
          const u = ed[i4], r = ed[i4 + 1], dn = ed[i4 + 2], l = ed[i4 + 3];
          const u2 = ed2[i4], r2 = ed2[i4 + 1], d2 = ed2[i4 + 2], l2 = ed2[i4 + 3];

          let vOk = u >= 0 && dn >= 0 && e[u] !== E_OFF && e[dn] !== E_OFF;
          let hOk = r >= 0 && l >= 0 && e[r] !== E_OFF && e[l] !== E_OFF;
          if (vOk && u2 >= 0 && e[u2] === E_ON && d2 >= 0 && e[d2] === E_ON) vOk = false;
          if (hOk && r2 >= 0 && e[r2] === E_ON && l2 >= 0 && e[l2] === E_ON) hOk = false;
          if ((r >= 0 && e[r] === E_ON) || (l >= 0 && e[l] === E_ON)) vOk = false;
          if ((u >= 0 && e[u] === E_ON) || (dn >= 0 && e[dn] === E_ON)) hOk = false;
          const canWhite = vOk || hOk;

          const canLeg = (d) => {
            const x1 = ed[i4 + d], x2 = ed2[i4 + d], opp = ed[i4 + (d ^ 2)];
            if (x1 < 0 || x2 < 0 || e[x1] === E_OFF || e[x2] === E_OFF) return false;
            if (opp >= 0 && e[opp] === E_ON) return false;
            const n1 = nb[i4 + d];
            if (clue[n1] === BLACK) return false;
            const p1 = ed[n1 * 4 + ((d + 1) & 3)], p2 = ed[n1 * 4 + ((d + 3) & 3)];
            if ((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON)) return false;
            return true;
          };
          const canBlack = (canLeg(0) || canLeg(2)) && (canLeg(1) || canLeg(3));

          if (!canWhite && !canBlack) { ok = false; break; }
          if (!canWhite) setGray(i, BLACK);
          else if (!canBlack) setGray(i, WHITE);
        } else if (ct === WHITE) {
          // 3. White circles: straight through, turn at >= 1 end
          const u = ed[i4], r = ed[i4 + 1], dn = ed[i4 + 2], l = ed[i4 + 3];
          const u2 = ed2[i4], r2 = ed2[i4 + 1], d2 = ed2[i4 + 2], l2 = ed2[i4 + 3];

          let vOk = u >= 0 && dn >= 0 && e[u] !== E_OFF && e[dn] !== E_OFF;
          let hOk = r >= 0 && l >= 0 && e[r] !== E_OFF && e[l] !== E_OFF;
          if (vOk && u2 >= 0 && e[u2] === E_ON && d2 >= 0 && e[d2] === E_ON) vOk = false;
          if (hOk && r2 >= 0 && e[r2] === E_ON && l2 >= 0 && e[l2] === E_ON) hOk = false;
          if ((r >= 0 && e[r] === E_ON) || (l >= 0 && e[l] === E_ON)) vOk = false;
          if ((u >= 0 && e[u] === E_ON) || (dn >= 0 && e[dn] === E_ON)) hOk = false;

          if (!vOk && !hOk) { ok = false; break; }
          if (!vOk) {
            setEdge(r, E_ON); setEdge(l, E_ON);
            if (u >= 0) setEdge(u, E_OFF);
            if (dn >= 0) setEdge(dn, E_OFF);
            if (r2 >= 0 && e[r2] === E_ON && l2 >= 0) setEdge(l2, E_OFF);
            if (l2 >= 0 && e[l2] === E_ON && r2 >= 0) setEdge(r2, E_OFF);
          } else if (!hOk) {
            setEdge(u, E_ON); setEdge(dn, E_ON);
            if (r >= 0) setEdge(r, E_OFF);
            if (l >= 0) setEdge(l, E_OFF);
            if (u2 >= 0 && e[u2] === E_ON && d2 >= 0) setEdge(d2, E_OFF);
            if (d2 >= 0 && e[d2] === E_ON && u2 >= 0) setEdge(u2, E_OFF);
          }
        } else {
          // 4. Black circles: turn 90° and go straight 2 steps in each chosen direction
          const eu = ed[i4], er = ed[i4 + 1], edown = ed[i4 + 2], el = ed[i4 + 3];
          const eu2 = ed2[i4], er2 = ed2[i4 + 1], ed2v = ed2[i4 + 2], el2 = ed2[i4 + 3];

          let can0 = eu >= 0 && eu2 >= 0 && e[eu] !== E_OFF && e[eu2] !== E_OFF;
          if (can0) {
            const n1 = nb[i4];
            if (clue[n1] === BLACK) can0 = false;
            else {
              const p1 = ed[n1 * 4 + 1], p2 = ed[n1 * 4 + 3];
              if ((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON)) can0 = false;
            }
          }
          let can2 = edown >= 0 && ed2v >= 0 && e[edown] !== E_OFF && e[ed2v] !== E_OFF;
          if (can2) {
            const n1 = nb[i4 + 2];
            if (clue[n1] === BLACK) can2 = false;
            else {
              const p1 = ed[n1 * 4 + 3], p2 = ed[n1 * 4 + 1];
              if ((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON)) can2 = false;
            }
          }
          if (!can0 && !can2) { ok = false; break; }
          if (!can0) {
            if (eu >= 0) setEdge(eu, E_OFF);
            setEdge(edown, E_ON); setEdge(ed2v, E_ON);
          } else if (!can2) {
            if (edown >= 0) setEdge(edown, E_OFF);
            setEdge(eu, E_ON); setEdge(eu2, E_ON);
          } else if (e[eu] === E_ON) {
            setEdge(edown, E_OFF); setEdge(eu2, E_ON);
          } else if (e[edown] === E_ON) {
            setEdge(eu, E_OFF); setEdge(ed2v, E_ON);
          }
          if (!ok) break;

          let can1 = er >= 0 && er2 >= 0 && e[er] !== E_OFF && e[er2] !== E_OFF;
          if (can1) {
            const n1 = nb[i4 + 1];
            if (clue[n1] === BLACK) can1 = false;
            else {
              const p1 = ed[n1 * 4 + 2], p2 = ed[n1 * 4 + 0];
              if ((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON)) can1 = false;
            }
          }
          let can3 = el >= 0 && el2 >= 0 && e[el] !== E_OFF && e[el2] !== E_OFF;
          if (can3) {
            const n1 = nb[i4 + 3];
            if (clue[n1] === BLACK) can3 = false;
            else {
              const p1 = ed[n1 * 4 + 0], p2 = ed[n1 * 4 + 2];
              if ((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON)) can3 = false;
            }
          }
          if (!can1 && !can3) { ok = false; break; }
          if (!can1) {
            if (er >= 0) setEdge(er, E_OFF);
            setEdge(el, E_ON); setEdge(el2, E_ON);
          } else if (!can3) {
            if (el >= 0) setEdge(el, E_OFF);
            setEdge(er, E_ON); setEdge(er2, E_ON);
          } else if (e[er] === E_ON) {
            setEdge(el, E_OFF); setEdge(er2, E_ON);
          } else if (e[el] === E_ON) {
            setEdge(er, E_OFF); setEdge(el2, E_ON);
          }
        }
      }

      while (ok && fHead !== fTail) {
        const f = qFace[fHead];
        fHead = (fHead + 1) & qMask;
        inFaceQ[f] = 0;
        if (!propagateSlitherFace(P, st, f, setEdge)) ok = false;
      }

      while (ok && mHead !== mTail) {
        const mi = qMid[mHead];
        mHead = (mHead + 1) & midMask;
        inMidQ[mi] = 0;
        if (!propagateMidloopDot(P, st, mi, setEdgeOk, setCellOk)) ok = false;
      }

      while (ok && cwHead !== cwTail) {
        const ci = qCw[cwHead];
        cwHead = (cwHead + 1) & cwMask;
        inCwQ[ci] = 0;
        if (!propagateCastleClue(P, st, ci, setEdgeOk)) ok = false;
      }
    }
    if (!ok) break;
    if (hasCastle && !st.cycle && (seedEdge >= 0 || seedCell < 0 || changes > 0)) {
      const before = changes;
      if (P.hasCastleWalls) {
        if (!propagateCastleParity(P, st, setEdgeOk)) { ok = false; break; }
      }
      if (cwDirtyLen > 0) {
        // Snapshot dirty rays into a separate run buffer BEFORE calling propagateCastleMedium so any
        // new edges set inside propagateCastleMedium cleanly mark cwDirty for the next pass!
        const runLen = cwDirtyLen;
        const cwRunDirty = scratchCwRunDirty, cwRunList = scratchCwRunList;
        for (let i = 0; i < runLen; i++) {
          const ci = cwDirtyList[i];
          cwDirty[ci] = 0;
          cwRunDirty[ci] = 1;
          cwRunList[i] = ci;
        }
        cwDirtyLen = 0;
        const okMed = propagateCastleMedium(P, st, setEdgeOk, cwRunDirty);
        for (let i = 0; i < runLen; i++) cwRunDirty[cwRunList[i]] = 0;
        if (!okMed) { ok = false; break; }
      }
      if (changes > before) continue;
    }
    if (!needLoopCheck) break;
    needLoopCheck = false;

    // 5. Single closed loop constraint via direct path/cycle tracing over LOOP cells (degOn <= 2 everywhere).
    // Replaces O(N + 2E) union-find + full unknown-edge scan with one trace over LOOP cells.
    let loopCount = 0;
    for (let i = 0; i < N; i++) {
      if (cell[i] === LOOP) {
        loopCells[loopCount++] = i;
        vis[i] = 0;
      }
    }

    let cycLen = 0, cycCount = 0;
    for (let li = 0; li < loopCount; li++) {
      const u = loopCells[li];
      if (vis[u]) continue;
      const u4 = u * 4;
      let next1 = -1, next2 = -1;
      let x = ed[u4]; if (x >= 0 && e[x] === E_ON) next1 = nb[u4];
      x = ed[u4 + 1]; if (x >= 0 && e[x] === E_ON) { if (next1 < 0) next1 = nb[u4 + 1]; else next2 = nb[u4 + 1]; }
      x = ed[u4 + 2]; if (x >= 0 && e[x] === E_ON) { if (next1 < 0) next1 = nb[u4 + 2]; else next2 = nb[u4 + 2]; }
      x = ed[u4 + 3]; if (x >= 0 && e[x] === E_ON) { if (next1 < 0) next1 = nb[u4 + 3]; else next2 = nb[u4 + 3]; }

      if (next1 < 0) { vis[u] = 1; continue; } // isolated LOOP cell (degOn === 0)
      if (next2 >= 0) continue; // interior of a path or cycle (wait until second pass for pure cycles)

      // Open path starting at degOn === 1 endpoint `u`: walk to far endpoint `cur`
      vis[u] = 1;
      let prev = u, cur = next1, len = 2;
      for (;;) {
        vis[cur] = 1;
        const c4 = cur * 4;
        let nxt = -1;
        x = ed[c4]; if (x >= 0 && e[x] === E_ON && nb[c4] !== prev) nxt = nb[c4];
        else { x = ed[c4 + 1]; if (x >= 0 && e[x] === E_ON && nb[c4 + 1] !== prev) nxt = nb[c4 + 1];
        else { x = ed[c4 + 2]; if (x >= 0 && e[x] === E_ON && nb[c4 + 2] !== prev) nxt = nb[c4 + 2];
        else { x = ed[c4 + 3]; if (x >= 0 && e[x] === E_ON && nb[c4 + 3] !== prev) nxt = nb[c4 + 3]; } } }
        if (nxt < 0) break;
        prev = cur; cur = nxt; len++;
      }
      if (len >= 4) {
        const diff = u > cur ? u - cur : cur - u;
        if (diff === 1 || diff === cols) {
          for (let d = 0; d < 4; d++) {
            if (nb[u4 + d] === cur) {
              const ex = ed[u4 + d];
              if (e[ex] === E_UNKNOWN) {
                let forbid = len < loopCount;
                if (!forbid && hasSlither) forbid = firstUnsatisfiedSlitherOnClose(P, st, ex) >= 0;
                if (!forbid && hasMidloop) forbid = firstUnsatisfiedMidloopOnClose(P, st, ex) >= 0;
                if (!forbid && hasCastle) forbid = firstUnsatisfiedCastleOnClose(P, st, ex) >= 0;
                if (forbid) setEdge(ex, E_OFF);
              }
              break;
            }
          }
        }
      }
    }

    // Any remaining unvisited LOOP cell with degOn === 2 belongs to a closed cycle
    for (let li = 0; li < loopCount && ok; li++) {
      const start = loopCells[li];
      if (vis[start]) continue;
      cycCount++;
      if (cycCount > 1) { ok = false; break; }
      vis[start] = 2;
      const s4 = start * 4;
      let cur = -1;
      let x = ed[s4]; if (x >= 0 && e[x] === E_ON) cur = nb[s4];
      else { x = ed[s4 + 1]; if (x >= 0 && e[x] === E_ON) cur = nb[s4 + 1];
      else { x = ed[s4 + 2]; if (x >= 0 && e[x] === E_ON) cur = nb[s4 + 2];
      else { x = ed[s4 + 3]; if (x >= 0 && e[x] === E_ON) cur = nb[s4 + 3]; } } }
      let prev = start, len = 1;
      while (cur >= 0 && cur !== start) {
        vis[cur] = 2;
        len++;
        const c4 = cur * 4;
        let nxt = -1;
        x = ed[c4]; if (x >= 0 && e[x] === E_ON && nb[c4] !== prev) nxt = nb[c4];
        else { x = ed[c4 + 1]; if (x >= 0 && e[x] === E_ON && nb[c4 + 1] !== prev) nxt = nb[c4 + 1];
        else { x = ed[c4 + 2]; if (x >= 0 && e[x] === E_ON && nb[c4 + 2] !== prev) nxt = nb[c4 + 2];
        else { x = ed[c4 + 3]; if (x >= 0 && e[x] === E_ON && nb[c4 + 3] !== prev) nxt = nb[c4 + 3]; } } }
        prev = cur; cur = nxt;
      }
      cycLen = len;
    }
    if (!ok) break;

    if (cycCount === 1) {
      if (cycLen < loopCount) { ok = false; break; }
      for (let i = 0; i < N; i++) {
        if (cell[i] === UNKNOWN) setCell(i, OFF);
      }
      if (hasSlither || hasMidloop || hasCastle) {
        for (let x = 0; x < P.numEdges; x++) {
          if (edgeA[x] >= 0 && e[x] === E_UNKNOWN) setEdge(x, E_OFF);
        }
      }
      if (hasMidloop && !isMidloopSatisfied(P, e)) { ok = false; break; }
      if (hasCastle && !isCastleSatisfied(P, e)) { ok = false; break; }
      st.cycle = true;
    } else {
      st.cycle = false;
    }
    if (cHead === cTail && kHead === kTail && fHead === fTail && mHead === mTail && cwHead === cwTail) break;
  }

  // O(touched) cleanup of queued flags on early contradiction exit
  while (cHead !== cTail) { inCellQ[qCell[cHead]] = 0; cHead = (cHead + 1) & qMask; }
  while (kHead !== kTail) { inClueQ[qClue[kHead]] = 0; kHead = (kHead + 1) & qMask; }
  while (fHead !== fTail) { inFaceQ[qFace[fHead]] = 0; fHead = (fHead + 1) & qMask; }
  while (mHead !== mTail) { inMidQ[qMid[mHead]] = 0; mHead = (mHead + 1) & midMask; }
  while (cwHead !== cwTail) { inCwQ[qCw[cwHead]] = 0; cwHead = (cwHead + 1) & cwMask; }
  for (let i = 0; i < cwDirtyLen; i++) cwDirty[cwDirtyList[i]] = 0;
  lastPropChanges = changes;
  return ok;
}

/**
 * Count solutions (up to `limit`) by propagation + backtracking search.
 * Returns { count, solutions: [state], exceeded, nodes }.
 * An `exceeded` result means `maxNodes` was hit and `count` is only a lower bound — never proof of uniqueness.
 */
export function solve(P, { limit = 2, state = null, maxNodes = Infinity, rng = null } = {}) {
  const { N, ed, clue } = P;
  const solutions = [];
  let nodes = 0, exceeded = false;

  const dfs = (st, seedEdge, seedCell) => {
    if (solutions.length >= limit || exceeded) return;
    if (++nodes > maxNodes) { exceeded = true; return; }
    if (!propagate(P, st, seedEdge, seedCell)) return;

    const cell = st.cell, e = st.e;
    // Pick a LOOP cell that still has undecided edges:
    // Prefer open ends (on === 1) with fewest choices, then circles with on === 0, then any LOOP cell.
    let bi = -1, bestKey = -1;
    const ties = rng ? [] : null;
    const isSlV = P.hasSlither ? P.isSlitherVertex : null;
    const hasMid = P.hasMidloop, midAtCell = P.midloopAtCell;
    for (let i = 0; i < N; i++) {
      if (cell[i] !== LOOP) continue;
      const i4 = i * 4;
      let on = 0, unk = 0;
      const x0 = ed[i4], x1 = ed[i4 + 1], x2 = ed[i4 + 2], x3 = ed[i4 + 3];
      if (x0 >= 0) { const v = e[x0]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (x1 >= 0) { const v = e[x1]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (x2 >= 0) { const v = e[x2]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (x3 >= 0) { const v = e[x3]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (unk === 0) continue;
      const isClue = (clue[i] !== NONE || (isSlV && isSlV[i]) || (hasMid && midAtCell[i] >= 0)) ? 1 : 0;
      const key = on * 100 + isClue * 10 + (4 - unk);
      if (ties) {
        if (key > bestKey) { bestKey = key; ties.length = 0; }
        if (key === bestKey) ties.push(i);
      } else if (key > bestKey) {
        bestKey = key; bi = i;
        if (key === 112) break; // maximum possible priority after propagate() (on=1, isClue=1, unk=2)
      }
    }
    if (ties && ties.length) bi = ties[(rng() * ties.length) | 0];

    if (bi >= 0) {
      let x = -1;
      const b4 = bi * 4;
      if (rng) {
        const open = [];
        for (let d = 0; d < 4; d++) {
          const y = ed[b4 + d];
          if (y >= 0 && e[y] === E_UNKNOWN) open.push(y);
        }
        x = open[(rng() * open.length) | 0];
      } else {
        for (let d = 0; d < 4; d++) {
          const y = ed[b4 + d];
          if (y >= 0 && e[y] === E_UNKNOWN) { x = y; break; }
        }
      }
      const onFirst = rng ? rng() < 0.5 : true;
      const v0 = onFirst ? E_ON : E_OFF;
      const v1 = onFirst ? E_OFF : E_ON;
      const a = cloneState(st);
      a.e[x] = v0;
      dfs(a, x, -1);
      if (solutions.length >= limit || exceeded) return;
      st.e[x] = v1;
      dfs(st, x, -1);
      return;
    }

    // If a cycle is already closed covering all LOOP cells, verify active constraints (Slitherlink, Mid-loop, Castle Wall) and record.
    if (st.cycle) {
      if ((!P.hasSlither || isSlitherSatisfied(P, e))
        && (!P.hasMidloop || isMidloopSatisfied(P, e))
        && (!P.hasCastle || isCastleSatisfied(P, e))) solutions.push(st);
      return;
    }

    // If there are no undecided LOOP vertices yet (e.g., pure Slitherlink before the first line is forced),
    // branch directly on an undecided edge of the tightest unsatisfied Slitherlink face.
    if (P.hasSlither) {
      let bestEdge = -1, bestPri = -1;
      const slTies = rng ? [] : null;
      const fe = P.faceEdges;
      for (let si = 0; si < P.slither.length; si++) {
        const sc = P.slither[si];
        if (sc.n === 0) continue;
        const f4 = sc.f * 4;
        let on = 0, unk = 0, firstUnk = -1;
        for (let d = 0; d < 4; d++) {
          const y = fe[f4 + d];
          if (y < 0) continue;
          if (e[y] === E_ON) on++;
          else if (e[y] === E_UNKNOWN) { unk++; if (firstUnk < 0) firstUnk = y; }
        }
        if (unk === 0) continue;
        const need = sc.n - on;
        if (need <= 0) continue;
        const pri = sc.n * 20 + (4 - unk) * 4 + (need === 1 ? 2 : 0);
        if (slTies) {
          if (pri > bestPri) { bestPri = pri; slTies.length = 0; }
          if (pri === bestPri) {
            for (let d = 0; d < 4; d++) { const y = fe[f4 + d]; if (y >= 0 && e[y] === E_UNKNOWN) slTies.push(y); }
          }
        } else if (pri > bestPri) { bestPri = pri; bestEdge = firstUnk; }
      }
      if (slTies && slTies.length) bestEdge = slTies[(rng() * slTies.length) | 0];
      if (bestEdge >= 0) {
        const onFirst = rng ? rng() < 0.5 : true;
        const v0 = onFirst ? E_ON : E_OFF;
        const v1 = onFirst ? E_OFF : E_ON;
        const a = cloneState(st);
        a.e[bestEdge] = v0;
        dfs(a, bestEdge, -1);
        if (solutions.length >= limit || exceeded) return;
        st.e[bestEdge] = v1;
        dfs(st, bestEdge, -1);
        return;
      }
    }

    // If there are no undecided LOOP vertices yet on a Castle Wall board, branch on an edge of the tightest unsatisfied ray.
    if (P.hasCastle) {
      let bestEdge = -1, bestPri = -1;
      const cwTies = rng ? [] : null;
      for (let ci = 0; ci < P.castle.length; ci++) {
        const cw = P.castle[ci];
        if (!cw.dir || cw.n === 0) continue;
        let on = 0, unk = 0, firstUnk = -1;
        const es = cw.edges;
        for (let j = 0; j < es.length; j++) {
          const y = es[j];
          if (e[y] === E_ON) on++;
          else if (e[y] === E_UNKNOWN) { unk++; if (firstUnk < 0) firstUnk = y; }
        }
        const need = cw.n - on;
        if (unk === 0 || need <= 0) continue;
        const pri = need * 20 - unk;
        if (cwTies) {
          if (pri > bestPri) { bestPri = pri; cwTies.length = 0; }
          if (pri === bestPri) {
            for (let j = 0; j < es.length; j++) if (e[es[j]] === E_UNKNOWN) cwTies.push(es[j]);
          }
        } else if (pri > bestPri) { bestPri = pri; bestEdge = firstUnk; }
      }
      if (cwTies && cwTies.length) bestEdge = cwTies[(rng() * cwTies.length) | 0];
      if (bestEdge >= 0) {
        const onFirst = rng ? rng() < 0.5 : true;
        const v0 = onFirst ? E_ON : E_OFF;
        const v1 = onFirst ? E_OFF : E_ON;
        const a = cloneState(st);
        a.e[bestEdge] = v0;
        dfs(a, bestEdge, -1);
        if (solutions.length >= limit || exceeded) return;
        st.e[bestEdge] = v1;
        dfs(st, bestEdge, -1);
        return;
      }
    }

    // Only reachable if there are 0 LOOP cells (e.g., a puzzle with no circles/numbers at all):
    // branch on an UNKNOWN cell being LOOP or OFF.
    let ci = -1;
    if (rng) {
      const unknown = [];
      for (let i = 0; i < N; i++) if (cell[i] === UNKNOWN) unknown.push(i);
      if (unknown.length) ci = unknown[(rng() * unknown.length) | 0];
    } else {
      for (let i = 0; i < N; i++) if (cell[i] === UNKNOWN) { ci = i; break; }
    }
    if (ci >= 0) {
      const loopFirst = rng ? rng() < 0.5 : true;
      const v0 = loopFirst ? LOOP : OFF;
      const v1 = loopFirst ? OFF : LOOP;
      const a = cloneState(st);
      a.cell[ci] = v0;
      dfs(a, -1, ci);
      if (solutions.length >= limit || exceeded) return;
      st.cell[ci] = v1;
      dfs(st, -1, ci);
    }
  };

  dfs(state ? cloneState(state) : initialState(P), -1, -1);
  return { count: solutions.length, solutions, exceeded, nodes };
}

/**
 * Encode a solved state as a string of length N:
 * a hex digit of the loop cell's exits (U=1, R=2, D=4, L=8), or '#' if not on the loop.
 */
export function encodeSolution(P, st) {
  let s = '';
  for (let i = 0; i < P.N; i++) {
    let m = 0;
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] === E_ON) m |= 1 << d;
    }
    s += m ? m.toString(16) : '#';
  }
  return s;
}

/** Decode a solution string back into a complete state { cell, e, cycle }. */
export function decodeSolution(P, str) {
  const st = initialState(P);
  st.cell.fill(OFF);
  st.e.fill(E_OFF);
  if (typeof str !== 'string') return st;
  const lim = Math.min(P.N, str.length);
  for (let i = 0; i < lim; i++) {
    const ch = str[i];
    if (!ch || ch === '#') continue;
    const m = parseInt(ch, 16);
    if (!Number.isFinite(m)) continue;
    st.cell[i] = LOOP;
    for (let d = 0; d < 4; d++) {
      if (m & (1 << d)) {
        const x = P.ed[i * 4 + d];
        if (x >= 0) st.e[x] = E_ON;
      }
    }
  }
  if (st.hasGray) {
    for (const i of P.grays) {
      const u = P.ed[i * 4], dn = P.ed[i * 4 + 2], r = P.ed[i * 4 + 1], l = P.ed[i * 4 + 3];
      const straight = (u >= 0 && dn >= 0 && st.e[u] === E_ON && st.e[dn] === E_ON)
        || (r >= 0 && l >= 0 && st.e[r] === E_ON && st.e[l] === E_ON);
      st.clue[i] = straight ? WHITE : BLACK;
    }
  }
  st.cycle = true;
  return st;
}

/**
 * Independent solution checker: returns true iff `edges` (Int8Array/Uint8Array where 1 = E_ON)
 * forms a valid complete Masyu solution for compiled puzzle `P`.
 * Never looks at P.solution; any valid solution counts.
 */
export function isSolved(P, edges) {
  const { N, numEdges, ed, nb, edgeA, edgeB, whites, blacks, clueCells } = P;
  const deg = new Int8Array(N);
  for (let x = 0; x < numEdges; x++) {
    if (edges[x] !== E_ON) continue;
    const a = edgeA[x], b = edgeB[x];
    if (a < 0) return false; // off-board edge marked on
    deg[a]++;
    deg[b]++;
  }

  let loopCells = 0, start = -1;
  for (let i = 0; i < N; i++) {
    if (deg[i] !== 0 && deg[i] !== 2) return false;
    if (deg[i] === 2) { loopCells++; if (start < 0) start = i; }
  }
  if (loopCells < 4) return false;
  if (P.fullBoard && loopCells !== P.activeCount) return false;

  // Every given edge/wall must be respected
  if (P.hasGivens) {
    for (const gv of P.givens) {
      if ((edges[gv.edge] === E_ON) !== (gv.v === 1)) return false;
    }
  }

  // Every circle must be on the loop
  for (const i of clueCells) if (deg[i] !== 2) return false;

  // Must be a single closed cycle visiting every loop cell
  let prev = -1, cur = start, steps = 0;
  do {
    let next = -1;
    for (let d = 0; d < 4; d++) {
      const x = ed[cur * 4 + d];
      if (x >= 0 && edges[x] === E_ON) {
        const j = nb[cur * 4 + d];
        if (j !== prev) { next = j; break; }
      }
    }
    if (next < 0) return false;
    prev = cur; cur = next; steps++;
  } while (cur !== start && steps <= N);
  if (steps !== loopCells) return false;

  // White circles: go straight through and turn at least one adjacent cell along the loop
  for (const i of whites) {
    const u = ed[i * 4 + 0], r = ed[i * 4 + 1], dn = ed[i * 4 + 2], l = ed[i * 4 + 3];
    const vert = u >= 0 && dn >= 0 && edges[u] === E_ON && edges[dn] === E_ON;
    const horiz = r >= 0 && l >= 0 && edges[r] === E_ON && edges[l] === E_ON;
    if (!vert && !horiz) return false;
    const d1 = vert ? 0 : 1, d2 = d1 ^ 2;
    const ext1 = P.ed2[i * 4 + d1], ext2 = P.ed2[i * 4 + d2];
    const straight1 = ext1 >= 0 && edges[ext1] === E_ON;
    const straight2 = ext2 >= 0 && edges[ext2] === E_ON;
    if (straight1 && straight2) return false;
  }

  // Black circles: turn 90° at the circle and go straight through both adjacent cells
  for (const i of blacks) {
    const dirs = [];
    for (let d = 0; d < 4; d++) {
      const x = ed[i * 4 + d];
      if (x >= 0 && edges[x] === E_ON) dirs.push(d);
    }
    if (dirs.length !== 2) return false;
    if (((dirs[0] ^ dirs[1]) & 1) === 0) return false; // must be perpendicular (turn 90°)
    for (const d of dirs) {
      const ext = P.ed2[i * 4 + d];
      if (ext < 0 || edges[ext] !== E_ON) return false;
    }
  }

  // Gray circles: must satisfy either the white rule (straight + turn) or black rule (turn + straight-2 each way)
  if (P.grays) {
    for (const i of P.grays) {
      const u = ed[i * 4 + 0], r = ed[i * 4 + 1], dn = ed[i * 4 + 2], l = ed[i * 4 + 3];
      const vert = u >= 0 && dn >= 0 && edges[u] === E_ON && edges[dn] === E_ON;
      const horiz = r >= 0 && l >= 0 && edges[r] === E_ON && edges[l] === E_ON;
      if (vert || horiz) {
        const d1 = vert ? 0 : 1, d2 = d1 ^ 2;
        const ext1 = P.ed2[i * 4 + d1], ext2 = P.ed2[i * 4 + d2];
        if (ext1 >= 0 && edges[ext1] === E_ON && ext2 >= 0 && edges[ext2] === E_ON) return false;
      } else {
        let found = 0;
        for (let d = 0; d < 4; d++) {
          const x = ed[i * 4 + d];
          if (x >= 0 && edges[x] === E_ON) {
            const ext = P.ed2[i * 4 + d];
            if (ext < 0 || edges[ext] !== E_ON) return false;
            found++;
          }
        }
        if (found !== 2) return false;
      }
    }
  }

  if (!isSlitherSatisfied(P, edges)) return false;
  if (!isMidloopSatisfied(P, edges)) return false;
  if (!isCastleSatisfied(P, edges)) return false;

  return true;
}

// ---------------------------------------------------------------- CSV

export const CSV_HEADER = 'name,rows,cols,clues,solution,rules,tier,score';

/** Serialize circle clues as `row:col:W|B|G` joined by `;`. */
export function cluesToString(clues) {
  return (clues || []).map((c) => `${c.r}:${c.c}:${c.t}`).join(';');
}

/** Serialize fullBoard flag, voids, circle clues, Slitherlink numbers, Mid-loop dots, and given edges/walls into the CSV clues field. */
export function puzzleCluesToString(p) {
  const parts = [];
  if (p.fullBoard) parts.push('full');
  for (const v of p.voids || []) parts.push(`${v.r}:${v.c}:X`);
  for (const c of p.clues || []) parts.push(`${c.r}:${c.c}:${c.t}`);
  serializeSlither(p, parts);
  serializeMidloop(p, parts);
  serializeCastle(p, parts);
  for (const gv of p.givens || []) parts.push(`${gv.r}:${gv.c}:${gv.dir}${gv.v}`);
  return parts.join(';');
}

/** Parse the CSV clues field into `{ clues, slither, midloop, castle, fullBoard, givens, voids }`. */
export function parseCluesField(s) {
  const acc = { clues: [], slither: [], midloop: [], castle: [], givens: [], voids: [], fullBoard: false };
  if (!s) return acc;
  for (const tok of s.split(';')) {
    if (!tok) continue;
    if (tok === 'full') { acc.fullBoard = true; continue; }
    const parts = tok.split(':');
    if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
      throw new Error(`bad clue "${tok}"`);
    }
    const r = +parts[0], c = +parts[1], tag = parts[2];
    if (tag === 'W' || tag === 'B' || tag === 'G') {
      acc.clues.push({ r, c, t: tag });
    } else if (tag === 'X') {
      acc.voids.push({ r, c });
    } else if (tag === 'H0' || tag === 'H1' || tag === 'V0' || tag === 'V1') {
      acc.givens.push({ r, c, dir: tag[0], v: tag[1] === '1' ? 1 : 0 });
    } else if (parseSlitherToken(r, c, tag, acc)) {
      // handled by Slitherlink variant
    } else if (parseMidloopToken(r, c, tag, acc)) {
      // handled by Mid-loop variant
    } else if (parseCastleToken(r, c, tag, acc)) {
      // handled by Castle Wall variant
    } else {
      throw new Error(`bad clue "${tok}"`);
    }
  }
  return acc;
}

export function cluesFromString(s) {
  return parseCluesField(s).clues;
}

export function toCsvRow(p) {
  return [
    p.name, p.rows, p.cols, puzzleCluesToString(p),
    p.solution || '', p.rules || '', p.tier || '', p.score ?? '',
  ].join(',');
}

export function toCsv(puzzles) {
  return [CSV_HEADER, ...puzzles.map(toCsvRow)].join('\n') + '\n';
}

export function parseCsv(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('name,')) continue;
    const parts = t.split(',');
    if (parts.length < 4) throw new Error(`malformed CSV row: "${t.slice(0, 60)}"`);
    const [name, rows, cols, cluesStr, solution, rules, tier, score] = parts;
    const { clues, slither, midloop, castle, fullBoard, givens, voids } = parseCluesField(cluesStr);
    const rec = {
      name,
      rows: +rows,
      cols: +cols,
      clues,
      solution: solution || '',
      rules: rules || '',
      tier: tier || '',
      score: score === undefined || score === '' ? null : +score,
    };
    if (slither.length) rec.slither = slither;
    if (midloop.length) rec.midloop = midloop;
    if (castle.length) rec.castle = castle;
    if (fullBoard) rec.fullBoard = true;
    if (givens.length) rec.givens = givens;
    if (voids.length) rec.voids = voids;
    out.push(rec);
  }
  return out;
}

/**
 * Canonical symmetry key across all 8 dihedral symmetries (rotations & reflections).
 * Used to deduplicate books so a pool never ships the same puzzle in two orientations.
 */
export function symmetryKey(p) {
  const { rows, cols } = p;
  const givens = p.givens || [];
  const voids = p.voids || [];
  const prefix = p.fullBoard ? 'F|' : '';
  let best = null;
  for (let t = 0; t < 8; t++) {
    const swap = t & 1, flipR = t & 2, flipC = t & 4;
    const R = swap ? cols : rows, C = swap ? rows : cols;
    const xform = (r, c) => {
      if (swap) [r, c] = [c, r];
      if (flipR) r = R - 1 - r;
      if (flipC) c = C - 1 - c;
      return [r, c];
    };
    const items = p.clues.map((cl) => {
      const [r, c] = xform(cl.r, cl.c);
      return [r * C + c, `${r}:${c}:${cl.t}`];
    }).sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(';');
    let vPart = '';
    if (voids.length) {
      vPart = '|X:' + voids.map((v) => {
        const [r, c] = xform(v.r, v.c);
        return [r * C + c, `${r}:${c}`];
      }).sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(';');
    }
    let gPart = '';
    if (givens.length) {
      gPart = '|' + givens.map((gv) => {
        const [r1, c1] = xform(gv.r, gv.c);
        const [r2, c2] = xform(gv.dir === 'V' ? gv.r + 1 : gv.r, gv.dir === 'H' ? gv.c + 1 : gv.c);
        const dir = r1 === r2 ? 'H' : 'V';
        const r = Math.min(r1, r2), c = Math.min(c1, c2);
        return [(r * C + c) * 2 + (dir === 'V' ? 1 : 0), `${r}:${c}:${dir}${gv.v}`];
      }).sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(';');
    }
    const sPart = symmetrySlither(p, swap, flipR, flipC);
    const mPart = symmetryMidloop(p, swap, flipR, flipC);
    const cPart = symmetryCastle(p, swap, flipR, flipC);
    const key = `${prefix}${R}x${C}|${items}${sPart}${mPart}${cPart}${vPart}${gPart}`;
    if (best === null || key < best) best = key;
  }
  return best;
}

/** Orientation-specific short stable hash of size + clues (+ slither / midloop / castle / fullBoard / voids / givens), for localStorage save keys. */
export function puzzleHash(p) {
  if (p.hashKey) return p.hashKey;
  const sorted = [...p.clues].sort((a, b) => (a.r * p.cols + a.c) - (b.r * p.cols + b.c));
  const sortedS = p.slither && p.slither.length
    ? [...p.slither].sort((a, b) => (a.r * (p.cols - 1) + a.c) - (b.r * (p.cols - 1) + b.c))
    : null;
  const dirOrd = (d) => (d === 'C' ? 0 : d === 'H' ? 1 : 2);
  const sortedM = p.midloop && p.midloop.length
    ? [...p.midloop].sort((a, b) => ((a.r * p.cols + a.c) * 3 + dirOrd(a.dir)) - ((b.r * p.cols + b.c) * 3 + dirOrd(b.dir)))
    : null;
  const sortedC = p.castle && p.castle.length
    ? [...p.castle].sort((a, b) => (a.r * p.cols + a.c) - (b.r * p.cols + b.c))
    : null;
  const sortedV = p.voids && p.voids.length
    ? [...p.voids].sort((a, b) => (a.r * p.cols + a.c) - (b.r * p.cols + b.c))
    : null;
  const sortedG = p.givens && p.givens.length
    ? [...p.givens].sort((a, b) => ((a.r * p.cols + a.c) * 2 + (a.dir === 'V' ? 1 : 0)) - ((b.r * p.cols + b.c) * 2 + (b.dir === 'V' ? 1 : 0)))
    : null;
  const body = (p.fullBoard || sortedS || sortedM || sortedC || sortedV || sortedG)
    ? puzzleCluesToString({ fullBoard: p.fullBoard, voids: sortedV || [], clues: sorted, slither: sortedS || [], midloop: sortedM || [], castle: sortedC || [], givens: sortedG || [] })
    : cluesToString(sorted);
  const s = `${p.rows}x${p.cols}|${body}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
