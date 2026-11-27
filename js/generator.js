// Solution-first single-loop puzzle generator (pure JS, no DOM).
//
// 1. Build a random simple closed loop on rows x cols using O(1) simple-point toggles on the
//    (rows-1) x (cols-1) dual face grid, then locally anneal faces near undecided edges until
//    all allowed circles uniquely determine the loop (`tightLoop`).
// 2. Strip circles while preserving exact uniqueness (and human solvability):
//    - Pass 1 uses fast sound-rule closure (no search needed) to strip redundant clues quickly.
//    - Pass 2 (for Medium/Hard/sparse) strips further using exact uniqueness checks, stepping back
//      if the human rater gets stuck (Expert) or exceeds `maxTier`.
// 3. Re-verify exact uniqueness (complete search, never trusting exceeded) and rate with js/rating.js.
import {
  compile, propagate, initialState, cloneState, solve, isSolved, encodeSolution, WHITE, BLACK, GRAY, E_ON, E_OFF, E_UNKNOWN,
} from './logic.js';
import { RULES, rate, solvedByRules, FIRST_LOOKAHEAD, TIERS } from './rating.js';

/** Deterministic PRNG (Mulberry32). */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeDualGrid(rows, cols) {
  const fr = rows - 1, fc = cols - 1, F = fr * fc;
  const inS = new Uint8Array(F);
  const at = (r, c) => (r >= 0 && c >= 0 && r < fr && c < fc ? inS[r * fc + c] : 0);
  const canToggle = (r, c) => {
    const a0 = at(r - 1, c), a1 = at(r - 1, c + 1), a2 = at(r, c + 1), a3 = at(r + 1, c + 1);
    const a4 = at(r + 1, c), a5 = at(r + 1, c - 1), a6 = at(r, c - 1), a7 = at(r - 1, c - 1);
    const orth = a0 + a2 + a4 + a6;
    if (orth === 0 || orth === 4) return false;
    const trans = (a0 !== a1) + (a1 !== a2) + (a2 !== a3) + (a3 !== a4)
      + (a4 !== a5) + (a5 !== a6) + (a6 !== a7) + (a7 !== a0);
    return trans === 2;
  };
  const toEdges = () => {
    const N = rows * cols;
    const edges = new Int8Array(2 * N);
    edges.fill(E_OFF);
    let loopCells = 0;
    let minR = rows, maxR = -1, minC = cols, maxC = -1;
    const midR = rows >> 1, midC = cols >> 1;
    const qLoop = [0, 0, 0, 0], qTot = [0, 0, 0, 0];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (c + 1 < cols && (at(r - 1, c) ^ at(r, c))) edges[2 * i] = E_ON;
        if (r + 1 < rows && (at(r, c - 1) ^ at(r, c))) edges[2 * i + 1] = E_ON;
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const q = (r >= midR ? 2 : 0) + (c >= midC ? 1 : 0);
        qTot[q]++;
        let deg = 0;
        if (c + 1 < cols && edges[2 * i] === E_ON) deg++;
        if (c > 0 && edges[2 * (i - 1)] === E_ON) deg++;
        if (r + 1 < rows && edges[2 * i + 1] === E_ON) deg++;
        if (r > 0 && edges[2 * (i - cols) + 1] === E_ON) deg++;
        if (deg === 2) {
          loopCells++;
          qLoop[q]++;
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    const emptyBorders = loopCells > 0 ? minR + (rows - 1 - maxR) + minC + (cols - 1 - maxC) : rows + cols;
    const quadFills = qTot.map((tot, q) => (tot > 0 ? qLoop[q] / tot : 1));
    const minQuadFill = Math.min(...quadFills);
    return { edges, loopCells, minR, maxR, minC, maxC, emptyBorders, quadFills, qTot, minQuadFill };
  };
  return { fr, fc, F, inS, at, canToggle, toEdges };
}

/**
 * Compute per-quadrant loop fill and clue counts for a board (top-left, top-right, bottom-left, bottom-right).
 */
export function quadrantStats(rows, cols, edges, clues = []) {
  const midR = rows >> 1, midC = cols >> 1;
  const qLoop = [0, 0, 0, 0], qTot = [0, 0, 0, 0], qClues = [0, 0, 0, 0];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const q = (r >= midR ? 2 : 0) + (c >= midC ? 1 : 0);
      qTot[q]++;
      let deg = 0;
      if (c + 1 < cols && edges[2 * i] === E_ON) deg++;
      if (c > 0 && edges[2 * (i - 1)] === E_ON) deg++;
      if (r + 1 < rows && edges[2 * i + 1] === E_ON) deg++;
      if (r > 0 && edges[2 * (i - cols) + 1] === E_ON) deg++;
      if (deg === 2) qLoop[q]++;
    }
  }
  for (const cl of clues) {
    const q = (cl.r >= midR ? 2 : 0) + (cl.c >= midC ? 1 : 0);
    qClues[q]++;
  }
  const fills = qTot.map((tot, q) => (tot > 0 ? qLoop[q] / tot : 1));
  return { fills, minFill: Math.min(...fills), clues: qClues, minClues: Math.min(...qClues) };
}

/**
 * Generate a random simple closed loop on `rows x cols` using O(1) simple-point toggles
 * on the (rows-1) x (cols-1) dual face grid.
 */
export function randomLoop(rows, cols, rng, { targetFill = null, steps = null } = {}) {
  const { fr, fc, F, inS, at, canToggle, toEdges } = makeDualGrid(rows, cols);
  if (fr <= 0 || fc <= 0) throw new Error(`board too small for a loop: ${rows}x${cols}`);
  let faceCount = 0;
  if (fr >= fc * 2) {
    const sc = (rng() * fc) | 0;
    for (let r = 0; r < fr; r++) { inS[r * fc + sc] = 1; faceCount++; }
  } else if (fc >= fr * 2) {
    const sr = (rng() * fr) | 0;
    for (let c = 0; c < fc; c++) { inS[sr * fc + c] = 1; faceCount++; }
  } else {
    inS[((rng() * fr) | 0) * fc + ((rng() * fc) | 0)] = 1;
    faceCount = 1;
  }
  const wantFrac = targetFill ?? (0.38 + 0.24 * rng());
  const totalSteps = steps ?? Math.max(80, F * 16);

  for (let s = 0; s < totalSteps; s++) {
    const r = (rng() * fr) | 0, c = (rng() * fc) | 0;
    const idx = r * fc + c;
    const cur = inS[idx];
    if (cur && faceCount <= 2) continue;
    if (!canToggle(r, c)) continue;
    const frac = faceCount / F;
    if (!cur && frac > wantFrac + 0.12 && rng() < 0.72) continue;
    if (cur && frac < wantFrac - 0.12 && rng() < 0.72) continue;
    const orth = at(r - 1, c) + at(r, c + 1) + at(r + 1, c) + at(r, c - 1);
    if (!cur && orth === 2 && rng() < 0.3) continue;
    inS[idx] = cur ? 0 : 1;
    faceCount += cur ? -1 : 1;
  }
  const { edges, loopCells, emptyBorders, minQuadFill } = toEdges();
  return { edges, loopCells, faceCount, emptyBorders, minQuadFill };
}

/** True if every pair of faces in `orb` has Chebyshev distance > 1 (non-overlapping 3x3 neighborhoods). */
function orbitIsDisjoint(orb) {
  for (let i = 0; i < orb.length; i++) {
    const r0 = orb[i][0], c0 = orb[i][1];
    for (let j = i + 1; j < orb.length; j++) {
      if (Math.abs(r0 - orb[j][0]) <= 1 && Math.abs(c0 - orb[j][1]) <= 1) return false;
    }
  }
  return true;
}

/** Generate a random symmetric simple closed loop ('rot180' | 'mirror' | 'transpose') on the dual face grid. */
function randomSymmetricLoop(rows, cols, rng, layout, { targetFill = null, steps = null, empty = null } = {}) {
  if (layout !== 'rot180' && layout !== 'mirror' && layout !== 'transpose') return null;
  if (layout === 'transpose' && rows !== cols) return null;
  const { fr, fc, F, inS, canToggle, toEdges } = makeDualGrid(rows, cols);
  if (fr <= 0 || fc <= 0) return null;
  const emptyBoard = empty || compile({ name: 'sym_sl', rows, cols, clues: [] });
  const orbitOf = (r, c) => {
    const r2 = layout === 'rot180' ? fr - 1 - r : layout === 'mirror' ? r : c;
    const c2 = layout === 'rot180' ? fc - 1 - c : layout === 'mirror' ? fc - 1 - c : r;
    return (r2 === r && c2 === c) ? [[r, c]] : [[r, c], [r2, c2]];
  };
  let faceCount = 0;
  const cr = (fr / 2) | 0, cc = (fc / 2) | 0;
  const seeds = layout === 'transpose'
    ? [[cr, cr]]
    : layout === 'mirror'
      ? (fc % 2 === 0 ? [[cr, cc - 1], [cr, cc]] : [[cr, cc]])
      : [[cr, cc], ...(fr % 2 === 0 ? [[cr - 1, cc]] : []), ...(fc % 2 === 0 ? [[cr, cc - 1]] : []), ...(fr % 2 === 0 && fc % 2 === 0 ? [[cr - 1, cc - 1]] : [])];
  for (const [sr, sc] of seeds) {
    if (sr >= 0 && sc >= 0 && sr < fr && sc < fc) {
      for (const [rr, ccc] of orbitOf(sr, sc)) {
        if (!inS[rr * fc + ccc]) { inS[rr * fc + ccc] = 1; faceCount++; }
      }
    }
  }
  const wantFrac = targetFill ?? (0.44 + 0.16 * rng());
  const totalSteps = steps ?? Math.max(120, F * 16);
  for (let s = 0; s < totalSteps; s++) {
    const r = (rng() * fr) | 0, c = (rng() * fc) | 0;
    const orb = orbitOf(r, c);
    const v0 = inS[r * fc + c];
    if (orb.length === 2 && inS[orb[1][0] * fc + orb[1][1]] !== v0) continue;
    if (v0 && faceCount - orb.length < 2) continue;
    const frac = faceCount / F;
    if (!v0 && frac > wantFrac + 0.14 && rng() < 0.72) continue;
    if (v0 && frac < wantFrac - 0.14 && rng() < 0.72) continue;
    // O(1) exact homotopy check whenever the orbit cells have disjoint 3x3 neighborhoods
    if (orb.length === 1 || orbitIsDisjoint(orb)) {
      if (!canToggle(r, c)) continue;
      for (let k = 0; k < orb.length; k++) inS[orb[k][0] * fc + orb[k][1]] ^= 1;
      faceCount += v0 ? -orb.length : orb.length;
      continue;
    }
    for (let k = 0; k < orb.length; k++) inS[orb[k][0] * fc + orb[k][1]] ^= 1;
    const { edges, loopCells } = toEdges();
    if (loopCells < 4 || !isSolved(emptyBoard, edges)) {
      for (let k = 0; k < orb.length; k++) inS[orb[k][0] * fc + orb[k][1]] ^= 1;
      continue;
    }
    faceCount += v0 ? -orb.length : orb.length;
  }
  const { edges, loopCells, emptyBorders, minQuadFill } = toEdges();
  return { edges, loopCells, faceCount, emptyBorders, minQuadFill };
}

/** Find every cell on `edges` where a White ('W') or Black ('B') circle is legally allowed. */
export function allowedClues(rows, cols, edges, grid = null) {
  const empty = grid || compile({ name: 'tmp', rows, cols, clues: [] });
  const whites = [], blacks = [];
  for (let i = 0; i < empty.N; i++) {
    const dirs = [];
    for (let d = 0; d < 4; d++) {
      const x = empty.ed[i * 4 + d];
      if (x >= 0 && edges[x] === E_ON) dirs.push(d);
    }
    if (dirs.length !== 2) continue;
    const straight = ((dirs[0] ^ dirs[1]) & 1) === 0;
    const ext0 = empty.ed2[i * 4 + dirs[0]], ext1 = empty.ed2[i * 4 + dirs[1]];
    const s0 = ext0 >= 0 && edges[ext0] === E_ON;
    const s1 = ext1 >= 0 && edges[ext1] === E_ON;
    const r = (i / cols) | 0, c = i % cols;
    if (straight && !(s0 && s1)) whites.push({ r, c, t: 'W' });
    else if (!straight && s0 && s1) blacks.push({ r, c, t: 'B' });
  }
  return { whites, blacks };
}

/** Find the exact Slitherlink face count (0..3) for every valid dual face on `edges`. */
export function allowedSlither(rows, cols, edges, grid = null) {
  const empty = grid || compile({ name: 'tmp', rows, cols, clues: [] });
  const fr = rows - 1, fc = cols - 1;
  const out = [];
  for (let r = 0; r < fr; r++) {
    for (let c = 0; c < fc; c++) {
      const f = r * fc + c;
      if (empty.hasVoids && (empty.faceExterior[f] || empty.faceHoleId[f] >= 0)) continue;
      const f4 = f * 4;
      let ok = true, cnt = 0;
      for (let d = 0; d < 4; d++) {
        const x = empty.faceEdges[f4 + d];
        if (x < 0) { ok = false; break; }
        if (edges[x] === E_ON) cnt++;
      }
      if (ok && cnt <= 3) out.push({ r, c, n: cnt });
    }
  }
  return out;
}

/** Find every exact geometric Mid-loop dot (vertex 'C' or edge 'H'/'V') on `edges`. */
export function allowedMidloop(rows, cols, edges, grid = null, includeLen = false) {
  const empty = grid || compile({ name: 'tmp', rows, cols, clues: [] });
  const { ed } = empty;
  const out = [];
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols - 1) {
      const x = ed[(r * cols + c) * 4 + 1];
      if (x < 0 || edges[x] !== E_ON) { c++; continue; }
      const start = c;
      while (c < cols - 1) {
        const y = ed[(r * cols + c) * 4 + 1];
        if (y < 0 || edges[y] !== E_ON) break;
        c++;
      }
      const len = c - start;
      const dot = (len & 1) === 0
        ? { r, c: start + (len >> 1), dir: 'C' }
        : { r, c: start + (len >> 1), dir: 'H' };
      if (includeLen) dot.len = len;
      out.push(dot);
    }
  }
  for (let c = 0; c < cols; c++) {
    let r = 0;
    while (r < rows - 1) {
      const x = ed[(r * cols + c) * 4 + 2];
      if (x < 0 || edges[x] !== E_ON) { r++; continue; }
      const start = r;
      while (r < rows - 1) {
        const y = ed[(r * cols + c) * 4 + 2];
        if (y < 0 || edges[y] !== E_ON) break;
        r++;
      }
      const len = r - start;
      const dot = (len & 1) === 0
        ? { r: start + (len >> 1), c, dir: 'C' }
        : { r: start + (len >> 1), c, dir: 'V' };
      if (includeLen) dot.len = len;
      out.push(dot);
    }
  }
  const dirOrd = (d) => (d === 'C' ? 0 : d === 'H' ? 1 : 2);
  out.sort((a, b) => ((a.r * cols + a.c) * 3 + dirOrd(a.dir)) - ((b.r * cols + b.c) * 3 + dirOrd(b.dir)));
  return out;
}

/**
 * Symmetry/layout helpers for themed bonus corpuses.
 * Supported `layout` values for clueFilterFor:
 *   'none'         normal unconstrained clues
 *   'checkerboard' clues only on (r + c) % 2 === 0 (no two circles ever touch orthogonally)
 *   'interior'     no clues on the outer perimeter (rows 0/R-1, cols 0/C-1)
 *   'frame'        clues only in the outer 2-cell ring (blank hollow center)
 *   'stripes'      clues only on even rows (r % 2 === 0)
 *   'rot180'       exact 180° rotational symmetry (loop and circle colors)
 *   'mirror'       exact left-right mirror symmetry (loop and circle colors)
 *   'transpose'    exact diagonal-mirror symmetry (r, c) <-> (c, r) (square boards)
 *   'rot90'        exact 90° 4-fold rotational symmetry (loop and circle colors; square boards)
 *   'yinyang' / 'yinyang-mirror' / 'yinyang-transpose'  opposite-color symmetry (W <-> B)
 *   'cookie' / 'cookie-horiz' / 'cookie-diag'           half white, half black split (vertical / horizontal / diagonal)
 *   'cookie-angle' / 'cookie:<deg>'                     arbitrary-angle half white, half black split through board center
 * Fixed-mask layouts (handled by `maskPoints` / `generateMaskPuzzle`):
 *   'lattice', 'blocks2x2', 'quilt2x2', 'circle-ring', 'honeycomb', 'pillars', 'hourglass',
 *   'brackets', 'x-bracket', 'spiral', 'stairs', 'small-x', 'bricks', 'dominoes',
 *   'ltiles', 'mirror-ltiles', 'herringbone', 'slashes', 'zigzags'
 */
function clueFilterFor(layout, rows, cols, rng = null) {
  if (!layout || layout === 'none') return (cs) => cs;
  if (layout === 'checkerboard') return (cs) => cs.filter((c) => ((c.r + c.c) & 1) === 0);
  if (layout === 'interior') return (cs) => cs.filter((c) => c.r > 0 && c.r < rows - 1 && c.c > 0 && c.c < cols - 1);
  if (layout === 'frame') return (cs) => cs.filter((c) => c.r <= 1 || c.r >= rows - 2 || c.c <= 1 || c.c >= cols - 2);
  if (layout === 'stripes') return (cs) => cs.filter((c) => (c.r & 1) === 0);
  if (layout === 'rot180') {
    return (cs) => {
      const m = new Map(cs.map((c) => [c.r * cols + c.c, c.t]));
      return cs.filter((c) => m.get((rows - 1 - c.r) * cols + (cols - 1 - c.c)) === c.t);
    };
  }
  if (layout === 'mirror') {
    return (cs) => {
      const m = new Map(cs.map((c) => [c.r * cols + c.c, c.t]));
      return cs.filter((c) => m.get(c.r * cols + (cols - 1 - c.c)) === c.t);
    };
  }
  if (layout === 'transpose') {
    return (cs) => {
      const m = new Map(cs.map((c) => [c.r * cols + c.c, c.t]));
      return cs.filter((c) => m.get(c.c * cols + c.r) === c.t);
    };
  }
  if (layout === 'rot90') {
    return (cs) => {
      const m = new Map(cs.map((c) => [c.r * cols + c.c, c.t]));
      return cs.filter((c) => (
        m.get(c.c * cols + (rows - 1 - c.r)) === c.t
        && m.get((rows - 1 - c.r) * cols + (cols - 1 - c.c)) === c.t
        && m.get((cols - 1 - c.c) * cols + c.r) === c.t
      ));
    };
  }
  if (layout === 'yinyang' || layout === 'yinyang-mirror' || layout === 'yinyang-transpose') {
    if (layout === 'yinyang-transpose' && rows !== cols) throw new Error('yinyang-transpose layout requires a square board');
    return (cs) => {
      const m = new Map(cs.map((c) => [c.r * cols + c.c, c.t]));
      return cs.filter((c) => {
        const opp = layout === 'yinyang' ? (rows - 1 - c.r) * cols + (cols - 1 - c.c)
          : layout === 'yinyang-mirror' ? c.r * cols + (cols - 1 - c.c)
          : c.c * cols + c.r;
        if (opp === c.r * cols + c.c) return false;
        const ot = m.get(opp);
        return ot && ot !== c.t;
      });
    };
  }
  if (layout === 'cookie') {
    return (cs) => cs.filter((c) => (c.t === 'W' ? c.c < (cols >> 1) : c.c >= (cols >> 1)));
  }
  if (layout === 'cookie-horiz') {
    return (cs) => cs.filter((c) => (c.t === 'W' ? c.r < (rows >> 1) : c.r >= (rows >> 1)));
  }
  if (layout === 'cookie-diag') {
    const diag = (rows - 1) * (cols - 1);
    return (cs) => cs.filter((c) => {
      const lhs = c.r * (cols - 1) + c.c * (rows - 1);
      return c.t === 'W' ? lhs < diag : lhs > diag;
    });
  }
  if (layout === 'cookie-angle' || (typeof layout === 'string' && layout.startsWith('cookie:'))) {
    let theta;
    if (layout === 'cookie-angle') {
      theta = (rng ? rng() : 0) * Math.PI * 2;
    } else {
      const deg = Number(layout.slice('cookie:'.length));
      if (!Number.isFinite(deg)) throw new Error(`Invalid cookie angle "${layout}"`);
      theta = (deg * Math.PI) / 180;
    }
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);
    const EPS = 1e-6;
    return (cs) => cs.filter((c) => {
      const d = (c.c - cx) * nx + (c.r - cy) * ny;
      return c.t === 'W' ? d < -EPS : d > EPS;
    });
  }
  throw new Error(`Unknown layout "${layout}"`);
}

function clueOrbitKeys(layout, rows, cols, r, c) {
  let pts;
  if (layout === 'rot180' || layout === 'yinyang') {
    pts = [[r, c], [rows - 1 - r, cols - 1 - c]];
  } else if (layout === 'mirror' || layout === 'yinyang-mirror') {
    pts = [[r, c], [r, cols - 1 - c]];
  } else if (layout === 'transpose' || layout === 'yinyang-transpose') {
    pts = [[r, c], [c, r]];
  } else if (layout === 'rot90') {
    pts = [[r, c], [c, rows - 1 - r], [rows - 1 - r, cols - 1 - c], [cols - 1 - c, r]];
  } else {
    return [r * cols + c];
  }
  return [...new Set(pts.map(([rr, cc]) => rr * cols + cc))];
}

/**
 * Build a random closed loop and locally anneal dual faces near undecided edges until
 * `propagate` leaves 0 (or very few) undecided edges for the requested style/layout's allowed clues.
 */
