// Mid-loop constraint module (pure logic, no DOM).
//
// Rules: each dot sits either on a grid intersection (`dir: 'C'`, CSV `r:c:MC`) or on the midpoint
// of a grid edge (`dir: 'H'` -> `r:c:MH`, `dir: 'V'` -> `r:c:MV`). The single closed loop must
// pass straight through every dot, and the dot must sit at the exact geometric midpoint of that
// straight segment (equal straight lengths on both sides up to the 90° turns at each end):
//   * Vertex dot ('C'): even straight-run length 2k (k >= 1), extending k edges in both opposite directions.
//   * Edge dot ('H'/'V'): odd straight-run length 2k+1 (k >= 0), edge ON plus k edges past each endpoint.
//
// Works standalone (pure Mid-loop) or composed with Masyu circles, Slitherlink numbers,
// Full board (Hamiltonian cycle), givens, and Swiss cheese voids.

const E_UNKNOWN = 0, E_ON = 1, E_OFF = 2;
const LOOP = 2, OFF = 1;
const WHITE = 1, BLACK = 2;

/** Axis directions: axis 0 = vertical (dNeg=0 U, dPos=2 D), axis 1 = horizontal (dNeg=3 L, dPos=1 R). */
const AXIS_NEG = [0, 3];
const AXIS_POS = [2, 1];
const AXIS_PERP0 = [1, 0];
const AXIS_PERP1 = [3, 2];

// Reusable scratch buffers for zero-allocation hot-path propagation (never called recursively)
let mlNegE = new Int16Array(64);
let mlPosE = new Int16Array(64);
let mlNegC = new Int16Array(64);
let mlPosC = new Int16Array(64);
let mlNegE2 = new Int16Array(64);
let mlPosE2 = new Int16Array(64);
let mlNegC2 = new Int16Array(64);
let mlPosC2 = new Int16Array(64);

function ensureRayScratch(maxLen) {
  if (mlNegE.length > maxLen) return;
  const cap = Math.max(64, maxLen + 8);
  mlNegE = new Int16Array(cap);
  mlPosE = new Int16Array(cap);
  mlNegC = new Int16Array(cap);
  mlPosC = new Int16Array(cap);
  mlNegE2 = new Int16Array(cap);
  mlPosE2 = new Int16Array(cap);
  mlNegC2 = new Int16Array(cap);
  mlPosC2 = new Int16Array(cap);
}

/** True if edge `x` directly carries or touches a Mid-loop dot (used for lookahead frontier). */
export function isMidloopEdge(P, x) {
  if (!P.hasMidloop) return false;
  if (P.midloopAtEdge && P.midloopAtEdge[x] >= 0) return true;
  if (P.midloopAtCell) {
    const a = P.edgeA[x], b = P.edgeB[x];
    if (a >= 0 && (P.midloopAtCell[a] >= 0 || P.midloopAtCell[b] >= 0)) return true;
  }
  return false;
}

/**
 * Compile Mid-loop dots onto puzzle `P`.
 * Expects `P.rows`, `P.cols`, `P.N`, `P.numEdges`, `P.isVoid`, `P.clueAt`, `P.edgeA`, `P.givenE` to be computed.
 * Attaches: `midloop`, `hasMidloop`, `midloopAtCell`, `midloopAtEdge`, `midloopByRow`, `midloopByCol`.
 */
export function compileMidloop(P, raw) {
  const { rows, cols, N, numEdges, isVoid, clueAt, edgeA, givenE } = P;
  const rawMid = Array.isArray(raw.midloop) ? raw.midloop : [];
  const midloop = [];
  let midloopAtCell = null;
  let midloopAtEdge = null;
  let midloopByRow = null;
  let midloopByCol = null;

  if (rawMid.length > 0) {
    midloopAtCell = new Int16Array(N).fill(-1);
    midloopAtEdge = new Int16Array(numEdges).fill(-1);
    midloopByRow = Array.from({ length: rows }, () => []);
    midloopByCol = Array.from({ length: cols }, () => []);

    rawMid.forEach((md, k) => {
      const { r, c, dir } = md;
      if (dir !== 'C' && dir !== 'H' && dir !== 'V') {
        throw new Error(`bad midloop dir "${dir}" at ${r},${c}`);
      }
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0
        || (dir === 'C' ? (r >= rows || c >= cols)
          : dir === 'H' ? (r >= rows || c >= cols - 1)
          : (r >= rows - 1 || c >= cols))) {
        throw new Error(`midloop dot out of bounds at ${r},${c},${dir}`);
      }
      if (dir === 'C') {
        const cell = r * cols + c;
        if (isVoid[cell]) throw new Error(`midloop dot on void cell at ${r},${c}`);
        if (clueAt[cell] >= 0) throw new Error(`midloop dot collides with circle clue at ${r},${c}`);
        if (midloopAtCell[cell] >= 0) throw new Error(`duplicate midloop dot at ${r},${c}`);
        midloopAtCell[cell] = k;
        midloop.push({ r, c, dir: 'C', cell, edge: -1, a: cell, b: cell, axis: -1 });
        midloopByRow[r].push(k);
        midloopByCol[c].push(k);
      } else if (dir === 'H') {
        const a = r * cols + c, b = a + 1, edge = 2 * a;
        if (edgeA[edge] < 0) throw new Error(`midloop edge dot touches void at ${r},${c},H`);
        if (givenE && givenE[edge] === E_OFF) throw new Error(`midloop edge dot on given wall at ${r},${c},H`);
        if (midloopAtEdge[edge] >= 0) throw new Error(`duplicate midloop edge dot at ${r},${c},H`);
        midloopAtEdge[edge] = k;
        midloop.push({ r, c, dir: 'H', cell: -1, edge, a, b, axis: 1 });
        midloopByRow[r].push(k);
      } else {
        const a = r * cols + c, b = a + cols, edge = 2 * a + 1;
        if (edgeA[edge] < 0) throw new Error(`midloop edge dot touches void at ${r},${c},V`);
        if (givenE && givenE[edge] === E_OFF) throw new Error(`midloop edge dot on given wall at ${r},${c},V`);
        if (midloopAtEdge[edge] >= 0) throw new Error(`duplicate midloop edge dot at ${r},${c},V`);
        midloopAtEdge[edge] = k;
        midloop.push({ r, c, dir: 'V', cell: -1, edge, a, b, axis: 0 });
        midloopByCol[c].push(k);
      }
    });
  }

  P.midloop = midloop;
  P.hasMidloop = midloop.length > 0;
  P.midloopAtCell = midloopAtCell;
  P.midloopAtEdge = midloopAtEdge;
  P.midloopByRow = midloopByRow;
  P.midloopByCol = midloopByCol;
}

