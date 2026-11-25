// Pure 90° clockwise logical rotation for puzzles and player marks, plus responsive layout selection (no DOM).
//
// Coordinate mapping (90° CW):
//   Base puzzle P has dimensions R × C; rotated puzzle R_P has dimensions C × R.
//   Cell (r, c) in P  <->  (r', c') = (c, R - 1 - r) in R_P.
//   Direction d (0=U, 1=R, 2=D, 3=L)  <->  d' = (d + 1) & 3.
//   Dual face (fr, fc) in (R-1)×(C-1)  <->  (fc, R - 2 - fr) in (C-1)×(R-1).
//
// Because the rotation is logical (not CSS-only), column/row labels (A.. across top, 1.. down left),
// directional hints in js/explain.js, Auto-X, Auto-Shade, and drag gestures all remain 100% consistent,
// while localStorage saves stay in canonical base orientation.
import { compile, puzzleHash } from './logic.js';
import { numFacesOf } from './marks.js';

export const MIN_PX = 26;
export const MAX_PX = 48;

/** Rotate a 4-bit direction mask (bits 0=U, 1=R, 2=D, 3=L) 90° clockwise. */
const rotDirMaskCW = (m) => ((m << 1) | (m >> 3)) & 15;

/** Rotate a compiled (or raw) puzzle 90° clockwise and compile the result. */
export function rotatePuzzleCW(P) {
  const R = P.rows, C = P.cols;
  const clues = P.clues.map((cl) => ({ r: cl.c, c: R - 1 - cl.r, t: cl.t }));
  const givens = (P.givens || []).map((gv) => (
    gv.dir === 'H'
      ? { r: gv.c, c: R - 1 - gv.r, dir: 'V', v: gv.v }
      : { r: gv.c, c: R - 2 - gv.r, dir: 'H', v: gv.v }
  ));

  let solution = '';
  if (P.solution && P.solution.length === R * C) {
    const out = new Array(R * C);
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const ch = P.solution[r * C + c];
        const dst = c * R + (R - 1 - r);
        out[dst] = ch === '#' ? '#' : rotDirMaskCW(parseInt(ch, 16)).toString(16);
      }
    }
    solution = out.join('');
  }

  return compile({
    name: P.name,
    rows: C,
    cols: R,
    clues,
    ...(P.fullBoard ? { fullBoard: true } : {}),
    ...(givens.length ? { givens } : {}),
    solution,
    rules: P.rules,
    tier: P.tier,
    score: P.score,
    hashKey: puzzleHash(P),
  });
}

/**
 * Map a valid edge index `x` in base puzzle `baseP` (R × C) to its corresponding
 * edge index in `rotatePuzzleCW(baseP)` (C × R). Returns -1 for off-board edges.
 */
export function mapEdgeCW(baseP, x) {
  if (x < 0 || x >= baseP.numEdges || baseP.edgeA[x] < 0) return -1;
  const R = baseP.rows, C = baseP.cols;
  const isVert = x & 1;
  const i = x >> 1;
  const r = (i / C) | 0, c = i % C;
  if (!isVert) {
    // Horizontal edge (r,c)-(r,c+1) -> vertical edge (c, R-1-r)-(c+1, R-1-r) in C × R
    return 2 * (c * R + (R - 1 - r)) + 1;
  }
  // Vertical edge (r,c)-(r+1,c) -> horizontal edge (c, R-2-r)-(c, R-1-r) in C × R
  return 2 * (c * R + (R - 2 - r));
}

/** Map a dual face index `f` in `baseP` ((R-1)×(C-1)) to its index in `rotatePuzzleCW(baseP)` ((C-1)×(R-1)). */
export function mapFaceCW(baseP, f) {
  const fR = baseP.rows - 1, fC = baseP.cols - 1;
  if (fR <= 0 || fC <= 0 || f < 0 || f >= fR * fC) return -1;
  const fr = (f / fC) | 0, fc = f % fC;
  return fc * fR + (fR - 1 - fr);
}