export function tightLoop(rows, cols, rng, {
  style = 'balanced',
  layout = 'none',
  minFill = null,
  maxSteps = null,
} = {}) {
  const { fr, fc, F, inS, canToggle, toEdges } = makeDualGrid(rows, cols);
  const symFaces = (layout === 'rot180' || layout === 'mirror' || layout === 'transpose' || layout === 'rot90') ? layout : null;
  if ((layout === 'rot90' || layout === 'transpose' || layout === 'yinyang-transpose') && rows !== cols) throw new Error(`${layout} layout requires a square board`);

  const orbitOf = (r, c) => {
    if (!symFaces) return [[r, c]];
    if (symFaces !== 'rot90') {
      const r2 = symFaces === 'rot180' ? fr - 1 - r : symFaces === 'mirror' ? r : c;
      const c2 = symFaces === 'rot180' ? fc - 1 - c : symFaces === 'mirror' ? fc - 1 - c : r;
      return (r2 === r && c2 === c) ? [[r, c]] : [[r, c], [r2, c2]];
    }
    const pts = [[r, c], [c, fr - 1 - r], [fr - 1 - r, fc - 1 - c], [fc - 1 - c, r]];
    const out = [];
    for (let i = 0; i < 4; i++) {
      const rr = pts[i][0], cc = pts[i][1];
      let dup = false;
      for (let j = 0; j < out.length; j++) if (out[j][0] === rr && out[j][1] === cc) { dup = true; break; }
      if (!dup) out.push([rr, cc]);
    }
    return out;
  };
  const emptyBoard = symFaces ? compile({ name: 'sym', rows, cols, clues: [] }) : null;
  let faceCount = 0;

  const tryToggle = (r, c, minFaces = 2) => {
    if (!symFaces) {
      const idx = r * fc + c;
      if (inS[idx] && faceCount <= minFaces) return null;
      if (!canToggle(r, c)) return null;
      inS[idx] ^= 1;
      faceCount += inS[idx] ? 1 : -1;
      return [[r, c]];
    }
    const orb = orbitOf(r, c);
    const v0 = inS[orb[0][0] * fc + orb[0][1]];
    for (let k = 1; k < orb.length; k++) if (inS[orb[k][0] * fc + orb[k][1]] !== v0) return null;
    if (v0 && faceCount - orb.length < minFaces) return null;
    if (orb.length === 1 || orbitIsDisjoint(orb)) {
      if (!canToggle(r, c)) return null;
      for (let k = 0; k < orb.length; k++) inS[orb[k][0] * fc + orb[k][1]] ^= 1;
      faceCount += v0 ? -orb.length : orb.length;
      return orb;
    }
    for (let k = 0; k < orb.length; k++) inS[orb[k][0] * fc + orb[k][1]] ^= 1;
    const { edges, loopCells } = toEdges();
    if (loopCells < 4 || !isSolved(emptyBoard, edges)) {
      for (let k = 0; k < orb.length; k++) inS[orb[k][0] * fc + orb[k][1]] ^= 1;
      return null;
    }
    faceCount += v0 ? -orb.length : orb.length;
    return orb;
  };
  const undoToggle = (orb) => {
    const v0 = inS[orb[0][0] * fc + orb[0][1]];
    for (const [rr, cc] of orb) inS[rr * fc + cc] ^= 1;
    faceCount += v0 ? -orb.length : orb.length;
  };

  const isExactHamSeed = !symFaces && minFill >= 1.0 && (rows & 1) === 0 && (cols & 1) === 0;
  const seedExactHam = () => {
    inS.fill(0);
    faceCount = 0;
    const hr = rows >> 1, hc = cols >> 1;
    for (let r = 0; r < hr; r++) {
      for (let c = 0; c < hc; c++) {
        inS[(2 * r) * fc + (2 * c)] = 1;
        faceCount++;
      }
    }
    const vis = new Uint8Array(hr * hc);
    const start = (rng() * hr * hc) | 0;
    vis[start] = 1;
    const frontier = [];
    const addNbrs = (u) => {
      const rr = (u / hc) | 0, cc = u % hc;
      if (rr > 0 && !vis[(rr - 1) * hc + cc]) frontier.push([rr, cc, rr - 1, cc]);
      if (rr + 1 < hr && !vis[(rr + 1) * hc + cc]) frontier.push([rr, cc, rr + 1, cc]);
      if (cc > 0 && !vis[rr * hc + (cc - 1)]) frontier.push([rr, cc, rr, cc - 1]);
      if (cc + 1 < hc && !vis[rr * hc + (cc + 1)]) frontier.push([rr, cc, rr, cc + 1]);
    };
    addNbrs(start);
    while (frontier.length) {
      const k = (rng() * frontier.length) | 0;
      const [rr, cc, nr, nc] = frontier[k];
      frontier[k] = frontier[frontier.length - 1];
      frontier.pop();
      const v = nr * hc + nc;
      if (vis[v]) continue;
      vis[v] = 1;
      inS[(rr + nr) * fc + (cc + nc)] = 1;
      faceCount++;
      addNbrs(v);
    }
  };

  // Seed initial connected dual face region
  if (isExactHamSeed) {
    seedExactHam();
  } else if (symFaces) {
    const cr = (fr / 2) | 0, cc = (fc / 2) | 0;
    const seeds = symFaces === 'transpose'
      ? [[cr, cr]]
      : symFaces === 'mirror'
        ? (fc % 2 === 0 ? [[cr, cc - 1], [cr, cc]] : [[cr, cc]])
        : [[cr, cc], ...(fr % 2 === 0 ? [[cr - 1, cc]] : []), ...(fc % 2 === 0 ? [[cr, cc - 1]] : []), ...(fr % 2 === 0 && fc % 2 === 0 ? [[cr - 1, cc - 1]] : [])];
    for (const [sr, sc] of seeds) {
      if (sr >= 0 && sc >= 0 && sr < fr && sc < fc) {
        for (const [rr, ccc] of orbitOf(sr, sc)) {
          if (!inS[rr * fc + ccc]) { inS[rr * fc + ccc] = 1; faceCount++; }
        }
      }
    }
  } else if (fr >= fc * 2) {
    const sc = (rng() * fc) | 0;
    for (let r = 0; r < fr; r++) { inS[r * fc + sc] = 1; faceCount++; }
  } else if (fc >= fr * 2) {
    const sr = (rng() * fr) | 0;
    for (let c = 0; c < fc; c++) { inS[sr * fc + c] = 1; faceCount++; }
  } else {
    inS[((rng() * fr) | 0) * fc + ((rng() * fc) | 0)] = 1;
    faceCount = 1;
  }

  const wantFrac = minFill >= 0.95 ? 0.5 : (0.42 + 0.22 * rng());
  for (let s = 0; !isExactHamSeed && s < Math.max(80, F * 16); s++) {
    const r = (rng() * fr) | 0, c = (rng() * fc) | 0, idx = r * fc + c;
    const frac = faceCount / F;
    if (!inS[idx] && frac > wantFrac + 0.14 && rng() < 0.72) continue;
    if (inS[idx] && frac < wantFrac - 0.14 && rng() < 0.72) continue;
    tryToggle(r, c, 2);
  }

  const N = rows * cols;
  const fillRatio = minFill ?? (N >= 25 ? 0.55 : 0.48);
  const minLoop = Math.max(8, Math.floor(N * fillRatio));
  const reqQuadFill = rows >= 12 && cols >= 12 ? Math.min(0.50, fillRatio * 0.85)
    : rows >= 8 && cols >= 8 ? Math.min(0.35, fillRatio * 0.8)
    : 0;
  const filterClues = clueFilterFor(layout, rows, cols, rng);
  const stepsLimit = maxSteps ?? Math.max(500, Math.min(6000, F * 5 + (layout !== 'none' ? 300 : 0) + (minFill >= 0.95 ? 700 : 0)));
  // Compile grid topology once and reuse across all annealing evaluations
  const baseGrid = compile({ name: 'tl', rows, cols, clues: [] });
  const tlClue = new Uint8Array(N);
  const tlClueAt = new Int16Array(N);
  const tlGrayAt = new Int16Array(N);

  const evaluate = () => {
    const { edges, loopCells, minR, maxR, minC, maxC, emptyBorders, quadFills, qTot, minQuadFill } = toEdges();
    const { whites, blacks } = allowedClues(rows, cols, edges, baseGrid);
    const pool = style === 'white' ? whites
      : style === 'black' ? blacks
      : style === 'gray-all' ? whites.concat(blacks).map((c) => ({ r: c.r, c: c.c, t: 'G' }))
      : whites.concat(blacks);
    const clues = filterClues(pool);
    tlClue.fill(0);
    tlClueAt.fill(-1);
    tlGrayAt.fill(-1);
    const clueCells = [], wIdx = [], bIdx = [], gIdx = [];
    for (let k = 0; k < clues.length; k++) {
      const cl = clues[k];
      const i = cl.r * cols + cl.c;
      tlClueAt[i] = k;
      tlClue[i] = cl.t === 'W' ? WHITE : cl.t === 'B' ? BLACK : GRAY;
      clueCells.push(i);
      if (cl.t === 'W') wIdx.push(i);
      else if (cl.t === 'B') bIdx.push(i);
      else { tlGrayAt[i] = gIdx.length; gIdx.push(i); }
    }
    const P = {
      name: 'tl', rows, cols, clues,
      N: baseGrid.N, K: 4, numEdges: baseGrid.numEdges,
      clue: tlClue, clueAt: tlClueAt, clueCells, whites: wIdx, blacks: bIdx, grays: gIdx, grayAt: tlGrayAt,
      nb: baseGrid.nb, ed: baseGrid.ed, step2: baseGrid.step2, ed2: baseGrid.ed2,
      edgeA: baseGrid.edgeA, edgeB: baseGrid.edgeB,
      _ecOff: null, _ecData: null,
    };
    const st = initialState(P);
    propagate(P, st);
    const unkEdges = [];
    for (let x = 0; x < P.numEdges; x++) if (P.edgeA[x] >= 0 && st.e[x] === E_UNKNOWN) unkEdges.push(x);
    const sizePenalty = loopCells < minLoop ? (minLoop - loopCells) * (minFill >= 0.95 ? 4 : 2) : 0;
    const borderPenalty = emptyBorders * 6;
    let quadPenalty = 0, weakestQuad = -1, weakestFill = reqQuadFill;
    if (reqQuadFill > 0) {
      for (let q = 0; q < 4; q++) {
        if (quadFills[q] < reqQuadFill) {
          quadPenalty += Math.ceil((reqQuadFill - quadFills[q]) * qTot[q]) * 3;
          if (quadFills[q] < weakestFill) { weakestFill = quadFills[q]; weakestQuad = q; }
        }
      }
    }
    const wOut = clues.filter((c) => c.t === 'W');
    const bOut = clues.filter((c) => c.t === 'B');
    return {
      score: unkEdges.length + sizePenalty + borderPenalty + quadPenalty,
      unk: unkEdges.length, unkEdges, P, edges, loopCells, emptyBorders, minR, maxR, minC, maxC,
      quadFills, minQuadFill, weakestQuad,
      clues, whites: wOut, blacks: bOut,
    };
  };

  const finalize = (res) => {
    res.P = compile({ name: 'tl', rows, cols, clues: res.clues });
    return res;
  };

  let cur = evaluate();
  if (isExactHamSeed) {
    // Re-sample O(N) spanning-tree Hamiltonian cycles until one is 100% tight (usually <10 tries, ~10ms)
    for (let t = 0; t < 40 && cur.score > 0; t++) {
      seedExactHam();
      const nxt = evaluate();
      if (nxt.score < cur.score) cur = nxt;
    }
    return finalize(cur);
  }
  const fMidR = fr >> 1, fMidC = fc >> 1;
  for (let step = 0; step < stepsLimit && cur.score > 0; step++) {
    let r, c;
    if (cur.emptyBorders > 0 && rng() < 0.35) {
      const pick = [];
      if (cur.minR > 0) pick.push([Math.max(0, cur.minR - 1), (rng() * fc) | 0]);
      if (cur.maxR < rows - 1) pick.push([Math.min(fr - 1, cur.maxR), (rng() * fc) | 0]);
      if (cur.minC > 0) pick.push([(rng() * fr) | 0, Math.max(0, cur.minC - 1)]);
      if (cur.maxC < cols - 1) pick.push([(rng() * fr) | 0, Math.min(fc - 1, cur.maxC)]);
      [r, c] = pick[(rng() * pick.length) | 0];
    } else if (cur.weakestQuad >= 0 && rng() < 0.35) {
      const qr = cur.weakestQuad >= 2 ? fMidR + ((rng() * (fr - fMidR)) | 0) : ((rng() * Math.max(1, fMidR)) | 0);
      const qc = (cur.weakestQuad & 1) ? fMidC + ((rng() * (fc - fMidC)) | 0) : ((rng() * Math.max(1, fMidC)) | 0);
      r = Math.min(fr - 1, qr);
      c = Math.min(fc - 1, qc);
    } else if (cur.unkEdges.length && rng() < 0.85) {
      const x = cur.unkEdges[(rng() * cur.unkEdges.length) | 0];
      const a = cur.P.edgeA[x], ar = (a / cols) | 0, ac = a % cols;
      const cand = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = ar + dr, cc = ac + dc;
          if (rr >= 0 && cc >= 0 && rr < fr && cc < fc) cand.push([rr, cc]);
        }
      }
      [r, c] = cand[(rng() * cand.length) | 0];
    } else {
      r = (rng() * fr) | 0;
      c = (rng() * fc) | 0;
    }
    const orb = tryToggle(r, c, 3);
    if (!orb) continue;
    const nxt = evaluate();
    const temp = Math.max(0.2, 4 * (1 - step / stepsLimit));
    if (nxt.score <= cur.score || rng() < Math.exp((cur.score - nxt.score) / temp) * 0.25) {
      cur = nxt;
    } else {
      undoToggle(orb);
    }
  }
  return finalize(cur);
}

const BEGINNER_UPTO = RULES.findIndex((r) => r.tier !== 'Beginner');
const MEDIUM_UPTO = RULES.findIndex((r) => r.tier !== 'Beginner' && r.tier !== 'Medium');

/**
 * Return the fixed dot coordinates [[r, c], ...] for a named geometric pattern mask, or null if not a mask layout.
 * All masks keep dots strictly inside the interior (1..rows-2, 1..cols-2) so loops route cleanly around them.
 */
export function maskPoints(layout, rows, cols) {
  const collect = (pred) => {
    const pts = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (pred(r, c)) pts.push([r, c]);
    return pts;
  };
  switch (layout) {
    case 'lattice':
      return collect((r, c) => r >= 1 && r <= rows - 2 && c >= 1 && c <= cols - 2 && (r & 1) === 1 && (c & 1) === 1);
    case 'blocks2x2': // 9x9: four inset 2x2 squares + center diamond
      return collect((r, c) => (
        r >= 1 && r <= rows - 2 && c >= 1 && c <= cols - 2
        && (((r === 1 || r === 2 || r === rows - 3 || r === rows - 2) && (c === 1 || c === 2 || c === cols - 3 || c === cols - 2))
          || (Math.abs(r - ((rows - 1) / 2)) + Math.abs(c - ((cols - 1) / 2)) === 1))
      ));
    case 'quilt2x2': // 10x10: five spaced 2x2 squares (4 corners + center) + 4 side accents
      if (rows !== 10 || cols !== 10) return [];
      return [
        [1, 1], [1, 2], [2, 1], [2, 2],
        [1, 7], [1, 8], [2, 7], [2, 8],
        [7, 1], [7, 2], [8, 1], [8, 2],
        [7, 7], [7, 8], [8, 7], [8, 8],
        [4, 4], [4, 5], [5, 4], [5, 5],
        [1, 4], [4, 8], [8, 5], [5, 1],
      ];
    case 'honeycomb': // 10x10: 3 symmetric staggered columns (1-2, 4-5, 7-8)
      return collect((r, c) => (
        r >= 1 && r <= rows - 2 && c >= 1 && c <= cols - 2
        && (((r & 1) === 1 && c % 3 === 1) || ((r & 1) === 0 && c % 3 === 2))
      ));
    case 'circle-ring': // 10x10: outer circular ring + central 2x2 bullseye
      if (rows !== 10 || cols !== 10) return [];
      return [
        [1, 3], [1, 4], [1, 5], [1, 6],
        [2, 2], [2, 7],
        [3, 1], [3, 8], [4, 1], [4, 8], [5, 1], [5, 8], [6, 1], [6, 8],
        [7, 2], [7, 7],
        [8, 3], [8, 4], [8, 5], [8, 6],
        [4, 4], [4, 5], [5, 4], [5, 5],
      ];
    case 'pillars': // 9x9: three bold solid vertical columns
      if (rows !== 9 || cols !== 9) return [];
      return collect((r, c) => r >= 1 && r <= rows - 2 && (c === 1 || c === 4 || c === 7));
    case 'hourglass': // 10x10: top & bottom solid bars + X diagonals
      if (rows !== 10 || cols !== 10) return [];
      return collect((r, c) => (
        r >= 1 && r <= rows - 2 && c >= 1 && c <= cols - 2
        && (r === 1 || r === rows - 2 || r === c || r + c === rows - 1)
      ));
    case 'brackets': // 10x10: four corner viewfinder brackets + 2x2 center reticle
      if (rows !== 10 || cols !== 10) return [];
      return collect((r, c) => (
        (r >= 1 && r <= 8 && c >= 1 && c <= 8 && (r === 1 || r === 8 || c === 1 || c === 8) && !(r === 4 || r === 5 || c === 4 || c === 5))
        || ((r === 4 || r === 5) && (c === 4 || c === 5))
      ));
    case 'x-bracket': // 9x9: giant diagonal X with heavy 2x2 corner anchors
      if (rows !== 9 || cols !== 9) return [];
      return collect((r, c) => (
        r >= 1 && r <= 7 && c >= 1 && c <= 7 && (
          r === c || r + c === 8
          || ((r === 1 || r === 7) && (c === 2 || c === 6))
          || ((c === 1 || c === 7) && (r === 2 || r === 6))
        )
      ));
    case 'spiral': // 10x10: continuous solid square spiral
      if (rows !== 10 || cols !== 10) return [];
      return [
        [1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [1, 7], [1, 8],
        [2, 8], [3, 8], [4, 8], [5, 8], [6, 8], [7, 8], [8, 8],
        [8, 7], [8, 6], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1],
        [7, 1], [6, 1], [5, 1], [4, 1],
        [4, 2], [4, 3], [4, 4], [4, 5], [5, 5],
      ];
    case 'stairs': // 9x9: parallel stepped diagonal staircases
      if (rows !== 9 || cols !== 9) return [];
      return collect((r, c) => (
        r >= 1 && r <= rows - 2 && c >= 1 && c <= cols - 2
        && (r - c === 0 || r - c === 1 || r - c === -4 || r - c === -3 || r - c === 4 || r - c === 5)
      ));
    case 'small-x': // 9x9: four 5-pearl X motifs
      if (rows !== 9 || cols !== 9) return [];
      return [
        [1, 1], [1, 3], [2, 2], [3, 1], [3, 3],
        [1, 5], [1, 7], [2, 6], [3, 5], [3, 7],
        [5, 1], [5, 3], [6, 2], [7, 1], [7, 3],
        [5, 5], [5, 7], [6, 6], [7, 5], [7, 7],
      ];
    case 'bricks': // 10x10: symmetric running-bond horizontal domino brickwork
      if (rows !== 10 || cols !== 10) return [];
      return collect((r, c) => (
        r >= 1 && r <= 8 && c >= 1 && c <= 8 && (
          ((r & 1) === 1 && (c === 1 || c === 2 || c === 5 || c === 6))
          || ((r & 1) === 0 && (c === 3 || c === 4 || c === 7 || c === 8))
        )
      ));
    case 'dominoes': // 10x10: symmetric 4x3 wallpaper of horizontal 2-pearl dominoes
      if (rows !== 10 || cols !== 10) return [];
      return collect((r, c) => (
        (r === 1 || r === 3 || r === 6 || r === 8)
        && (c === 1 || c === 2 || c === 4 || c === 5 || c === 7 || c === 8)
      ));
    case 'ltiles': // 10x10: 3x3 wallpaper of identical L-trominoes
      if (rows !== 10 || cols !== 10) return [];
      return collect((r, c) => {
        if (r < 1 || r > 8 || c < 1 || c > 8) return false;
        const lr = (r - 1) % 3, lc = (c - 1) % 3;
        return (lr === 0 && (lc === 0 || lc === 1)) || (lr === 1 && lc === 0);
      });
    case 'mirror-ltiles': // 10x10: 3x3 checkerboard of alternating ┌ and ┘ L-trominoes
      if (rows !== 10 || cols !== 10) return [];
      return collect((r, c) => {
        if (r < 1 || r > 8 || c < 1 || c > 8) return false;
        const tr = ((r - 1) / 3) | 0, tc = ((c - 1) / 3) | 0;
        const lr = (r - 1) % 3, lc = (c - 1) % 3;
        if (((tr + tc) & 1) === 0) return (lr === 0 && (lc === 0 || lc === 1)) || (lr === 1 && lc === 0);
        return (lr === 1 && (lc === 0 || lc === 1)) || (lr === 0 && lc === 1);
      });
    case 'herringbone': // 10x10: 3x3 wallpaper of alternating \ and / diagonal pairs
      if (rows !== 10 || cols !== 10) return [];
      return collect((r, c) => {
        if (r < 1 || r > 8 || c < 1 || c > 8) return false;
        const tr = ((r - 1) / 3) | 0, tc = ((c - 1) / 3) | 0;
        const lr = (r - 1) % 3, lc = (c - 1) % 3;
        if (((tr + tc) & 1) === 0) return (lr === 0 && lc === 0) || (lr === 1 && lc === 1);
        return (lr === 0 && lc === 1) || (lr === 1 && lc === 0);
      });
    case 'slashes': // 10x10: 3x3 wallpaper of parallel \ diagonal pairs
      if (rows !== 10 || cols !== 10) return [];
      return collect((r, c) => {
        if (r < 1 || r > 8 || c < 1 || c > 8) return false;
        const lr = (r - 1) % 3, lc = (c - 1) % 3;
        return (lr === 0 && lc === 0) || (lr === 1 && lc === 1);
      });
    case 'zigzags': // 10x10: three vertical stepped zigzag columns
      if (rows !== 10 || cols !== 10) return [];
      return collect((r, c) => {
        if (r < 1 || r > 8 || c < 1 || c > 8) return false;
        const shift = ((r - 1) >> 1) & 1;
        return (c - 1) % 3 === shift;
      });
    default:
      return null;
  }
}

/**
 * Generate a fixed-mask Masyu puzzle where every intersection in `pts` holds a W or B circle
 * (all dots present, none elsewhere) via guided W<->B hill-climbing toward uniqueness.
 */
function generateMaskPuzzle({
  rows, cols, pts, rand, deadline, maxTierIdx, targetTier, wantUnsolved, allowUnsolved, verifyMaxNodes, name, minLoopCells,
}) {
  const K = pts.length;
  if (K < 4) return null;

  const ptIdxMap = new Map(pts.map(([r, c], i) => [r * cols + c, i]));
  const adjList = pts.map(([r, c]) => {
    const out = [];
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const j = ptIdxMap.get((r + dr) * cols + (c + dc));
      if (j !== undefined) out.push(j);
    }
    return out;
  });

  const unkCount = (P, st) => {
    let u = 0;
    for (let x = 0; x < P.numEdges; x++) if (P.edgeA[x] >= 0 && st.e[x] === E_UNKNOWN) u++;
    return u;
  };
  const checkBoundsAndFill = (solStr) => {
    let minR = rows, maxR = -1, minC = cols, maxC = -1, used = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (solStr[r * cols + c] !== '#') {
        used++;
        if (r < minR) minR = r; if (r > maxR) maxR = r;
        if (c < minC) minC = c; if (c > maxC) maxC = c;
      }
    }
    return minR === 0 && maxR === rows - 1 && minC === 0 && maxC === cols - 1 && used >= minLoopCells;
  };
  const diffDots = (P, s0, s1) => {
    const out = [];
    for (let i = 0; i < K; i++) {
      const cell = pts[i][0] * cols + pts[i][1];
      for (let d = 0; d < 4; d++) {
        const x = P.ed[cell * 4 + d];
        if (x >= 0 && s0.e[x] !== s1.e[x]) { out.push(i); break; }
      }
    }
    return out;
  };
  const stepNodeCap = K <= 16 ? 8000 : K <= 20 ? 12000 : 16000;

  while (Date.now() < deadline) {
    const pW = 0.36 + 0.28 * rand();
    const types = pts.map(() => (rand() < pW ? 'W' : 'B'));
    for (let i = 0; i < K; i++) {
      if (types[i] === 'B' && adjList[i].length >= 2 && rand() < 0.5) {
        if (adjList[i].some((j) => types[j] === 'B')) types[i] = 'W';
      }
    }
    let P = compile({ name, rows, cols, clues: pts.map(([r, c], i) => ({ r, c, t: types[i] })) });
    let st = initialState(P);
    if (!propagate(P, st)) continue;
    let res = solve(P, { state: st, limit: 2, maxNodes: stepNodeCap });
    if (res.exceeded || res.count === 0) continue;

    let curUnk = unkCount(P, st);
    for (let step = 0; step < 24 && res.count !== 1 && Date.now() < deadline; step++) {
      const preferred = res.solutions.length >= 2 ? diffDots(P, res.solutions[0], res.solutions[1]) : [];
      let best = null;
      for (let k = 0; k < 10; k++) {
        const idx = (preferred.length && rand() < 0.75)
          ? preferred[(rand() * preferred.length) | 0]
          : (rand() * K) | 0;
        types[idx] = types[idx] === 'W' ? 'B' : 'W';
        const P2 = compile({ name, rows, cols, clues: pts.map(([r, c], i) => ({ r, c, t: types[i] })) });
        const st2 = initialState(P2);
        if (propagate(P2, st2)) {
          const u2 = unkCount(P2, st2);
          if (u2 <= curUnk + 8) {
            const r2 = solve(P2, { state: st2, limit: 2, maxNodes: stepNodeCap });
            if (!r2.exceeded && r2.count >= 1) {
              if (r2.count === 1) { best = { idx, P: P2, res: r2, unk: u2 }; types[idx] = types[idx] === 'W' ? 'B' : 'W'; break; }
              if (!best || u2 < best.unk) best = { idx, P: P2, res: r2, unk: u2 };
            }
          }
        }
        types[idx] = types[idx] === 'W' ? 'B' : 'W';
      }
      if (!best) break;
      types[best.idx] = types[best.idx] === 'W' ? 'B' : 'W';
      P = best.P; res = best.res; curUnk = best.unk;
    }

    if (res.count !== 1) continue;
    const verify = solve(P, { limit: 2, maxNodes: verifyMaxNodes });
    if (verify.exceeded || verify.count !== 1) continue;
    const sol = verify.solutions[0];
    if (!isSolved(P, sol.e)) continue;
    const solStr = encodeSolution(P, sol);
    if (!checkBoundsAndFill(solStr)) continue;

    const rated = rate(P);
    if (wantUnsolved) {
      if (rated.solved) continue;
    } else if (!rated.solved) {
      if (!allowUnsolved) continue;
    } else {
      if (TIERS.indexOf(rated.tier) > maxTierIdx) continue;
      if (targetTier && rated.tier !== targetTier) continue;
    }

    P.solution = solStr;
    P.rules = rated.rules;
    P.tier = rated.tier;
    P.score = rated.score;
    return P;
  }
  return null;
}

/** Build symmetric edge index mapping for `layout` ('rot180' | 'mirror' | 'transpose'). */
function symEdgeMapFor(P, layout) {
  const { rows, cols, numEdges, edgeA, edgeB, nb, ed } = P;
  const mapCell = (i) => {
    const r = (i / cols) | 0, c = i % cols;
    if (layout === 'rot180') return (rows - 1 - r) * cols + (cols - 1 - c);
    if (layout === 'mirror') return r * cols + (cols - 1 - c);
    return c * cols + r;
  };
  const em = new Int32Array(numEdges).fill(-1);
  for (let x = 0; x < numEdges; x++) {
    const a = edgeA[x];
    if (a < 0) continue;
    const b = edgeB[x];
    const a2 = mapCell(a), b2 = mapCell(b);
    for (let d = 0; d < 4; d++) {
      if (nb[a2 * 4 + d] === b2) { em[x] = ed[a2 * 4 + d]; break; }
    }
  }
  return em;
}

/** True if a symmetric Hamiltonian cycle on a void-free `rows x cols` grid is mathematically impossible. */
function isImpossibleSymFull(rows, cols, layout) {
  if (layout === 'transpose' && rows >= 4) return true;
  if (layout === 'mirror' && (cols & 1) && rows >= 4) return true;
  return false;
}