/** Append CSV tokens `r:c:MC` | `r:c:MH` | `r:c:MV` to `parts`. */
export function serializeMidloop(p, parts) {
  for (const md of p.midloop || []) parts.push(`${md.r}:${md.c}:M${md.dir}`);
}

/** Parse a `MC` | `MH` | `MV` CSV clue token. Returns true if consumed. */
export function parseMidloopToken(r, c, tag, acc) {
  if (tag === 'MC' || tag === 'MH' || tag === 'MV') {
    acc.midloop.push({ r, c, dir: tag[1] });
    return true;
  }
  return false;
}

/** Canonical dihedral-transformed Mid-loop string for `symmetryKey`. */
export function symmetryMidloop(p, swap, flipR, flipC) {
  const list = p.midloop || [];
  if (!list.length) return '';
  const R = swap ? p.cols : p.rows;
  const C = swap ? p.rows : p.cols;
  const xform = (r, c) => {
    if (swap) [r, c] = [c, r];
    if (flipR) r = R - 1 - r;
    if (flipC) c = C - 1 - c;
    return [r, c];
  };
  const dirCode = (d) => (d === 'C' ? 0 : d === 'H' ? 1 : 2);
  return '|M:' + list.map((md) => {
    if (md.dir === 'C') {
      const [r, c] = xform(md.r, md.c);
      return [(r * C + c) * 3, `${r}:${c}:C`];
    }
    const [r1, c1] = xform(md.r, md.c);
    const [r2, c2] = xform(md.dir === 'V' ? md.r + 1 : md.r, md.dir === 'H' ? md.c + 1 : md.c);
    const dir = r1 === r2 ? 'H' : 'V';
    const r = Math.min(r1, r2), c = Math.min(c1, c2);
    return [(r * C + c) * 3 + dirCode(dir), `${r}:${c}:${dir}`];
  }).sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(';');
}

/** Rotate Mid-loop dots 90° CW for a board of size R x C -> C x R. */
export function rotateMidloopCW(P) {
  const R = P.rows;
  return (P.midloop || []).map((md) => {
    if (md.dir === 'C') return { r: md.c, c: R - 1 - md.r, dir: 'C' };
    if (md.dir === 'H') return { r: md.c, c: R - 1 - md.r, dir: 'V' };
    return { r: md.c, c: R - 2 - md.r, dir: 'H' };
  });
}

// ------------------------------------------------------------ Zero-allocation core ray helpers

/** True if vertex `u` has at least one perpendicular edge ON along `axis`. */
function hasPerpOnAt(ed, e, u, p0, p1) {
  const x0 = ed[u * 4 + p0], x1 = ed[u * 4 + p1];
  return (x0 >= 0 && e[x0] === E_ON) || (x1 >= 0 && e[x1] === E_ON);
}

/**
 * True if vertex `u` can serve as a 90° turn endpoint along `axis`:
 * must NOT already have BOTH perpendicular edges ON (would force degree 3),
 * and must have at least one perpendicular edge available (on-board, not OFF, neighbor not OFF).
 */
function canTurnAt(ed, nb, e, cell, clue, u, p0, p1) {
  if (clue && clue[u] === WHITE) return false;
  const u4 = u * 4;
  const x0 = ed[u4 + p0], x1 = ed[u4 + p1];
  const on0 = x0 >= 0 && e[x0] === E_ON;
  const on1 = x1 >= 0 && e[x1] === E_ON;
  if (on0 && on1) return false;
  const ok0 = x0 >= 0 && e[x0] !== E_OFF && (!cell || cell[nb[u4 + p0]] !== OFF);
  const ok1 = x1 >= 0 && e[x1] !== E_OFF && (!cell || cell[nb[u4 + p1]] !== OFF);
  return ok0 || ok1;
}

/**
 * Zero-allocation ray scan into scratch buffers `(negE, posE, negC, posC)`.
 * Returns packed `(validCount << 16) | (minK & 0xffff)` (or `0` when no valid `k` exists).
 * If `stopAtFirst` is true, returns `1` immediately upon finding the first valid `k` (fast contradiction / live-state check).
 */
