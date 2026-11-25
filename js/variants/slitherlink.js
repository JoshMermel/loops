// Slitherlink constraint module (pure logic, no DOM).
//
// Rules: each numbered dual face (0..3) at (r, c) in the (rows-1) x (cols-1) square grid
// must have exactly `n` of its 4 surrounding grid edges on the single closed loop.
//
// CSV tokens: `r:c:S0` | `r:c:S1` | `r:c:S2` | `r:c:S3` (0-based face row/col).
// Works standalone (pure Slitherlink) or composed with Masyu circles, Full board (Hamiltonian cycle),
// givens, and Swiss cheese voids.

const E_UNKNOWN = 0, E_ON = 1, E_OFF = 2;

/** True if edge `x` borders at least one numbered Slitherlink face (with optional nonzero filter). */
export function isSlitherEdge(P, x, nonzeroOnly = true) {
  if (!P.hasSlither || !P.edgeFaces) return false;
  const f0 = P.edgeFaces[x * 2], f1 = P.edgeFaces[x * 2 + 1];
  const sn = P.slitherNum;
  if (nonzeroOnly) return (f0 >= 0 && sn[f0] > 0) || (f1 >= 0 && sn[f1] > 0);
  return (f0 >= 0 && sn[f0] >= 0) || (f1 >= 0 && sn[f1] >= 0);
}

/**
 * Check whether closing an edge `closingEdge` (currently UNKNOWN -> ON) would leave any
 * Slitherlink face unsatisfied. Returns the first unsatisfied face index, or -1 if all match.
 */
export function firstUnsatisfiedSlitherOnClose(P, st, closingEdge) {
  if (!P.hasSlither) return -1;
  const ef0 = P.edgeFaces[closingEdge * 2], ef1 = P.edgeFaces[closingEdge * 2 + 1];
  const fe = P.faceEdges, e = st.e, sl = P.slither;
  for (let si = 0; si < sl.length; si++) {
    const sc = sl[si];
    const f4 = sc.f * 4;
    let fon = (sc.f === ef0 || sc.f === ef1) ? 1 : 0;
    const e0 = fe[f4], e1 = fe[f4 + 1], e2 = fe[f4 + 2], e3 = fe[f4 + 3];
    if (e0 >= 0 && e[e0] === E_ON) fon++;
    if (e1 >= 0 && e[e1] === E_ON) fon++;
    if (e2 >= 0 && e[e2] === E_ON) fon++;
    if (e3 >= 0 && e[e3] === E_ON) fon++;
    if (fon !== sc.n) return sc.f;
  }
  return -1;
}

/**
 * Compile Slitherlink face clues onto puzzle `P`.
 * Expects `P.rows`, `P.cols`, `P.edgeA`, `P.faceExterior`, `P.faceHoleId` to already be computed.
 * Attaches: `slither`, `hasSlither`, `slitherNum` (Int8Array(F), -1 if empty), `slitherAt` (Int16Array(F)),
 * `faceEdges` (Int32Array(F * 4)), and `edgeFaces` (Int32Array(numEdges * 2), null when !hasSlither).
 */
export function compileSlither(P, raw) {
  const { rows, cols, numEdges, edgeA } = P;
  const fr = Math.max(0, rows - 1), fc = Math.max(0, cols - 1), F = fr * fc;
  const rawSlither = Array.isArray(raw.slither) ? raw.slither : [];
  const hasRaw = rawSlither.length > 0;

  // Dual face adjacency tables (skip edgeFaces allocation when puzzle has no Slitherlink clues)
  const faceEdges = new Int32Array(F * 4).fill(-1);
  const edgeFaces = hasRaw ? new Int32Array(numEdges * 2).fill(-1) : null;
  for (let r = 0; r < fr; r++) {
    for (let c = 0; c < fc; c++) {
      const f = r * fc + c;
      const e0 = 2 * (r * cols + c);
      const e1 = 2 * (r * cols + c + 1) + 1;
      const e2 = 2 * ((r + 1) * cols + c);
      const e3 = 2 * (r * cols + c) + 1;
      const f4 = f * 4;
      if (edgeA[e0] >= 0) {
        faceEdges[f4] = e0;
        if (edgeFaces) { if (edgeFaces[e0 * 2] < 0) edgeFaces[e0 * 2] = f; else edgeFaces[e0 * 2 + 1] = f; }
      }
      if (edgeA[e1] >= 0) {
        faceEdges[f4 + 1] = e1;
        if (edgeFaces) { if (edgeFaces[e1 * 2] < 0) edgeFaces[e1 * 2] = f; else edgeFaces[e1 * 2 + 1] = f; }
      }
      if (edgeA[e2] >= 0) {
        faceEdges[f4 + 2] = e2;
        if (edgeFaces) { if (edgeFaces[e2 * 2] < 0) edgeFaces[e2 * 2] = f; else edgeFaces[e2 * 2 + 1] = f; }
      }
      if (edgeA[e3] >= 0) {
        faceEdges[f4 + 3] = e3;
        if (edgeFaces) { if (edgeFaces[e3 * 2] < 0) edgeFaces[e3 * 2] = f; else edgeFaces[e3 * 2 + 1] = f; }
      }
    }
  }

  const slither = [];
  let slitherNum = null, slitherAt = null;
  if (hasRaw) {
    slitherNum = new Int8Array(F).fill(-1);
    slitherAt = new Int16Array(F).fill(-1);
    rawSlither.forEach((sc, k) => {
      const { r, c, n } = sc;
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= fr || c >= fc) {
        throw new Error(`slitherlink clue out of bounds at ${r},${c}`);
      }
      if (!Number.isInteger(n) || n < 0 || n > 3) {
        throw new Error(`bad slitherlink clue value "${n}" at ${r},${c}`);
      }
      const f = r * fc + c;
      if (P.faceExterior && P.faceExterior[f]) throw new Error(`slitherlink clue on exterior void at ${r},${c}`);
      if (P.faceHoleId && P.faceHoleId[f] >= 0) throw new Error(`slitherlink clue on void hole at ${r},${c}`);
      if (slitherAt[f] >= 0) throw new Error(`duplicate slitherlink clue at ${r},${c}`);
      slitherAt[f] = k;
      slitherNum[f] = n;
      slither.push({ r, c, n, f });
    });
  }

  P.numFaces = F;
  P.faceEdges = faceEdges;
  P.edgeFaces = edgeFaces;
  P.slither = slither;
  P.hasSlither = slither.length > 0;
  P.slitherNum = slitherNum;
  P.slitherAt = slitherAt;
}