/** Sample a random symmetric Hamiltonian cycle on `emptyFull` for 'rot180', 'mirror', or 'transpose'. */
function sampleSymmetricFullLoop(emptyFull, layout, rand, maxNodes = 4000) {
  if (layout === 'transpose' && emptyFull.rows !== emptyFull.cols) return null;
  if (!emptyFull.hasVoids && isImpossibleSymFull(emptyFull.rows, emptyFull.cols, layout)) return null;
  const em = symEdgeMapFor(emptyFull, layout);
  const { N, numEdges, ed, edgeA } = emptyFull;
  let nodes = 0;

  const pickBranchEdge = (st) => {
    const e = st.e;
    // Prefer an unknown edge incident to an open degree-1 endpoint with fewest unknown exits (MRV)
    let bestUnk = 5;
    const mrv = [];
    for (let i = 0; i < N; i++) {
      if (emptyFull.isVoid && emptyFull.isVoid[i]) continue;
      let on = 0, unk = 0;
      const i4 = i * 4;
      for (let d = 0; d < 4; d++) {
        const x = ed[i4 + d];
        if (x < 0) continue;
        if (e[x] === E_ON) on++;
        else if (e[x] === E_UNKNOWN) unk++;
      }
      if (on === 1 && unk > 0) {
        if (unk < bestUnk) { bestUnk = unk; mrv.length = 0; }
        if (unk === bestUnk) {
          for (let d = 0; d < 4; d++) {
            const x = ed[i4 + d];
            if (x >= 0 && e[x] === E_UNKNOWN) mrv.push(x);
          }
        }
      }
    }
    if (mrv.length) return mrv[(rand() * mrv.length) | 0];
    const cands = [];
    for (let x = 0; x < numEdges; x++) if (edgeA[x] >= 0 && e[x] === E_UNKNOWN) cands.push(x);
    return cands.length ? cands[(rand() * cands.length) | 0] : -1;
  };

  const dfs = (st) => {
    if (++nodes > maxNodes) return null;
    const x = pickBranchEdge(st);
    if (x < 0) return isSolved(emptyFull, st.e) ? st.e : null;
    const tx = em[x];
    const vals = rand() < 0.5 ? [E_ON, E_OFF] : [E_OFF, E_ON];
    for (let vi = 0; vi < 2; vi++) {
      const v = vals[vi];
      const s2 = vi === 0 ? cloneState(st) : st;
      s2.e[x] = v;
      if (!propagate(emptyFull, s2, x)) continue;
      if (tx >= 0 && tx !== x) {
        if (s2.e[tx] === E_UNKNOWN) {
          s2.e[tx] = v;
          if (!propagate(emptyFull, s2, tx)) continue;
        } else if (s2.e[tx] !== v) {
          continue;
        }
      }
      // Fixpoint symmetry closure: any newly propagated edge forces its symmetric partner
      let symOk = true, symChanged = true;
      while (symChanged && symOk) {
        symChanged = false;
        for (let e = 0; e < numEdges; e++) {
          if (edgeA[e] < 0 || s2.e[e] === E_UNKNOWN) continue;
          const te = em[e];
          if (te < 0 || te === e) continue;
          if (s2.e[te] === E_UNKNOWN) {
            s2.e[te] = s2.e[e];
            if (!propagate(emptyFull, s2, te)) { symOk = false; break; }
            symChanged = true;
          } else if (s2.e[te] !== s2.e[e]) {
            symOk = false;
            break;
          }
        }
      }
      if (!symOk) continue;
      const got = dfs(s2);
      if (got) return got;
    }
    return null;
  };
  const st0 = initialState(emptyFull);
  // For rot180 on even x odd without voids, the single self-symmetric center edge cannot lie on a simple symmetric cycle
  if (layout === 'rot180' && !emptyFull.hasVoids && (((emptyFull.rows & 1) ^ (emptyFull.cols & 1)) === 1)) {
    for (let e = 0; e < numEdges; e++) if (edgeA[e] >= 0 && em[e] === e) st0.e[e] = E_OFF;
  }
  if (!propagate(emptyFull, st0)) return null;
  return dfs(st0);
}

/**
 * Generate one verified, rated Full-board puzzle (`fullBoard: true`):
 *   - 'full-masyu': circles + full-board rule, verified to REQUIRE the full-board rule (non-unique without it).
 *   - 'full-gray':  all-gray circles + full-board rule, verified to REQUIRE the full-board rule (non-unique without it).
 *   - 'full-lines': zero circles, permanent given loop segments only.
 *   - 'full-walls': zero circles, permanent given walls (X) only.
 *   - 'full-mixed': zero circles, mix of permanent given segments and given walls (supports `layout`: 'rot180'|'mirror').
 *   - 'full-swiss': zero circles, mixed givens on a bipartite-balanced Swiss cheese cutout board.
 */
function generateFullBoardPuzzle({
  rows, cols, style, layout = 'none', voids = null, rand, deadline, maxTierIdx, effectiveMaxTier, targetTier,
  wantUnsolved, allowUnsolved, beginnerOnly, mediumOnly, stripMode, verifyMaxNodes, name,
}) {
  const hasExplicitVoids = Boolean(voids && voids.length > 0);
  if (!hasExplicitVoids && ((rows * cols) & 1)) return null;
  const isSwiss = style === 'full-swiss' || hasExplicitVoids;
  const isGray = style === 'full-gray';
  const isMasyu = style === 'full-masyu' || isGray;
  const symLayout = (!isSwiss && !isMasyu && (layout === 'rot180' || layout === 'mirror')) ? layout : null;
  if (symLayout && isImpossibleSymFull(rows, cols, symLayout)) return null;
  const N = rows * cols;
  const pruneNodeCap = N <= 64 ? 15000 : N <= 100 ? 25000 : 40000;
  const solvedByPropagate = (P) => {
    const st = initialState(P);
    if (!propagate(P, st)) return false;
    for (let x = 0; x < P.numEdges; x++) if (P.edgeA[x] >= 0 && st.e[x] === E_UNKNOWN) return false;
    return isSolved(P, st.e);
  };
  const isWithin = (r) => (allowUnsolved && !r.solved) || (r.solved && TIERS.indexOf(r.tier) <= effectiveMaxTier);
  const baseEmpty = !isSwiss ? compile({ name: 'ef', rows, cols, clues: [], fullBoard: true }) : null;
  const symEm = (symLayout && baseEmpty) ? symEdgeMapFor(baseEmpty, symLayout) : null;

  while (Date.now() < deadline) {
    const useVoids = isSwiss
      ? (hasExplicitVoids ? voids : swissCheeseVoids(rows, cols, rand, { balanced: true }))
      : [];
    if (isSwiss && !useVoids.length) continue;
    const emptyFull = isSwiss
      ? compile({ name: 'ef', rows, cols, clues: [], voids: useVoids, fullBoard: true })
      : baseEmpty;
    if (emptyFull.activeLight !== emptyFull.activeDark) {
      if (hasExplicitVoids) return null;
      continue;
    }
    const isCornerEdge = (x) => {
      const a = emptyFull.edgeA[x], b = emptyFull.edgeB[x];
      const degOf = (i) => {
        let d = 0;
        for (let dir = 0; dir < 4; dir++) if (emptyFull.nb[i * 4 + dir] >= 0) d++;
        return d;
      };
      return degOf(a) === 2 || degOf(b) === 2;
    };

    // Sample a general (or symmetric) random Hamiltonian cycle on emptyFull
    let edges;
    if (symLayout) {
      edges = sampleSymmetricFullLoop(emptyFull, symLayout, rand);
      if (!edges) continue;
    } else {
      const sample = solve(emptyFull, { limit: 1, maxNodes: isSwiss ? 8000 : 4000, rng: rand });
      if (sample.count === 0) continue;
      edges = sample.solutions[0].e;
    }

    if (isMasyu) {
      const compileFM = (clues, extra = {}) => compile({
        name, rows, cols, clues,
        ...(useVoids.length ? { voids: useVoids } : {}),
        fullBoard: true,
        ...extra,
      });
      const { whites, blacks } = allowedClues(rows, cols, edges, emptyFull);
      const whiteSet = isGray ? new Set(whites.map((c) => c.r * cols + c.c)) : null;
      const rawClues = isGray
        ? whites.concat(blacks).map(({ r, c }) => ({ r, c, t: 'G' }))
        : whites.concat(blacks);
      let current = shuffle(rawClues, rand);
      if (current.length < 4) continue;
      const Pfull = compileFM(current);
      let baseTight = solvedByPropagate(Pfull);
      if (!baseTight) {
        if (beginnerOnly && !solvedByRules(Pfull, BEGINNER_UPTO).solved) continue;
        if (!beginnerOnly) {
          const chk = solve(Pfull, { limit: 2, maxNodes: pruneNodeCap });
          if (chk.exceeded || chk.count !== 1) continue;
        }
      }

      // Pass 0: propagation-only pruning
      if (baseTight) {
        for (let i = current.length - 1; i >= 0 && Date.now() < deadline && current.length > 2; i--) {
          const trial = current.slice(0, i).concat(current.slice(i + 1));
          if (solvedByPropagate(compileFM(trial))) current = trial;
        }
      }
      // Pass 1: sound human-rule pruning
      const fastUpto = beginnerOnly ? BEGINNER_UPTO : mediumOnly ? MEDIUM_UPTO : FIRST_LOOKAHEAD;
      shuffle(current, rand);
      for (let i = current.length - 1; i >= 0 && Date.now() < deadline && current.length > 2; i--) {
        const trial = current.slice(0, i).concat(current.slice(i + 1));
        if (solvedByRules(compileFM(trial), fastUpto).solved) current = trial;
      }
      const sortClues = (list) => list.slice().sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
      // Pass 2: exact-search pruning + binary search back to effectiveMaxTier
      let cachedRated = null;
      let skipPass2 = beginnerOnly;
      if (!skipPass2 && mediumOnly && Date.now() < deadline) {
        const r1 = rate(compileFM(sortClues(current)));
        if (!r1.solved || TIERS.indexOf(r1.tier) >= 1) { cachedRated = r1; skipPass2 = true; }
      }
      if (!skipPass2 && Date.now() < deadline) {
        shuffle(current, rand);
        const deepStrip = stripMode === 'deep' || wantUnsolved || targetTier === 'Hard' || targetTier === 'Expert';
        const maxStrips = deepStrip ? current.length : Math.max(2, Math.min(8, Math.ceil(current.length * 0.4)));
        const removed = [];
        for (let i = current.length - 1; i >= 0 && Date.now() < deadline && current.length > 2 && removed.length < maxStrips; i--) {
          const trial = current.slice(0, i).concat(current.slice(i + 1));
          const ex = solve(compileFM(trial), { limit: 2, maxNodes: pruneNodeCap });
          if (ex.exceeded || ex.count !== 1) continue;
          removed.push(current[i]);
          current = trial;
        }
        const rated = rate(compileFM(sortClues(current)));
        if (wantUnsolved || isWithin(rated)) {
          cachedRated = rated;
        } else if (removed.length > 0 && Date.now() < deadline) {
          const base = current;
          let lo = 0, hi = removed.length, bestC = base.concat(removed), bestR = null;
          while (lo + 1 < hi && Date.now() < deadline) {
            const mid = (lo + hi) >> 1;
            const cand = sortClues(base.concat(removed.slice(mid)));
            const r = rate(compileFM(cand));
            if (isWithin(r)) { lo = mid; bestC = cand; bestR = r; }
            else hi = mid;
          }
          current = bestC;
          cachedRated = bestR;
        }
      }

      if (Date.now() >= deadline) break;
      if (isGray) {
        if (current.length < 4 || !current.some((c) => whiteSet.has(c.r * cols + c.c)) || !current.some((c) => !whiteSet.has(c.r * cols + c.c))) continue;
      } else if (!current.some((c) => c.t === 'W') || !current.some((c) => c.t === 'B')) {
        continue;
      }
      current = sortClues(current);

      const P = compileFM(current);
      const rated = cachedRated || rate(P);
      if (wantUnsolved) { if (rated.solved) continue; }
      else if (!rated.solved) { if (!allowUnsolved) continue; }
      else {
        if (TIERS.indexOf(rated.tier) > maxTierIdx) continue;
        if (targetTier && rated.tier !== targetTier) continue;
      }

      // Must GENUINELY require the full-board rule (standard Masyu without fullBoard must have >= 2 solutions!)
      const withoutFull = solve(compileFM(current, { fullBoard: false }), { limit: 2, maxNodes: 50000, rng: rand });
      if (withoutFull.count < 2) continue;

      const verify = solve(P, { limit: 2, maxNodes: verifyMaxNodes });
      if (verify.exceeded || verify.count !== 1) continue;
      const sol = verify.solutions[0];
      if (!isSolved(P, sol.e)) continue;

      P.solution = encodeSolution(P, sol);
      P.rules = rated.rules;
      P.tier = rated.tier;
      P.score = rated.score;
      return P;
    }

    // Zero-circle Full-board puzzles: 'full-lines' | 'full-walls' | 'full-mixed' | 'full-swiss' (with optional symmetry)
    const givenObj = (x, isOn) => {
      const i = x >> 1;
      return { r: (i / cols) | 0, c: i % cols, dir: (x & 1) ? 'V' : 'H', v: isOn ? 1 : 0, _x: x };
    };
    const pool = [];
    for (let x = 0; x < emptyFull.numEdges; x++) {
      if (emptyFull.edgeA[x] < 0) continue;
      const isOn = edges[x] === E_ON;
      if (isOn && isCornerEdge(x)) continue; // corner edges are always forced on step 0
      if (style === 'full-lines' && !isOn) continue;
      if (style === 'full-walls' && isOn) continue;
      pool.push(givenObj(x, isOn));
    }
    const cmpG = (a, b) => ((a.r * cols + a.c) * 2 + (a.dir === 'V' ? 1 : 0)) - ((b.r * cols + b.c) * 2 + (b.dir === 'V' ? 1 : 0));
    const buildGivenUnits = (list) => {
      if (!symEm) return list.map((g) => ({ keys: [g._x], items: [g] }));
      const byX = new Map(list.map((g) => [g._x, g]));
      const used = new Set(), units = [];
      for (const g of list) {
        if (used.has(g._x)) continue;
        const tx = symEm[g._x];
        const orb = (tx >= 0 && tx !== g._x && byX.has(tx)) ? [g._x, tx] : [g._x];
        for (const ox of orb) used.add(ox);
        units.push({ keys: orb, items: orb.map((ox) => byX.get(ox)) });
      }
      return units;
    };
    const stripUnit = (list, u) => {
      const drop = new Set(u.keys);
      return list.filter((g) => !drop.has(g._x));
    };
    const compileG = (list) => compile({
      name, rows, cols, clues: [], voids: useVoids, fullBoard: true,
      givens: list.slice().sort(cmpG),
    });

    let current = pool.slice().sort(cmpG);
    // Pass 0: ultra-fast propagation-only pruning
    for (const u of shuffle(buildGivenUnits(current), rand)) {
      if (Date.now() >= deadline || current.length - u.keys.length < 2) break;
      const trial = stripUnit(current, u);
      if (solvedByPropagate(compileG(trial))) current = trial;
    }
    // Pass 1: sound human-rule pruning
    const fastUpto = beginnerOnly ? BEGINNER_UPTO : mediumOnly ? MEDIUM_UPTO : FIRST_LOOKAHEAD;
    for (const u of shuffle(buildGivenUnits(current), rand)) {
      if (Date.now() >= deadline || current.length - u.keys.length < 2) break;
      const trial = stripUnit(current, u);
      if (solvedByRules(compileG(trial), fastUpto).solved) current = trial;
    }
    // Pass 2: exact-search pruning + binary search back to effectiveMaxTier
    let cachedRated = null;
    let skipPass2 = beginnerOnly;
    if (!skipPass2 && mediumOnly && Date.now() < deadline) {
      const r1 = rate(compileG(current));
      if (!r1.solved || TIERS.indexOf(r1.tier) >= 1) { cachedRated = r1; skipPass2 = true; }
    }
    if (!skipPass2 && Date.now() < deadline) {
      const remUnits = shuffle(buildGivenUnits(current), rand);
      const deepStrip = stripMode === 'deep' || wantUnsolved || targetTier === 'Hard' || targetTier === 'Expert';
      const maxStrips = deepStrip ? remUnits.length : Math.max(2, Math.min(8, Math.ceil(remUnits.length * 0.4)));
      const removed = [];
      for (const u of remUnits) {
        if (Date.now() >= deadline || current.length - u.keys.length < 2 || removed.length >= maxStrips) break;
        const trial = stripUnit(current, u);
        const ex = solve(compileG(trial), { limit: 2, maxNodes: pruneNodeCap });
        if (ex.exceeded || ex.count !== 1) continue;
        removed.push(u.items);
        current = trial;
      }
      const rated = rate(compileG(current));
      if (wantUnsolved || isWithin(rated)) {
        cachedRated = rated;
      } else if (removed.length > 0 && Date.now() < deadline) {
        const base = current;
        let lo = 0, hi = removed.length;
        let bestG = base.concat(...removed).sort(cmpG), bestR = null;
        while (lo + 1 < hi && Date.now() < deadline) {
          const mid = (lo + hi) >> 1;
          const cand = base.concat(...removed.slice(mid)).sort(cmpG);
          const r = rate(compileG(cand));
          if (isWithin(r)) { lo = mid; bestG = cand; bestR = r; }
          else hi = mid;
        }
        current = bestG;
        cachedRated = bestR;
      }
    }

    if (Date.now() >= deadline) break;
    if (style === 'full-mixed' || style === 'full-swiss') {
      let nOn = 0, nOff = 0;
      for (const gv of current) if (gv.v === 1) nOn++; else nOff++;
      if (nOn < 2 || nOff < 2) continue;
    }
    const cleanGivens = current.map(({ r, c, dir, v }) => ({ r, c, dir, v })).sort(cmpG);
    const P = compile({ name, rows, cols, clues: [], voids: useVoids, fullBoard: true, givens: cleanGivens });

    const rated = cachedRated || rate(P);
    if (wantUnsolved) { if (rated.solved) continue; }
    else if (!rated.solved) { if (!allowUnsolved) continue; }
    else {
      if (TIERS.indexOf(rated.tier) > maxTierIdx) continue;
      if (targetTier && rated.tier !== targetTier) continue;
    }

    const verify = solve(P, { limit: 2, maxNodes: verifyMaxNodes });
    if (verify.exceeded || verify.count !== 1) continue;
    const sol = verify.solutions[0];
    if (!isSolved(P, sol.e)) continue;
    // Must genuinely require the full-board rule (non-fullBoard must have >= 2 solutions)
    const noFull = compile({ name: 'nf', rows, cols, clues: [], voids: useVoids, givens: cleanGivens });
    if (solve(noFull, { limit: 2, maxNodes: 50000, rng: rand }).count < 2) continue;

    P.solution = encodeSolution(P, sol);
    P.rules = rated.rules;
    P.tier = rated.tier;
    P.score = rated.score;
    return P;
  }
  return null;
}

// ------------------------------------------------------------ Shaped / Cutout boards (Swiss cheese)

/** Generate organic random interior cutouts ("Swiss cheese") on `rows x cols` with no dead ends. */
export function swissCheeseVoids(rows, cols, rng, { minHoles = null, maxHoles = null, balanced = false } = {}) {
  const area = rows * cols;
  const loHoles = minHoles ?? Math.max(3, Math.round(area * 0.032));
  const hiHoles = maxHoles ?? Math.max(loHoles + 2, Math.round(area * 0.052));
  const stamps = balanced ? [
    [[0, 0], [0, 1]],                               // 1x2 domino (1 light + 1 dark)
    [[0, 0], [1, 0]],                               // 2x1 domino (1 light + 1 dark)
    [[0, 0], [0, 1], [1, 0], [1, 1]],               // 2x2 pocket (2 light + 2 dark)
  ] : [
    [[0, 0]],                                       // 1x1 pinhole
    [[0, 0]],                                       // 1x1 pinhole (higher weight)
    [[0, 0], [0, 1]],                               // 1x2 bar
    [[0, 0], [1, 0]],                               // 2x1 bar
    [[0, 0], [0, 1], [1, 0], [1, 1]],               // 2x2 pocket
    [[0, 0], [0, 1], [1, 0]],                       // 3-cell L pocket
  ];
  if (rows >= 12 && cols >= 12) {
    stamps.push(
      [[0, 0], [0, 1], [1, 0], [1, 1]],                             // extra 2x2 weight on big boards
      [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]],             // 2x3 pocket
      [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]],             // 3x2 pocket
    );
  }
  if (!balanced && (rows >= 16 || cols >= 16)) {
    stamps.push(
      [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]], // 3x3 chunk
    );
  }
  const grid = new Uint8Array(rows * cols);
  const targetHoles = loHoles + ((rng() * (hiHoles - loHoles + 1)) | 0);
  const voids = [];
  let holes = 0;
  const maxTries = Math.max(140, targetHoles * 35);
  for (let tries = 0; tries < maxTries && holes < targetHoles; tries++) {
    const stamp = stamps[(rng() * stamps.length) | 0];
    const r0 = 1 + ((rng() * (rows - 2)) | 0);
    const c0 = 1 + ((rng() * (cols - 2)) | 0);
    let ok = true;
    const cells = [];
    for (const [dr, dc] of stamp) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 1 || r >= rows - 1 || c < 1 || c >= cols - 1) { ok = false; break; }
      cells.push([r, c]);
    }
    if (!ok) continue;
    // Keep at least 1 active cell separating distinct holes (orthogonal & diagonal) so every hole is crisp
    for (const [r, c] of cells) {
      for (let nr = r - 1; nr <= r + 1 && ok; nr++) {
        for (let nc = c - 1; nc <= c + 1; nc++) {
          if (grid[nr * cols + nc]) { ok = false; break; }
        }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    for (const [r, c] of cells) {
      grid[r * cols + c] = 1;
      voids.push({ r, c });
    }
    holes++;
  }
  voids.sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
  return voids;
}

/**
 * Dual-face loop representation for any shaped board (supporting exterior cutouts and interior holes).
 * - Exterior cutout faces (`P.faceExterior`) are pinned to 0.
 * - Regular 4-active-corner faces toggle in O(1) via `canToggle(r, c)`.
 * - Interior hole super-faces (`P.holeList[h]`) toggle all together via an exact single-cycle check.
 */
function makeShapedDualGrid(P) {
  const { rows, cols, N, isVoid, faceExterior, faceHoleId, holeList } = P;
  const fr = rows - 1, fc = cols - 1, F = fr * fc;
  const inS = new Uint8Array(F);
  const regFaces = [];
  for (let f = 0; f < F; f++) {
    if (faceExterior && faceExterior[f]) continue;
    if (faceHoleId && faceHoleId[f] >= 0) continue;
    regFaces.push(f);
  }
  const at = (r, c) => {
    if (r < 0 || c < 0 || r >= fr || c >= fc) return 0;
    return inS[r * fc + c];
  };
  const canToggleReg = (r, c) => {
    const a0 = at(r - 1, c), a1 = at(r - 1, c + 1), a2 = at(r, c + 1), a3 = at(r + 1, c + 1);
    const a4 = at(r + 1, c), a5 = at(r + 1, c - 1), a6 = at(r, c - 1), a7 = at(r - 1, c - 1);
    const orth = a0 + a2 + a4 + a6;
    if (orth === 0 || orth === 4) return false;
    const trans = (a0 !== a1) + (a1 !== a2) + (a2 !== a3) + (a3 !== a4)
      + (a4 !== a5) + (a5 !== a6) + (a6 !== a7) + (a7 !== a0);
    return trans === 2;
  };
  const toEdges = () => {
    const edges = new Int8Array(2 * N);
    edges.fill(E_OFF);
    const deg = new Uint8Array(N);
    let loopCells = 0, start = -1, valid = true;
    for (let x = 0; x < P.numEdges; x++) {
      const a = P.edgeA[x];
      if (a < 0) continue;
      const r = (a / cols) | 0, c = a % cols;
      const on = (x & 1) === 0
        ? (at(r - 1, c) ^ at(r, c))
        : (at(r, c - 1) ^ at(r, c));
      if (on) {
        edges[x] = E_ON;
        const b = P.edgeB[x];
        deg[a]++; deg[b]++;
      }
    }
    for (let i = 0; i < N; i++) {
      if (deg[i] === 2) { loopCells++; if (start < 0) start = i; }
      else if (deg[i] !== 0) valid = false;
    }
    if (valid && loopCells >= 4) {
      let prev = -1, cur = start, steps = 0;
      do {
        let nxt = -1;
        for (let d = 0; d < 4; d++) {
          const x = P.ed[cur * 4 + d];
          if (x >= 0 && edges[x] === E_ON) {
            const j = P.nb[cur * 4 + d];
            if (j !== prev) { nxt = j; break; }
          }
        }
        if (nxt < 0) { valid = false; break; }
        prev = cur; cur = nxt; steps++;
      } while (cur !== start && steps <= loopCells);
      if (steps !== loopCells) valid = false;
    } else {
      valid = false;
    }
    return { edges, loopCells, valid };
  };
  const tryToggleHole = (hid) => {
    const grp = holeList[hid];
    const cur = inS[grp[0]];
    const next = cur ? 0 : 1;
    for (let i = 0; i < grp.length; i++) inS[grp[i]] = next;
    const res = toEdges();
    if (!res.valid) {
      for (let i = 0; i < grp.length; i++) inS[grp[i]] = cur;
      return false;
    }
    return true;
  };
  return { fr, fc, F, inS, regFaces, holeList: holeList || [], at, canToggleReg, tryToggleHole, toEdges };
}