function scanMidloopAxis(P, st, m, axis, negE, posE, negC, posC, stopAtFirst = false) {
  const { ed, nb, midloopAtCell, midloopAtEdge } = P;
  const e = st.e;
  const cell = st.cell;
  const clue = P.clueCells && P.clueCells.length ? (st.clue || P.clue) : null;
  const dNeg = AXIS_NEG[axis], dPos = AXIS_POS[axis];
  const p0 = AXIS_PERP0[axis], p1 = AXIS_PERP1[axis];
  const isC = m.dir === 'C';
  const kMin = isC ? 1 : 0;

  if (cell && (cell[m.a] === OFF || cell[m.b] === OFF)) return 0;
  if (!isC) {
    if (e[m.edge] === E_OFF) return 0;
    if (midloopAtCell && (midloopAtCell[m.a] >= 0 || midloopAtCell[m.b] >= 0)) return 0;
  } else if (hasPerpOnAt(ed, e, m.a, p0, p1)) {
    return 0;
  }

  let curN = m.a, curP = m.b;
  if (negC) { negC[0] = curN; posC[0] = curP; }
  let validCount = 0;
  let minK = 0;

  // Test k = 0 for edge dots before tracing step 1 (a Black circle cannot turn after a length-1 run)
  if (kMin === 0) {
    const blackBlocked = clue && (clue[curN] === BLACK || clue[curP] === BLACK);
    const nextN = ed[curN * 4 + dNeg];
    const nextP = ed[curP * 4 + dPos];
    const forcedN = nextN >= 0 && (e[nextN] === E_ON || (midloopAtEdge && midloopAtEdge[nextN] >= 0));
    const forcedP = nextP >= 0 && (e[nextP] === E_ON || (midloopAtEdge && midloopAtEdge[nextP] >= 0));
    if (!blackBlocked && !forcedN && !forcedP
      && canTurnAt(ed, nb, e, cell, clue, curN, p0, p1)
      && canTurnAt(ed, nb, e, cell, clue, curP, p0, p1)) {
      if (stopAtFirst) return 1;
      validCount = 1;
      minK = 0;
    }
  }

  for (let j = 1; ; j++) {
    // Extending to step j makes curN and curP strict interior vertices of the straight run (no perp ON, no Black circle)
    if ((!isC || j > 1) && (
      hasPerpOnAt(ed, e, curN, p0, p1) || hasPerpOnAt(ed, e, curP, p0, p1)
      || (clue && (clue[curN] === BLACK || clue[curP] === BLACK))
    )) break;
    const ne = ed[curN * 4 + dNeg];
    const pe = ed[curP * 4 + dPos];
    if (ne < 0 || pe < 0) break;
    if (e[ne] === E_OFF || e[pe] === E_OFF) break;
    if (midloopAtEdge && (midloopAtEdge[ne] >= 0 || midloopAtEdge[pe] >= 0)) break;
    const nn = nb[curN * 4 + dNeg];
    const np = nb[curP * 4 + dPos];
    if (cell && (cell[nn] === OFF || cell[np] === OFF)) break;
    if (midloopAtCell && (midloopAtCell[nn] >= 0 || midloopAtCell[np] >= 0)) break;

    if (negE) { negE[j] = ne; posE[j] = pe; negC[j] = nn; posC[j] = np; }
    curN = nn;
    curP = np;

    const nextN = ed[curN * 4 + dNeg];
    const nextP = ed[curP * 4 + dPos];
    const forcedN = nextN >= 0 && (e[nextN] === E_ON || (midloopAtEdge && midloopAtEdge[nextN] >= 0));
    const forcedP = nextP >= 0 && (e[nextP] === E_ON || (midloopAtEdge && midloopAtEdge[nextP] >= 0));
    if (!forcedN && !forcedP
      && canTurnAt(ed, nb, e, cell, clue, curN, p0, p1)
      && canTurnAt(ed, nb, e, cell, clue, curP, p0, p1)) {
      if (stopAtFirst) return 1;
      if (validCount === 0) minK = j;
      validCount++;
    }
  }

  return validCount === 0 ? 0 : ((validCount << 16) | minK);
}

/** Fast zero-allocation check: does dot `m` have at least one valid symmetric half-length along `axis`? */
export function hasValidMidloopK(P, st, m, axis) {
  return scanMidloopAxis(P, st, m, axis, null, null, null, null, true) !== 0;
}

/**
 * Return index of the first unsatisfied Mid-loop dot in `edges`, or `-1` if every dot is satisfied.
 */
export function firstUnsatisfiedMidloop(P, edges) {
  if (!P.hasMidloop) return -1;
  const { ed, nb, midloop } = P;
  for (let k = 0; k < midloop.length; k++) {
    const m = midloop[k];
    let axis = m.axis;
    if (m.dir === 'C') {
      const i4 = m.cell * 4;
      const u = ed[i4], r = ed[i4 + 1], dn = ed[i4 + 2], l = ed[i4 + 3];
      const vert = u >= 0 && dn >= 0 && edges[u] === E_ON && edges[dn] === E_ON;
      const horiz = r >= 0 && l >= 0 && edges[r] === E_ON && edges[l] === E_ON;
      if (vert === horiz) return k;
      axis = vert ? 0 : 1;
    } else if (edges[m.edge] !== E_ON) {
      return k;
    }
    const dNeg = AXIS_NEG[axis], dPos = AXIS_POS[axis];
    let lenN = 0, cur = m.a;
    while (true) {
      const x = ed[cur * 4 + dNeg];
      if (x < 0 || edges[x] !== E_ON) break;
      lenN++;
      cur = nb[cur * 4 + dNeg];
    }
    let lenP = 0;
    cur = m.b;
    while (true) {
      const x = ed[cur * 4 + dPos];
      if (x < 0 || edges[x] !== E_ON) break;
      lenP++;
      cur = nb[cur * 4 + dPos];
    }
    if (lenN !== lenP || (m.dir === 'C' && lenN < 1)) return k;
  }
  return -1;
}

/** Exact solution check: every Mid-loop dot sits at the exact midpoint of its straight loop segment. */
export function isMidloopSatisfied(P, edges) {
  return firstUnsatisfiedMidloop(P, edges) < 0;
}

/**
 * Check whether closing `closingEdge` (currently UNKNOWN -> ON) would leave any Mid-loop dot
 * unsatisfied. Returns the first unsatisfied dot index, or -1 if all match.
 */
export function firstUnsatisfiedMidloopOnClose(P, st, closingEdge) {
  if (!P.hasMidloop) return -1;
  const e = st.e;
  const prev = e[closingEdge];
  e[closingEdge] = E_ON;
  const bad = firstUnsatisfiedMidloop(P, e);
  e[closingEdge] = prev;
  return bad;
}

/**
 * Zero-allocation exact propagator step for one Mid-loop dot `k`.
 * Calls `setEdge(x, val)` and `setCell(i, val)` callbacks; returns false on contradiction.
 */
export function propagateMidloopDot(P, st, k, setEdge, setCell) {
  const m = P.midloop[k];
  const { ed } = P;
  ensureRayScratch(P.rows > P.cols ? P.rows : P.cols);

  let packed = 0;
  let axis = m.axis;
  let negE = mlNegE, posE = mlPosE, negC = mlNegC, posC = mlPosC;

  if (m.dir !== 'C') {
    if (!setEdge(m.edge, E_ON)) return false;
    packed = scanMidloopAxis(P, st, m, axis, negE, posE, negC, posC, false);
    if (packed === 0) return false;
  } else {
    if (!setCell(m.cell, LOOP)) return false;
    const pV = scanMidloopAxis(P, st, m, 0, mlNegE, mlPosE, mlNegC, mlPosC, false);
    const pH = scanMidloopAxis(P, st, m, 1, mlNegE2, mlPosE2, mlNegC2, mlPosC2, false);
    if (pV === 0 && pH === 0) return false;
    if (pV !== 0 && pH !== 0) return true; // orientation still undecided
    if (pV !== 0) {
      packed = pV; axis = 0;
    } else {
      packed = pH; axis = 1;
      negE = mlNegE2; posE = mlPosE2; negC = mlNegC2; posC = mlPosC2;
    }
    const p0e = ed[m.cell * 4 + AXIS_PERP0[axis]];
    const p1e = ed[m.cell * 4 + AXIS_PERP1[axis]];
    if (p0e >= 0 && !setEdge(p0e, E_OFF)) return false;
    if (p1e >= 0 && !setEdge(p1e, E_OFF)) return false;
  }

  const validCount = packed >>> 16;
  const minK = packed & 0xffff;
  for (let j = 1; j <= minK; j++) {
    if (!setEdge(negE[j], E_ON)) return false;
    if (!setEdge(posE[j], E_ON)) return false;
  }
  if (validCount === 1) {
    const capN = ed[negC[minK] * 4 + AXIS_NEG[axis]];
    const capP = ed[posC[minK] * 4 + AXIS_POS[axis]];
    if (capN >= 0 && !setEdge(capN, E_OFF)) return false;
    if (capP >= 0 && !setEdge(capP, E_OFF)) return false;
  }
  return true;
}