/** Transform a marks bundle `{ edges, autoE, faces, autoF, grays?, autoG? }` from `baseP` into `rotP` (90° CW). */
export function rotateMarksCW(baseP, rotP, m) {
  const gLen = rotP.grays ? rotP.grays.length : 0;
  const out = {
    edges: new Uint8Array(rotP.numEdges),
    autoE: new Uint8Array(rotP.numEdges),
    faces: new Uint8Array(numFacesOf(rotP)),
    autoF: new Uint8Array(numFacesOf(rotP)),
    grays: m.grays ? m.grays.slice() : new Uint8Array(gLen),
    autoG: m.autoG ? m.autoG.slice() : new Uint8Array(gLen),
  };
  for (let x = 0; x < baseP.numEdges; x++) {
    const x2 = mapEdgeCW(baseP, x);
    if (x2 >= 0) {
      out.edges[x2] = m.edges[x];
      out.autoE[x2] = m.autoE[x];
    }
  }
  const F = m.faces.length;
  for (let f = 0; f < F; f++) {
    const f2 = mapFaceCW(baseP, f);
    if (f2 >= 0) {
      out.faces[f2] = m.faces[f];
      out.autoF[f2] = m.autoF[f];
    }
  }
  return out;
}

/** Inverse of `rotateMarksCW`: transform marks from `rotP` back into canonical `baseP` (90° CCW). */
export function unrotateMarksCW(baseP, rotP, m) {
  const gLen = baseP.grays ? baseP.grays.length : 0;
  const out = {
    edges: new Uint8Array(baseP.numEdges),
    autoE: new Uint8Array(baseP.numEdges),
    faces: new Uint8Array(numFacesOf(baseP)),
    autoF: new Uint8Array(numFacesOf(baseP)),
    grays: m.grays ? m.grays.slice() : new Uint8Array(gLen),
    autoG: m.autoG ? m.autoG.slice() : new Uint8Array(gLen),
  };
  for (let x = 0; x < baseP.numEdges; x++) {
    const x2 = mapEdgeCW(baseP, x);
    if (x2 >= 0) {
      out.edges[x] = m.edges[x2];
      out.autoE[x] = m.autoE[x2];
    }
  }
  const F = out.faces.length;
  for (let f = 0; f < F; f++) {
    const f2 = mapFaceCW(baseP, f);
    if (f2 >= 0) {
      out.faces[f] = m.faces[f2];
      out.autoF[f] = m.autoF[f2];
    }
  }
  return out;
}

/**
 * Choose board orientation and cell pitch (`px`) for a given available viewport `(availW, availH)`.
 *
 * Honors vertical-overflow preference: never auto-rotates into horizontal overflow (`pxW < MIN_PX`)
 * when canonical fits horizontally. If `override` is `true`/`false`, respects the player's manual turn.
 */
export function chooseLayout(baseRows, baseCols, availW, availH, override = null) {
  const pitchFor = (r, c) => {
    const pxW = availW / (c + 0.5);
    const pxH = availH > 0 ? availH / (r + 0.5) : Infinity;
    const fitsW = pxW >= MIN_PX;
    const fitsH = pxH >= MIN_PX;
    const raw = fitsH ? Math.min(pxW, pxH) : pxW;
    const px = Math.max(MIN_PX, Math.min(MAX_PX, Math.floor(raw)));
    return { px, pxW, pxH, fitsW, fitsH, fitsBoth: fitsW && fitsH };
  };

  const a = pitchFor(baseRows, baseCols);
  if (baseRows === baseCols) return { rotated: false, px: a.px };

  const b = pitchFor(baseCols, baseRows);
  if (override !== null) return { rotated: !!override, px: override ? b.px : a.px };

  let rotated = false;
  if (!b.fitsW) {
    rotated = false;
  } else if (!a.fitsW) {
    rotated = true;
  } else if (b.fitsBoth && !a.fitsBoth) {
    rotated = true;
  } else if (b.fitsBoth && a.fitsBoth) {
    rotated = b.px > a.px;
  } else {
    rotated = baseCols < baseRows;
  }
  return { rotated, px: rotated ? b.px : a.px };
}