/** Generate a random simple closed loop on compiled empty shaped board `P`. */
export function randomShapedLoop(P, rng, { targetFill = null, steps = null } = {}) {
  const g = makeShapedDualGrid(P);
  const { fr, fc, F, inS, regFaces, holeList, at, canToggleReg, tryToggleHole, toEdges } = g;
  const activeFaces = regFaces.length + holeList.reduce((acc, h) => acc + h.length, 0);
  if (activeFaces === 0) throw new Error('shaped board has no dual faces');

  // Seed either an interior hole (so loops wrap around donuts!) or a random regular face
  let faceCount = 0;
  if (holeList.length > 0 && (regFaces.length === 0 || rng() < 0.55)) {
    const grp = holeList[(rng() * holeList.length) | 0];
    for (const f of grp) inS[f] = 1;
    faceCount = grp.length;
  } else {
    const f0 = regFaces[(rng() * regFaces.length) | 0];
    inS[f0] = 1;
    faceCount = 1;
  }

  const wantFrac = targetFill ?? (0.42 + 0.24 * rng());
  const totalSteps = steps ?? Math.max(120, F * 18);
  for (let s = 0; s < totalSteps; s++) {
    if (holeList.length > 0 && rng() < 0.14) {
      const hid = (rng() * holeList.length) | 0;
      const grp = holeList[hid];
      const was = inS[grp[0]];
      if (was && faceCount <= grp.length) continue;
      if (tryToggleHole(hid)) faceCount += was ? -grp.length : grp.length;
      continue;
    }
    if (!regFaces.length) continue;
    const f = regFaces[(rng() * regFaces.length) | 0];
    const r = (f / fc) | 0, c = f % fc;
    const cur = inS[f];
    if (cur && faceCount <= 2) continue;
    if (!canToggleReg(r, c)) continue;
    const frac = faceCount / activeFaces;
    if (!cur && frac > wantFrac + 0.14 && rng() < 0.72) continue;
    if (cur && frac < wantFrac - 0.14 && rng() < 0.72) continue;
    const orth = at(r - 1, c) + at(r, c + 1) + at(r + 1, c) + at(r, c - 1);
    if (!cur && orth === 2 && rng() < 0.3) continue;
    inS[f] = cur ? 0 : 1;
    faceCount += cur ? -1 : 1;
  }
  const res = toEdges();
  return { ...res, grid: g };
}

/**
 * Generate one verified, rated Shaped / Cutout Masyu puzzle for explicit `voids` (or named shape / swiss-cheese).
 */
function generateShapedPuzzle({
  rows, cols, voids, style, rand, deadline, maxTierIdx, effectiveMaxTier, targetTier,
  wantUnsolved, allowUnsolved, beginnerOnly, mediumOnly, stripMode, verifyMaxNodes, name, minFill,
}) {
  const baseGrid = compile({ name: 'sh_empty', rows, cols, voids, clues: [] });
  const minLoopCells = Math.max(10, Math.floor(baseGrid.activeCount * (minFill ?? 0.58)));
  const pruneNodeCap = baseGrid.activeCount <= 64 ? 15000 : 25000;
  const solvedByPropagate = (P) => {
    const st = initialState(P);
    if (!propagate(P, st)) return false;
    for (let x = 0; x < P.numEdges; x++) if (P.edgeA[x] >= 0 && st.e[x] === E_UNKNOWN) return false;
    return isSolved(P, st.e);
  };

  while (Date.now() < deadline) {
    // 1. Build and anneal a shaped loop until all allowed clues uniquely determine it
    const init = randomShapedLoop(baseGrid, rand, { targetFill: 0.45 + 0.25 * rand() });
    if (!init.valid) continue;
    const { fr, fc, inS, regFaces, holeList, canToggleReg, tryToggleHole, toEdges } = init.grid;

    const evalCur = () => {
      const { edges, loopCells, valid } = toEdges();
      if (!valid) return null;
      const { whites, blacks } = allowedClues(rows, cols, edges, baseGrid);
      const clues = whites.concat(blacks);
      const P = compile({ name: 'sh_a', rows, cols, voids, clues });
      const st = initialState(P);
      propagate(P, st);
      let unk = 0;
      const unkEdges = [];
      for (let x = 0; x < P.numEdges; x++) {
        if (P.edgeA[x] >= 0 && st.e[x] === E_UNKNOWN) { unk++; unkEdges.push(x); }
      }
      return { edges, loopCells, clues, P, unk, unkEdges };
    };

    let cur = evalCur();
    if (!cur) continue;
    const maxAnneal = Math.max(250, fr * fc * 4);
    for (let step = 0; step < maxAnneal && Date.now() < deadline; step++) {
      if (cur.unk === 0 && cur.loopCells >= minLoopCells) break;
      let toggledReg = -1, toggledHole = -1;
      if (holeList.length > 0 && rand() < 0.14) {
        const hid = (rand() * holeList.length) | 0;
        if (tryToggleHole(hid)) toggledHole = hid;
      } else if (regFaces.length > 0) {
        let f = -1;
        if (cur.unkEdges.length > 0 && rand() < 0.72) {
          const x = cur.unkEdges[(rand() * cur.unkEdges.length) | 0];
          const a = baseGrid.edgeA[x];
          const ar = (a / cols) | 0, ac = a % cols;
          const cr = Math.max(0, Math.min(fr - 1, ar + ((rand() * 3) | 0) - 1));
          const cc = Math.max(0, Math.min(fc - 1, ac + ((rand() * 3) | 0) - 1));
          const cand = cr * fc + cc;
          if (!baseGrid.faceExterior[cand] && baseGrid.faceHoleId[cand] < 0) f = cand;
        }
        if (f < 0) f = regFaces[(rand() * regFaces.length) | 0];
        const r = (f / fc) | 0, c = f % fc;
        if (canToggleReg(r, c)) {
          inS[f] = inS[f] ? 0 : 1;
          toggledReg = f;
        }
      }
      if (toggledReg < 0 && toggledHole < 0) continue;
      const next = evalCur();
      const curDef = Math.max(0, minLoopCells - cur.loopCells);
      const nextDef = next ? Math.max(0, minLoopCells - next.loopCells) : Infinity;
      const curScore = cur.unk * 4 + curDef * 3;
      const nextScore = next ? next.unk * 4 + nextDef * 3 : Infinity;
      if (next && (nextScore <= curScore || rand() < 0.05)) {
        cur = next;
      } else {
        if (toggledReg >= 0) inS[toggledReg] = inS[toggledReg] ? 0 : 1;
        else tryToggleHole(toggledHole);
      }
    }

    if (cur.unk > 0 || cur.loopCells < minLoopCells || cur.clues.length < 4) continue;
    if (rows >= 12 && cols >= 12) {
      const qs = quadrantStats(rows, cols, cur.edges, cur.clues);
      if (qs.minFill < 0.38 || qs.minClues < 2) continue;
    }

    // 2. Strip clues (Pass 1 fast rules + Pass 2 exact solve + binary search back to targetTier)
    let current = cur.clues.slice().sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
    const fastUpto = beginnerOnly ? RULES.findIndex((r) => r.tier !== 'Beginner') : FIRST_LOOKAHEAD;
    const order1 = shuffle(current.slice(), rand);
    for (const cl of order1) {
      if (Date.now() >= deadline || current.length <= 4) break;
      const trial = current.filter((x) => x !== cl);
      const P = compile({ name, rows, cols, voids, clues: trial });
      if (beginnerOnly ? solvedByRules(P, fastUpto).solved : solvedByPropagate(P)) current = trial;
    }
    if (!beginnerOnly && Date.now() < deadline) {
      const order1b = shuffle(current.slice(), rand);
      const p1Cap = baseGrid.activeCount >= 200 ? 22 : order1b.length;
      let p1Tried = 0;
      for (const cl of order1b) {
        if (Date.now() >= deadline || current.length <= 4 || p1Tried >= p1Cap) break;
        p1Tried++;
        const trial = current.filter((x) => x !== cl);
        if (solvedByRules(compile({ name, rows, cols, voids, clues: trial }), fastUpto).solved) current = trial;
      }
    }

    let cachedRated = null;
    let skipPass2 = beginnerOnly;
    if (!skipPass2 && mediumOnly && Date.now() < deadline) {
      const r1 = rate(compile({ name, rows, cols, voids, clues: current }));
      if (r1.solved && r1.tier === 'Medium') { cachedRated = r1; skipPass2 = true; }
    }
    if (!skipPass2 && Date.now() < deadline) {
      const order2 = shuffle(current.slice(), rand);
      const deepStrip = stripMode === 'deep' || wantUnsolved || targetTier === 'Hard' || targetTier === 'Expert';
      const maxStrips = wantUnsolved
        ? order2.length
        : baseGrid.activeCount >= 200
          ? (deepStrip ? 14 : 5)
          : (deepStrip ? order2.length : Math.max(3, Math.min(10, Math.ceil(order2.length * 0.38))));
      const maxPass2Tries = (wantUnsolved || baseGrid.activeCount < 200) ? order2.length : 50;
      const removed = [];
      let p2Tried = 0;
      for (const cl of order2) {
        if (Date.now() >= deadline || current.length <= 4 || removed.length >= maxStrips || p2Tried >= maxPass2Tries) break;
        p2Tried++;
        const trial = current.filter((x) => x !== cl);
        const ex = solve(compile({ name, rows, cols, voids, clues: trial }), { limit: 2, maxNodes: pruneNodeCap });
        if (ex.exceeded || ex.count !== 1) continue;
        current = trial;
        removed.push(cl);
      }
      const isWithin = (r) => (allowUnsolved && !r.solved) || (r.solved && TIERS.indexOf(r.tier) <= effectiveMaxTier);
      const rated = rate(compile({ name, rows, cols, voids, clues: current }));
      if (wantUnsolved || isWithin(rated)) {
        cachedRated = rated;
      } else if (removed.length > 0 && Date.now() < deadline) {
        const strippedBase = current;
        let lo = 0, hi = removed.length;
        let bestClues = strippedBase.concat(removed).sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
        let bestRated = null;
        while (lo + 1 < hi && Date.now() < deadline) {
          const mid = (lo + hi) >> 1;
          const cand = strippedBase.concat(removed.slice(mid))
            .sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
          const r = rate(compile({ name, rows, cols, voids, clues: cand }));
          if (isWithin(r)) { lo = mid; bestClues = cand; bestRated = r; }
          else hi = mid;
        }
        current = bestClues;
        cachedRated = bestRated;
      }
    }

    if (Date.now() >= deadline) break;
    if (!current.some((c) => c.t === 'W') || !current.some((c) => c.t === 'B')) continue;

    current.sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
    const P = compile({ name, rows, cols, voids, clues: current });

    const rated = cachedRated || rate(P);
    if (wantUnsolved) { if (rated.solved) continue; }
    else if (!rated.solved) { if (!allowUnsolved) continue; }
    else {
      if (TIERS.indexOf(rated.tier) > maxTierIdx) continue;
      if (targetTier && rated.tier !== targetTier) continue;
    }

    const verify = solve(P, { limit: 2, maxNodes: verifyMaxNodes });
    if (verify.exceeded || verify.count !== 1) continue;
    const sol = verify.solutions[0];
    if (!isSolved(P, sol.e)) continue;

    P.solution = encodeSolution(P, sol);
    P.rules = rated.rules;
    P.tier = rated.tier;
    P.score = rated.score;
    return P;
  }
  return null;
}

/**
 * Generate one verified, rated Slitherlink or Slitherlink-hybrid puzzle:
 *   - 'slither'            pure Slitherlink (numbered dual faces only; supports `layout`: 'rot180'|'mirror'|'transpose')
 *   - 'slither-swiss'      Slitherlink on a Swiss cheese cutout board
 *   - 'slither-all3'       pure Slitherlink where every numbered square is a 3
 *   - 'slither-all2-full'  Slitherlink + Hamilton cycle where every numbered square is a 2 (verified full-board necessity)
 *   - 'slither-all3-full'  Slitherlink + Hamilton cycle where every numbered square is a 3 (verified full-board necessity)
 *   - 'slither-masyu'      Slitherlink + Masyu hybrid (verified mutual necessity: neither clue set alone is unique)
 *   - 'slither-all2-masyu' All-2s Slitherlink + Masyu hybrid (verified mutual necessity)
 *   - 'slither-all3-masyu' All-3s Slitherlink + Masyu hybrid (verified mutual necessity)
 *   - 'slither-gray'       Slitherlink + All-gray Masyu circles hybrid (verified mutual necessity)
 *   - 'slither-masyu-swiss' Slitherlink + Masyu on a Swiss cheese cutout board (verified mutual necessity)
 *   - 'slither-full'       Slitherlink + Full board / Hamiltonian cycle (verified full-board necessity)
 *   - 'slither-full-swiss' Slitherlink + Hamilton cycle on a balanced Swiss cheese board (verified full-board necessity)
 */
function generateSlitherPuzzle({
  rows, cols, style, layout = 'none', voids = null, rand, deadline, maxTierIdx, effectiveMaxTier, targetTier,
  wantUnsolved, allowUnsolved, beginnerOnly, mediumOnly, stripMode, verifyMaxNodes, name, minLoopCells,
}) {
  const isAll3 = style === 'slither-all3' || style === 'slither-all3-masyu' || style === 'slither-all3-full';
  const isAll2 = style === 'slither-all2-full' || style === 'slither-all2-masyu';
  const isSingleDigit = isAll3 || isAll2;
  const isFull = style === 'slither-full' || style === 'slither-full-swiss' || style === 'slither-all2-full' || style === 'slither-all3-full';
  const isGray = style === 'slither-gray';
  const isHybrid = style === 'slither-masyu' || style === 'slither-all2-masyu' || style === 'slither-all3-masyu' || isGray || style === 'slither-masyu-swiss';
  const hasExplicitVoids = Boolean(voids && voids.length > 0);
  const isSwiss = style === 'slither-swiss' || style === 'slither-masyu-swiss' || style === 'slither-full-swiss' || hasExplicitVoids;
  const symLayout = (!isSwiss && (layout === 'rot180' || layout === 'mirror' || layout === 'transpose')) ? layout : null;
  if ((isFull || style === 'slither-all3') && !isSwiss && ((rows * cols) & 1)) return null;
  if (symLayout === 'transpose' && rows !== cols) return null;
  if ((isFull || style === 'slither-all3') && symLayout && !isSwiss && isImpossibleSymFull(rows, cols, symLayout)) return null;
  const N = rows * cols;
  const fr = rows - 1, fc = cols - 1;
  const pruneNodeCap = N >= 225 ? 8000 : N <= 64 ? 15000 : N <= 100 ? 25000 : 40000;
  const baseEmpty = !isSwiss ? compile({ name: 'esl', rows, cols, clues: [], fullBoard: isFull }) : null;
  const hamEmpty = (style === 'slither-all3' && !isSwiss) ? compile({ name: 'eham', rows, cols, clues: [], fullBoard: true }) : null;

  const solvedByPropagate = (P) => {
    const st = initialState(P);
    if (!propagate(P, st)) return false;
    for (let x = 0; x < P.numEdges; x++) if (P.edgeA[x] >= 0 && st.e[x] === E_UNKNOWN) return false;
    return isSolved(P, st.e);
  };
  const isWithin = (r) => (allowUnsolved && !r.solved) || (r.solved && TIERS.indexOf(r.tier) <= effectiveMaxTier);
  const fastUpto = beginnerOnly ? BEGINNER_UPTO : mediumOnly ? MEDIUM_UPTO : FIRST_LOOKAHEAD;
  const deepStrip = stripMode === 'deep' || wantUnsolved || targetTier === 'Hard' || targetTier === 'Expert';
  const reqQuadFill = (!isSwiss && rows >= 10 && cols >= 10) ? 0.35 : (!isSwiss && rows >= 8 && cols >= 8) ? 0.28 : 0;
  const reqQuadItems = rows >= 10 && cols >= 10 ? Math.max(2, Math.floor((N / 4) * 0.08)) : 0;
  const minClues = isHybrid ? (N >= 100 ? 6 : N >= 64 ? 5 : 3) : 0;
  const minSlither = isHybrid ? (N >= 100 ? 8 : N >= 64 ? 6 : 4) : Math.max(4, Math.floor(N * 0.08));

  const faceOrbitKeys = (r, c) => {
    if (!symLayout) return [r * fc + c];
    const pts = symLayout === 'rot180' ? [[r, c], [fr - 1 - r, fc - 1 - c]]
      : symLayout === 'mirror' ? [[r, c], [r, fc - 1 - c]]
      : [[r, c], [c, r]];
    return [...new Set(pts.map(([rr, cc]) => rr * fc + cc))];
  };

  while (Date.now() < deadline) {
    const useVoids = isSwiss
      ? ((voids && voids.length) ? voids : swissCheeseVoids(rows, cols, rand, { balanced: isFull }))
      : [];
    if (isSwiss && !useVoids.length) continue;
    const empty = isSwiss
      ? compile({ name: 'esl', rows, cols, clues: [], voids: useVoids, fullBoard: isFull })
      : baseEmpty;
    if (isFull && empty.activeLight !== empty.activeDark) {
      if (hasExplicitVoids) return null;
      continue;
    }
    const compileS = (clues, slither, extra = {}) => compile({
      name, rows, cols, clues, slither,
      ...(useVoids.length ? { voids: useVoids } : {}),
      ...(isFull ? { fullBoard: true } : {}),
      ...extra,
    });

    let edges;
    if (isFull || style === 'slither-all3') {
      const sampleGrid = style === 'slither-all3'
        ? (hamEmpty || compile({ name: 'eham', rows, cols, clues: [], voids: useVoids, fullBoard: true }))
        : empty;
      if (symLayout) {
        edges = sampleSymmetricFullLoop(sampleGrid, symLayout, rand);
        if (!edges) continue;
      } else {
        const sample = solve(sampleGrid, { limit: 1, maxNodes: 4000, rng: rand });
        if (sample.count === 0) continue;
        edges = sample.solutions[0].e;
      }
    } else if (isSwiss) {
      const res = randomShapedLoop(empty, rand, {
        targetFill: 0.44 + 0.14 * rand(),
        steps: Math.max(160, fr * fc * 24),
      });
      const minLoop = Math.max(10, Math.floor(empty.activeCount * 0.48));
      if (!res.valid || res.loopCells < minLoop) continue;
      edges = res.edges;
    } else if (symLayout) {
      const res = randomSymmetricLoop(rows, cols, rand, symLayout, {
        targetFill: 0.44 + 0.14 * rand(),
        steps: Math.max(160, fr * fc * 24),
        empty,
      });
      if (!res || res.loopCells < minLoopCells || res.emptyBorders > 0) continue;
      if (reqQuadFill > 0 && res.minQuadFill < reqQuadFill) continue;
      edges = res.edges;
    } else {
      const res = randomLoop(rows, cols, rand, {
        targetFill: (isAll3 ? 0.56 : 0.44) + 0.14 * rand(),
        steps: Math.max(160, fr * fc * 24),
      });
      if (res.loopCells < minLoopCells || res.emptyBorders > 0) continue;
      if (reqQuadFill > 0 && res.minQuadFill < reqQuadFill) continue;
      edges = res.edges;
    }

    let slitherInit = allowedSlither(rows, cols, edges, empty);
    if (isAll3) slitherInit = slitherInit.filter((s) => s.n === 3);
    else if (isAll2) slitherInit = slitherInit.filter((s) => s.n === 2);

    let cluesInit = [];
    if (isHybrid) {
      const { whites, blacks } = allowedClues(rows, cols, edges, empty);
      cluesInit = isGray
        ? whites.concat(blacks).map(({ r, c }) => ({ r, c, t: 'G' }))
        : whites.concat(blacks);
      if (cluesInit.length < Math.max(4, minClues)) continue;
    }
    if (slitherInit.length < Math.max(4, minSlither)) continue;

    // Canonical initial order (clues sorted by cell index, slither sorted by face index)
    cluesInit.sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
    slitherInit.sort((a, b) => (a.r * fc + a.c) - (b.r * fc + b.c));

    // Verify full pool is uniquely solvable before stripping
    const P0 = compileS(cluesInit, slitherInit);
    let baseTight = solvedByPropagate(P0);
    let p0FastOk = baseTight;
    if (!baseTight) {
      if (beginnerOnly) {
        if (!solvedByRules(P0, BEGINNER_UPTO).solved) continue;
        p0FastOk = true;
      } else {
        p0FastOk = solvedByRules(P0, fastUpto).solved;
        if (!p0FastOk) {
          const ex = solve(P0, { limit: 2, maxNodes: pruneNodeCap });
          if (ex.exceeded || ex.count !== 1) continue;
        }
        if (mediumOnly && !p0FastOk) {
          const r0 = rate(P0);
          if (!r0.solved || TIERS.indexOf(r0.tier) > 1) continue;
        }
      }
    }

    // Track active items via O(1) Uint8Array mask (always extracts canonically sorted clues & slither!)
    const totalItems = cluesInit.length + slitherInit.length;
    const cLen = cluesInit.length;
    const active = new Uint8Array(totalItems).fill(1);
    let nC = cLen, nS = slitherInit.length;

    // Build stripping units (single items normally, or symmetric orbits when symLayout is set)
    const allUnits = [];
    if (!symLayout) {
      for (let i = 0; i < totalItems; i++) allUnits.push({ idxs: [i], isC: i < cLen });
    } else {
      const cByKey = new Map();
      for (let i = 0; i < cLen; i++) cByKey.set(cluesInit[i].r * cols + cluesInit[i].c, i);
      const usedC = new Set();
      for (let i = 0; i < cLen; i++) {
        if (usedC.has(i)) continue;
        const orb = clueOrbitKeys(symLayout, rows, cols, cluesInit[i].r, cluesInit[i].c)
          .map((k) => cByKey.get(k))
          .filter((x) => x !== undefined);
        for (const x of orb) usedC.add(x);
        allUnits.push({ idxs: orb, isC: true });
      }
      const sByKey = new Map();
      for (let i = 0; i < slitherInit.length; i++) sByKey.set(slitherInit[i].r * fc + slitherInit[i].c, cLen + i);
      const usedS = new Set();
      for (let i = 0; i < slitherInit.length; i++) {
        const idx = cLen + i;
        if (usedS.has(idx)) continue;
        const orb = faceOrbitKeys(slitherInit[i].r, slitherInit[i].c)
          .map((k) => sByKey.get(k))
          .filter((x) => x !== undefined);
        for (const x of orb) usedS.add(x);
        allUnits.push({ idxs: orb, isC: false });
      }
    }

    const extractActive = (skipIdxs = null) => {
      const s0 = skipIdxs && skipIdxs.length > 0 ? skipIdxs[0] : -1;
      const s1 = skipIdxs && skipIdxs.length > 1 ? skipIdxs[1] : -1;
      const cs = [], ss = [];
      for (let i = 0; i < cLen; i++) if (active[i] && i !== s0 && i !== s1) cs.push(cluesInit[i]);
      for (let i = 0; i < slitherInit.length; i++) {
        const idx = cLen + i;
        if (active[idx] && idx !== s0 && idx !== s1) ss.push(slitherInit[i]);
      }
      return { clues: cs, slither: ss };
    };
    const buildUnits = () => {
      const us = allUnits.filter((u) => active[u.idxs[0]]);
      if (isHybrid) {
        const keyed = us.map((u) => ({ u, k: (!u.isC ? 0 : 0.22) + rand() }));
        keyed.sort((a, b) => a.k - b.k);
        return keyed.map((x) => x.u);
      }
      return shuffle(us, rand);
    };
    const canDrop = (u) => (u.isC ? nC - u.idxs.length >= minClues : nS - u.idxs.length >= minSlither);
    const dropUnit = (u) => {
      for (const idx of u.idxs) active[idx] = 0;
      if (u.isC) nC -= u.idxs.length; else nS -= u.idxs.length;
    };

    // Pass 0: ultra-fast propagation-only pruning
    if (baseTight) {
      for (const u of buildUnits()) {
        if (Date.now() >= deadline) break;
        if (!canDrop(u)) continue;
        const { clues: tc, slither: ts } = extractActive(u.idxs);
        if (solvedByPropagate(compileS(tc, ts))) dropUnit(u);
      }
    }

    // Pass 1: sound human-rule pruning (capped on large boards; skip if full pool wasn't solved by fastUpto)
    if (p0FastOk) {
      const p1Units = buildUnits();
      const pass1Cap = N >= 200 ? 24 : p1Units.length;
      for (let k = 0; k < p1Units.length && k < pass1Cap; k++) {
        if (Date.now() >= deadline) break;
        const u = p1Units[k];
        if (!canDrop(u)) continue;
        const { clues: tc, slither: ts } = extractActive(u.idxs);
        if (solvedByRules(compileS(tc, ts), fastUpto).solved) dropUnit(u);
      }
    }

    // Pass 2: exact uniqueness pruning + binary-search rollback to stay within effectiveMaxTier
    let cachedRated = null;
    let skipPass2 = beginnerOnly;
    let r1Pre = null;
    if (!skipPass2 && mediumOnly && Date.now() < deadline) {
      const { clues: tc, slither: ts } = extractActive();
      r1Pre = rate(compileS(tc, ts));
      if (!r1Pre.solved || TIERS.indexOf(r1Pre.tier) >= 1) {
        cachedRated = r1Pre;
        skipPass2 = true;
      }
    }
    if (!skipPass2 && Date.now() < deadline) {
      const rem = buildUnits();
      const maxStrips = N >= 225 && !wantUnsolved ? (deepStrip ? 8 : 4)
        : deepStrip ? rem.length
        : (stripMode === 'medium' || targetTier === 'Medium') ? Math.max(2, Math.min(8, Math.ceil(rem.length * 0.30)))
        : Math.max(3, Math.min(12, Math.ceil(rem.length * 0.50)));
      const maxPass2Tries = N >= 200 && !wantUnsolved ? 40 : rem.length;
      let stripped = 0, tried = 0;
      const removed = [];
      for (const u of rem) {
        if (Date.now() >= deadline || stripped >= maxStrips || tried >= maxPass2Tries) break;
        if (!canDrop(u)) continue;
        tried++;
        const { clues: tc, slither: ts } = extractActive(u.idxs);
        const exact = solve(compileS(tc, ts), { limit: 2, maxNodes: pruneNodeCap });
        if (exact.exceeded || exact.count !== 1) continue;
        dropUnit(u);
        removed.push(u.idxs);
        stripped++;
      }

      const { clues: cNow, slither: sNow } = extractActive();
      const rated = (removed.length === 0 && r1Pre) ? r1Pre : rate(compileS(cNow, sNow));
      if (wantUnsolved || isWithin(rated)) {
        cachedRated = rated;
      } else if (removed.length > 0 && Date.now() < deadline) {
        let lo = 0, hi = removed.length;
        let bestMid = 0;
        let bestRated = (r1Pre && isWithin(r1Pre)) ? r1Pre : null;
        while (lo + 1 < hi && Date.now() < deadline) {
          const mid = (lo + hi) >> 1;
          for (let j = mid; j < removed.length; j++) for (const idx of removed[j]) active[idx] = 1;
          const { clues: cc, slither: cs } = extractActive();
          for (let j = mid; j < removed.length; j++) for (const idx of removed[j]) active[idx] = 0;
          const r = rate(compileS(cc, cs));
          if (isWithin(r)) {
            lo = mid;
            bestMid = mid;
            bestRated = r;
          } else {
            hi = mid;
          }
        }
        for (let j = bestMid; j < removed.length; j++) for (const idx of removed[j]) active[idx] = 1;
        cachedRated = bestRated;
      }
    }

    if (Date.now() >= deadline) break;
    const fin = extractActive();
    if (fin.slither.length < minSlither) continue;
    if (!isSingleDigit) {
      const distinctDigits = new Set(fin.slither.map((s) => s.n));
      if (distinctDigits.size < 2) continue;
    }

    if (isHybrid) {
      if (isGray) {
        if (fin.clues.length < minClues) continue;
      } else {
        const nW = fin.clues.filter((c) => c.t === 'W').length;
        const nB = fin.clues.filter((c) => c.t === 'B').length;
        if (fin.clues.length < minClues || (rows >= 5 && cols >= 5 && (nW < 1 || nB < 1))) continue;
      }
    }
    if (reqQuadItems > 0) {
      const midR = rows >> 1, midC = cols >> 1;
      const fMidR = fr >> 1, fMidC = fc >> 1;
      const qCnt = [0, 0, 0, 0];
      for (const c of fin.clues) qCnt[(c.r >= midR ? 2 : 0) + (c.c >= midC ? 1 : 0)]++;
      for (const s of fin.slither) qCnt[(s.r >= fMidR ? 2 : 0) + (s.c >= fMidC ? 1 : 0)]++;
      if (Math.min(...qCnt) < reqQuadItems) continue;
    }

    const P = compileS(fin.clues, fin.slither);

    // Check tier filter BEFORE expensive exact verification & necessity searches
    const rated = cachedRated || rate(P);
    if (wantUnsolved) {
      if (rated.solved) continue;
    } else if (!rated.solved) {
      if (!allowUnsolved) continue;
    } else {
      if (TIERS.indexOf(rated.tier) > maxTierIdx) continue;
      if (targetTier && rated.tier !== targetTier) continue;
    }

    // Independent exact verification
    const verify = solve(P, { limit: 2, maxNodes: verifyMaxNodes });
    if (verify.exceeded || verify.count !== 1) continue;
    const sol = verify.solutions[0];
    if (!isSolved(P, sol.e)) continue;

    // Hybrid necessity checks: fast-reject via propagation, then single capped randomized search
    const hasSecondSol = (altP) => {
      if (solvedByPropagate(altP)) return false;
      return solve(altP, { limit: 2, maxNodes: 30000, rng: rand }).count >= 2;
    };
    if (isHybrid) {
      if (!hasSecondSol(compileS([], fin.slither, { name: `${name}_s` }))) continue;
      if (!hasSecondSol(compileS(fin.clues, [], { name: `${name}_m` }))) continue;
    } else if (isFull) {
      if (!hasSecondSol(compileS([], fin.slither, { name: `${name}_nf`, fullBoard: false }))) continue;
    }

    P.solution = encodeSolution(P, sol);
    P.rules = rated.rules;
    P.tier = rated.tier;
    P.score = rated.score;
    return P;
  }
  return null;
}