/**
 * Auto-X bookkeeping for Mid-loop:
 *  1. Vertex dot with 1 drawn straight segment -> auto-X its two perpendicular edges.
 *  2. Equal-length capped run (strict Option 1): once a dot's axis is drawn and both branches
 *     have equal contiguous drawn length `k`, if one tip is already stopped (border/void, X, or
 *     drawn 90° turn), auto-X the straight continuation past the opposite tip.
 */
export function autoXMidloop(P, w, add) {
  if (!P.hasMidloop) return false;
  const { ed, nb, midloop } = P;
  let changed = false;
  const hasPerp = (cell, axis) => {
    const p0 = ed[cell * 4 + AXIS_PERP0[axis]];
    const p1 = ed[cell * 4 + AXIS_PERP1[axis]];
    return (p0 >= 0 && w[p0] === 1) || (p1 >= 0 && w[p1] === 1);
  };
  for (let k = 0; k < midloop.length; k++) {
    const m = midloop[k];
    let axis = -1, startNeg = -1, startPos = -1;
    if (m.dir !== 'C') {
      if (w[m.edge] !== 1) continue;
      axis = m.axis;
      startNeg = m.a;
      startPos = m.b;
    } else {
      const i4 = m.cell * 4;
      const u = ed[i4], r = ed[i4 + 1], dn = ed[i4 + 2], l = ed[i4 + 3];
      const uOn = u >= 0 && w[u] === 1;
      const dOn = dn >= 0 && w[dn] === 1;
      const rOn = r >= 0 && w[r] === 1;
      const lOn = l >= 0 && w[l] === 1;
      const vOn = uOn || dOn;
      const hOn = rOn || lOn;
      if (vOn && !hOn) {
        if (r >= 0 && w[r] !== 1 && add(r)) changed = true;
        if (l >= 0 && w[l] !== 1 && add(l)) changed = true;
        if (uOn && dOn) { axis = 0; startNeg = m.cell; startPos = m.cell; }
      } else if (hOn && !vOn) {
        if (u >= 0 && w[u] !== 1 && add(u)) changed = true;
        if (dn >= 0 && w[dn] !== 1 && add(dn)) changed = true;
        if (lOn && rOn) { axis = 1; startNeg = m.cell; startPos = m.cell; }
      }
    }
    if (axis < 0) continue;

    const dNeg = AXIS_NEG[axis], dPos = AXIS_POS[axis];
    let lenNeg = 0, tipNeg = startNeg;
    while (true) {
      const x = ed[tipNeg * 4 + dNeg];
      if (x < 0 || w[x] !== 1) break;
      lenNeg++;
      tipNeg = nb[tipNeg * 4 + dNeg];
    }
    let lenPos = 0, tipPos = startPos;
    while (true) {
      const x = ed[tipPos * 4 + dPos];
      if (x < 0 || w[x] !== 1) break;
      lenPos++;
      tipPos = nb[tipPos * 4 + dPos];
    }
    if (lenNeg !== lenPos) continue;

    const nextNeg = ed[tipNeg * 4 + dNeg];
    const nextPos = ed[tipPos * 4 + dPos];
    const negStopped = nextNeg < 0 || w[nextNeg] === 2 || hasPerp(tipNeg, axis);
    const posStopped = nextPos < 0 || w[nextPos] === 2 || hasPerp(tipPos, axis);
    if (negStopped && nextPos >= 0 && w[nextPos] !== 1 && add(nextPos)) changed = true;
    if (posStopped && nextNeg >= 0 && w[nextNeg] !== 1 && add(nextNeg)) changed = true;
  }
  return changed;
}

/**
 * Live error feedback for Mid-loop dots from player marks alone (never looks at stored solution).
 * Returns array of 'bad' | '' per dot in P.midloop.
 */
export function midloopStates(P, marks) {
  if (!P.hasMidloop) return [];
  const fakeSt = { e: marks.edges, cell: null };
  return P.midloop.map((m) => {
    if (m.dir !== 'C') {
      if (marks.edges[m.edge] === E_OFF) return 'bad';
      return hasValidMidloopK(P, fakeSt, m, m.axis) ? '' : 'bad';
    }
    return (hasValidMidloopK(P, fakeSt, m, 0) || hasValidMidloopK(P, fakeSt, m, 1)) ? '' : 'bad';
  });
}

// ------------------------------------------------------------ Human-style Mid-loop rules

/** Determine a dot's known straight axis (0=V, 1=H) or -1 if undecided. */
function knownAxisOf(P, st, m) {
  if (m.dir !== 'C') return st.e[m.edge] === E_ON ? m.axis : -1;
  const i4 = m.cell * 4, ed = P.ed, e = st.e;
  const vOn = (ed[i4] >= 0 && e[ed[i4]] === E_ON) || (ed[i4 + 2] >= 0 && e[ed[i4 + 2]] === E_ON);
  const hOn = (ed[i4 + 1] >= 0 && e[ed[i4 + 1]] === E_ON) || (ed[i4 + 3] >= 0 && e[ed[i4 + 3]] === E_ON);
  if (vOn && !hOn) return 0;
  if (hOn && !vOn) return 1;
  return -1;
}

/** Measure contiguous drawn ON length from `start` along `dir`. */
function drawnSideLen(ed, nb, e, start, dir) {
  let len = 0, cur = start;
  while (true) {
    const x = ed[cur * 4 + dir];
    if (x < 0 || e[x] !== E_ON) break;
    len++;
    cur = nb[cur * 4 + dir];
  }
  return len;
}