/** Append CSV tokens `r:c:S0`..`r:c:S3` to `parts`. */
export function serializeSlither(p, parts) {
  for (const sc of p.slither || []) parts.push(`${sc.r}:${sc.c}:S${sc.n}`);
}

/** Parse a `S0`..`S3` CSV clue token. Returns true if consumed. */
export function parseSlitherToken(r, c, tag, acc) {
  if (tag === 'S0' || tag === 'S1' || tag === 'S2' || tag === 'S3') {
    acc.slither.push({ r, c, n: Number(tag[1]) });
    return true;
  }
  return false;
}

/** Canonical dihedral-transformed Slitherlink string for `symmetryKey`. */
export function symmetrySlither(p, swap, flipR, flipC) {
  const list = p.slither || [];
  if (!list.length) return '';
  const fR = (swap ? p.cols : p.rows) - 1;
  const fC = (swap ? p.rows : p.cols) - 1;
  return '|S:' + list.map((sc) => {
    let r = sc.r, c = sc.c;
    if (swap) [r, c] = [c, r];
    if (flipR) r = fR - 1 - r;
    if (flipC) c = fC - 1 - c;
    return [r * fC + c, `${r}:${c}:${sc.n}`];
  }).sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(';');
}

/** Rotate Slitherlink face clues 90° CW for a board of size R x C -> C x R. */
export function rotateSlitherCW(P) {
  const fR = P.rows - 1;
  return (P.slither || []).map((sc) => ({ r: sc.c, c: fR - 1 - sc.r, n: sc.n }));
}

/** Exact solution check: every numbered face has exactly `n` ON edges. */
export function isSlitherSatisfied(P, edges) {
  if (!P.hasSlither) return true;
  const { faceEdges, slither } = P;
  for (let k = 0; k < slither.length; k++) {
    const sc = slither[k];
    const f4 = sc.f * 4;
    let on = 0;
    const e0 = faceEdges[f4], e1 = faceEdges[f4 + 1], e2 = faceEdges[f4 + 2], e3 = faceEdges[f4 + 3];
    if (e0 >= 0 && edges[e0] === E_ON) on++;
    if (e1 >= 0 && edges[e1] === E_ON) on++;
    if (e2 >= 0 && edges[e2] === E_ON) on++;
    if (e3 >= 0 && edges[e3] === E_ON) on++;
    if (on !== sc.n) return false;
  }
  return true;
}

/**
 * Exact local propagation for Slitherlink face `f` inside `propagate()`.
 * Applies exact count completion plus O(1) blocked-corner (3/1) and 3-line-in deductions.
 * Returns false on contradiction.
 */