/**
 * Generate one verified, rated Mid-loop or Mid-loop hybrid puzzle:
 *   - 'midloop'         pure Mid-loop (teal midpoint dots only; supports `layout`: 'rot180'|'mirror'|'transpose'|'interior'|'frame')
 *   - 'midloop-swiss'   pure Mid-loop on a Swiss cheese cutout board
 *   - 'midloop-even'    pure Mid-loop with intersection dots only (every clued run has even length 2, 4, 6...)
 *   - 'midloop-odd'     pure Mid-loop with edge-midpoint dots only (every clued run has odd length 1, 3, 5...)
 *   - 'midloop-long'    pure Mid-loop with no length-1 runs (every clued run has length >= 2; odd dots >= 3)
 *   - 'midloop-masyu'   Mid-loop + Masyu hybrid (verified mutual necessity)
 *   - 'midloop-gray'    Mid-loop + All-gray Masyu circles hybrid (verified mutual necessity)
 *   - 'midloop-slither' Mid-loop + Slitherlink hybrid (verified mutual necessity)
 *   - 'midloop-full'    Mid-loop + Hamilton cycle hybrid (verified full-board necessity)
 */
function generateMidloopPuzzle({
  rows, cols, style, layout = 'none', voids = null, rand, deadline, maxTierIdx, effectiveMaxTier, targetTier,
  wantUnsolved, allowUnsolved, beginnerOnly, mediumOnly, stripMode, verifyMaxNodes, name, minLoopCells,
}) {
  const isFull = style === 'midloop-full';
  const isGray = style === 'midloop-gray';
  const isMasyu = style === 'midloop-masyu' || isGray;
  const isSlither = style === 'midloop-slither' || style === 'midloop-slither-swiss' || style === 'midloop-slither2';
  const isSlitherAll2 = style === 'midloop-slither2';
  const isEvenOnly = style === 'midloop-even';
  const isOddOnly = style === 'midloop-odd';
  const isLongOnly = style === 'midloop-long';
  const hasExplicitVoids = Boolean(voids && voids.length > 0);
  const isSwiss = style === 'midloop-swiss' || style === 'midloop-slither-swiss' || hasExplicitVoids;
  const symLayout = (!isSwiss && (layout === 'rot180' || layout === 'mirror' || layout === 'transpose')) ? layout : null;
  const regionLayout = (!isSwiss && (layout === 'interior' || layout === 'frame')) ? layout : null;
  if (layout && layout !== 'none' && !symLayout && !regionLayout) return null;
  if (symLayout === 'transpose' && rows !== cols) return null;
  if (isFull && symLayout && !isSwiss && isImpossibleSymFull(rows, cols, symLayout)) return null;
  if (isFull && !isSwiss && ((rows * cols) & 1)) return null;
  const N = rows * cols;
  const fr = rows - 1, fc = cols - 1;
  const pruneNodeCap = N >= 225 ? 8000 : N >= 200 ? 10000 : N <= 64 ? 15000 : 25000;
  const baseEmpty = !isSwiss ? compile({
    name: 'eml', rows, cols, clues: [],
    ...(isFull ? { fullBoard: true } : {}),
  }) : null;
  if (isFull && !isSwiss && baseEmpty.activeLight !== baseEmpty.activeDark) return null;

  const solvedByPropagate = (P) => {
    const st = initialState(P);
    if (!propagate(P, st)) return false;
    for (let x = 0; x < P.numEdges; x++) if (P.edgeA[x] >= 0 && st.e[x] === E_UNKNOWN) return false;
    return isSolved(P, st.e);
  };
  const isWithin = (r) => (allowUnsolved && !r.solved) || (r.solved && TIERS.indexOf(r.tier) <= effectiveMaxTier);
  const fastUpto = beginnerOnly ? BEGINNER_UPTO : mediumOnly ? MEDIUM_UPTO : FIRST_LOOKAHEAD;
  const deepStrip = stripMode === 'deep' || wantUnsolved || targetTier === 'Hard' || targetTier === 'Expert';
  const reqQuadFill = (!isSwiss && rows >= 10 && cols >= 10) ? 0.35 : (!isSwiss && rows >= 8 && cols >= 8) ? 0.28 : 0;
  const reqQuadItems = (!isSwiss && !regionLayout && rows >= 10 && cols >= 10) ? Math.max(2, Math.floor((N / 4) * 0.08)) : 0;
  const minClues = isMasyu ? (N >= 100 ? 5 : N >= 64 ? 4 : 3) : 0;
  const minSlither = isSlither ? (N >= 100 ? 7 : N >= 64 ? 5 : 4) : 0;
  const minMid = (isMasyu || isSlither) ? (N >= 100 ? 6 : N >= 64 ? 5 : 4)
    : (isEvenOnly || isLongOnly || regionLayout) ? Math.max(4, Math.floor(N * 0.07))
    : Math.max(4, Math.floor(N * 0.10));

  const dirCode = (d) => (d === 'C' ? 0 : d === 'H' ? 1 : 2);
  const midKey = (r, c, dir) => (r * cols + c) * 3 + dirCode(dir);
  const midOrbitKeys = (r, c, dir) => {
    const k0 = midKey(r, c, dir);
    if (!symLayout) return [k0];
    let r2, c2, d2 = dir;
    if (symLayout === 'rot180') {
      r2 = dir === 'V' ? rows - 2 - r : rows - 1 - r;
      c2 = dir === 'H' ? cols - 2 - c : cols - 1 - c;
    } else if (symLayout === 'mirror') {
      r2 = r;
      c2 = dir === 'H' ? cols - 2 - c : cols - 1 - c;
    } else {
      r2 = c;
      c2 = r;
      d2 = dir === 'H' ? 'V' : dir === 'V' ? 'H' : 'C';
    }
    const k1 = midKey(r2, c2, d2);
    return k1 === k0 ? [k0] : [k0, k1];
  };
  const faceOrbitKeys = (r, c) => {
    if (!symLayout) return [r * fc + c];
    const r2 = symLayout === 'rot180' ? fr - 1 - r : symLayout === 'mirror' ? r : c;
    const c2 = symLayout === 'rot180' ? fc - 1 - c : symLayout === 'mirror' ? fc - 1 - c : r;
    const k0 = r * fc + c, k1 = r2 * fc + c2;
    return k1 === k0 ? [k0] : [k0, k1];
  };

  while (Date.now() < deadline) {
    const useVoids = isSwiss
      ? ((voids && voids.length) ? voids : swissCheeseVoids(rows, cols, rand))
      : [];
    if (isSwiss && !useVoids.length) continue;
    const empty = isSwiss
      ? compile({ name: 'eml', rows, cols, clues: [], voids: useVoids, ...(isFull ? { fullBoard: true } : {}) })
      : baseEmpty;
    if (isFull && empty.activeLight !== empty.activeDark) {
      if (hasExplicitVoids) return null;
      continue;
    }
    const compileM = (clues, slither, midloop, extra = {}) => compile({
      name, rows, cols, clues,
      ...(slither.length ? { slither } : {}),
      ...(midloop.length ? { midloop } : {}),
      ...(useVoids.length ? { voids: useVoids } : {}),
      ...(isFull ? { fullBoard: true } : {}),
      ...extra,
    });

    let edges;
    if (isFull) {
      if (symLayout) {
        edges = sampleSymmetricFullLoop(empty, symLayout, rand);
        if (!edges) continue;
      } else {
        const sample = solve(empty, { limit: 1, maxNodes: 4000, rng: rand });
        if (sample.count === 0) continue;
        edges = sample.solutions[0].e;
      }
    } else if (isSwiss) {
      const res = randomShapedLoop(empty, rand, { targetFill: 0.45 + 0.16 * rand(), steps: Math.max(160, fr * fc * 24) });
      if (!res.valid || res.loopCells < Math.max(10, Math.floor(empty.activeCount * 0.48))) continue;
      edges = res.edges;
    } else if (symLayout) {
      const res = randomSymmetricLoop(rows, cols, rand, symLayout, {
        targetFill: 0.44 + 0.16 * rand(),
        steps: Math.max(160, fr * fc * 24),
        empty,
      });
      if (!res || res.loopCells < minLoopCells || res.emptyBorders > 0) continue;
      if (reqQuadFill > 0 && res.minQuadFill < reqQuadFill) continue;
      edges = res.edges;
    } else {
      const res = randomLoop(rows, cols, rand, {
        targetFill: 0.44 + 0.16 * rand(),
        steps: Math.max(160, fr * fc * 24),
      });
      if (res.loopCells < minLoopCells || res.emptyBorders > 0) continue;
      if (reqQuadFill > 0 && res.minQuadFill < reqQuadFill) continue;
      edges = res.edges;
    }

    let midInit = allowedMidloop(rows, cols, edges, empty, isLongOnly);
    if (isEvenOnly) {
      midInit = midInit.filter((m) => m.dir === 'C');
    } else if (isOddOnly) {
      midInit = midInit.filter((m) => m.dir !== 'C');
    } else if (isLongOnly) {
      midInit = midInit.filter((m) => m.len >= 2).map(({ r, c, dir }) => ({ r, c, dir }));
    }
    if (regionLayout === 'interior') {
      // No dot touching the outer border ring
      midInit = midInit.filter((m) => {
        if (m.dir === 'C') return m.r > 0 && m.r < rows - 1 && m.c > 0 && m.c < cols - 1;
        if (m.dir === 'H') return m.r > 0 && m.r < rows - 1 && m.c > 0 && m.c < cols - 2;
        return m.r > 0 && m.r < rows - 2 && m.c > 0 && m.c < cols - 1;
      });
    } else if (regionLayout === 'frame') {
      // Dots only in the outer frame, leaving a blank hollow center box
      const padR = rows >= 9 ? 3 : 2;
      const padC = cols >= 9 ? 3 : 2;
      midInit = midInit.filter((m) => {
        const rr = m.dir === 'V' ? m.r + 0.5 : m.r;
        const cc = m.dir === 'H' ? m.c + 0.5 : m.c;
        return rr < padR || rr > rows - 1 - padR || cc < padC || cc > cols - 1 - padC;
      });
    }
    let cluesInit = [];
    let slitherInit = [];
    let whiteSet = null;
    if (isMasyu) {
      const { whites, blacks } = allowedClues(rows, cols, edges, empty);
      if (isGray) whiteSet = new Set(whites.map((c) => c.r * cols + c.c));
      const allC = isGray ? whites.concat(blacks).map(({ r, c }) => ({ r, c, t: 'G' })) : whites.concat(blacks);
      const midCSet = new Set(midInit.filter((m) => m.dir === 'C').map((m) => m.r * cols + m.c));
      const dropMidC = new Set();
      if (!symLayout) {
        for (const cl of allC) {
          const ci = cl.r * cols + cl.c;
          if (midCSet.has(ci)) {
            if (rand() < 0.5) { dropMidC.add(ci); cluesInit.push(cl); }
          } else {
            cluesInit.push(cl);
          }
        }
      } else {
        const keepAsClue = new Map();
        for (const cl of allC) {
          const ci = cl.r * cols + cl.c;
          if (!midCSet.has(ci)) { cluesInit.push(cl); continue; }
          const orb = clueOrbitKeys(symLayout, rows, cols, cl.r, cl.c);
          const rep = Math.min(...orb);
          if (!keepAsClue.has(rep)) keepAsClue.set(rep, rand() < 0.5);
          if (keepAsClue.get(rep)) { dropMidC.add(ci); cluesInit.push(cl); }
        }
      }
      if (dropMidC.size) midInit = midInit.filter((m) => m.dir !== 'C' || !dropMidC.has(m.r * cols + m.c));
      if (cluesInit.length < Math.max(4, minClues)) continue;
      cluesInit.sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
    } else if (isSlither) {
      slitherInit = allowedSlither(rows, cols, edges, empty);
      if (isSlitherAll2) slitherInit = slitherInit.filter((s) => s.n === 2);
      if (slitherInit.length < Math.max(4, minSlither)) continue;
      slitherInit.sort((a, b) => (a.r * fc + a.c) - (b.r * fc + b.c));
    }
    if (midInit.length < Math.max(4, minMid)) continue;

    // Verify full pool is uniquely solvable (note: propagateMidloopDot uses Medium logic, so beginnerOnly must check BEGINNER_UPTO directly)
    const P0 = compileM(cluesInit, slitherInit, midInit);
    let baseTight = false;
    let p0FastOk = false;
    if (beginnerOnly) {
      if (!solvedByRules(P0, BEGINNER_UPTO).solved) continue;
      p0FastOk = true;
    } else {
      baseTight = solvedByPropagate(P0);
      p0FastOk = baseTight || solvedByRules(P0, fastUpto).solved;
      if (!p0FastOk) {
        const ex = solve(P0, { limit: 2, maxNodes: pruneNodeCap });
        if (ex.exceeded || ex.count !== 1) continue;
        if (mediumOnly) {
          const r0 = rate(P0);
          if (!r0.solved || TIERS.indexOf(r0.tier) > 1) continue;
        }
      }
    }

    // Track active items across clues, slither, and midloop via O(1) Uint8Array mask
    const cLen = cluesInit.length, sLen = slitherInit.length, mLen = midInit.length;
    const totalItems = cLen + sLen + mLen;
    const active = new Uint8Array(totalItems).fill(1);
    let nC = cLen, nS = sLen, nM = mLen;

    // Build stripping units (single items normally, or symmetric orbits when symLayout is set)
    const allUnits = [];
    if (!symLayout) {
      for (let i = 0; i < totalItems; i++) {
        allUnits.push({ idxs: [i], kind: i < cLen ? 0 : i < cLen + sLen ? 1 : 2 });
      }
    } else {
      const cByKey = new Map();
      for (let i = 0; i < cLen; i++) cByKey.set(cluesInit[i].r * cols + cluesInit[i].c, i);
      const usedC = new Set();
      for (let i = 0; i < cLen; i++) {
        if (usedC.has(i)) continue;
        const orb = clueOrbitKeys(symLayout, rows, cols, cluesInit[i].r, cluesInit[i].c)
          .map((k) => cByKey.get(k))
          .filter((x) => x !== undefined);
        for (const x of orb) usedC.add(x);
        allUnits.push({ idxs: orb, kind: 0 });
      }
      const sByKey = new Map();
      for (let i = 0; i < sLen; i++) sByKey.set(slitherInit[i].r * fc + slitherInit[i].c, cLen + i);
      const usedS = new Set();
      for (let i = 0; i < sLen; i++) {
        const idx = cLen + i;
        if (usedS.has(idx)) continue;
        const orb = faceOrbitKeys(slitherInit[i].r, slitherInit[i].c)
          .map((k) => sByKey.get(k))
          .filter((x) => x !== undefined);
        for (const x of orb) usedS.add(x);
        allUnits.push({ idxs: orb, kind: 1 });
      }
      const mByKey = new Map();
      for (let i = 0; i < mLen; i++) mByKey.set(midKey(midInit[i].r, midInit[i].c, midInit[i].dir), cLen + sLen + i);
      const usedM = new Set();
      for (let i = 0; i < mLen; i++) {
        const idx = cLen + sLen + i;
        if (usedM.has(idx)) continue;
        const orb = midOrbitKeys(midInit[i].r, midInit[i].c, midInit[i].dir)
          .map((k) => mByKey.get(k))
          .filter((x) => x !== undefined);
        for (const x of orb) usedM.add(x);
        allUnits.push({ idxs: orb, kind: 2 });
      }
    }

    const canDrop = (u) => {
      const k = u.kind, len = u.idxs.length;
      return k === 0 ? nC - len >= minClues : k === 1 ? nS - len >= minSlither : nM - len >= minMid;
    };
    const dropUnit = (u) => {
      for (const idx of u.idxs) active[idx] = 0;
      const len = u.idxs.length;
      if (u.kind === 0) nC -= len; else if (u.kind === 1) nS -= len; else nM -= len;
    };
    const extractActive = (skipIdxs = null) => {
      const s0 = skipIdxs && skipIdxs.length > 0 ? skipIdxs[0] : -1;
      const s1 = skipIdxs && skipIdxs.length > 1 ? skipIdxs[1] : -1;
      const cs = [], ss = [], ms = [];
      for (let i = 0; i < cLen; i++) if (active[i] && i !== s0 && i !== s1) cs.push(cluesInit[i]);
      for (let i = 0; i < sLen; i++) {
        const idx = cLen + i;
        if (active[idx] && idx !== s0 && idx !== s1) ss.push(slitherInit[i]);
      }
      for (let i = 0; i < mLen; i++) {
        const idx = cLen + sLen + i;
        if (active[idx] && idx !== s0 && idx !== s1) ms.push(midInit[i]);
      }
      return { clues: cs, slither: ss, midloop: ms };
    };
    const buildUnits = () => {
      const us = allUnits.filter((u) => active[u.idxs[0]]);
      if (isMasyu || isSlither) {
        const keyed = us.map((u) => ({ u, k: (u.kind === 2 ? 0.15 : 0) + rand() }));
        keyed.sort((a, b) => a.k - b.k);
        return keyed.map((x) => x.u);
      }
      return shuffle(us, rand);
    };

    // Pass 0: ultra-fast propagation-only pruning (skipped for beginnerOnly since propagateMidloopDot uses Medium logic)
    if (baseTight && !beginnerOnly) {
      for (const u of buildUnits()) {
        if (Date.now() >= deadline) break;
        if (!canDrop(u)) continue;
        const t = extractActive(u.idxs);
        if (solvedByPropagate(compileM(t.clues, t.slither, t.midloop))) dropUnit(u);
      }
    }

    // Pass 1: sound human-rule pruning (capped on large boards; skipped if full pool wasn't solved by fastUpto)
    if (p0FastOk) {
      const p1Units = buildUnits();
      const pass1Cap = N >= 200 ? 24 : p1Units.length;
      for (let k = 0; k < p1Units.length && k < pass1Cap; k++) {
        if (Date.now() >= deadline) break;
        const u = p1Units[k];
        if (!canDrop(u)) continue;
        const t = extractActive(u.idxs);
        if (solvedByRules(compileM(t.clues, t.slither, t.midloop), fastUpto).solved) dropUnit(u);
      }
    }

    // Pass 2: exact uniqueness pruning + binary-search rollback to effectiveMaxTier
    let cachedRated = null;
    let skipPass2 = beginnerOnly;
    let r1Pre = null;
    if (!skipPass2 && mediumOnly && Date.now() < deadline) {
      const t = extractActive();
      r1Pre = rate(compileM(t.clues, t.slither, t.midloop));
      if (!r1Pre.solved || TIERS.indexOf(r1Pre.tier) >= 1) { cachedRated = r1Pre; skipPass2 = true; }
    }
    if (!skipPass2 && Date.now() < deadline) {
      const rem = buildUnits();
      const maxStrips = N >= 225 && !wantUnsolved ? (deepStrip ? 8 : 4)
        : deepStrip ? rem.length
        : (stripMode === 'medium' || targetTier === 'Medium') ? Math.max(2, Math.min(8, Math.ceil(rem.length * 0.30)))
        : Math.max(3, Math.min(12, Math.ceil(rem.length * 0.50)));
      const maxPass2Tries = N >= 200 && !wantUnsolved ? 40 : rem.length;
      let stripped = 0, tried = 0;
      const removed = [];
      for (const u of rem) {
        if (Date.now() >= deadline || stripped >= maxStrips || tried >= maxPass2Tries) break;
        if (!canDrop(u)) continue;
        tried++;
        const t = extractActive(u.idxs);
        const exact = solve(compileM(t.clues, t.slither, t.midloop), { limit: 2, maxNodes: pruneNodeCap });
        if (exact.exceeded || exact.count !== 1) continue;
        dropUnit(u);
        removed.push(u.idxs);
        stripped++;
      }

      const cur = extractActive();
      const rated = (removed.length === 0 && r1Pre) ? r1Pre : rate(compileM(cur.clues, cur.slither, cur.midloop));
      if (wantUnsolved || isWithin(rated)) {
        cachedRated = rated;
      } else if (removed.length > 0 && Date.now() < deadline) {
        let lo = 0, hi = removed.length, bestMid = 0;
        let bestRated = (r1Pre && isWithin(r1Pre)) ? r1Pre : null;
        while (lo + 1 < hi && Date.now() < deadline) {
          const mid = (lo + hi) >> 1;
          for (let j = mid; j < removed.length; j++) for (const idx of removed[j]) active[idx] = 1;
          const cc = extractActive();
          for (let j = mid; j < removed.length; j++) for (const idx of removed[j]) active[idx] = 0;
          const r = rate(compileM(cc.clues, cc.slither, cc.midloop));
          if (isWithin(r)) { lo = mid; bestMid = mid; bestRated = r; }
          else hi = mid;
        }
        for (let j = bestMid; j < removed.length; j++) for (const idx of removed[j]) active[idx] = 1;
        cachedRated = bestRated;
      }
    }

    if (Date.now() >= deadline) break;
    const fin = extractActive();
    if (fin.midloop.length < minMid) continue;
    // Require a mix of vertex dots and edge dots on pure Mid-loop boards >= 6x6 (except All-Even / All-Odd)
    if ((style === 'midloop' || style === 'midloop-swiss' || isLongOnly) && rows >= 6 && cols >= 6) {
      const hasC = fin.midloop.some((m) => m.dir === 'C');
      const hasE = fin.midloop.some((m) => m.dir !== 'C');
      if (!hasC || !hasE) continue;
    } else if (isOddOnly && rows >= 6 && cols >= 6) {
      const hasH = fin.midloop.some((m) => m.dir === 'H');
      const hasV = fin.midloop.some((m) => m.dir === 'V');
      if (!hasH || !hasV) continue;
    }
    if (isMasyu) {
      const nW = isGray
        ? fin.clues.filter((c) => whiteSet.has(c.r * cols + c.c)).length
        : fin.clues.filter((c) => c.t === 'W').length;
      const nB = isGray
        ? fin.clues.filter((c) => !whiteSet.has(c.r * cols + c.c)).length
        : fin.clues.filter((c) => c.t === 'B').length;
      if (fin.clues.length < minClues || (rows >= 5 && cols >= 5 && (nW < 1 || nB < 1))) continue;
    }
    if (isSlither) {
      if (fin.slither.length < minSlither || (!isSlitherAll2 && new Set(fin.slither.map((s) => s.n)).size < 2)) continue;
    }
    if (reqQuadItems > 0) {
      const midR = rows >> 1, midC = cols >> 1;
      const fMidR = fr >> 1, fMidC = fc >> 1;
      const qCnt = [0, 0, 0, 0];
      for (const c of fin.clues) qCnt[(c.r >= midR ? 2 : 0) + (c.c >= midC ? 1 : 0)]++;
      for (const s of fin.slither) qCnt[(s.r >= fMidR ? 2 : 0) + (s.c >= fMidC ? 1 : 0)]++;
      for (const m of fin.midloop) qCnt[(m.r >= midR ? 2 : 0) + (m.c >= midC ? 1 : 0)]++;
      if (Math.min(...qCnt) < reqQuadItems) continue;
    }

    const P = compileM(fin.clues, fin.slither, fin.midloop);
    const rated = cachedRated || rate(P);
    if (wantUnsolved) {
      if (rated.solved) continue;
    } else if (!rated.solved) {
      if (!allowUnsolved) continue;
    } else {
      if (TIERS.indexOf(rated.tier) > maxTierIdx) continue;
      if (targetTier && rated.tier !== targetTier) continue;
    }

    const verify = solve(P, { limit: 2, maxNodes: verifyMaxNodes });
    if (verify.exceeded || verify.count !== 1) continue;
    const sol = verify.solutions[0];
    if (!isSolved(P, sol.e)) continue;

    // Hybrid necessity checks
    const hasSecondSol = (altP) => {
      if (solvedByPropagate(altP)) return false;
      return solve(altP, { limit: 2, maxNodes: 30000, rng: rand }).count >= 2;
    };
    if (isMasyu) {
      if (!hasSecondSol(compileM([], [], fin.midloop, { name: `${name}_ml` }))) continue;
      if (!hasSecondSol(compileM(fin.clues, [], [], { name: `${name}_ms` }))) continue;
    } else if (isSlither) {
      if (!hasSecondSol(compileM([], [], fin.midloop, { name: `${name}_ml` }))) continue;
      if (!hasSecondSol(compileM([], fin.slither, [], { name: `${name}_sl` }))) continue;
    } else if (isFull) {
      if (!hasSecondSol(compileM([], [], fin.midloop, { name: `${name}_nf`, fullBoard: false }))) continue;
    }

    P.solution = encodeSolution(P, sol);
    P.rules = rated.rules;
    P.tier = rated.tier;
    P.score = rated.score;
    return P;
  }
  return null;
}