/** Measure immediate straight stop distance (first OFF/border/perp-ON/Black/dot) from `start` along `dir`. */
function sideBlockedDist(P, st, start, dir, axis, checkStartPerp) {
  const { ed, nb, midloopAtCell, midloopAtEdge } = P;
  const e = st.e, cell = st.cell;
  const clue = P.clueCells && P.clueCells.length ? (st.clue || P.clue) : null;
  const p0 = AXIS_PERP0[axis], p1 = AXIS_PERP1[axis];
  let cur = start;
  for (let d = 0; ; d++) {
    if ((d > 0 || checkStartPerp) && (hasPerpOnAt(ed, e, cur, p0, p1) || (clue && clue[cur] === BLACK))) return d;
    const x = ed[cur * 4 + dir];
    if (x < 0 || e[x] === E_OFF) return d;
    // A collinear edge dot at edge d+1 prevents stopping at distance d (would merge runs), so max stop is d-1
    if (midloopAtEdge && midloopAtEdge[x] >= 0) return d > 0 ? d - 1 : 0;
    const nxt = nb[cur * 4 + dir];
    if (cell && cell[nxt] === OFF) return d;
    if (midloopAtCell && midloopAtCell[nxt] >= 0) return d;
    cur = nxt;
  }
}

/** Local check for Rule 2 (`midVertexAxis`): can vertex dot `i` step 1 cell straight on both sides of `axis`? */
function localAxisOk(P, st, i, axis) {
  const { ed, nb, midloopAtCell, midloopAtEdge } = P;
  const e = st.e, cell = st.cell;
  if (hasPerpOnAt(ed, e, i, AXIS_PERP0[axis], AXIS_PERP1[axis])) return false;
  const d0 = AXIS_NEG[axis], d1 = AXIS_POS[axis];
  const x0 = ed[i * 4 + d0];
  if (x0 < 0 || e[x0] === E_OFF || (midloopAtEdge && midloopAtEdge[x0] >= 0)) return false;
  const j0 = nb[i * 4 + d0];
  if (cell[j0] === OFF || (midloopAtCell && midloopAtCell[j0] >= 0)) return false;
  const x1 = ed[i * 4 + d1];
  if (x1 < 0 || e[x1] === E_OFF || (midloopAtEdge && midloopAtEdge[x1] >= 0)) return false;
  const j1 = nb[i * 4 + d1];
  if (cell[j1] === OFF || (midloopAtCell && midloopAtCell[j1] >= 0)) return false;
  return true;
}

/** Single-dot evaluator for Rule 1 (`midEdgeDot`). Returns `{ sets, info }` or null. */
function checkMidEdgeDot(P, st, k) {
  const m = P.midloop[k];
  if (m.dir === 'C' || st.e[m.edge] !== E_UNKNOWN) return null;
  const sets = [['e', m.edge, E_ON]];
  if (st.cell[m.a] !== LOOP) sets.push(['c', m.a, LOOP]);
  if (st.cell[m.b] !== LOOP) sets.push(['c', m.b, LOOP]);
  return { sets, info: { midIdx: k, cell: m.a, cell2: m.b, edge: m.edge } };
}

/** Single-dot evaluator for Rule 2 (`midVertexAxis`). Returns `{ sets, info }` or null. */
function checkMidVertexAxis(P, st, k) {
  const m = P.midloop[k];
  if (m.dir !== 'C') return null;
  const i = m.cell;
  const { ed } = P;
  const e = st.e;
  const i4 = i * 4;
  // Early exit when all 4 incident edges are already decided
  const eu = ed[i4], er = ed[i4 + 1], edn = ed[i4 + 2], el = ed[i4 + 3];
  if ((eu < 0 || e[eu] !== E_UNKNOWN) && (er < 0 || e[er] !== E_UNKNOWN)
    && (edn < 0 || e[edn] !== E_UNKNOWN) && (el < 0 || e[el] !== E_UNKNOWN)) return null;
  const vOk = localAxisOk(P, st, i, 0);
  const hOk = localAxisOk(P, st, i, 1);
  if (vOk === hOk) return null;
  const axis = vOk ? 0 : 1;
  const sets = [];
  const e0 = ed[i4 + AXIS_NEG[axis]], e1 = ed[i4 + AXIS_POS[axis]];
  const p0 = ed[i4 + AXIS_PERP0[axis]], p1 = ed[i4 + AXIS_PERP1[axis]];
  if (e[e0] === E_UNKNOWN) sets.push(['e', e0, E_ON]);
  if (e[e1] === E_UNKNOWN) sets.push(['e', e1, E_ON]);
  if (p0 >= 0 && e[p0] === E_UNKNOWN) sets.push(['e', p0, E_OFF]);
  if (p1 >= 0 && e[p1] === E_UNKNOWN) sets.push(['e', p1, E_OFF]);
  return sets.length ? { sets, info: { midIdx: k, cell: i, axis } } : null;
}

/** Single-dot evaluator for Rule 3 (`midSymExtend`). Returns `{ sets, info }` or null. */
function checkMidSymExtend(P, st, k) {
  const m = P.midloop[k];
  const axis = knownAxisOf(P, st, m);
  if (axis < 0) return null;
  const { ed, nb } = P;
  const e = st.e;
  const dNeg = AXIS_NEG[axis], dPos = AXIS_POS[axis];
  const lenN = drawnSideLen(ed, nb, e, m.a, dNeg);
  const lenP = drawnSideLen(ed, nb, e, m.b, dPos);
  const target = Math.max(lenN, lenP, m.dir === 'C' ? 1 : 0);
  if (lenN >= target && lenP >= target) return null;
  const sets = [];
  let cur = m.a;
  for (let s = 1; s <= target; s++) {
    const x = ed[cur * 4 + dNeg];
    if (x < 0 || e[x] === E_OFF) return null;
    if (e[x] === E_UNKNOWN) sets.push(['e', x, E_ON]);
    cur = nb[cur * 4 + dNeg];
  }
  cur = m.b;
  for (let s = 1; s <= target; s++) {
    const x = ed[cur * 4 + dPos];
    if (x < 0 || e[x] === E_OFF) return null;
    if (e[x] === E_UNKNOWN) sets.push(['e', x, E_ON]);
    cur = nb[cur * 4 + dPos];
  }
  return sets.length ? { sets, info: { midIdx: k, cell: m.a, cell2: m.b, axis, target } } : null;
}