export function propagateSlitherFace(P, st, f, setEdge) {
  const n = P.slitherNum[f];
  if (n < 0) return true;
  const e = st.e;
  const fe = P.faceEdges;
  const f4 = f * 4;
  const e0 = fe[f4], e1 = fe[f4 + 1], e2 = fe[f4 + 2], e3 = fe[f4 + 3];
  let on = 0, unk = 0;
  if (e0 >= 0) { const v = e[e0]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
  if (e1 >= 0) { const v = e[e1]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
  if (e2 >= 0) { const v = e[e2]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
  if (e3 >= 0) { const v = e[e3]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
  if (on > n || on + unk < n) return false;
  if (unk > 0) {
    if (on === n) {
      if (e0 >= 0 && e[e0] === E_UNKNOWN) setEdge(e0, E_OFF);
      if (e1 >= 0 && e[e1] === E_UNKNOWN) setEdge(e1, E_OFF);
      if (e2 >= 0 && e[e2] === E_UNKNOWN) setEdge(e2, E_OFF);
      if (e3 >= 0 && e[e3] === E_UNKNOWN) setEdge(e3, E_OFF);
      return true;
    }
    if (on + unk === n) {
      if (e0 >= 0 && e[e0] === E_UNKNOWN) setEdge(e0, E_ON);
      if (e1 >= 0 && e[e1] === E_UNKNOWN) setEdge(e1, E_ON);
      if (e2 >= 0 && e[e2] === E_UNKNOWN) setEdge(e2, E_ON);
      if (e3 >= 0 && e[e3] === E_UNKNOWN) setEdge(e3, E_ON);
      return true;
    }
    // O(1) blocked-corner (3/1) and 3-line-in deductions (zero-alloc, accelerates solve() dramatically)
    if (n === 3 || n === 1) {
      const cols = P.cols, fc = cols - 1, ed = P.ed, nb = P.nb, cell = st.cell;
      const fr = (f / fc) | 0, c = f % fc;
      for (let ci = 0; ci < 4; ci++) {
        const sp = CORNER_SPEC[ci];
        const v = (fr + sp[0]) * cols + (c + sp[1]);
        const odA = sp[6], odB = sp[7];
        const xA = ed[v * 4 + odA], xB = ed[v * 4 + odB];
        const blkA = xA < 0 || e[xA] === E_OFF || cell[nb[v * 4 + odA]] === OFF;
        const blkB = xB < 0 || e[xB] === E_OFF || cell[nb[v * 4 + odB]] === OFF;
        if (blkA && blkB) {
          const ea = fe[f4 + sp[2]], eb = fe[f4 + sp[3]];
          if (ea >= 0 && eb >= 0) {
            if (n === 3) {
              if (e[ea] === E_OFF || e[eb] === E_OFF) return false;
              if (e[ea] === E_UNKNOWN) setEdge(ea, E_ON);
              if (e[eb] === E_UNKNOWN) setEdge(eb, E_ON);
            } else {
              if (e[ea] === E_ON || e[eb] === E_ON) return false;
              if (e[ea] === E_UNKNOWN) setEdge(ea, E_OFF);
              if (e[eb] === E_UNKNOWN) setEdge(eb, E_OFF);
            }
          }
        } else if (n === 3) {
          const onA = xA >= 0 && e[xA] === E_ON;
          const onB = xB >= 0 && e[xB] === E_ON;
          if (onA !== onB) {
            const eoA = fe[f4 + sp[4]], eoB = fe[f4 + sp[5]];
            const otherOut = onA ? xB : xA;
            if (eoA >= 0) {
              if (e[eoA] === E_OFF) return false;
              if (e[eoA] === E_UNKNOWN) setEdge(eoA, E_ON);
            }
            if (eoB >= 0) {
              if (e[eoB] === E_OFF) return false;
              if (e[eoB] === E_UNKNOWN) setEdge(eoB, E_ON);
            }
            if (otherOut >= 0 && e[otherOut] === E_UNKNOWN) setEdge(otherOut, E_OFF);
          } else if (onA && onB) {
            // Both outside exits ON -> corner has degree 2 -> both inner edges OFF -> at most 2 edges left for 3!
            return false;
          }
        }
      }
    }
  }
  return true;
}

/**
 * Live UI error states for Slitherlink clues from player edge marks alone (never inspects P.solution).
 * Returns an array of 'bad' | '' parallel to `P.slither`.
 */
export function slitherStates(P, marks) {
  if (!P.hasSlither) return [];
  const e = marks.edges;
  const fe = P.faceEdges;
  return P.slither.map((sc) => {
    const f4 = sc.f * 4;
    let on = 0, avail = 0;
    for (let d = 0; d < 4; d++) {
      const x = fe[f4 + d];
      if (x < 0) continue;
      if (e[x] === 1) { on++; avail++; }
      else if (e[x] === 0) avail++;
    }
    return (on > sc.n || avail < sc.n) ? 'bad' : '';
  });
}

/**
 * Auto-X bookkeeping for Slitherlink numbers:
 * When a numbered face `n` (including `0`) already has `n` player-drawn segments (`w[x] === 1`),
 * automatically X out its remaining open sides. Pure bookkeeping (never draws lines or makes
 * multi-clue inferences) and cleanly unwinds when a segment is erased.
 */
export function autoXSlither(P, w, add) {
  if (!P.hasSlither) return false;
  const fe = P.faceEdges;
  let changed = false;
  for (let k = 0; k < P.slither.length; k++) {
    const sc = P.slither[k];
    const f4 = sc.f * 4;
    let on = 0;
    for (let d = 0; d < 4; d++) {
      const x = fe[f4 + d];
      if (x >= 0 && w[x] === 1) on++;
    }
    if (on === sc.n) {
      for (let d = 0; d < 4; d++) {
        const x = fe[f4 + d];
        if (x >= 0 && w[x] === 0 && add(x)) changed = true;
      }
    }
  }
  return changed;
}

/**
 * Slitherlink Inside/Outside parity laws plugged into `js/faceparity.js`:
 *   1. `0` face: all 4 flanking neighbor faces share the SAME parity as `f` (xor = 0).
 *   2. Exact-count parity completion on `1`, `2`, `3`:
 *      - `3`: if 1 neighbor is SAME as `f` -> the other 3 are OPPOSITE; if 3 are OPPOSITE -> 4th is SAME.
 *      - `1`: if 1 neighbor is OPPOSITE to `f` -> the other 3 are SAME; if 3 are SAME -> 4th is OPPOSITE.
 *      - `2`: if 2 neighbors are SAME as `f` -> other 2 are OPPOSITE; if 2 are OPPOSITE -> other 2 are SAME.
 *   3. Universal Slitherlink mod-2 parity law on ANY `n` in {0, 1, 2, 3}:
 *      parity(N) ^ parity(E) ^ parity(S) ^ parity(W) = n mod 2
 *      -> whenever any pair (a, b) of the 4 neighbors is related, the complementary pair (c, d)
 *         has relation `relate(a, b) ^ (n & 1)`.
 *   4. Orthogonally adjacent `3`–`3`: the two `3`s ALWAYS have OPPOSITE parity (xor = 1),
 *      and both far opposite edges are ON (flanking faces opposite to each `3`).
 *   5. Diagonally adjacent `3`–`3` sharing a corner vertex: the two off-diagonal flanking faces
 *      ALWAYS have OPPOSITE parity (xor = 1), and each `3`'s two outer edges are ON.
 */
const PARITY_PAIRS = [[0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2]];
const scratchNb = new Int32Array(4);
const scratchRel = new Int8Array(4);

/**
 * True when some constraint outside the 1x2 rectangle of two orthogonally adjacent 3s
 * prevents that 1x2 box from being the entire loop on its own (sound even when 1 clues
 * sit orthogonally adjacent to the 1x2 box, which share 1 perimeter edge with it!).
 */
function hasLoopOutsideAdj3(P, st, r1, c1, r2, c2, f1, f2) {
  if (P.fullBoard && P.activeCount > 6) return true;
  for (let k = 0; k < P.slither.length; k++) {
    const sc = P.slither[k];
    if (sc.f === f1 || sc.f === f2) continue;
    const adjToBox = (Math.abs(sc.r - r1) + Math.abs(sc.c - c1) === 1)
      || (Math.abs(sc.r - r2) + Math.abs(sc.c - c2) === 1);
    if (sc.n >= 2) return true;
    if (sc.n === 1 && !adjToBox) return true;
    if (sc.n === 0 && adjToBox) return true;
  }
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2) + 1;
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2) + 1;
  for (let k = 0; k < P.clueCells.length; k++) {
    const ci = P.clueCells[k];
    const cr = (ci / P.cols) | 0, cc = ci % P.cols;
    if (cr < minR || cr > maxR || cc < minC || cc > maxC) return true;
  }
  if (st) {
    for (let x = 0; x < P.numEdges; x++) {
      if (P.edgeA[x] < 0 || st.e[x] !== E_ON) continue;
      const a = P.edgeA[x], b = P.edgeB[x];
      const ar = (a / P.cols) | 0, ac = a % P.cols;
      const br = (b / P.cols) | 0, bc = b % P.cols;
      if (ar < minR || ar > maxR || ac < minC || ac > maxC || br < minR || br > maxR || bc < minC || bc > maxC) {
        return true;
      }
    }
  }
  return false;
}

export function applySlitherParity(P, st, ctx) {
  if (!P.hasSlither) return false;
  const { rows, cols, slither, slitherNum } = P;
  const fr = rows - 1, fc = cols - 1;
  const { EXT, relate, link, canonFace = (f) => f, buildGraph = true } = ctx;
  const faceAt = (r, c) => canonFace(r >= 0 && c >= 0 && r < fr && c < fc ? r * fc + c : EXT);
  let anyLinked = false;
  const addLink = (u, v, xor, reason) => {
    if (link(u, v, xor, reason)) { anyLinked = true; return true; }
    return false;
  };

  // 1. Direct static laws (0-face all-same, adjacent 3-3, diagonal 3-3) — run once per parity build
  if (!ctx.staticDone) {
    ctx.staticDone = true;
    for (let k = 0; k < slither.length && !ctx.hasConflict(); k++) {
      const sc = slither[k];
      const { r, c, n } = sc;
      const f = canonFace(sc.f);
      if (n === 0) {
        const r0 = buildGraph ? { kind: 'slither0', face: sc.f } : null;
        addLink(f, faceAt(r - 1, c), 0, r0);
        addLink(f, faceAt(r, c + 1), 0, r0);
        addLink(f, faceAt(r + 1, c), 0, r0);
        addLink(f, faceAt(r, c - 1), 0, r0);
      } else if (n === 3) {
        // Orthogonal adjacent 3-3 (check right and down to avoid duplicate links)
        if (c + 1 < fc && slitherNum[sc.f + 1] === 3 && hasLoopOutsideAdj3(P, st, r, c, r, c + 1, sc.f, sc.f + 1)) {
          const f2Raw = sc.f + 1, f2 = canonFace(f2Raw);
          const r33 = buildGraph ? { kind: 'slither33', face: sc.f, face2: f2Raw } : null;
          addLink(f, f2, 1, r33);
          addLink(f, faceAt(r, c - 1), 1, r33);
          addLink(f2, faceAt(r, c + 2), 1, r33);
        }
        if (r + 1 < fr && slitherNum[sc.f + fc] === 3 && hasLoopOutsideAdj3(P, st, r, c, r + 1, c, sc.f, sc.f + fc)) {
          const f2Raw = sc.f + fc, f2 = canonFace(f2Raw);
          const r33 = buildGraph ? { kind: 'slither33', face: sc.f, face2: f2Raw } : null;
          addLink(f, f2, 1, r33);
          addLink(f, faceAt(r - 1, c), 1, r33);
          addLink(f2, faceAt(r + 2, c), 1, r33);
        }
        // Diagonal adjacent 3-3 (check SE and SW to avoid duplicates)
        if (r + 1 < fr && c + 1 < fc && slitherNum[(r + 1) * fc + (c + 1)] === 3) {
          const f2Raw = (r + 1) * fc + (c + 1), f2 = canonFace(f2Raw);
          const rd = buildGraph ? { kind: 'slitherDiag33', face: sc.f, face2: f2Raw } : null;
          addLink(faceAt(r, c + 1), faceAt(r + 1, c), 1, rd);
          addLink(f, faceAt(r - 1, c), 1, rd);
          addLink(f, faceAt(r, c - 1), 1, rd);
          addLink(f2, faceAt(r + 2, c + 1), 1, rd);
          addLink(f2, faceAt(r + 1, c + 2), 1, rd);
        }
        if (r + 1 < fr && c - 1 >= 0 && slitherNum[(r + 1) * fc + (c - 1)] === 3) {
          const f2Raw = (r + 1) * fc + (c - 1), f2 = canonFace(f2Raw);
          const rd = buildGraph ? { kind: 'slitherDiag33', face: sc.f, face2: f2Raw } : null;
          addLink(faceAt(r, c - 1), faceAt(r + 1, c), 1, rd);
          addLink(f, faceAt(r - 1, c), 1, rd);
          addLink(f, faceAt(r, c + 1), 1, rd);
          addLink(f2, faceAt(r + 2, c - 1), 1, rd);
          addLink(f2, faceAt(r + 1, c - 2), 1, rd);
        }
      }
    }
  }

  // 2. Iterative parity propagation for exact counts + universal mod-2 law across all clues
  let changed = true;
  while (changed && !ctx.hasConflict()) {
    changed = false;
    for (let k = 0; k < slither.length && !ctx.hasConflict(); k++) {
      const sc = slither[k];
      const { r, c, n } = sc;
      if (n === 0) continue;
      const f = canonFace(sc.f);
      scratchNb[0] = faceAt(r - 1, c);
      scratchNb[1] = faceAt(r, c + 1);
      scratchNb[2] = faceAt(r + 1, c);
      scratchNb[3] = faceAt(r, c - 1);
      let same = 0, opp = 0;
      for (let d = 0; d < 4; d++) {
        const rv = relate(f, scratchNb[d]);
        scratchRel[d] = rv;
        if (rv === 0) same++;
        else if (rv === 1) opp++;
      }
      if (opp > n || same > 4 - n) { ctx.markConflict(); break; }
      if (opp === n && same < 4 - n) {
        const rc = buildGraph ? { kind: 'slitherCount', face: sc.f, n } : null;
        for (let d = 0; d < 4; d++) {
          if (scratchRel[d] < 0 && addLink(f, scratchNb[d], 0, rc)) changed = true;
        }
      } else if (same === 4 - n && opp < n) {
        const rc = buildGraph ? { kind: 'slitherCount', face: sc.f, n } : null;
        for (let d = 0; d < 4; d++) {
          if (scratchRel[d] < 0 && addLink(f, scratchNb[d], 1, rc)) changed = true;
        }
      }
      // Universal mod-2 law: relate(a, b) ^ relate(c, d) === (n & 1)
      const par = n & 1;
      for (let pi = 0; pi < 3; pi++) {
        const p = PARITY_PAIRS[pi];
        const a = scratchNb[p[0]], b = scratchNb[p[1]], c2 = scratchNb[p[2]], d2 = scratchNb[p[3]];
        const rAB = relate(a, b);
        const rCD = relate(c2, d2);
        if (rAB >= 0 && rCD < 0) {
          if (addLink(c2, d2, rAB ^ par, buildGraph ? { kind: 'slitherMod2', face: sc.f, n } : null)) changed = true;
        } else if (rCD >= 0 && rAB < 0) {
          if (addLink(a, b, rCD ^ par, buildGraph ? { kind: 'slitherMod2', face: sc.f, n } : null)) changed = true;
        } else if (rAB >= 0 && rCD >= 0 && (rAB ^ rCD) !== par) {
          ctx.markConflict();
          break;
        }
      }
    }
  }
  return anyLinked;
}

// ------------------------------------------------------------ Human-style solving rules

const OFF = 1;
const CORNER_SPEC = [
  // [dr, dc, fEdgeA, fEdgeB, oppA, oppB, outDirA, outDirB, adjA: [dr,dc,contDir,perpOutDir], adjB: [dr,dc,contDir,perpOutDir]]
  [0, 0, 0, 3, 1, 2, 0, 3, [0, 1, 1, 0], [1, 0, 2, 3]], // NW
  [0, 1, 0, 1, 2, 3, 0, 1, [0, 0, 3, 0], [1, 1, 2, 1]], // NE
  [1, 1, 1, 2, 0, 3, 2, 1, [0, 1, 0, 1], [1, 0, 3, 2]], // SE
  [1, 0, 2, 3, 0, 1, 2, 3, [1, 1, 1, 2], [0, 0, 0, 3]], // SW
];

const isBlockedDir = (P, st, v, d) => {
  const x = P.ed[v * 4 + d];
  if (x < 0 || st.e[x] === E_OFF) return true;
  const j = P.nb[v * 4 + d];
  return j < 0 || st.cell[j] === OFF;
};

/** 0 face -> cross out all 4 surrounding edges. */
export function findSlitherZero(P, st) {
  if (!P.hasSlither) return [];
  const { slither, faceEdges } = P;
  const e = st.e;
  const out = [];
  for (let k = 0; k < slither.length; k++) {
    const sc = slither[k];
    if (sc.n !== 0) continue;
    const f4 = sc.f * 4;
    const sets = [];
    for (let d = 0; d < 4; d++) {
      const x = faceEdges[f4 + d];
      if (x >= 0 && e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
    }
    if (sets.length) out.push({ sets, info: { face: sc.f, n: 0 } });
  }
  return out;
}

/** Numbered face count completion (on === n -> X rest; on + unk === n -> draw rest). */
export function findSlitherCount(P, st) {
  if (!P.hasSlither) return [];
  const { slither, faceEdges } = P;
  const e = st.e;
  const out = [];
  for (let k = 0; k < slither.length; k++) {
    const sc = slither[k];
    if (sc.n === 0) continue;
    const f4 = sc.f * 4;
    const e0 = faceEdges[f4], e1 = faceEdges[f4 + 1], e2 = faceEdges[f4 + 2], e3 = faceEdges[f4 + 3];
    let on = 0, unk = 0;
    if (e0 >= 0) { const v = e[e0]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
    if (e1 >= 0) { const v = e[e1]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
    if (e2 >= 0) { const v = e[e2]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
    if (e3 >= 0) { const v = e[e3]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
    if (unk === 0) continue;
    if (on === sc.n || on + unk === sc.n) {
      const val = on === sc.n ? E_OFF : E_ON;
      const sets = [];
      if (e0 >= 0 && e[e0] === E_UNKNOWN) sets.push(['e', e0, val]);
      if (e1 >= 0 && e[e1] === E_UNKNOWN) sets.push(['e', e1, val]);
      if (e2 >= 0 && e[e2] === E_UNKNOWN) sets.push(['e', e2, val]);
      if (e3 >= 0 && e[e3] === E_UNKNOWN) sets.push(['e', e3, val]);
      out.push({ sets, info: { face: sc.f, n: sc.n, mode: val === E_OFF ? 'done' : 'fill' } });
    }
  }
  return out;
}

/** Corner patterns on a 3, 1, or 2 at any corner vertex whose two outside exits are blocked (board corner, 0, or X). */
export function findSlitherCorner(P, st) {
  if (!P.hasSlither) return [];
  const { cols, slither, faceEdges, ed } = P;
  const e = st.e;
  const out = [];
  for (let k = 0; k < slither.length; k++) {
    const sc = slither[k];
    if (sc.n === 0) continue;
    const f4 = sc.f * 4;
    for (let ci = 0; ci < 4; ci++) {
      const [dr, dc, fea, feb, , , odA, odB, adjA, adjB] = CORNER_SPEC[ci];
      const v = (sc.r + dr) * cols + (sc.c + dc);
      if (!isBlockedDir(P, st, v, odA) || !isBlockedDir(P, st, v, odB)) continue;
      const ea = faceEdges[f4 + fea], eb = faceEdges[f4 + feb];
      if (ea < 0 || eb < 0) continue;
      if (sc.n === 3) {
        const sets = [];
        if (e[ea] === E_UNKNOWN) sets.push(['e', ea, E_ON]);
        if (e[eb] === E_UNKNOWN) sets.push(['e', eb, E_ON]);
        if (sets.length) out.push({ sets, info: { face: sc.f, n: 3, cell: v } });
      } else if (sc.n === 1) {
        const sets = [];
        if (e[ea] === E_UNKNOWN) sets.push(['e', ea, E_OFF]);
        if (e[eb] === E_UNKNOWN) sets.push(['e', eb, E_OFF]);
        if (sets.length) out.push({ sets, info: { face: sc.f, n: 1, cell: v } });
      } else if (sc.n === 2) {
        // At a blocked-corner 2, ea and eb are coupled (both ON or both OFF), so each adjacent corner
        // has exactly 1 ON edge on the 2 and therefore exactly 1 ON edge among its two outside edges.
        const sets = [];
        for (const [adr, adc, contDir, perpOutDir] of [adjA, adjB]) {
          const av = (sc.r + adr) * cols + (sc.c + adc);
          const xCont = ed[av * 4 + contDir];
          const xPerp = ed[av * 4 + perpOutDir];
          const blkCont = isBlockedDir(P, st, av, contDir);
          const blkPerp = isBlockedDir(P, st, av, perpOutDir);
          if (xCont >= 0 && e[xCont] === E_UNKNOWN && !blkCont) {
            if (blkPerp) sets.push(['e', xCont, E_ON]);
            else if (xPerp >= 0 && e[xPerp] === E_ON) sets.push(['e', xCont, E_OFF]);
          }
          if (xPerp >= 0 && e[xPerp] === E_UNKNOWN && !blkPerp) {
            if (blkCont) sets.push(['e', xPerp, E_ON]);
            else if (xCont >= 0 && e[xCont] === E_ON) sets.push(['e', xPerp, E_OFF]);
          }
        }
        if (sets.length) out.push({ sets, info: { face: sc.f, n: 2, cell: v } });
      }
    }
  }
  return out;
}

/** Two orthogonally adjacent 3s force 3 parallel segments ON and the 2 collinear extensions off their shared vertices OFF. */
export function findSlitherAdjacent3(P, st) {
  if (!P.hasSlither) return [];
  const { rows, cols, slither, slitherNum, faceEdges, ed } = P;
  const fr = rows - 1, fc = cols - 1;
  const e = st.e;
  const out = [];
  for (let k = 0; k < slither.length; k++) {
    const sc = slither[k];
    if (sc.n !== 3) continue;
    const { r, c, f } = sc;
    // Horizontal pair: (r, c) and (r, c+1) share vertical edge right of f
    if (c + 1 < fc && slitherNum[f + 1] === 3 && hasLoopOutsideAdj3(P, st, r, c, r, c + 1, f, f + 1)) {
      const f2 = f + 1;
      const eMid = faceEdges[f * 4 + 1];
      const eLeft = faceEdges[f * 4 + 3];
      const eRight = faceEdges[f2 * 4 + 1];
      const vTop = r * cols + (c + 1);
      const vBot = (r + 1) * cols + (c + 1);
      const extUp = ed[vTop * 4 + 0];
      const extDn = ed[vBot * 4 + 2];
      const sets = [];
      for (const x of [eMid, eLeft, eRight]) if (x >= 0 && e[x] === E_UNKNOWN) sets.push(['e', x, E_ON]);
      for (const x of [extUp, extDn]) if (x >= 0 && e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
      if (sets.length) out.push({ sets, info: { face: f, face2: f2 } });
    }
    // Vertical pair: (r, c) and (r+1, c) share horizontal edge bottom of f
    if (r + 1 < fr && slitherNum[f + fc] === 3 && hasLoopOutsideAdj3(P, st, r, c, r + 1, c, f, f + fc)) {
      const f2 = f + fc;
      const eMid = faceEdges[f * 4 + 2];
      const eTop = faceEdges[f * 4 + 0];
      const eBot = faceEdges[f2 * 4 + 2];
      const vLeft = (r + 1) * cols + c;
      const vRight = (r + 1) * cols + (c + 1);
      const extL = ed[vLeft * 4 + 3];
      const extR = ed[vRight * 4 + 1];
      const sets = [];
      for (const x of [eMid, eTop, eBot]) if (x >= 0 && e[x] === E_UNKNOWN) sets.push(['e', x, E_ON]);
      for (const x of [extL, extR]) if (x >= 0 && e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
      if (sets.length) out.push({ sets, info: { face: f, face2: f2 } });
    }
  }
  return out;
}

/** Two diagonally adjacent 3s force the 2 outer corner edges of each 3 ON. */
export function findSlitherDiag3(P, st) {
  if (!P.hasSlither) return [];
  const { rows, cols, slither, slitherNum, faceEdges } = P;
  const fr = rows - 1, fc = cols - 1;
  const e = st.e;
  const out = [];
  for (let k = 0; k < slither.length; k++) {
    const sc = slither[k];
    if (sc.n !== 3) continue;
    const { r, c, f } = sc;
    // SE diagonal: (r, c) and (r+1, c+1)
    if (r + 1 < fr && c + 1 < fc && slitherNum[(r + 1) * fc + (c + 1)] === 3) {
      const f2 = (r + 1) * fc + (c + 1);
      const sets = [];
      for (const x of [faceEdges[f * 4 + 0], faceEdges[f * 4 + 3], faceEdges[f2 * 4 + 1], faceEdges[f2 * 4 + 2]]) {
        if (x >= 0 && e[x] === E_UNKNOWN) sets.push(['e', x, E_ON]);
      }
      if (sets.length) out.push({ sets, info: { face: f, face2: f2, cell: (r + 1) * cols + (c + 1) } });
    }
    // SW diagonal: (r, c) and (r+1, c-1)
    if (r + 1 < fr && c - 1 >= 0 && slitherNum[(r + 1) * fc + (c - 1)] === 3) {
      const f2 = (r + 1) * fc + (c - 1);
      const sets = [];
      for (const x of [faceEdges[f * 4 + 0], faceEdges[f * 4 + 1], faceEdges[f2 * 4 + 2], faceEdges[f2 * 4 + 3]]) {
        if (x >= 0 && e[x] === E_UNKNOWN) sets.push(['e', x, E_ON]);
      }
      if (sets.length) out.push({ sets, info: { face: f, face2: f2, cell: (r + 1) * cols + c } });
    }
  }
  return out;
}

/** A line entering a corner of a 3 from outside forces the two opposite edges ON and blocks the other outside exit at that corner. */
export function findSlither3LineIn(P, st) {
  if (!P.hasSlither) return [];
  const { cols, slither, faceEdges, ed } = P;
  const e = st.e;
  const out = [];
  for (let k = 0; k < slither.length; k++) {
    const sc = slither[k];
    if (sc.n !== 3) continue;
    const f4 = sc.f * 4;
    for (let ci = 0; ci < 4; ci++) {
      const [dr, dc, , , oppA, oppB, odA, odB] = CORNER_SPEC[ci];
      const v = (sc.r + dr) * cols + (sc.c + dc);
      const xA = ed[v * 4 + odA], xB = ed[v * 4 + odB];
      const onA = xA >= 0 && e[xA] === E_ON;
      const onB = xB >= 0 && e[xB] === E_ON;
      if (onA === onB) continue; // need exactly one outside line entering v
      const otherOut = onA ? xB : xA;
      const sets = [];
      const eoA = faceEdges[f4 + oppA], eoB = faceEdges[f4 + oppB];
      if (eoA >= 0 && e[eoA] === E_UNKNOWN) sets.push(['e', eoA, E_ON]);
      if (eoB >= 0 && e[eoB] === E_UNKNOWN) sets.push(['e', eoB, E_ON]);
      if (otherOut >= 0 && e[otherOut] === E_UNKNOWN) sets.push(['e', otherOut, E_OFF]);
      if (sets.length) out.push({ sets, info: { face: sc.f, cell: v } });
    }
  }
  return out;
}

/** A line forced to enter a corner of a 1 (the other outside exit is blocked) crosses out the two opposite edges of the 1. */
export function findSlither1LineIn(P, st) {
  if (!P.hasSlither) return [];
  const { cols, slither, faceEdges, ed } = P;
  const e = st.e;
  const out = [];
  for (let k = 0; k < slither.length; k++) {
    const sc = slither[k];
    if (sc.n !== 1) continue;
    const f4 = sc.f * 4;
    for (let ci = 0; ci < 4; ci++) {
      const [dr, dc, , , oppA, oppB, odA, odB] = CORNER_SPEC[ci];
      const v = (sc.r + dr) * cols + (sc.c + dc);
      const xA = ed[v * 4 + odA], xB = ed[v * 4 + odB];
      const forcedIn = (xA >= 0 && e[xA] === E_ON && isBlockedDir(P, st, v, odB))
        || (xB >= 0 && e[xB] === E_ON && isBlockedDir(P, st, v, odA));
      if (!forcedIn) continue;
      const sets = [];
      const eoA = faceEdges[f4 + oppA], eoB = faceEdges[f4 + oppB];
      if (eoA >= 0 && e[eoA] === E_UNKNOWN) sets.push(['e', eoA, E_OFF]);
      if (eoB >= 0 && e[eoB] === E_UNKNOWN) sets.push(['e', eoB, E_OFF]);
      if (sets.length) out.push({ sets, info: { face: sc.f, cell: v } });
    }
  }
  return out;
}

/** Diagonal 3-2-...-2-3 chain (one or more 2s between two 3s along a diagonal) forces the outer corner edges of both 3s ON. */
export function findSlitherDiag32(P, st) {
  if (!P.hasSlither) return [];
  const { rows, cols, slither, slitherNum, faceEdges } = P;
  const fr = rows - 1, fc = cols - 1;
  const e = st.e;
  const out = [];
  for (let k = 0; k < slither.length; k++) {
    const sc = slither[k];
    if (sc.n !== 3) continue;
    for (const [dr, dc, outer1, outer2] of [
      [1, 1, [0, 3], [1, 2]],
      [1, -1, [0, 1], [2, 3]],
    ]) {
      let nr = sc.r + dr, nc = sc.c + dc;
      const mids = [];
      while (nr >= 0 && nc >= 0 && nr < fr && nc < fc && slitherNum[nr * fc + nc] === 2) {
        mids.push(nr * fc + nc);
        nr += dr; nc += dc;
      }
      if (!mids.length) continue;
      if (nr < 0 || nc < 0 || nr >= fr || nc >= fc || slitherNum[nr * fc + nc] !== 3) continue;
      const f2 = nr * fc + nc;
      const sets = [];
      for (const d of outer1) { const x = faceEdges[sc.f * 4 + d]; if (x >= 0 && e[x] === E_UNKNOWN) sets.push(['e', x, E_ON]); }
      for (const d of outer2) { const x = faceEdges[f2 * 4 + d]; if (x >= 0 && e[x] === E_UNKNOWN) sets.push(['e', x, E_ON]); }
      if (sets.length) out.push({ sets, info: { face: sc.f, face2: f2, mids } });
    }
  }
  return out;
}

export const SLITHER_RULES = [
  { id: 'slitherZero', tier: 'Beginner', weight: 2, find: findSlitherZero, label: 'a 0 square has no loop segments around it' },
  { id: 'slitherCount', tier: 'Beginner', weight: 2, find: findSlitherCount, label: 'a numbered square whose remaining edges match its count must fill or cross them out' },
  { id: 'slitherCorner', tier: 'Beginner', weight: 3, find: findSlitherCorner, label: 'a 3, 1, or 2 at a blocked corner forces its corner or outer extension segments' },
  { id: 'slitherAdjacent3', tier: 'Beginner', weight: 5, find: findSlitherAdjacent3, label: 'two orthogonally adjacent 3s force three parallel segments and cross out the shared-vertex extensions' },
  { id: 'slitherDiag3', tier: 'Beginner', weight: 6, find: findSlitherDiag3, label: 'two diagonally adjacent 3s force both outer corners on' },
  { id: 'slither3LineIn', tier: 'Beginner', weight: 6, find: findSlither3LineIn, label: 'a segment entering a corner of a 3 forces its two opposite sides on and blocks the other exit' },
  { id: 'slither1LineIn', tier: 'Medium', weight: 12, find: findSlither1LineIn, label: 'a segment forced into a corner of a 1 crosses out its two opposite sides' },
  { id: 'slitherDiag32', tier: 'Medium', weight: 14, find: findSlitherDiag32, label: 'a diagonal chain of 2s between two 3s forces both outer corners on' },
];

/** Describe a Slitherlink step inside an imagined chain. Returns null for non-Slitherlink rules. */
export function describeSlitherChainStep(P, s, { faceName }) {
  const { rule, info } = s;
  const fn = info && info.face !== undefined ? faceName(P, info.face) : '';
  switch (rule) {
    case 'slitherZero':
      return `the 0 square ${fn} crosses out its surrounding edges`;
    case 'slitherCount':
      return info.mode === 'fill'
        ? `the ${info.n} square ${fn} needs all of its remaining open sides`
        : `the ${info.n} square ${fn} already has ${info.n} segment${info.n === 1 ? '' : 's'}, so its other sides are off`;
    case 'slitherCorner':
      return `the blocked corner on the ${info.n} square ${fn} forces its edges`;
    case 'slitherAdjacent3':
      return `the adjacent 3 squares ${fn} and ${faceName(P, info.face2)} force three parallel segments`;
    case 'slitherDiag3':
      return `the diagonal 3 squares ${fn} and ${faceName(P, info.face2)} force their outer corners`;
    case 'slither3LineIn':
      return `the segment entering the 3 square ${fn} forces its opposite corner`;
    case 'slither1LineIn':
      return `the segment entering the 1 square ${fn} crosses out its opposite sides`;
    case 'slitherDiag32':
      return `the diagonal 3–2–3 chain between ${fn} and ${faceName(P, info.face2)} forces both outer corners`;
    case 'faceSlither':
      return 'inside/outside shading around numbered squares forces an edge';
    default:
      return null;
  }
}

/** Explain a Slitherlink human rule step for Hint. Returns { text, nudge, faces } or null if not a Slitherlink rule. */
export function explainSlitherStep(P, step, helpers) {
  const { rule, info = {}, targets } = step;
  const { cellName, faceName, describeMarks, roles, nudgeRoles, faces } = helpers;
  const fn = info.face !== undefined ? faceName(P, info.face) : '';
  const fn2 = info.face2 !== undefined ? faceName(P, info.face2) : '';
  const marks = describeMarks(P, targets);
  const addFace = (arr, f) => { if (f !== undefined && f >= 0) arr.push(f); };

  switch (rule) {
    case 'slitherZero':
      addFace(faces.focus, info.face);
      return {
        nudge: `Look at the 0 square at ${fn}.`,
        text: `The 0 square at ${fn} cannot touch any loop segments — ${marks}.`,
      };
    case 'slitherCount':
      addFace(faces.focus, info.face);
      return {
        nudge: `Count the sides around the ${info.n} square at ${fn}.`,
        text: info.mode === 'fill'
          ? `The ${info.n} square at ${fn} needs every remaining open side to reach ${info.n} — ${marks}.`
          : `The ${info.n} square at ${fn} already has ${info.n} segment${info.n === 1 ? '' : 's'}, so its remaining sides cannot be used — ${marks}.`,
      };
    case 'slitherCorner':
      addFace(faces.focus, info.face);
      if (info.cell !== undefined) { roles.focus.push(info.cell); nudgeRoles.focus.push(info.cell); }
      return {
        nudge: `Look at the ${info.n} square at ${fn} near the blocked corner ${cellName(P, info.cell)}.`,
        text: info.n === 3
          ? `Because corner ${cellName(P, info.cell)} of the 3 square at ${fn} has no exits outside the square, skipping that corner would leave at most two sides — so ${marks}.`
          : info.n === 1
            ? `Because corner ${cellName(P, info.cell)} of the 1 square at ${fn} has no exits outside the square, using either corner side would force both (two sides on a 1) — so ${marks}.`
            : `Because corner ${cellName(P, info.cell)} of the 2 square at ${fn} has no outside exits, the two sides at that corner are either both on or both off — forcing ${marks}.`,
      };
    case 'slitherAdjacent3':
      addFace(faces.focus, info.face);
      addFace(faces.focus, info.face2);
      return {
        nudge: `Look at the two adjacent 3 squares at ${fn} and ${fn2}.`,
        text: `Two orthogonally adjacent 3 squares (${fn} and ${fn2}) must share their middle edge and use both opposite far sides without branching at their shared corners — ${marks}.`,
      };
    case 'slitherDiag3':
      addFace(faces.focus, info.face);
      addFace(faces.focus, info.face2);
      if (info.cell !== undefined) roles.focus.push(info.cell);
      return {
        nudge: `Look at the two diagonally touching 3 squares at ${fn} and ${fn2}.`,
        text: `The diagonal 3 squares at ${fn} and ${fn2} cannot both turn sharply around their shared corner ${cellName(P, info.cell)}, so each must use both of its outer sides — ${marks}.`,
      };
    case 'slither3LineIn':
      addFace(faces.focus, info.face);
      roles.focus.push(info.cell);
      nudgeRoles.focus.push(info.cell);
      return {
        nudge: `Look at the segment entering corner ${cellName(P, info.cell)} of the 3 square at ${fn}.`,
        text: `A segment enters corner ${cellName(P, info.cell)} of the 3 square at ${fn}, so at most one of the 3's two edges at ${cellName(P, info.cell)} can be used — forcing its two opposite sides on and blocking the other exit: ${marks}.`,
      };
    case 'slither1LineIn':
      addFace(faces.focus, info.face);
      roles.focus.push(info.cell);
      nudgeRoles.focus.push(info.cell);
      return {
        nudge: `Look at the segment entering corner ${cellName(P, info.cell)} of the 1 square at ${fn}.`,
        text: `The segment at ${cellName(P, info.cell)} must continue along one of the 1 square's two adjacent sides at ${fn}, using up its single segment — so its two opposite sides are off: ${marks}.`,
      };
    case 'slitherDiag32':
      addFace(faces.focus, info.face);
      addFace(faces.focus, info.face2);
      for (const mf of info.mids || []) addFace(faces.clue, mf);
      return {
        nudge: `Follow the diagonal chain of 2s connecting the 3 squares at ${fn} and ${fn2}.`,
        text: `A diagonal chain of 2s between the 3 squares at ${fn} and ${fn2} prevents either 3 from using both sides facing the chain, forcing both outer corners — ${marks}.`,
      };
    default:
      return null;
  }
}

export const slitherlinkVariant = {
  id: 'slitherlink',
  name: 'Slitherlink',
  active: (P) => Boolean(P && P.hasSlither),
  compile: compileSlither,
  serialize: serializeSlither,
  parseToken: parseSlitherToken,
  symmetry: symmetrySlither,
  rotateCW: rotateSlitherCW,
  isSatisfied: isSlitherSatisfied,
  propagateFace: propagateSlitherFace,
  clueStates: slitherStates,
  autoX: autoXSlither,
  applyFaceParity: applySlitherParity,
  rules: SLITHER_RULES,
  explain: explainSlitherStep,
  describeChainStep: describeSlitherChainStep,
};