/**
 * Generate one verified, rated Castle Wall or Castle Wall hybrid puzzle:
 *   - 'castle'          pure Castle Wall (White=Inside, Black=Outside, Gray=Either + directional segment counts; supports `layout`: 'rot180'|'mirror'|'transpose')
 *   - 'castle-allgray'  pure Castle Wall with interior Gray numbered tiles only (no Inside/Outside wall colors)
 *   - 'castle-allwhite' pure Castle Wall with White (Inside) tiles only
 *   - 'castle-allblack' pure Castle Wall with Black (Outside) tiles only
 *   - 'castle-swiss'    Castle Wall on a Swiss cheese cutout board (plain interior cutout holes + Castle Wall tiles)
 *   - 'castle-masyu'    Castle Wall + Masyu hybrid (verified mutual necessity)
 *   - 'castle-gray'     Castle Wall + All-gray Masyu circles hybrid (verified mutual necessity)
 *   - 'castle-slither'  Castle Wall + Slitherlink hybrid (verified mutual necessity)
 *   - 'castle-midloop'  Castle Wall + Mid-loop hybrid (verified mutual necessity)
 *   - 'castle-full'     Castle Wall + Hamilton cycle hybrid (verified full-board necessity)
 */
function generateCastlePuzzle({
  rows, cols, style, layout = 'none', voids = null, rand, deadline, maxTierIdx, effectiveMaxTier, targetTier,
  wantUnsolved, allowUnsolved, beginnerOnly, mediumOnly, stripMode, verifyMaxNodes, name,
}) {
  const isFull = style === 'castle-full';
  const isGray = style === 'castle-gray';
  const isAllGray = style === 'castle-allgray';
  const isAllWhite = style === 'castle-allwhite';
  const isAllBlack = style === 'castle-allblack';
  const isSingleColor = isAllGray || isAllWhite || isAllBlack;
  const hasExplicitVoids = Boolean(voids && voids.length > 0);
  const isSwiss = style === 'castle-swiss' || hasExplicitVoids;
  const isMasyu = style === 'castle-masyu' || isGray;
  const isSlither = style === 'castle-slither';
  const isMidloop = style === 'castle-midloop';
  const isHybrid = isMasyu || isSlither || isMidloop;
  const symLayout = (!isSwiss && !isHybrid && !isFull && (layout === 'rot180' || layout === 'mirror' || layout === 'transpose')) ? layout : null;
  if (layout && layout !== 'none' && !symLayout) return null;
  if (symLayout === 'transpose' && rows !== cols) return null;
  const N = rows * cols;
  const fr = rows - 1, fc = cols - 1;
  const pruneNodeCap = N >= 144 ? 8000 : N >= 100 ? 15000 : 25000;
  const dirList = ['U', 'R', 'D', 'L'];
  const cDR = [-1, 0, 1, 0], cDC = [0, 1, 0, -1];
  const symPt = (r, c) => (
    symLayout === 'rot180' ? [rows - 1 - r, cols - 1 - c]
      : symLayout === 'mirror' ? [r, cols - 1 - c]
        : [c, r]
  );
  const symDir = (d) => (
    symLayout === 'rot180' ? (d ^ 2)
      : symLayout === 'mirror' ? ((d & 1) ? (d ^ 2) : d)
        : [3, 2, 1, 0][d]
  );

  const solvedByPropagate = (P) => {
    const st = initialState(P);
    if (!propagate(P, st)) return false;
    for (let x = 0; x < P.numEdges; x++) if (P.edgeA[x] >= 0 && st.e[x] === E_UNKNOWN) return false;
    return isSolved(P, st.e);
  };
  const isWithin = (r) => (allowUnsolved && !r.solved) || (r.solved && TIERS.indexOf(r.tier) <= effectiveMaxTier);
  const fastUpto = beginnerOnly ? BEGINNER_UPTO : mediumOnly ? MEDIUM_UPTO : FIRST_LOOKAHEAD;
  const deepStrip = stripMode === 'deep' || wantUnsolved || targetTier === 'Hard' || targetTier === 'Expert';
  const minClues = isMasyu ? (N >= 64 ? 4 : 3) : 0;
  const minSlither = isSlither ? (N >= 64 ? 5 : 4) : 0;
  const minMid = isMidloop ? (N >= 64 ? 5 : 4) : 0;
  const minCastle = isHybrid || isFull
    ? (N >= 64 ? Math.max(4, Math.floor(N * 0.06)) : 3)
    : Math.max(4, Math.floor(N * 0.10));
  const reqQuadFill = (!isFull && !isSwiss && rows >= 10 && cols >= 10) ? 0.30 : (!isFull && !isSwiss && rows >= 8 && cols >= 8) ? 0.24 : 0;
  const reqQuadItems = (!isSwiss && rows >= 10 && cols >= 10) ? 2 : (!isSwiss && rows >= 7 && cols >= 7 ? 1 : 0);

  const isBorderCell = (r, c) => r === 0 || r === rows - 1 || c === 0 || c === cols - 1;
  const sampleCastlePositions = (blockedSet = null) => {
    const baseFrac = (isAllGray || isAllWhite || isAllBlack) ? (0.20 + 0.06 * rand())
      : beginnerOnly && !isHybrid && !isFull && N >= 144 ? (0.21 + 0.06 * rand())
        : beginnerOnly && !isHybrid && !isFull && N >= 100 ? (0.20 + 0.06 * rand())
          : !isHybrid && !isFull && N >= 100 ? (0.165 + 0.055 * rand())
            : (0.17 + 0.06 * rand());
    const maxFrac = !isHybrid && !isFull && N >= 100
      ? (beginnerOnly ? (N >= 144 ? 0.29 : 0.28) : 0.26)
      : 0.28;
    const targetK = isHybrid || isFull
      ? Math.max(5, Math.min(Math.floor(N * 0.20), Math.round(N * (0.11 + 0.05 * rand()))))
      : Math.max(6, Math.min(Math.floor(N * maxFrac), Math.round(N * baseFrac)));
    const interiorOnly = isAllGray || isAllWhite;
    const maxBorder = interiorOnly ? 0 : Math.max(1, Math.floor(targetK * 0.28));
    let nBorder = 0;
    const grid = new Uint8Array(N);
    if (blockedSet) for (const u of blockedSet) grid[u] = 2;
    const pts = [];
    const cand = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cand.push([r, c]);
    shuffle(cand, rand);

    const orthNeighbors = (r, c) => {
      let orth = 0;
      for (let d = 0; d < 4; d++) {
        const nr = r + cDR[d], nc = c + cDC[d];
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr * cols + nc]) orth++;
      }
      return orth;
    };

    const canPlace = (r, c, maxOrth = 1) => {
      if (grid[r * cols + c]) return false;
      const onB = isBorderCell(r, c);
      if (onB && nBorder >= maxBorder) return false;
      // Avoid 2x2 solid clumps and 3-cell blobs of blocked tiles
      let orth = 0;
      for (let d = 0; d < 4; d++) {
        const nr = r + cDR[d], nc = c + cDC[d];
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr * cols + nc]) {
          orth++;
          if (orthNeighbors(nr, nc) >= 1) return false;
        }
      }
      if (orth > maxOrth) return false;
      // Don't place directly on board corners (useless 0-inside dead corners)
      if ((r === 0 || r === rows - 1) && (c === 0 || c === cols - 1)) return false;
      // On Hamilton cycle (fullBoard), never block a cell orthogonally adjacent to a board corner
      // (which would leave that corner with degree 1 -> 0 Hamiltonian cycles).
      if (isFull) {
        const onTopBot = r === 0 || r === rows - 1;
        const onLeftRight = c === 0 || c === cols - 1;
        if ((onTopBot && (c === 1 || c === cols - 2)) || (onLeftRight && (r === 1 || r === rows - 2))) return false;
      }
      return true;
    };

    if (isFull) {
      // Keep activeLight === activeDark by placing balanced pairs of light/dark tiles
      const lights = cand.filter(([r, c]) => ((r + c) & 1) === 0);
      const darks = cand.filter(([r, c]) => ((r + c) & 1) === 1);
      const needPairs = Math.max(2, targetK >> 1);
      if ((N & 1) === 1) {
        for (const [r, c] of lights) {
          if (canPlace(r, c)) {
            grid[r * cols + c] = 1;
            if (isBorderCell(r, c)) nBorder++;
            pts.push({ r, c });
            break;
          }
        }
      }
      let li = 0, di = 0;
      while (pts.length + 2 <= needPairs * 2 + (N & 1) && li < lights.length && di < darks.length) {
        while (li < lights.length && !canPlace(lights[li][0], lights[li][1])) li++;
        if (li >= lights.length) break;
        const [lr, lc] = lights[li++];
        grid[lr * cols + lc] = 1;
        const lb = isBorderCell(lr, lc);
        if (lb) nBorder++;
        let placedD = false;
        while (di < darks.length) {
          const [dr, dc] = darks[di++];
          if (canPlace(dr, dc)) {
            grid[dr * cols + dc] = 1;
            if (isBorderCell(dr, dc)) nBorder++;
            pts.push({ r: lr, c: lc }, { r: dr, c: dc });
            placedD = true;
            break;
          }
        }
        if (!placedD) { grid[lr * cols + lc] = 0; if (lb) nBorder--; break; }
      }
    } else {
      const pairProb = !isSwiss && N >= 64 ? (isHybrid ? 0.25 : 0.35) : 0;
      const dirOrd = [0, 1, 2, 3];
      for (const [r, c] of cand) {
        if (pts.length >= targetK) break;
        if (!canPlace(r, c)) continue;
        const wasIso = orthNeighbors(r, c) === 0;
        grid[r * cols + c] = 1;
        const onB = isBorderCell(r, c);
        if (onB) nBorder++;
        pts.push({ r, c });
        // Grow an interior 2-cell wall pair (domino) to shape corridors cleanly without scattered singletons
        if (pairProb > 0 && wasIso && !onB && pts.length < targetK && rand() < pairProb) {
          shuffle(dirOrd, rand);
          for (const d of dirOrd) {
            const nr = r + cDR[d], nc = c + cDC[d];
            if (nr <= 0 || nr >= rows - 1 || nc <= 0 || nc >= cols - 1) continue;
            if (grid[nr * cols + nc]) continue;
            if (orthNeighbors(nr, nc) !== 1) continue;
            grid[nr * cols + nc] = 1;
            pts.push({ r: nr, c: nc });
            break;
          }
        }
      }
    }
    return pts;
  };

  while (Date.now() < deadline) {
    const useVoids = isSwiss
      ? (hasExplicitVoids ? voids : swissCheeseVoids(rows, cols, rand))
      : [];
    if (isSwiss && !useVoids.length) continue;
    const plainVoidSet = useVoids.length ? new Set(useVoids.map((v) => v.r * cols + v.c)) : null;

    let tilePts, empty, edges;
    if (symLayout) {
      const res = randomSymmetricLoop(rows, cols, rand, symLayout, {
        targetFill: 0.52 + 0.16 * rand(),
        steps: Math.max(200, fr * fc * 28),
      });
      if (!res || res.loopCells < Math.max(12, Math.floor(N * 0.48)) || res.emptyBorders > (N <= 36 ? 1 : 0)) continue;
      if (reqQuadFill > 0 && res.minQuadFill < reqQuadFill) continue;
      edges = res.edges;
      const used = new Uint8Array(N);
      for (let x = 0; x < edges.length; x++) {
        if (edges[x] === E_ON) {
          const cell = x >> 1;
          used[cell] = 1;
          used[(x & 1) === 0 ? cell + 1 : cell + cols] = 1;
        }
      }
      const orbits = [];
      const seenU = new Uint8Array(N);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const u = r * cols + c;
          if (seenU[u] || used[u]) continue;
          const [sr, sc] = symPt(r, c);
          const su = sr * cols + sc;
          seenU[u] = 1; seenU[su] = 1;
          if (used[su]) continue;
          orbits.push(u === su ? [[r, c]] : [[r, c], [sr, sc]]);
        }
      }
      shuffle(orbits, rand);
      const targetK = Math.max(6, Math.min(Math.floor(N * 0.28), Math.round(N * (0.18 + 0.06 * rand()))));
      const interiorOnly = isAllGray || isAllWhite;
      const maxBorder = interiorOnly ? 0 : Math.max(2, Math.floor(targetK * 0.28));
      let nBorder = 0;
      const grid = new Uint8Array(N);
      tilePts = [];
      for (const orb of orbits) {
        if (tilePts.length >= targetK) break;
        const addB = orb.reduce((s, [r, c]) => s + (isBorderCell(r, c) ? 1 : 0), 0);
        if (nBorder + addB > maxBorder) continue;
        let ok = true;
        for (const [r, c] of orb) {
          if ((r === 0 || r === rows - 1) && (c === 0 || c === cols - 1)) { ok = false; break; }
          let orth = 0;
          for (let d = 0; d < 4; d++) {
            const nr = r + cDR[d], nc = c + cDC[d];
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr * cols + nc]) orth++;
          }
          if (orth > 1) { ok = false; break; }
        }
        if (!ok) continue;
        for (const [r, c] of orb) grid[r * cols + c] = 1;
        nBorder += addB;
        for (const [r, c] of orb) tilePts.push({ r, c });
      }
      if (tilePts.length < Math.max(4, minCastle)) continue;
      empty = compile({ name: 'ecw', rows, cols, clues: [], voids: tilePts });
    } else if (isAllWhite || isAllBlack) {
      // Sample the loop first so we pick ONLY off-loop vertices with the desired Inside ('W') or Outside ('B') parity!
      const res = randomLoop(rows, cols, rand, {
        targetFill: isAllWhite ? (0.52 + 0.16 * rand()) : (0.38 + 0.14 * rand()),
        steps: Math.max(200, fr * fc * 28),
      });
      if (res.loopCells < Math.max(12, Math.floor(N * (isAllBlack ? 0.40 : 0.46))) || res.emptyBorders > (N <= 36 ? 1 : 0)) continue;
      if (reqQuadFill > 0 && res.minQuadFill < (isAllBlack ? 0.18 : reqQuadFill)) continue;
      edges = res.edges;
      const used = new Uint8Array(N);
      for (let x = 0; x < edges.length; x++) {
        if (edges[x] === E_ON) {
          const cell = x >> 1;
          used[cell] = 1;
          used[(x & 1) === 0 ? cell + 1 : cell + cols] = 1;
        }
      }
      const wantWall = isAllWhite ? 'W' : 'B';
      const cand = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const u = r * cols + c;
          if (used[u]) continue;
          if ((r === 0 || r === rows - 1) && (c === 0 || c === cols - 1)) continue;
          if (isAllWhite && isBorderCell(r, c)) continue;
          let cr = 0;
          if (r < rows - 1) {
            for (let cc = c + 1; cc < cols; cc++) {
              if (edges[2 * (r * cols + cc) + 1] === E_ON) cr++;
            }
          }
          const w = (cr & 1) === 1 ? 'W' : 'B';
          if (w === wantWall) cand.push([r, c]);
        }
      }
      shuffle(cand, rand);
      const targetK = Math.max(6, Math.min(Math.floor(N * 0.32), Math.round(N * (0.22 + 0.08 * rand()))));
      const maxBorder = isAllWhite ? 0 : Math.max(2, Math.floor(targetK * 0.50));
      let nBorder = 0;
      const grid = new Uint8Array(N);
      tilePts = [];
      for (const [r, c] of cand) {
        if (tilePts.length >= targetK) break;
        const onB = isBorderCell(r, c);
        if (onB && nBorder >= maxBorder) continue;
        let orth = 0;
        for (let d = 0; d < 4; d++) {
          const nr = r + cDR[d], nc = c + cDC[d];
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr * cols + nc]) orth++;
        }
        if (orth > 1) continue;
        grid[r * cols + c] = 1;
        if (onB) nBorder++;
        tilePts.push({ r, c });
      }
      if (tilePts.length < Math.max(4, minCastle)) continue;
      empty = compile({ name: 'ecw', rows, cols, clues: [], voids: tilePts });
    } else {
      tilePts = sampleCastlePositions(plainVoidSet);
      if (tilePts.length < Math.max(4, minCastle)) continue;
      empty = compile({
        name: 'ecw', rows, cols, clues: [], voids: useVoids.length ? useVoids.concat(tilePts) : tilePts,
        ...(isFull ? { fullBoard: true } : {}),
      });
      if (isFull && empty.activeLight !== empty.activeDark) continue;

      if (isFull) {
        const sample = solve(empty, { limit: 1, maxNodes: 4000, rng: rand });
        if (sample.count === 0) continue;
        edges = sample.solutions[0].e;
      } else {
        const res = randomShapedLoop(empty, rand, {
          targetFill: 0.54 + 0.16 * rand(),
          steps: Math.max(200, fr * fc * 28),
        });
        const minLoop = isSwiss ? Math.max(10, Math.floor(empty.activeCount * 0.48)) : Math.max(12, Math.floor(N * 0.48));
        if (!res.valid || res.loopCells < minLoop) continue;
        edges = res.edges;
        if (!isSwiss) {
          // Check border reach and quadrant loop balance so boards never have empty sides or dead corners
          const used = new Uint8Array(N);
          for (let x = 0; x < empty.numEdges; x++) {
            if (empty.edgeA[x] >= 0 && edges[x] === E_ON) { used[empty.edgeA[x]] = 1; used[empty.edgeB[x]] = 1; }
          }
          let topHit = 0, botHit = 0, leftHit = 0, rightHit = 0;
          for (let c = 0; c < cols; c++) { if (used[c]) topHit = 1; if (used[(rows - 1) * cols + c]) botHit = 1; }
          for (let r = 0; r < rows; r++) { if (used[r * cols]) leftHit = 1; if (used[r * cols + cols - 1]) rightHit = 1; }
          const emptyBorders = 4 - (topHit + botHit + leftHit + rightHit);
          if (emptyBorders > (N <= 36 ? 1 : 0)) continue;
          if (reqQuadFill > 0) {
            const mr = rows >> 1, mc = cols >> 1;
            const qAct = [0, 0, 0, 0], qUse = [0, 0, 0, 0];
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                const u = r * cols + c;
                if (empty.isVoid[u]) continue;
                const qi = (r >= mr ? 2 : 0) + (c >= mc ? 1 : 0);
                qAct[qi]++;
                if (used[u]) qUse[qi]++;
              }
            }
            let minQF = 1;
            for (let qi = 0; qi < 4; qi++) if (qAct[qi] > 0) minQF = Math.min(minQF, qUse[qi] / qAct[qi]);
            if (minQF < reqQuadFill) continue;
          }
        }
      }
    }

    // Build initial Castle Wall tiles (all exact W/B wall colors + best informative arrow direction)
    const castleInit = [];
    const tileCands = [];
    const isVoidExtAt = (r, c) => {
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) return true;
      for (const [dr, dc] of [[-1, -1], [-1, 0], [0, -1], [0, 0]]) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < fr && cc >= 0 && cc < fc && empty.faceExterior && empty.faceExterior[rr * fc + cc]) return true;
      }
      return false;
    };
    const candDirsFor = (r, c) => {
      const out = [];
      for (let d = 0; d < 4; d++) {
        const rayEs = [];
        let cnt = 0;
        let rr = r + cDR[d], cc = c + cDC[d];
        while (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
          const nr = rr + cDR[d], nc = cc + cDC[d];
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) break;
          const ex = empty.ed[(rr * cols + cc) * 4 + d];
          if (ex >= 0) { rayEs.push(ex); if (edges[ex] === E_ON) cnt++; }
          rr = nr; cc = nc;
        }
        if (rayEs.length >= 1) out.push({ d, dir: dirList[d], n: cnt, len: rayEs.length, rayEs });
      }
      return out;
    };
    const wallAt = (r, c) => {
      let crossings = 0;
      if (r < rows - 1) {
        for (let cc = c + 1; cc < cols; cc++) {
          const ex = 2 * (r * cols + cc) + 1;
          if (empty.edgeA[ex] >= 0 && edges[ex] === E_ON) crossings++;
        }
      }
      return (crossings & 1) === 1 ? 'W' : 'B';
    };

    let badFullTile = false;
    if (symLayout) {
      const donePt = new Uint8Array(N);
      for (const v of tilePts) {
        const u = v.r * cols + v.c;
        if (donePt[u]) continue;
        const [sr, sc] = symPt(v.r, v.c);
        const su = sr * cols + sc;
        donePt[u] = 1; donePt[su] = 1;
        const isExt = isVoidExtAt(v.r, v.c);
        if ((isAllGray || isAllWhite) && isExt) continue;
        const wall = isAllGray ? 'G' : wallAt(v.r, v.c);
        if ((isAllWhite && wall !== 'W') || (isAllBlack && wall !== 'B')) continue;
        const cands0 = candDirsFor(v.r, v.c);
        if (u === su) {
          // Fixed-point tile: only directions fixed by symDir(d) === d preserve symmetry
          const fixedCands = cands0.filter((cd) => symDir(cd.d) === cd.d);
          if (fixedCands.length) {
            const weighted = fixedCands.map((cd) => ({ cd, w: (cd.len >= 2 ? 2 : 0.6) * (cd.n > 0 ? 2.5 : 1) * (0.5 + rand()) }));
            weighted.sort((a, b) => b.w - a.w);
            const pick = weighted[0].cd;
            castleInit.push({ r: v.r, c: v.c, wall, dir: pick.dir, n: pick.n, isExt });
            tileCands.push(fixedCands);
          } else if (!isExt && !isAllGray) {
            castleInit.push({ r: v.r, c: v.c, wall, dir: '', n: -1, isExt });
            tileCands.push([]);
          } else {
            badFullTile = true; break;
          }
        } else {
          const cands1 = candDirsFor(sr, sc);
          const c1ByD = new Map(cands1.map((cd) => [cd.d, cd]));
          const valid0 = cands0.filter((cd) => c1ByD.has(symDir(cd.d)));
          if (!valid0.length) {
            if (isExt || isAllGray) { badFullTile = true; break; }
            castleInit.push({ r: v.r, c: v.c, wall, dir: '', n: -1, isExt });
            tileCands.push([]);
            castleInit.push({ r: sr, c: sc, wall, dir: '', n: -1, isExt });
            tileCands.push([]);
          } else {
            const weighted = valid0.map((cd) => ({ cd, w: (cd.len >= 2 ? 2 : 0.6) * (cd.n > 0 ? 2.5 : 1) * (0.5 + rand()) }));
            weighted.sort((a, b) => b.w - a.w);
            const p0 = weighted[0].cd;
            const p1 = c1ByD.get(symDir(p0.d));
            castleInit.push({ r: v.r, c: v.c, wall, dir: p0.dir, n: p0.n, isExt });
            tileCands.push(valid0);
            castleInit.push({ r: sr, c: sc, wall, dir: p1.dir, n: p1.n, isExt });
            tileCands.push(valid0.map((cd) => c1ByD.get(symDir(cd.d))));
          }
        }
      }
    } else {
      for (const v of tilePts) {
        const isExt = isVoidExtAt(v.r, v.c);
        if ((isAllGray || isAllWhite) && isExt) continue;
        const wall = isAllGray ? 'G' : wallAt(v.r, v.c);
        if ((isAllWhite && wall !== 'W') || (isAllBlack && wall !== 'B')) continue;
        const candDirs = candDirsFor(v.r, v.c);
        if (!candDirs.length) {
          if (isExt || isAllGray) { badFullTile = true; break; }
          castleInit.push({ r: v.r, c: v.c, wall, dir: '', n: -1, isExt });
          tileCands.push([]);
          continue;
        }
        // Prefer longer rays and mildly prefer nonzero counts so clues feel rich and varied
        const weighted = candDirs.map((cd) => ({
          cd,
          w: (cd.len >= 2 ? 2 : 0.6) * (cd.n > 0 ? 2.5 : 1) * (0.5 + rand()),
        }));
        weighted.sort((a, b) => b.w - a.w);
        const pick = weighted[0].cd;
        castleInit.push({ r: v.r, c: v.c, wall, dir: pick.dir, n: pick.n, isExt });
        tileCands.push(candDirs);
      }
    }
    if (badFullTile) continue;
    // Keep castleInit and tileCands in canonical cell order together
    const zipped = castleInit.map((cw, idx) => ({ cw, cands: tileCands[idx] }))
      .sort((a, b) => (a.cw.r * cols + a.cw.c) - (b.cw.r * cols + b.cw.c));
    castleInit.length = 0;
    tileCands.length = 0;
    for (const z of zipped) { castleInit.push(z.cw); tileCands.push(z.cands); }
    if (castleInit.length < Math.max(4, minCastle)) continue;

    // Build symmetric orbit index map for Castle Wall tiles (1-element orbits normally, 1-2 elements under symLayout)
    const cwPartner = new Int16Array(castleInit.length).fill(-1);
    const cwOrbits = [];
    if (!symLayout) {
      for (let i = 0; i < castleInit.length; i++) cwOrbits.push([i]);
    } else {
      const byCell = new Map();
      for (let i = 0; i < castleInit.length; i++) byCell.set(castleInit[i].r * cols + castleInit[i].c, i);
      const seenI = new Uint8Array(castleInit.length);
      for (let i = 0; i < castleInit.length; i++) {
        if (seenI[i]) continue;
        const [sr, sc] = symPt(castleInit[i].r, castleInit[i].c);
        const j = byCell.get(sr * cols + sc);
        if (j === undefined || j === i) {
          seenI[i] = 1;
          cwOrbits.push([i]);
        } else {
          seenI[i] = 1; seenI[j] = 1;
          cwPartner[i] = j; cwPartner[j] = i;
          cwOrbits.push([i, j]);
        }
      }
    }

    let cluesInit = [], slitherInit = [], midInit = [];
    let clWhiteSet = null;
    if (isMasyu) {
      const { whites, blacks } = allowedClues(rows, cols, edges, empty);
      if (isGray) clWhiteSet = new Set(whites.map((c) => c.r * cols + c.c));
      cluesInit = isGray ? whites.concat(blacks).map(({ r, c }) => ({ r, c, t: 'G' })) : whites.concat(blacks);
      if (cluesInit.length < Math.max(4, minClues)) continue;
      cluesInit.sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
    } else if (isSlither) {
      slitherInit = allowedSlither(rows, cols, edges, empty);
      if (slitherInit.length < Math.max(4, minSlither)) continue;
      slitherInit.sort((a, b) => (a.r * fc + a.c) - (b.r * fc + b.c));
    } else if (isMidloop) {
      midInit = allowedMidloop(rows, cols, edges, empty);
      if (midInit.length < Math.max(4, minMid)) continue;
    }

    const compileC = (castle, clues, slither, midloop, extra = {}) => compile({
      name, rows, cols, clues,
      ...(castle.length ? { castle } : {}),
      ...(useVoids.length ? { voids: useVoids } : {}),
      ...(slither.length ? { slither } : {}),
      ...(midloop.length ? { midloop } : {}),
      ...(isFull ? { fullBoard: true } : {}),
      ...extra,
    });

    const toRawCastle = (list) => list.map(({ r, c, wall, dir, n }) => ({ r, c, wall, dir, n }));
    let P0 = compileC(toRawCastle(castleInit), cluesInit, slitherInit, midInit);
    let baseTight = false, p0FastOk = false, provedSol = null;
    if (beginnerOnly) {
      const rBeg = solvedByRules(P0, BEGINNER_UPTO);
      if (!rBeg.solved) continue;
      p0FastOk = true;
      provedSol = rBeg.state;
    } else {
      baseTight = solvedByPropagate(P0);
      if (baseTight) {
        p0FastOk = true;
      } else {
        const rFast = solvedByRules(P0, fastUpto);
        if (rFast.solved) { p0FastOk = true; provedSol = rFast.state; }
      }
      if (!p0FastOk) {
        // Counterexample-guided arrow re-pointing (up to 6 rounds): if P0 has a 2nd solution,
        // flip arrows on tiles (or symmetric orbits) whose alternate direction separates our target loop!
        let ex = solve(P0, { limit: 2, maxNodes: pruneNodeCap });
        for (let round = 0; round < 6 && !ex.exceeded && ex.count === 2 && Date.now() < deadline; round++) {
          let alt = ex.solutions[0].e;
          let same = true;
          for (let x = 0; x < P0.numEdges; x++) {
            if (P0.edgeA[x] >= 0 && (alt[x] === E_ON) !== (edges[x] === E_ON)) { same = false; break; }
          }
          if (same) alt = ex.solutions[1].e;
          const flips = [];
          for (let idx = 0; idx < castleInit.length; idx++) {
            const cw = castleInit[idx];
            const cands = tileCands[idx];
            if (cands.length <= 1) continue;
            for (const cd of cands) {
              if (cd.dir === cw.dir) continue;
              let altCnt = 0;
              for (let j = 0; j < cd.rayEs.length; j++) if (alt[cd.rayEs[j]] === E_ON) altCnt++;
              if (altCnt !== cd.n) flips.push({ idx, cd, delta: Math.abs(altCnt - cd.n) });
            }
          }
          if (!flips.length) break;
          shuffle(flips, rand);
          flips.sort((a, b) => b.delta - a.delta);
          const pick = flips[0];
          castleInit[pick.idx].dir = pick.cd.dir;
          castleInit[pick.idx].n = pick.cd.n;
          const pIdx = cwPartner[pick.idx];
          if (symLayout && pIdx >= 0) {
            const sd = symDir(pick.cd.d);
            const pCd = tileCands[pIdx].find((c) => c.d === sd);
            if (pCd) { castleInit[pIdx].dir = pCd.dir; castleInit[pIdx].n = pCd.n; }
          }
          P0 = compileC(toRawCastle(castleInit), cluesInit, slitherInit, midInit);
          if (solvedByPropagate(P0)) { baseTight = true; p0FastOk = true; break; }
          ex = solve(P0, { limit: 2, maxNodes: pruneNodeCap });
        }
        if (!p0FastOk) {
          if (ex.exceeded || ex.count !== 1) continue;
          provedSol = ex.solutions[0];
          if (mediumOnly) {
            const r0 = rate(P0);
            if (!r0.solved || TIERS.indexOf(r0.tier) > 1) continue;
          }
        }
      }
    }

    // Track active state with live invariant counters
    const cwState = castleInit.map((cw) => ({ ...cw, active: true }));
    const clAct = new Uint8Array(cluesInit.length).fill(1);
    const slAct = new Uint8Array(slitherInit.length).fill(1);
    const mlAct = new Uint8Array(midInit.length).fill(1);
    let nCw = cwState.length, nCl = cluesInit.length, nSl = slitherInit.length, nMl = midInit.length;
    let nWAct = cwState.filter((c) => c.wall === 'W').length;
    let nBAct = cwState.filter((c) => c.wall === 'B').length;
    let nGAct = cwState.filter((c) => c.wall === 'G').length;
    let nNumAct = cwState.filter((c) => c.dir).length;
    const isClW = (cl) => (isGray ? clWhiteSet.has(cl.r * cols + cl.c) : cl.t === 'W');
    let nClW = isMasyu ? cluesInit.filter(isClW).length : 0;
    let nClB = isMasyu ? cluesInit.length - nClW : 0;
    const minNumFloor = Math.max(2, Math.floor(minCastle * 0.6));

    const extract = () => ({
      castle: cwState.filter((c) => c.active).map(({ r, c, wall, dir, n }) => ({ r, c, wall, dir, n })),
      clues: cluesInit.filter((_, i) => clAct[i]),
      slither: slitherInit.filter((_, i) => slAct[i]),
      midloop: midInit.filter((_, i) => mlAct[i]),
    });

    // Build stripping actions (operating on full symmetric orbits when symLayout is active)
    const buildActions = (pass2 = false, dropsOnly = false) => {
      const acts = [];
      for (const idxs of cwOrbits) {
        const cw = cwState[idxs[0]];
        if (!cw.active) continue;
        if (!isFull) acts.push({ kind: 'dropCw', idxs });
        if (dropsOnly) continue;
        if (!isSingleColor && cw.wall !== 'G' && cw.dir && !cw.isExt) {
          if (rand() < 0.30) acts.push({ kind: 'grayCw', idxs });
          if (!pass2 || N < 144 || isHybrid || isFull || rand() < 0.50) acts.push({ kind: 'bareCw', idxs });
        } else if ((isAllWhite || isAllBlack) && cw.dir && !cw.isExt) {
          if (!pass2 || N < 144 || isHybrid || isFull || rand() < 0.50) acts.push({ kind: 'bareCw', idxs });
        }
      }
      for (let i = 0; i < cluesInit.length; i++) if (clAct[i]) acts.push({ kind: 'dropCl', i });
      for (let i = 0; i < slitherInit.length; i++) if (slAct[i]) acts.push({ kind: 'dropSl', i });
      for (let i = 0; i < midInit.length; i++) if (mlAct[i]) acts.push({ kind: 'dropMl', i });
      if (isHybrid) {
        // Strip secondary clues slightly earlier so Castle Wall stays prominent
        const keyed = acts.map((a) => ({ a, k: (a.kind.endsWith('Cw') ? (a.kind === 'dropCw' ? 0.15 : 0.30) : 0) + rand() }));
        keyed.sort((x, y) => x.k - y.k);
        return keyed.map((x) => x.a);
      }
      if (pass2) {
        // Mildly favor dropping whole redundant tiles before bare/gray tweaks in exact Pass 2
        const keyed = acts.map((a) => ({ a, k: (a.kind === 'dropCw' ? 0 : 0.25) + rand() }));
        keyed.sort((x, y) => x.k - y.k);
        return keyed.map((x) => x.a);
      }
      return shuffle(acts, rand);
    };

    const canAct = (a) => {
      if (a.kind === 'dropCw') {
        if (isFull) return false;
        const len = a.idxs.length;
        const cw = cwState[a.idxs[0]];
        if (!cw.active || nCw - len < minCastle) return false;
        const dropNum = a.idxs.reduce((s, idx) => s + (cwState[idx].dir ? 1 : 0), 0);
        if (nNumAct - dropNum < minNumFloor) return false;
        if (!isSingleColor) {
          const dropW = a.idxs.reduce((s, idx) => s + (cwState[idx].wall === 'W' ? 1 : 0), 0);
          const dropB = a.idxs.reduce((s, idx) => s + (cwState[idx].wall === 'B' ? 1 : 0), 0);
          if (nWAct - dropW < 1) return false;
          if (nBAct - dropB < 1) return false;
          if (cw.wall !== 'G' && nGAct > Math.max(1, Math.floor((nCw - len) * 0.25))) return false;
          if (isHybrid && cw.wall !== 'G' && (nWAct + nBAct - dropW - dropB) < Math.max(2, Math.ceil((nCw - len) * 0.5))) {
            return false;
          }
        }
        return true;
      }
      if (a.kind === 'grayCw') {
        if (isSingleColor) return false;
        const len = a.idxs.length;
        const cw = cwState[a.idxs[0]];
        if (!cw.active || cw.wall === 'G' || cw.isExt || !cw.dir) return false;
        if (nGAct + len > Math.max(1, Math.floor(nCw * 0.25))) return false;
        if (cw.wall === 'W' && nWAct - len < 1) return false;
        if (cw.wall === 'B' && nBAct - len < 1) return false;
        if ((isHybrid || isFull) && (nWAct + nBAct - len) < Math.max(2, Math.ceil(nCw * 0.5))) {
          return false;
        }
        return true;
      }
      if (a.kind === 'bareCw') {
        if (isAllGray) return false;
        const len = a.idxs.length;
        const cw = cwState[a.idxs[0]];
        return cw.active && cw.wall !== 'G' && !cw.isExt && Boolean(cw.dir) && nNumAct - len >= minNumFloor;
      }
      if (a.kind === 'dropCl') {
        if (!clAct[a.i] || nCl <= minClues) return false;
        if (isClW(cluesInit[a.i]) && nClW <= 1) return false;
        if (!isClW(cluesInit[a.i]) && nClB <= 1) return false;
        return true;
      }
      if (a.kind === 'dropSl') return slAct[a.i] && nSl > minSlither;
      if (a.kind === 'dropMl') return mlAct[a.i] && nMl > minMid;
      return false;
    };
    const applyAct = (a) => {
      if (a.kind === 'dropCw') {
        const saved = a.idxs.map((idx) => {
          const cw = cwState[idx];
          const w = cw.wall, hadDir = Boolean(cw.dir);
          cw.active = false; nCw--;
          if (w === 'W') nWAct--; else if (w === 'B') nBAct--; else nGAct--;
          if (hadDir) nNumAct--;
          return { idx, w, hadDir };
        });
        return () => {
          for (const { idx, w, hadDir } of saved) {
            cwState[idx].active = true; nCw++;
            if (w === 'W') nWAct++; else if (w === 'B') nBAct++; else nGAct++;
            if (hadDir) nNumAct++;
          }
        };
      }
      if (a.kind === 'grayCw') {
        const saved = a.idxs.map((idx) => {
          const prev = cwState[idx].wall;
          cwState[idx].wall = 'G';
          if (prev === 'W') nWAct--; else if (prev === 'B') nBAct--;
          nGAct++;
          return { idx, prev };
        });
        return () => {
          for (const { idx, prev } of saved) {
            cwState[idx].wall = prev;
            if (prev === 'W') nWAct++; else if (prev === 'B') nBAct++;
            nGAct--;
          }
        };
      }
      if (a.kind === 'bareCw') {
        const saved = a.idxs.map((idx) => {
          const pd = cwState[idx].dir, pn = cwState[idx].n;
          cwState[idx].dir = ''; cwState[idx].n = -1; nNumAct--;
          return { idx, pd, pn };
        });
        return () => {
          for (const { idx, pd, pn } of saved) {
            cwState[idx].dir = pd; cwState[idx].n = pn; nNumAct++;
          }
        };
      }
      if (a.kind === 'dropCl') {
        clAct[a.i] = 0; nCl--;
        const wFlag = isClW(cluesInit[a.i]);
        if (wFlag) nClW--; else nClB--;
        return () => {
          clAct[a.i] = 1; nCl++;
          if (wFlag) nClW++; else nClB++;
        };
      }
      if (a.kind === 'dropSl') { slAct[a.i] = 0; nSl--; return () => { slAct[a.i] = 1; nSl++; }; }
      if (a.kind === 'dropMl') { mlAct[a.i] = 0; nMl--; return () => { mlAct[a.i] = 1; nMl++; }; }
      return () => {};
    };

    // Pass 0: propagation-only fast pruning
    if (baseTight && !beginnerOnly) {
      for (const a of buildActions()) {
        if (Date.now() >= deadline) break;
        if (!canAct(a)) continue;
        const undo = applyAct(a);
        const cur = extract();
        if (!solvedByPropagate(compileC(cur.castle, cur.clues, cur.slither, cur.midloop))) undo();
        else provedSol = null;
      }
    }

    // Pass 1: sound human-rule pruning
    if (p0FastOk) {
      for (const a of buildActions()) {
        if (Date.now() >= deadline) break;
        if (!canAct(a)) continue;
        const undo = applyAct(a);
        const cur = extract();
        const r = solvedByRules(compileC(cur.castle, cur.clues, cur.slither, cur.midloop), fastUpto);
        if (!r.solved) undo();
        else provedSol = r.state;
      }
    }

    // Pass 2: exact uniqueness pruning + true binary-search rollback to stay within effectiveMaxTier
    let cachedRated = null;
    let skipPass2 = beginnerOnly;
    let r1Pre = null;
    let pass2Failed = false;
    if (!skipPass2 && mediumOnly && Date.now() < deadline) {
      const cur = extract();
      r1Pre = rate(compileC(cur.castle, cur.clues, cur.slither, cur.midloop));
      if (!r1Pre.solved || TIERS.indexOf(r1Pre.tier) > effectiveMaxTier) {
        pass2Failed = true;
        skipPass2 = true;
      }
    }
    if (!skipPass2 && Date.now() < deadline) {
      const alreadyMed = Boolean(mediumOnly && r1Pre && TIERS.indexOf(r1Pre.tier) === 1);
      const rem = buildActions(true, alreadyMed && !isFull);
      const maxStrips = alreadyMed
        ? Math.min(rem.length, N >= 144 ? 8 : 6)
        : N >= 144
          ? (deepStrip ? 24 : 12)
          : deepStrip ? rem.length
            : (stripMode === 'medium' || targetTier === 'Medium') ? Math.max(4, Math.min(12, Math.ceil(rem.length * 0.40)))
              : Math.max(4, Math.min(14, Math.ceil(rem.length * 0.55)));
      const maxPass2Tries = N >= 144 ? Math.min(rem.length, 50) : rem.length;
      const pass2Log = []; // [{ act, undo, sol }]
      let tried = 0;
      for (const a of rem) {
        if (Date.now() >= deadline || pass2Log.length >= maxStrips || tried >= maxPass2Tries) break;
        if (!canAct(a)) continue;
        tried++;
        const undo = applyAct(a);
        const cur = extract();
        const exact = solve(compileC(cur.castle, cur.clues, cur.slither, cur.midloop), { limit: 2, maxNodes: pruneNodeCap });
        if (exact.exceeded || exact.count !== 1) { undo(); continue; }
        pass2Log.push({ act: a, undo, sol: exact.solutions[0] });
        provedSol = exact.solutions[0];
      }

      const cur = extract();
      const rated = (pass2Log.length === 0 && r1Pre) ? r1Pre : rate(compileC(cur.castle, cur.clues, cur.slither, cur.midloop));
      if (wantUnsolved || isWithin(rated)) {
        cachedRated = rated;
      } else if (pass2Log.length > 0 && Date.now() < deadline) {
        // Binary search on prefix length `k` in [0, pass2Log.length] using exact LIFO cursor stepping
        let cursor = pass2Log.length;
        const setCursor = (target) => {
          while (cursor > target) { cursor--; pass2Log[cursor].undo(); }
          while (cursor < target) { pass2Log[cursor].undo = applyAct(pass2Log[cursor].act); cursor++; }
        };
        let lo = 0, hi = pass2Log.length;
        let bestK = -1, bestRated = null;
        if (r1Pre && isWithin(r1Pre)) { bestK = 0; bestRated = r1Pre; }
        else {
          setCursor(0);
          const cc0 = extract();
          const r0 = rate(compileC(cc0.castle, cc0.clues, cc0.slither, cc0.midloop));
          if (isWithin(r0)) { bestK = 0; bestRated = r0; }
          else { pass2Failed = true; }
        }
        if (!pass2Failed) {
          while (lo + 1 < hi && Date.now() < deadline) {
            const mid = (lo + hi) >> 1;
            setCursor(mid);
            const cc = extract();
            const r = rate(compileC(cc.castle, cc.clues, cc.slither, cc.midloop));
            if (isWithin(r)) { lo = mid; bestK = mid; bestRated = r; }
            else hi = mid;
          }
          setCursor(bestK);
          provedSol = bestK > 0 ? pass2Log[bestK - 1].sol : null;
          cachedRated = bestRated;
        }
      } else {
        pass2Failed = true;
      }
    }

    if (pass2Failed || Date.now() >= deadline) continue;
    const fin = extract();
    if (fin.castle.length < minCastle) continue;
    const nNum = fin.castle.filter((c) => c.dir).length;
    const nZero = fin.castle.filter((c) => c.dir && c.n === 0).length;
    const nW = fin.castle.filter((c) => c.wall === 'W').length;
    const nB = fin.castle.filter((c) => c.wall === 'B').length;
    if (nNum < minNumFloor) continue;
    if (nZero > Math.max(2, Math.floor(nNum * 0.30))) continue;
    if (!isSingleColor && (nW < 1 || nB < 1)) continue;
    if ((isHybrid || isFull) && (nW + nB) < Math.max(2, Math.ceil(fin.castle.length * 0.5))) continue;
    if (isMasyu) {
      const mcW = fin.clues.filter(isClW).length;
      const mcB = fin.clues.length - mcW;
      if (fin.clues.length < minClues || mcW < 1 || mcB < 1) continue;
      const ratio = fin.castle.length / fin.clues.length;
      if (ratio < 0.45 || ratio > 2.2) continue;
    }
    if (isSlither) {
      if (fin.slither.length < minSlither || new Set(fin.slither.map((s) => s.n)).size < 2) continue;
      const ratio = fin.castle.length / fin.slither.length;
      if (ratio < 0.45 || ratio > 2.2) continue;
    }
    if (isMidloop) {
      if (fin.midloop.length < minMid) continue;
      const ratio = fin.castle.length / fin.midloop.length;
      if (ratio < 0.45 || ratio > 2.2) continue;
    }
    if (reqQuadItems > 0) {
      const mr = rows >> 1, mc = cols >> 1;
      const qCnt = [0, 0, 0, 0];
      for (const cw of fin.castle) qCnt[(cw.r >= mr ? 2 : 0) + (cw.c >= mc ? 1 : 0)]++;
      for (const cl of fin.clues) qCnt[(cl.r >= mr ? 2 : 0) + (cl.c >= mc ? 1 : 0)]++;
      for (const sc of fin.slither) qCnt[(sc.r >= mr ? 2 : 0) + (sc.c >= mc ? 1 : 0)]++;
      for (const md of fin.midloop) qCnt[(md.r >= mr ? 2 : 0) + (md.c >= mc ? 1 : 0)]++;
      if (Math.min(...qCnt) < reqQuadItems) continue;
    }

    let P = compileC(fin.castle, fin.clues, fin.slither, fin.midloop);
    // Guard against unnumbered exterior Black, exterior Gray, or unnumbered Gray tiles
    if (P.castle.some((cw) => (cw.wall === 'G' && (!cw.dir || cw.isExterior)) || (cw.wall === 'B' && !cw.dir && cw.isExterior))) continue;

    let rated = cachedRated || rate(P);
    if (wantUnsolved) {
      if (rated.solved) continue;
    } else if (!rated.solved) {
      if (!allowUnsolved) continue;
    } else {
      if (TIERS.indexOf(rated.tier) > maxTierIdx) continue;
      if (targetTier && rated.tier !== targetTier) continue;
    }

    // Tier-preserving redundant-number stripping pass: turn interior W/B arrows into bare walls
    // whenever removing the number preserves uniqueness and does not raise the puzzle's tier.
    if (!isAllGray && !wantUnsolved && rated.solved && Date.now() < deadline) {
      const curTierIdx = TIERS.indexOf(rated.tier);
      const extNow = new Set(P.castle.filter((c) => c.isExterior).map((c) => c.r * cols + c.c));
      const bareOrbits = [];
      for (const idxs of cwOrbits) {
        const cw = cwState[idxs[0]];
        if (!cw.active || cw.wall === 'G' || !cw.dir) continue;
        if (idxs.some((idx) => extNow.has(cwState[idx].r * cols + cwState[idx].c))) continue;
        bareOrbits.push(idxs);
      }
      if (bareOrbits.length) {
        shuffle(bareOrbits, rand);
        // Prefer stripping 0-arrows first so we reduce zero clues and respect the 30% zero cap
        bareOrbits.sort((a, b) => (cwState[a[0]].n === 0 ? 0 : 1) - (cwState[b[0]].n === 0 ? 0 : 1));
        let curZero = nZero;
        let needReRate = false;
        for (const idxs of bareOrbits) {
          if (Date.now() >= deadline) break;
          if (nNumAct - idxs.length < minNumFloor) continue;
          const act = { kind: 'bareCw', idxs };
          const dropZero = idxs.reduce((s, idx) => s + (cwState[idx].n === 0 ? 1 : 0), 0);
          if (curZero - dropZero > Math.max(2, Math.floor((nNumAct - idxs.length) * 0.30))) continue;
          const undo = applyAct(act);
          const cur = extract();
          const altP = compileC(cur.castle, cur.clues, cur.slither, cur.midloop);
          let okBare = false;
          if (curTierIdx === 0) {
            const rb = solvedByRules(altP, BEGINNER_UPTO);
            if (rb.solved) { okBare = true; provedSol = rb.state; needReRate = true; }
          } else {
            const fastLimit = curTierIdx === 1 ? MEDIUM_UPTO : FIRST_LOOKAHEAD;
            const rf = solvedByRules(altP, fastLimit);
            if (rf.solved) {
              okBare = true;
              provedSol = rf.state;
              needReRate = true;
            } else {
              const ex = solve(altP, { limit: 2, maxNodes: pruneNodeCap });
              if (!ex.exceeded && ex.count === 1) {
                const rr = rate(altP);
                if (rr.solved && TIERS.indexOf(rr.tier) <= curTierIdx && (!targetTier || rr.tier === targetTier)) {
                  okBare = true;
                  rated = rr;
                  provedSol = ex.solutions[0];
                  needReRate = false;
                }
              }
            }
          }
          if (okBare) {
            curZero -= dropZero;
            P = altP;
            fin.castle = cur.castle;
          } else {
            undo();
          }
        }
        if (needReRate) {
          const rr = rate(P);
          if (!rr.solved || TIERS.indexOf(rr.tier) > maxTierIdx || (targetTier && rr.tier !== targetTier)) continue;
          rated = rr;
        }
      }
    }

    let sol = provedSol;
    if (!sol || !isSolved(P, sol.e)) {
      const verify = solve(P, { limit: 2, maxNodes: verifyMaxNodes });
      if (verify.exceeded || verify.count !== 1) continue;
      sol = verify.solutions[0];
      if (!isSolved(P, sol.e)) continue;
    }

    // Hybrid necessity checks (keeping blocked tiles as plain voids when testing the other family alone!)
    const plainVoids = fin.castle.map(({ r, c }) => ({ r, c }));
    const hasSecondSol = (altP) => {
      if (solvedByPropagate(altP)) return false;
      return solve(altP, { limit: 2, maxNodes: 30000, rng: rand }).count >= 2;
    };
    if (isMasyu) {
      if (!hasSecondSol(compileC(fin.castle, [], [], [], { name: `${name}_cw` }))) continue;
      if (!hasSecondSol(compileC([], fin.clues, [], [], { name: `${name}_ms`, voids: plainVoids }))) continue;
    } else if (isSlither) {
      if (!hasSecondSol(compileC(fin.castle, [], [], [], { name: `${name}_cw` }))) continue;
      if (!hasSecondSol(compileC([], [], fin.slither, [], { name: `${name}_sl`, voids: plainVoids }))) continue;
    } else if (isMidloop) {
      if (!hasSecondSol(compileC(fin.castle, [], [], [], { name: `${name}_cw` }))) continue;
      if (!hasSecondSol(compileC([], [], [], fin.midloop, { name: `${name}_ml`, voids: plainVoids }))) continue;
    } else if (isFull) {
      if (!hasSecondSol(compileC(fin.castle, [], [], [], { name: `${name}_nf`, fullBoard: false }))) continue;
      if (!hasSecondSol(compileC([], [], [], [], { name: `${name}_cw_voids`, voids: plainVoids }))) continue;
    }

    P.solution = encodeSolution(P, sol);
    P.rules = rated.rules;
    P.tier = rated.tier;
    P.score = rated.score;
    return P;
  }
  return null;
}