/** Single-dot evaluator for Rule 4 (`midSymCap`). Returns `{ sets, info }` or null. */
function checkMidSymCap(P, st, k) {
  const m = P.midloop[k];
  const axis = knownAxisOf(P, st, m);
  if (axis < 0) return null;
  const { ed, nb } = P;
  const e = st.e;
  const dNeg = AXIS_NEG[axis], dPos = AXIS_POS[axis];
  let lenN = 0, endN = m.a;
  while (true) {
    const x = ed[endN * 4 + dNeg];
    if (x < 0 || e[x] !== E_ON) break;
    lenN++;
    endN = nb[endN * 4 + dNeg];
  }
  let lenP = 0, endP = m.b;
  while (true) {
    const x = ed[endP * 4 + dPos];
    if (x < 0 || e[x] !== E_ON) break;
    lenP++;
    endP = nb[endP * 4 + dPos];
  }
  const minDrawn = lenN < lenP ? lenN : lenP;
  const kMin = m.dir === 'C' ? 1 : 0;
  if (minDrawn < kMin) return null;
  // Early exit: if both caps at minDrawn are already non-unknown, check only whether a tighter block exists below minDrawn
  if (lenN === lenP) {
    const cN = ed[endN * 4 + dNeg];
    const cP = ed[endP * 4 + dPos];
    if ((cN < 0 || e[cN] !== E_UNKNOWN) && (cP < 0 || e[cP] !== E_UNKNOWN)) return null;
  }
  const blkN = sideBlockedDist(P, st, m.a, dNeg, axis, m.dir !== 'C');
  const blkP = sideBlockedDist(P, st, m.b, dPos, axis, m.dir !== 'C');
  const maxSym = blkN < blkP ? blkN : blkP;
  if (minDrawn < maxSym || maxSym < kMin) return null;
  let curN = m.a, curP = m.b;
  if (maxSym === lenN && maxSym === lenP) {
    curN = endN; curP = endP;
  } else {
    for (let s = 0; s < maxSym; s++) { curN = nb[curN * 4 + dNeg]; curP = nb[curP * 4 + dPos]; }
  }
  const capN = ed[curN * 4 + dNeg];
  const capP = ed[curP * 4 + dPos];
  const sets = [];
  if (capN >= 0 && e[capN] === E_UNKNOWN) sets.push(['e', capN, E_OFF]);
  if (capP >= 0 && e[capP] === E_UNKNOWN) sets.push(['e', capP, E_OFF]);
  return sets.length ? { sets, info: { midIdx: k, cell: m.a, cell2: m.b, axis, cap: maxSym, endN: curN, endP: curP } } : null;
}

/** Rule 1 (Beginner, weight 1): an edge Mid-loop dot immediately forces its edge ON. */
function findMidEdgeDot(P, st) {
  if (!P.hasMidloop) return [];
  const out = [];
  for (let k = 0; k < P.midloop.length; k++) {
    const h = checkMidEdgeDot(P, st, k);
    if (h) out.push(h);
  }
  return out;
}

/** Rule 2 (Beginner, weight 3): a vertex Mid-loop dot blocked on one axis goes straight along the other. */
function findMidVertexAxis(P, st) {
  if (!P.hasMidloop) return [];
  const out = [];
  for (let k = 0; k < P.midloop.length; k++) {
    const h = checkMidVertexAxis(P, st, k);
    if (h) out.push(h);
  }
  return out;
}

/** Rule 3 (Beginner, weight 4): symmetric arm extension. */
function findMidSymExtend(P, st) {
  if (!P.hasMidloop) return [];
  const out = [];
  for (let k = 0; k < P.midloop.length; k++) {
    const h = checkMidSymExtend(P, st, k);
    if (h) out.push(h);
  }
  return out;
}

/** Rule 4 (Beginner, weight 5): symmetric turn cap. */
function findMidSymCap(P, st) {
  if (!P.hasMidloop) return [];
  const out = [];
  for (let k = 0; k < P.midloop.length; k++) {
    const h = checkMidSymCap(P, st, k);
    if (h) out.push(h);
  }
  return out;
}

/** Single-dot evaluator for Rule 5 (`midLengthForce`). Returns `{ sets, info }` or null. */
function checkMidLengthForce(P, st, k) {
  const m = P.midloop[k];
  const axis = knownAxisOf(P, st, m);
  if (axis < 0) return null;
  const { ed, nb } = P;
  const e = st.e;
  const dNeg = AXIS_NEG[axis], dPos = AXIS_POS[axis];
  // Early exit on already-completed dots (equal drawn arms capped OFF/border on both ends)
  let lenN = 0, endN = m.a;
  while (true) {
    const x = ed[endN * 4 + dNeg];
    if (x < 0 || e[x] !== E_ON) break;
    lenN++;
    endN = nb[endN * 4 + dNeg];
  }
  let lenP = 0, endP = m.b;
  while (true) {
    const x = ed[endP * 4 + dPos];
    if (x < 0 || e[x] !== E_ON) break;
    lenP++;
    endP = nb[endP * 4 + dPos];
  }
  if (lenN === lenP && lenN >= (m.dir === 'C' ? 1 : 0)) {
    const cN = ed[endN * 4 + dNeg], cP = ed[endP * 4 + dPos];
    if ((cN < 0 || e[cN] === E_OFF) && (cP < 0 || e[cP] === E_OFF)) return null;
  }
  ensureRayScratch(P.rows > P.cols ? P.rows : P.cols);
  const packed = scanMidloopAxis(P, st, m, axis, mlNegE, mlPosE, mlNegC, mlPosC, false);
  if (packed === 0) return null;
  const validCount = packed >>> 16;
  const minK = packed & 0xffff;
  const sets = [];
  for (let j = 1; j <= minK; j++) {
    if (e[mlNegE[j]] === E_UNKNOWN) sets.push(['e', mlNegE[j], E_ON]);
    if (e[mlPosE[j]] === E_UNKNOWN) sets.push(['e', mlPosE[j], E_ON]);
  }
  if (validCount === 1) {
    const capN = ed[mlNegC[minK] * 4 + dNeg];
    const capP = ed[mlPosC[minK] * 4 + dPos];
    if (capN >= 0 && e[capN] === E_UNKNOWN) sets.push(['e', capN, E_OFF]);
    if (capP >= 0 && e[capP] === E_UNKNOWN) sets.push(['e', capP, E_OFF]);
  }
  return sets.length ? { sets, info: { midIdx: k, cell: m.a, cell2: m.b, axis, minK, exact: validCount === 1 } } : null;
}

