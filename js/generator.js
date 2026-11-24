// Solution-first Masyu generator (pure JS, no DOM).
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
  compile, propagate, initialState, solve, isSolved, encodeSolution, E_ON, E_OFF, E_UNKNOWN,
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
  inS[((rng() * fr) | 0) * fc + ((rng() * fc) | 0)] = 1;
  let faceCount = 1;
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
  const { edges, loopCells } = toEdges();
  return { edges, loopCells, faceCount };
}

/** Find every cell on `edges` where a White ('W') or Black ('B') circle is legally allowed. */
export function allowedClues(rows, cols, edges) {
  const empty = compile({ name: 'tmp', rows, cols, clues: [] });
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

/**
 * Symmetry/layout helpers for themed bonus corpuses.
 * Supported `layout` values:
 *   'none'         normal unconstrained clues
 *   'checkerboard' clues only on (r + c) % 2 === 0 (no two circles ever touch orthogonally)
 *   'interior'     no clues on the outer perimeter (rows 0/R-1, cols 0/C-1)
 *   'frame'        clues only in the outer 2-cell ring (blank hollow center)
 *   'stripes'      clues only on even rows (r % 2 === 0)
 *   'rot180'       exact 180° rotational symmetry (loop and circle colors)
 *   'mirror'       exact left-right mirror symmetry (loop and circle colors)
 *   'transpose'    exact diagonal-mirror symmetry (r, c) <-> (c, r) (square boards)
 *   'rot90'        exact 90° 4-fold rotational symmetry (loop and circle colors; square boards)
 *   'yinyang'      180° opposite-color symmetry (every W sits opposite a B and vice versa)
 *   'lattice'      every even 1-based row & col (r%2===1, c%2===1) has a W or B circle (all present)
 */
function clueFilterFor(layout, rows, cols) {
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
    const pts = symFaces === 'rot180' ? [[r, c], [fr - 1 - r, fc - 1 - c]]
      : symFaces === 'mirror' ? [[r, c], [r, fc - 1 - c]]
      : symFaces === 'transpose' ? [[r, c], [c, r]]
      : [[r, c], [c, fr - 1 - r], [fr - 1 - r, fc - 1 - c], [fc - 1 - c, r]];
    const seen = new Set(), out = [];
    for (const [rr, cc] of pts) {
      const k = rr * fc + cc;
      if (!seen.has(k)) { seen.add(k); out.push([rr, cc]); }
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
    if (orb.some(([rr, cc]) => inS[rr * fc + cc] !== v0)) return null;
    if (v0 && faceCount - orb.length < minFaces) return null;
    for (const [rr, cc] of orb) inS[rr * fc + cc] ^= 1;
    const { edges, loopCells } = toEdges();
    if (loopCells < 4 || !isSolved(emptyBoard, edges)) {
      for (const [rr, cc] of orb) inS[rr * fc + cc] ^= 1;
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
  const filterClues = clueFilterFor(layout, rows, cols);
  const stepsLimit = maxSteps ?? Math.max(500, Math.min(6000, F * 5 + (layout !== 'none' ? 300 : 0) + (minFill >= 0.95 ? 700 : 0)));

  const evaluate = () => {
    const { edges, loopCells, minR, maxR, minC, maxC, emptyBorders, quadFills, qTot, minQuadFill } = toEdges();
    const { whites, blacks } = allowedClues(rows, cols, edges);
    const pool = style === 'white' ? whites : style === 'black' ? blacks : whites.concat(blacks);
    const clues = filterClues(pool);
    const P = compile({ name: 'tl', rows, cols, clues });
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

  let cur = evaluate();
  if (isExactHamSeed) {
    // Re-sample O(N) spanning-tree Hamiltonian cycles until one is 100% tight (usually <10 tries, ~10ms)
    for (let t = 0; t < 40 && cur.score > 0; t++) {
      seedExactHam();
      const nxt = evaluate();
      if (nxt.score < cur.score) cur = nxt;
    }
    return cur;
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
  return cur;
}

const BEGINNER_UPTO = RULES.findIndex((r) => r.tier !== 'Beginner');
const MEDIUM_UPTO = RULES.findIndex((r) => r.tier !== 'Beginner' && r.tier !== 'Medium');

/**
 * Generate one verified, rated Masyu puzzle.
 * Options:
 *   rows, cols           board dimensions (each >= 4)
 *   seed                 PRNG seed (or pass `rng` directly)
 *   style                'balanced' | 'white' | 'black' | 'sparse'
 *   maxTier              'Beginner' | 'Medium' | 'Hard'
 *   targetTier           'Beginner' | 'Medium' | 'Hard' | null
 *   keepFrac             0..1: optional minimum fraction of initial clues to keep
 *   budgetMs             time budget in ms (default 15000)
 *   verifyMaxNodes       node cap for complete uniqueness check (default 500000)
 *   name                 puzzle name
 */
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
      return collect((r, c) => (r & 1) === 1 && (c & 1) === 1);
    case 'concentric-sq': // 9x9: dotted outer ring (d=1) + inner diamond (d=2 midpoints) + center
      return collect((r, c) => {
        const d = Math.min(r, rows - 1 - r, c, cols - 1 - c);
        const mr = (rows - 1) / 2, mc = (cols - 1) / 2;
        return (d === 1 && ((r + c) & 1) === 0) || (d === 2 && (r === mr || c === mc)) || (r === mr && c === mc);
      });
    case 'twin-sq': // 10x10: two concentric dotted square rings (d=1 and d=3)
      return collect((r, c) => {
        const d = Math.min(r, rows - 1 - r, c, cols - 1 - c);
        return (d === 1 || d === 3) && ((r + c) & 1) === 0;
      });
    case 'blocks2x2': // 9x9: four inset 2x2 squares + center diamond
      return collect((r, c) => (
        ((r === 1 || r === 2 || r === rows - 3 || r === rows - 2) && (c === 1 || c === 2 || c === cols - 3 || c === cols - 2))
        || (Math.abs(r - ((rows - 1) / 2)) + Math.abs(c - ((cols - 1) / 2)) === 1)
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
    case 'honeycomb': // 9x9 or 10x10: staggered brickwork / hexagonal lattice strictly interior
      return collect((r, c) => (
        r >= 1 && r <= rows - 2 && c >= 1 && c <= cols - 2
        && (((r & 1) === 1 && c % 3 === 1) || ((r & 1) === 0 && c % 3 === 2))
      ));
    case 'galaxy': // 10x10: 4-arm swirling spiral radiating from a central 2x2 core
      if (rows !== 10 || cols !== 10) return [];
      return [
        [4, 4], [4, 5], [5, 4], [5, 5],
        [2, 4], [1, 5], [1, 7], [3, 8],
        [4, 7], [5, 8], [7, 8], [8, 6],
        [7, 5], [8, 4], [8, 2], [6, 1],
        [5, 2], [4, 1], [2, 1], [1, 3],
      ];
    case 'circle-ring': // 10x10: outer circular ring + central 2x2 core
      if (rows !== 10 || cols !== 10) return [];
      return [
        [1, 3], [1, 4], [1, 5], [1, 6],
        [2, 2], [2, 7],
        [3, 1], [3, 8], [4, 1], [4, 8], [5, 1], [5, 8], [6, 1], [6, 8],
        [7, 2], [7, 7],
        [8, 3], [8, 4], [8, 5], [8, 6],
        [4, 4], [4, 5], [5, 4], [5, 5],
      ];
    case 'diag-stripes': // 9x9: parallel diagonal bands strictly interior
      return collect((r, c) => r >= 1 && r <= rows - 2 && c >= 1 && c <= cols - 2 && (r + c) % 3 === 1);
    default:
      return null;
  }
}

/**
 * Generate a fixed-mask Masyu puzzle where every intersection in `pts` holds a W or B circle
 * (all dots present, none elsewhere) via guided W<->B hill-climbing toward uniqueness.
 */
function generateMaskPuzzle({
  rows, cols, pts, rand, deadline, maxTierIdx, targetTier, verifyMaxNodes, name, minLoopCells,
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
    if (!rated.solved) continue;
    if (TIERS.indexOf(rated.tier) > maxTierIdx) continue;
    if (targetTier && rated.tier !== targetTier) continue;

    P.solution = solStr;
    P.rules = rated.rules;
    P.tier = rated.tier;
    P.score = rated.score;
    return P;
  }
  return null;
}

export function generatePuzzle({
  rows,
  cols,
  seed = 1,
  rng = null,
  style = 'balanced',
  layout = 'none',
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
  const pts = maskPoints(layout, rows, cols);
  if (pts) {
    return generateMaskPuzzle({
      rows, cols, pts, rand, deadline, maxTierIdx, targetTier: wantUnsolved ? null : targetTier, verifyMaxNodes, name, minLoopCells,
    });
  }
  const effectiveMaxTier = targetTier && !wantUnsolved ? Math.min(maxTierIdx, TIERS.indexOf(targetTier)) : maxTierIdx;
  const beginnerOnly = stripMode === 'beginner' || (stripMode === null && effectiveMaxTier === 0);
  const mediumOnly = stripMode === 'medium' || (stripMode === null && effectiveMaxTier === 1);
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
      style: style === 'white' || style === 'black' ? style : 'balanced',
      layout,
      minFill,
      maxSteps: style === 'black' ? Math.max(700, (rows - 1) * (cols - 1) * 6) : null,
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
      if (wRatio > 0.65) {
        units.sort((a, b) => (a.items[0].t === 'W' ? -1 : 1) - (b.items[0].t === 'W' ? -1 : 1) + (rand() - 0.5) * 1.4);
      } else if (wRatio < 0.35) {
        units.sort((a, b) => (a.items[0].t === 'B' ? -1 : 1) - (b.items[0].t === 'B' ? -1 : 1) + (rand() - 0.5) * 1.4);
      }
    }

    // Pass 0: ultra-fast propagation-only pruning (sub-millisecond per clue, Beginner-sound).
    // Strips the bulk of redundant clues cheaply before running full human-rule or exact-search passes.
    const keepSet = new Set(current.map((c) => c.r * cols + c.c));
    if (base.unk === 0) {
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
        let bestClues = strippedBase.concat(...removed);
        let bestRated = null;
        while (lo + 1 < hi && Date.now() < deadline) {
          const mid = (lo + hi) >> 1;
          const cand = strippedBase.concat(...removed.slice(mid));
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
      const hasW = current.some((c) => c.t === 'W');
      const hasB = current.some((c) => c.t === 'B');
      if (!hasW || !hasB) continue;
    }
    if (reqQuadClues > 0) {
      const qs = quadrantStats(rows, cols, base.edges, current);
      if (qs.minClues < reqQuadClues) continue;
    }

    current.sort((a, b) => (a.r * cols + a.c) - (b.r * cols + b.c));
    const P = compile({ name, rows, cols, clues: current });

    // Independent verification: complete exact search (never trust exceeded!)
    const verify = solve(P, { limit: 2, maxNodes: verifyMaxNodes });
    if (verify.exceeded || verify.count !== 1) continue;
    const sol = verify.solutions[0];
    if (!isSolved(P, sol.e)) continue;

    // Human-style rating
    const rated = cachedRated || rate(P);
    if (wantUnsolved) {
      if (rated.solved) continue;
    } else if (!rated.solved) {
      if (!allowUnsolved) continue;
    } else {
      if (TIERS.indexOf(rated.tier) > maxTierIdx) continue;
      if (targetTier && rated.tier !== targetTier) continue;
    }

    P.solution = encodeSolution(P, sol);
    P.rules = rated.rules;
    P.tier = rated.tier;
    P.score = rated.score;
    return P;
  }

  return null;
}