/**
 * Generate one verified, rated Masyu puzzle.
 * Options:
 *   rows, cols           board dimensions (each >= 4)
 *   seed                 PRNG seed (or pass `rng` directly)
 *   style                'balanced' | 'white' | 'black' | 'sparse' | 'gray-mixed' | 'gray-all' | 'full-masyu' | 'full-lines' | 'full-walls' | 'full-mixed' | 'full-swiss' | 'shaped' | 'swiss-cheese' | 'slither' | 'slither-swiss' | 'slither-all3' | 'slither-all2-full' | 'slither-masyu' | 'slither-full' | 'midloop' | 'midloop-masyu' | 'midloop-slither' | 'midloop-full' | 'castle' | 'castle-masyu' | 'castle-slither' | 'castle-midloop' | 'castle-full'
 *   voids                optional explicit array of `{ r, c }` cutout voids
 *   layout               clue filter or geometric pattern mask name (default 'none')
 *   minFill              minimum loop fill fraction (e.g. 1.0 for Full board)
 *   maxTier              'Beginner' | 'Medium' | 'Hard' | 'Expert' (default 'Expert')
 *   targetTier           'Beginner' | 'Medium' | 'Hard' | 'Expert' | 'Expert+' | null
 *   stripMode            'beginner' | 'medium' | 'deep' | null
 *   allowUnsolved        allow Expert+ puzzles beyond the human rater
 *   keepFrac             0..1: optional minimum fraction of initial clues to keep
 *   budgetMs             time budget in ms (default 15000)
 *   verifyMaxNodes       node cap for complete uniqueness check (default 500000)
 *   name                 puzzle name
 */