/**
 * Rule 5 (Medium, weight 11): Mid-loop exact-length / gap deduction — along a known axis,
 * eliminating impossible stop lengths forces a larger minimum extension or a unique cap.
 */
function findMidLengthForce(P, st) {
  if (!P.hasMidloop) return [];
  const out = [];
  for (let k = 0; k < P.midloop.length; k++) {
    const h = checkMidLengthForce(P, st, k);
    if (h) out.push(h);
  }
  return out;
}

/** Single-dot evaluator for Rule 6 (`midVertexParity`). Returns `{ sets, info }` or null. */
function checkMidVertexParity(P, st, k) {
  const m = P.midloop[k];
  if (m.dir !== 'C' || knownAxisOf(P, st, m) >= 0) return null;
  ensureRayScratch(P.rows > P.cols ? P.rows : P.cols);
  const pV = scanMidloopAxis(P, st, m, 0, mlNegE, mlPosE, mlNegC, mlPosC, false);
  const pH = scanMidloopAxis(P, st, m, 1, mlNegE2, mlPosE2, mlNegC2, mlPosC2, false);
  if ((pV === 0) === (pH === 0)) return null;
  const axis = pV !== 0 ? 0 : 1;
  const packed = pV !== 0 ? pV : pH;
  const negE = pV !== 0 ? mlNegE : mlNegE2;
  const posE = pV !== 0 ? mlPosE : mlPosE2;
  const { ed } = P;
  const e = st.e;
  const i = m.cell;
  const sets = [];
  const p0 = ed[i * 4 + AXIS_PERP0[axis]], p1 = ed[i * 4 + AXIS_PERP1[axis]];
  if (p0 >= 0 && e[p0] === E_UNKNOWN) sets.push(['e', p0, E_OFF]);
  if (p1 >= 0 && e[p1] === E_UNKNOWN) sets.push(['e', p1, E_OFF]);
  const minK = packed & 0xffff;
  for (let j = 1; j <= minK; j++) {
    if (e[negE[j]] === E_UNKNOWN) sets.push(['e', negE[j], E_ON]);
    if (e[posE[j]] === E_UNKNOWN) sets.push(['e', posE[j], E_ON]);
  }
  return sets.length ? { sets, info: { midIdx: k, cell: i, axis } } : null;
}

/**
 * Rule 6 (Medium, weight 12): Mid-loop vertex axis elimination — an unoriented vertex dot whose
 * one axis has zero feasible symmetric half-lengths must run along the other axis.
 */
function findMidVertexParity(P, st) {
  if (!P.hasMidloop) return [];
  const out = [];
  for (let k = 0; k < P.midloop.length; k++) {
    const h = checkMidVertexParity(P, st, k);
    if (h) out.push(h);
  }
  return out;
}

/**
 * Lookahead medium-step helper for `js/imagine.js` (parallels `whiteBothStraight` at step 7):
 * keeps `runHypothesis` in sync with `propagateMidloopDot` so Mid-loop lookaheads don't fall through to `tryEdge`.
 */
export function findMediumMidloopStep(P, st, tryEmit, scopeMids = null) {
  if (!P.hasMidloop) return null;
  const len = scopeMids ? scopeMids.length : P.midloop.length;
  for (let i = 0; i < len; i++) {
    const k = scopeMids ? scopeMids[i] : i;
    const h = checkMidLengthForce(P, st, k);
    if (h) { const em = tryEmit('midLengthForce', h.sets, h.info); if (em) return em; }
  }
  for (let i = 0; i < len; i++) {
    const k = scopeMids ? scopeMids[i] : i;
    const h = checkMidVertexParity(P, st, k);
    if (h) { const em = tryEmit('midVertexParity', h.sets, h.info); if (em) return em; }
  }
  return null;
}

/**
 * Lookahead easy-step helper for `js/imagine.js`: iterates across all hits of all 4 Beginner Mid-loop
 * rules (optionally restricted to dirty `scopeMids`) and passes each through `tryEmit` so `forbid`
 * ablation never skips later hits or later rules.
 */
export function findEasyMidloopStep(P, st, tryEmit, scopeMids = null) {
  if (!P.hasMidloop) return null;
  const len = scopeMids ? scopeMids.length : P.midloop.length;
  for (let i = 0; i < len; i++) {
    const k = scopeMids ? scopeMids[i] : i;
    const h = checkMidEdgeDot(P, st, k);
    if (h) { const em = tryEmit('midEdgeDot', h.sets, h.info); if (em) return em; }
  }
  for (let i = 0; i < len; i++) {
    const k = scopeMids ? scopeMids[i] : i;
    const h = checkMidVertexAxis(P, st, k);
    if (h) { const em = tryEmit('midVertexAxis', h.sets, h.info); if (em) return em; }
  }
  for (let i = 0; i < len; i++) {
    const k = scopeMids ? scopeMids[i] : i;
    const h = checkMidSymExtend(P, st, k);
    if (h) { const em = tryEmit('midSymExtend', h.sets, h.info); if (em) return em; }
  }
  for (let i = 0; i < len; i++) {
    const k = scopeMids ? scopeMids[i] : i;
    const h = checkMidSymCap(P, st, k);
    if (h) { const em = tryEmit('midSymCap', h.sets, h.info); if (em) return em; }
  }
  return null;
}

/**
 * Zero-allocation Mid-loop contradiction check for `js/imagine.js` (optionally scoped to `scopeMids`).
 * Returns `{ kind: 'midloop', midIdx, cell, cell2? }` or null.
 */
export function midloopContradiction(P, st, scopeMids = null) {
  if (!P.hasMidloop) return null;
  const len = scopeMids ? scopeMids.length : P.midloop.length;
  for (let i = 0; i < len; i++) {
    const k = scopeMids ? scopeMids[i] : i;
    const m = P.midloop[k];
    if (m.dir !== 'C') {
      if (st.e[m.edge] === E_OFF || !hasValidMidloopK(P, st, m, m.axis)) {
        return { kind: 'midloop', midIdx: k, cell: m.a, cell2: m.b };
      }
    } else if (!hasValidMidloopK(P, st, m, 0) && !hasValidMidloopK(P, st, m, 1)) {
      return { kind: 'midloop', midIdx: k, cell: m.cell };
    }
  }
  return null;
}