export function generatePuzzle({
  rows,
  cols,
  seed = 1,
  rng = null,
  style = 'balanced',
  layout = 'none',
  voids = null,
  minFill = null,
  maxTier = 'Expert',
  targetTier = null,
  stripMode = null,
  allowUnsolved = false,
  keepFrac = null,
  budgetMs = 15000,
  verifyMaxNodes = 500000,
  name = `masyu_${cols}x${rows}_${seed}`,
} = {}) {
  const rand = rng || makeRng(seed);
  const deadline = Date.now() + budgetMs;
  if (style === 'swiss-cheese' && (!voids || !voids.length)) {
    voids = swissCheeseVoids(rows, cols, rand);
  }
  const N = rows * cols;
  const fillRatio = minFill ?? (N >= 25 ? 0.55 : 0.48);
  const minLoopCells = Math.max(8, Math.floor(N * fillRatio));
  const reqQuadFill = rows >= 12 && cols >= 12 ? Math.min(0.50, fillRatio * 0.85)
    : rows >= 8 && cols >= 8 ? Math.min(0.35, fillRatio * 0.8)
    : 0;
  const reqQuadClues = (rows >= 12 && cols >= 12 && layout !== 'frame' && style !== 'sparse')
    ? Math.max(2, Math.floor((N / 4) * 0.08))
    : 0;
  const wantUnsolved = targetTier === 'Expert+';
  const maxTierIdx = wantUnsolved ? TIERS.length - 1 : TIERS.indexOf(maxTier);
  const effectiveMaxTier = targetTier && !wantUnsolved ? Math.min(maxTierIdx, TIERS.indexOf(targetTier)) : maxTierIdx;
  const beginnerOnly = stripMode === 'beginner' || (stripMode === null && effectiveMaxTier === 0);
  const mediumOnly = stripMode === 'medium' || (stripMode === null && effectiveMaxTier === 1);
  if (style === 'full-masyu' || style === 'full-gray' || style === 'full-lines' || style === 'full-walls' || style === 'full-mixed' || style === 'full-swiss') {
    return generateFullBoardPuzzle({
      rows, cols, style, layout, voids, rand, deadline, maxTierIdx, effectiveMaxTier, targetTier: wantUnsolved ? null : targetTier,
      wantUnsolved, allowUnsolved, beginnerOnly, mediumOnly, stripMode, verifyMaxNodes, name,
    });
  }
  if (style === 'slither' || style === 'slither-swiss' || style === 'slither-all3' || style === 'slither-all2-full' || style === 'slither-all3-full' || style === 'slither-masyu' || style === 'slither-all2-masyu' || style === 'slither-all3-masyu' || style === 'slither-gray' || style === 'slither-masyu-swiss' || style === 'slither-full' || style === 'slither-full-swiss') {
    return generateSlitherPuzzle({
      rows, cols, style, layout, voids, rand, deadline, maxTierIdx, effectiveMaxTier, targetTier: wantUnsolved ? null : targetTier,
      wantUnsolved, allowUnsolved, beginnerOnly, mediumOnly, stripMode, verifyMaxNodes, name, minLoopCells,
    });
  }
  if (style === 'midloop' || style === 'midloop-swiss' || style === 'midloop-even' || style === 'midloop-odd' || style === 'midloop-long' || style === 'midloop-masyu' || style === 'midloop-gray' || style === 'midloop-slither' || style === 'midloop-slither-swiss' || style === 'midloop-slither2' || style === 'midloop-full') {
    return generateMidloopPuzzle({
      rows, cols, style, layout, voids, rand, deadline, maxTierIdx, effectiveMaxTier, targetTier: wantUnsolved ? null : targetTier,
      wantUnsolved, allowUnsolved, beginnerOnly, mediumOnly, stripMode, verifyMaxNodes, name, minLoopCells,
    });
  }
  if (style === 'castle' || style === 'castle-allgray' || style === 'castle-allwhite' || style === 'castle-allblack' || style === 'castle-swiss' || style === 'castle-masyu' || style === 'castle-gray' || style === 'castle-slither' || style === 'castle-midloop' || style === 'castle-full') {
    return generateCastlePuzzle({
      rows, cols, style, layout, voids, rand, deadline, maxTierIdx, effectiveMaxTier, targetTier: wantUnsolved ? null : targetTier,
      wantUnsolved, allowUnsolved, beginnerOnly, mediumOnly, stripMode, verifyMaxNodes, name,
    });
  }
  if ((voids && voids.length) || style === 'shaped' || style === 'swiss-cheese') {
    return generateShapedPuzzle({
      rows, cols, voids: voids || [], style, rand, deadline, maxTierIdx, effectiveMaxTier,
      targetTier: wantUnsolved ? null : targetTier, wantUnsolved, allowUnsolved, beginnerOnly,
      mediumOnly, stripMode, verifyMaxNodes, name, minFill,
    });
  }
  const pts = maskPoints(layout, rows, cols);
  if (pts) {
    return generateMaskPuzzle({
      rows, cols, pts, rand, deadline, maxTierIdx, targetTier: wantUnsolved ? null : targetTier,
      wantUnsolved, allowUnsolved, verifyMaxNodes, name, minLoopCells,
    });
  }
  const pruneNodeCap = N <= 64 ? 15000 : N <= 100 ? 25000 : N < 320 ? 40000 : 6000;
  const solvedByPropagate = (P) => {
    const st = initialState(P);
    if (!propagate(P, st)) return false;
    for (let x = 0; x < P.numEdges; x++) if (P.edgeA[x] >= 0 && st.e[x] === E_UNKNOWN) return false;
    return isSolved(P, st.e);
  };
  const pairedStrip = layout === 'rot180' || layout === 'mirror' || layout === 'transpose' || layout === 'rot90'
    || layout === 'yinyang' || layout === 'yinyang-mirror' || layout === 'yinyang-transpose';

  while (Date.now() < deadline) {
    const base = tightLoop(rows, cols, rand, {
      style: (style === 'white' || style === 'black' || style === 'gray-all') ? style : 'balanced',
      layout,
      minFill,
      maxSteps: (style === 'black' || style === 'gray-all') ? Math.max(700, (rows - 1) * (cols - 1) * 6) : null,
    });
    if (base.loopCells < minLoopCells || base.emptyBorders > 0 || base.clues.length < 4) continue;
    if (reqQuadFill > 0 && base.minQuadFill < reqQuadFill) continue;

    // Check uniqueness of the full clue pool
    if (base.unk > 0) {
      if (N >= 320 && style === 'balanced' && layout === 'none') continue;
      if (base.unk > 48) continue;
      const checkFull = solve(base.P, { limit: 2, maxNodes: pruneNodeCap });
      if (checkFull.exceeded || checkFull.count !== 1) continue;
    }

    let current = base.clues.slice();
    let baseTight = base.unk === 0;

    // For gray-mixed, convert ~55% of the initial clue pool into mystery gray pearls while preserving uniqueness
    // (trying a fast batch flip first, then sub-ms propagation-guided greedy flips).
    if (style === 'gray-mixed' && !pairedStrip) {
      const targetG = Math.max(3, Math.round(current.length * (0.48 + 0.16 * rand())));
      const idxs = shuffle(current.map((_, idx) => idx), rand);
      const batch = current.map((c) => ({ ...c }));
      for (let j = 0; j < targetG && j < idxs.length; j++) batch[idxs[j]].t = 'G';
      const Pbatch = compile({ name, rows, cols, clues: batch });
      let batchOk = solvedByPropagate(Pbatch) ? 2 : 0;
      if (!batchOk && !beginnerOnly) {
        const ex = solve(Pbatch, { limit: 2, maxNodes: Math.min(2500, pruneNodeCap) });
        if (!ex.exceeded && ex.count === 1) batchOk = 1;
      }
      if (batchOk) {
        current = batch;
        baseTight = batchOk === 2;
      } else {
        // Sub-millisecond propagation-only greedy flips (never stalls on hard exact-search trees)
        current = current.map((c) => ({ ...c }));
        let flipped = 0;
        for (const idx of idxs) {
          if (Date.now() >= deadline || flipped >= targetG) break;
          const prev = current[idx].t;
          current[idx].t = 'G';
          if (solvedByPropagate(compile({ name, rows, cols, clues: current }))) {
            flipped++;
          } else {
            current[idx].t = prev;
          }
        }
        baseTight = true;
      }
    }

    // Keep canonical cell order so cachedRated matches final compile() even on gray-mixed/gray-all
    current.sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));

    const minKeep = keepFrac != null
      ? Math.max(2, Math.floor(current.length * keepFrac))
      : (style === 'sparse' ? 2 : beginnerOnly ? Math.max(4, Math.floor(current.length * 0.22)) : 2);

    // Group clues into removable units (single clues normally, or whole symmetry orbits for symmetric layouts)
    const buildUnits = (list) => {
      if (!pairedStrip) return list.map((c) => ({ keys: [c.r * cols + c.c], items: [c] }));
      const byKey = new Map(list.map((c) => [c.r * cols + c.c, c]));
      const used = new Set(), units = [];
      for (const c of list) {
        const k = c.r * cols + c.c;
        if (used.has(k)) continue;
        const orb = clueOrbitKeys(layout, rows, cols, c.r, c.c).filter((ok) => byKey.has(ok));
        for (const ok of orb) used.add(ok);
        units.push({ keys: orb, items: orb.map((ok) => byKey.get(ok)) });
      }
      return units;
    };

    const units = shuffle(buildUnits(current), rand);
    if (!pairedStrip && style === 'balanced' && base.whites.length > 0 && base.blacks.length > 0) {
      const wRatio = base.whites.length / current.length;
      const overRep = wRatio > 0.65 ? 'W' : wRatio < 0.35 ? 'B' : null;
      if (overRep) {
        const keyed = units.map((u) => ({ u, k: (u.items[0].t === overRep ? 0 : 1) + rand() * 0.7 }));
        keyed.sort((a, b) => a.k - b.k);
        for (let i = 0; i < keyed.length; i++) units[i] = keyed[i].u;
      }
    } else if (style === 'gray-mixed') {
      // Gently prefer stripping regular W/B before gray clues so stripped puzzles keep a healthy gray mix
      const keyed = units.map((u) => ({ u, k: (u.items[0].t === 'G' ? 0.45 : 0) + rand() }));
      keyed.sort((a, b) => a.k - b.k);
      for (let i = 0; i < keyed.length; i++) units[i] = keyed[i].u;
    }

    // Pass 0: ultra-fast propagation-only pruning (sub-millisecond per clue, Beginner-sound).
    // Strips the bulk of redundant clues cheaply before running full human-rule or exact-search passes.
    const keepSet = new Set(current.map((c) => c.r * cols + c.c));
    if (baseTight) {
      for (const u of units) {
        if (Date.now() >= deadline || current.length - u.keys.length < minKeep) break;
        if (u.keys.some((k) => !keepSet.has(k))) continue;
        const drop = new Set(u.keys);
        const trial = current.filter((x) => !drop.has(x.r * cols + x.c));
        const P = compile({ name, rows, cols, clues: trial });
        if (solvedByPropagate(P)) {
          current = trial;
          for (const k of u.keys) keepSet.delete(k);
        }
      }
    }

    // Pass 1: sound human-rule pruning (no search needed) on remaining clues.
    // On giant boards (N >= 320), Pass 0 already stripped propagation-redundant clues cheaply;
    // skip Pass 1 when Pass 2 will strip directly with exact search, and cap it for beginnerOnly/mediumOnly.
    const fastUpto = beginnerOnly ? BEGINNER_UPTO : mediumOnly ? MEDIUM_UPTO : FIRST_LOOKAHEAD;
    const remPass1 = (N >= 320 && !beginnerOnly && !mediumOnly && base.unk === 0) ? [] : shuffle(buildUnits(current), rand);
    const pass1Cap = N >= 320 ? 15 : remPass1.length;
    let pass1Tried = 0;
    for (const u of remPass1) {
      if (Date.now() >= deadline || current.length - u.keys.length < minKeep || pass1Tried >= pass1Cap) break;
      if (u.keys.some((k) => !keepSet.has(k))) continue;
      pass1Tried++;
      const drop = new Set(u.keys);
      const trial = current.filter((x) => !drop.has(x.r * cols + x.c));
      const P = compile({ name, rows, cols, clues: trial });
      if (solvedByRules(P, fastUpto).solved) {
        current = trial;
        for (const k of u.keys) keepSet.delete(k);
      }
    }

    // Pass 2: for Medium (if Pass 1 stayed Beginner) / Hard / Expert / sparse, strip further using fast exact
    // uniqueness checks, remembering removed units so we can binary-search back if we step past maxTier.
    let cachedRated = null;
    let skipPass2 = beginnerOnly;
    if (!skipPass2 && mediumOnly && Date.now() < deadline) {
      const P1 = compile({ name, rows, cols, clues: current });
      const r1 = rate(P1);
      if (r1.solved && r1.tier === 'Medium') {
        cachedRated = r1;
        skipPass2 = true;
      }
    }
    if (!skipPass2 && Date.now() < deadline) {
      const remUnits = shuffle(buildUnits(current), rand);
      const deepStrip = stripMode === 'deep' || wantUnsolved || targetTier === 'Hard' || targetTier === 'Expert';
      const maxStrips = style === 'sparse' ? remUnits.length
        : N >= 320 ? (stripMode === 'medium' || targetTier === 'Medium' ? 2 : (stripMode === 'deep' || wantUnsolved || targetTier === 'Expert') ? 7 : targetTier === 'Hard' ? 4 : 3)
        : deepStrip ? remUnits.length
        : (stripMode === 'medium' || targetTier === 'Medium') ? Math.max(2, Math.min(8, Math.ceil(remUnits.length * 0.28)))
        : Math.max(3, Math.min(12, Math.ceil(remUnits.length * 0.45)));
      const maxPass2Tries = N >= 320 && style !== 'sparse' ? 60 : remUnits.length;

      let stripped = 0, tried = 0;
      const removed = [];
      for (const u of remUnits) {
        if (Date.now() >= deadline || current.length - u.keys.length < minKeep || stripped >= maxStrips || tried >= maxPass2Tries) break;
        tried++;
        const drop = new Set(u.keys);
        const trial = current.filter((x) => !drop.has(x.r * cols + x.c));
        const P = compile({ name, rows, cols, clues: trial });
        const exact = solve(P, { limit: 2, maxNodes: pruneNodeCap });
        if (exact.exceeded || exact.count !== 1) continue;
        current = trial;
        removed.push(u.items);
        stripped++;
      }

      // If rating gets stuck (Expert+) or exceeds maxTier, restore removed units via binary search
      // (O(log k) rate() calls instead of O(k)) unless Expert+ / allowUnsolved wants unsolved puzzles!
      const isWithin = (r) => (allowUnsolved && !r.solved) || (r.solved && TIERS.indexOf(r.tier) <= effectiveMaxTier);
      let rated = rate(compile({ name, rows, cols, clues: current }));
      if (wantUnsolved || isWithin(rated)) {
        cachedRated = rated;
      } else if (removed.length > 0 && Date.now() < deadline) {
        const strippedBase = current;
        let lo = 0, hi = removed.length;
        let bestClues = strippedBase.concat(...removed).sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
        let bestRated = null;
        while (lo + 1 < hi && Date.now() < deadline) {
          const mid = (lo + hi) >> 1;
          const cand = strippedBase.concat(...removed.slice(mid))
            .sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
          const r = rate(compile({ name, rows, cols, clues: cand }));
          if (isWithin(r)) {
            lo = mid;
            bestClues = cand;
            bestRated = r;
          } else {
            hi = mid;
          }
        }
        current = bestClues;
        cachedRated = bestRated;
      }
    }

    if (Date.now() >= deadline) break;

    if (style === 'balanced' && rows >= 5 && cols >= 5) {
      const nW = current.filter((c) => c.t === 'W').length;
      const nB = current.filter((c) => c.t === 'B').length;
      if (nW < 1 || nB < 1) continue;
      if (typeof layout === 'string' && layout.startsWith('cookie')) {
        const minHalf = rows >= 10 && cols >= 10 ? 4 : rows >= 8 && cols >= 8 ? 2 : 1;
        if (nW < minHalf || nB < minHalf) continue;
      }
    }
    if (style === 'gray-mixed') {
      let nW = 0, nB = 0, nG = 0, nonCornerG = 0;
      for (const c of current) {
        if (c.t === 'W') nW++;
        else if (c.t === 'B') nB++;
        else if (c.t === 'G') {
          nG++;
          if (!((c.r === 0 || c.r === rows - 1) && (c.c === 0 || c.c === cols - 1))) nonCornerG++;
        }
      }
      const minG = Math.max(2, Math.ceil(current.length * 0.30));
      if (nW < 1 || nB < 1 || nG < minG || nonCornerG < 1) continue;
    }
    if (reqQuadClues > 0) {
      const qs = quadrantStats(rows, cols, base.edges, current);
      if (qs.minClues < reqQuadClues) continue;
    }

    current.sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
    const P = compile({ name, rows, cols, clues: current });

    // Human-style rating BEFORE expensive exact verification
    const rated = cachedRated || rate(P);
    if (wantUnsolved) {
      if (rated.solved) continue;
    } else if (!rated.solved) {
      if (!allowUnsolved) continue;
    } else {
      if (TIERS.indexOf(rated.tier) > maxTierIdx) continue;
      if (targetTier && rated.tier !== targetTier) continue;
    }

    // Independent verification: complete exact search (never trust exceeded!)
    const verify = solve(P, { limit: 2, maxNodes: verifyMaxNodes });
    if (verify.exceeded || verify.count !== 1) continue;
    const sol = verify.solutions[0];
    if (!isSolved(P, sol.e)) continue;

    P.solution = encodeSolution(P, sol);
    P.rules = rated.rules;
    P.tier = rated.tier;
    P.score = rated.score;
    return P;
  }

  return null;
}