/** Human Mid-loop rules for splicing into `RULES` in `js/rating.js`. */
export const MIDLOOP_RULES = [
  {
    id: 'midEdgeDot',
    tier: 'Beginner',
    weight: 1,
    name: 'Mid-loop edge dot',
    label: 'a Mid-loop dot on a grid segment puts that segment on the loop',
    find: findMidEdgeDot,
  },
  {
    id: 'midVertexAxis',
    tier: 'Beginner',
    weight: 3,
    name: 'Mid-loop straight line',
    label: 'a Mid-loop dot on an intersection whose one direction is blocked goes straight the other way',
    find: findMidVertexAxis,
  },
  {
    id: 'midSymExtend',
    tier: 'Beginner',
    weight: 4,
    name: 'Mid-loop symmetric extend',
    label: 'when a Mid-loop straight segment extends further on one side, extend the opposite side to match',
    find: findMidSymExtend,
  },
  {
    id: 'midSymCap',
    tier: 'Beginner',
    weight: 5,
    name: 'Mid-loop symmetric turn',
    label: 'when one side of a Mid-loop segment must turn, the matching distance on the opposite side must also turn',
    find: findMidSymCap,
  },
  {
    id: 'midLengthForce',
    tier: 'Medium',
    weight: 11,
    name: 'Mid-loop forced length',
    label: 'eliminating impossible stop lengths along a Mid-loop dot forces its straight run to extend or turn',
    find: findMidLengthForce,
  },
  {
    id: 'midVertexParity',
    tier: 'Medium',
    weight: 12,
    name: 'Mid-loop orientation',
    label: 'an intersection Mid-loop dot with no valid symmetric length along one axis runs along the other',
    find: findMidVertexParity,
  },
];

// ------------------------------------------------------------ Hint explanations

/** Format a Mid-loop dot's human location (e.g., `B3` for a vertex dot, `B3–C3` for an edge dot). */
export function midDotLoc(P, m, { cellName, edgeName }) {
  return m.dir === 'C' ? cellName(P, m.cell) : edgeName(P, m.edge);
}

/** Short chain clause for Mid-loop steps inside an imagined chain (`js/explain.js`). */
export function describeMidloopChainStep(P, s, helpers) {
  if (!P.hasMidloop || !s.info || s.info.midIdx === undefined) return null;
  const m = P.midloop[s.info.midIdx];
  if (!m) return null;
  const loc = midDotLoc(P, m, helpers);
  const axisWord = s.info.axis === 0 ? 'vertically' : 'horizontally';
  switch (s.rule) {
    case 'midEdgeDot':
      return `the Mid-loop dot on ${loc} puts that segment on the loop`;
    case 'midVertexAxis':
    case 'midVertexParity':
      return `the Mid-loop dot at ${loc} must go straight ${axisWord}`;
    case 'midSymExtend':
      return `the Mid-loop dot at ${loc} must extend symmetrically ${axisWord}`;
    case 'midSymCap':
      return `the Mid-loop dot at ${loc} must turn symmetrically on both ends`;
    case 'midLengthForce':
      return `the Mid-loop dot at ${loc} is forced to ${s.info.exact ? 'turn symmetrically' : 'extend symmetrically'}`;
    default:
      return null;
  }
}

/** Full explanation + non-spoiling nudge for Mid-loop rules (`js/explain.js`). */
export function explainMidloopStep(P, { rule, info, targets }, helpers) {
  if (!P.hasMidloop || !info || info.midIdx === undefined) return null;
  const m = P.midloop[info.midIdx];
  if (!m) return null;
  const { cellName, edgeName, describeMarks, roles, nudgeRoles } = helpers;
  const loc = midDotLoc(P, m, helpers);
  const axisWord = info.axis === 0 ? 'vertically' : 'horizontally';
  const otherAxis = info.axis === 0 ? 'horizontally' : 'vertically';

  if (m.dir === 'C') {
    roles.clue.push(m.cell);
    nudgeRoles.clue.push(m.cell);
  } else {
    roles.clue.push(m.a, m.b);
    nudgeRoles.clue.push(m.a, m.b);
  }

  switch (rule) {
    case 'midEdgeDot':
      return {
        nudge: `Look at the Mid-loop dot on ${loc} — every Mid-loop dot must lie on the loop.`,
        text: `The Mid-loop dot sits directly on ${loc}, so draw ${loc}.`,
      };
    case 'midVertexAxis':
      return {
        nudge: `Look at the Mid-loop dot at ${loc} — check which straight direction through it is still open.`,
        text: `The Mid-loop dot at ${loc} cannot go straight ${otherAxis}, so the loop must go straight ${axisWord} through ${loc}.`,
      };
    case 'midSymExtend':
      return {
        nudge: `Look at the Mid-loop dot at ${loc} — compare how far the straight segment extends on each side.`,
        text: `Because ${loc} must sit at the midpoint of its straight segment, extending the matching side forces ${describeMarks(P, targets)}.`,
      };
    case 'midSymCap':
      return info.cap === 0
        ? {
          nudge: `Look at the Mid-loop dot on ${loc} — one end must turn immediately, so check the opposite end.`,
          text: `One end of the Mid-loop segment ${loc} must turn immediately, so the opposite end must also turn immediately: ${describeMarks(P, targets)}.`,
        }
        : {
          nudge: `Look at the Mid-loop dot at ${loc} — one side must turn at distance ${info.cap}, so check the matching distance on the opposite side.`,
          text: `One side of the Mid-loop dot at ${loc} cannot go further than ${info.cap} step${info.cap === 1 ? '' : 's'}, so the opposite side must also turn there: ${describeMarks(P, targets)}.`,
        };
    case 'midLengthForce':
      return {
        nudge: `Look at the Mid-loop dot at ${loc} — check which symmetric straight lengths are still possible on both sides.`,
        text: `Eliminating blocked stop lengths around the Mid-loop dot at ${loc} forces ${describeMarks(P, targets)}.`,
      };
    case 'midVertexParity':
      return {
        nudge: `Look at the Mid-loop dot at ${loc} — check whether any symmetric straight length works along each axis.`,
        text: `The Mid-loop dot at ${loc} has no valid symmetric straight length ${otherAxis}, so it must run ${axisWord}: ${describeMarks(P, targets)}.`,
      };
    default:
      return null;
  }
}
