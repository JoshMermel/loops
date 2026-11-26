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

/** Axis directions: axis 0 = vertical (dNeg=0 U, dPos=2 D), axis 1 = horizontal (dNeg=3 L, dPos=1 R). */
const AXIS_NEG = [0, 3];
const AXIS_POS = [2, 1];
const AXIS_PERP0 = [1, 0];
const AXIS_PERP1 = [3, 2];

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

/**
 * Analyze all currently feasible symmetric half-lengths `k` for Mid-loop dot `m` along `axis`
 * (`0` = vertical, `1` = horizontal) under state `st` (or raw edge array `edges` when `cell` is null).
 *
 * Returns `{ validKs, negEdges, posEdges, negCells, posCells, dNeg, dPos, p0, p1, kMin }`:
 *   - `negEdges[j]` (`j >= 1`) is the j-th edge stepping from `m.a` in direction `dNeg`
 *   - `posEdges[j]` (`j >= 1`) is the j-th edge stepping from `m.b` in direction `dPos`
 *   - `negCells[0] = m.a`, `negCells[j]` is vertex after j steps along `dNeg`
 *   - `posCells[0] = m.b`, `posCells[j]` is vertex after j steps along `dPos`
 *   - `validKs`: sorted list of feasible integer half-lengths `k >= kMin`.
 */
export function analyzeMidloopAxis(P, st, m, axis) {
  const { ed, nb, midloopAtCell, midloopAtEdge } = P;
  const e = st.e;
  const cell = st.cell;
  const dNeg = AXIS_NEG[axis], dPos = AXIS_POS[axis];
  const p0 = AXIS_PERP0[axis], p1 = AXIS_PERP1[axis];
  const kMin = m.dir === 'C' ? 1 : 0;

  const negEdges = [-1], posEdges = [-1];
  const negCells = [m.a], posCells = [m.b];
  const validKs = [];

  const hasPerpOn = (u) => {
    const x0 = ed[u * 4 + p0], x1 = ed[u * 4 + p1];
    return (x0 >= 0 && e[x0] === E_ON) || (x1 >= 0 && e[x1] === E_ON);
  };
  const hasPerpAvail = (u) => {
    const x0 = ed[u * 4 + p0], x1 = ed[u * 4 + p1];
    const ok0 = x0 >= 0 && e[x0] !== E_OFF && (!cell || cell[nb[u * 4 + p0]] !== OFF);
    const ok1 = x1 >= 0 && e[x1] !== E_OFF && (!cell || cell[nb[u * 4 + p1]] !== OFF);
    return ok0 || ok1;
  };
  const isForcedOn = (x) => x >= 0 && (e[x] === E_ON || (midloopAtEdge && midloopAtEdge[x] >= 0));

  // Edge dot: underlying edge itself cannot be OFF, and neither endpoint can carry a vertex dot
  if (m.dir !== 'C') {
    if (e[m.edge] === E_OFF) return { validKs, negEdges, posEdges, negCells, posCells, dNeg, dPos, p0, p1, kMin };
    if (midloopAtCell && (midloopAtCell[m.a] >= 0 || midloopAtCell[m.b] >= 0)) {
      return { validKs, negEdges, posEdges, negCells, posCells, dNeg, dPos, p0, p1, kMin };
    }
  } else {
    // Vertex dot: cannot have any perpendicular edge ON at center
    if (hasPerpOn(m.a)) return { validKs, negEdges, posEdges, negCells, posCells, dNeg, dPos, p0, p1, kMin };
  }

  // Trace both rays simultaneously out to the maximum symmetric half-length `maxK`
  let curN = m.a, curP = m.b;
  let maxK = 0;
  for (let j = 1; ; j++) {
    // Extending to step j makes curN and curP strict interior vertices of the straight run
    if ((m.dir !== 'C' || j > 1) && (hasPerpOn(curN) || hasPerpOn(curP))) break;
    const ne = ed[curN * 4 + dNeg];
    const pe = ed[curP * 4 + dPos];
    if (ne < 0 || pe < 0) break;
    if (e[ne] === E_OFF || e[pe] === E_OFF) break;
    // A straight run cannot pass through a second edge dot on either side
    if (midloopAtEdge && (midloopAtEdge[ne] >= 0 || midloopAtEdge[pe] >= 0)) break;
    const nn = nb[curN * 4 + dNeg];
    const np = nb[curP * 4 + dPos];
    if (cell && (cell[nn] === OFF || cell[np] === OFF)) break;
    // Another vertex dot cannot be an interior vertex NOR a turn endpoint of this straight run
    if (midloopAtCell && (midloopAtCell[nn] >= 0 || midloopAtCell[np] >= 0)) break;

    negEdges.push(ne);
    posEdges.push(pe);
    negCells.push(nn);
    posCells.push(np);
    curN = nn;
    curP = np;
    maxK = j;
  }

  // Test each k in [kMin..maxK]: the run must TURN at negCells[k] and posCells[k]
  for (let k = kMin; k <= maxK; k++) {
    const endN = negCells[k], endP = posCells[k];
    const nextN = ed[endN * 4 + dNeg];
    const nextP = ed[endP * 4 + dPos];
    if (isForcedOn(nextN) || isForcedOn(nextP)) continue;
    if (!hasPerpAvail(endN) || !hasPerpAvail(endP)) continue;
    validKs.push(k);
  }

  return { validKs, negEdges, posEdges, negCells, posCells, dNeg, dPos, p0, p1, kMin };
}

/** Exact solution check: every Mid-loop dot sits at the exact midpoint of its straight loop segment. */
export function isMidloopSatisfied(P, edges) {
  if (!P.hasMidloop) return true;
  const { ed, nb, midloop } = P;
  for (let k = 0; k < midloop.length; k++) {
    const m = midloop[k];
    let axis = m.axis;
    if (m.dir === 'C') {
      const i4 = m.cell * 4;
      const u = ed[i4], r = ed[i4 + 1], dn = ed[i4 + 2], l = ed[i4 + 3];
      const vert = u >= 0 && dn >= 0 && edges[u] === E_ON && edges[dn] === E_ON;
      const horiz = r >= 0 && l >= 0 && edges[r] === E_ON && edges[l] === E_ON;
      if (vert === horiz) return false; // neither straight, or crossing
      axis = vert ? 0 : 1;
    } else {
      if (edges[m.edge] !== E_ON) return false;
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
    if (lenN !== lenP) return false;
    if (m.dir === 'C' && lenN < 1) return false;
  }
  return true;
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
  const ok = isMidloopSatisfied(P, e);
  e[closingEdge] = prev;
  if (ok) return -1;
  // Find first dot that fails (for diagnostic/hint info)
  const { ed, nb, midloop } = P;
  e[closingEdge] = E_ON;
  let bad = 0;
  for (let k = 0; k < midloop.length; k++) {
    const m = midloop[k];
    let axis = m.axis;
    let good = true;
    if (m.dir === 'C') {
      const i4 = m.cell * 4;
      const u = ed[i4], r = ed[i4 + 1], dn = ed[i4 + 2], l = ed[i4 + 3];
      const vert = u >= 0 && dn >= 0 && e[u] === E_ON && e[dn] === E_ON;
      const horiz = r >= 0 && l >= 0 && e[r] === E_ON && e[l] === E_ON;
      if (vert === horiz) good = false;
      else axis = vert ? 0 : 1;
    } else if (e[m.edge] !== E_ON) {
      good = false;
    }
    if (good) {
      const dNeg = AXIS_NEG[axis], dPos = AXIS_POS[axis];
      let lenN = 0, cur = m.a;
      while (true) { const x = ed[cur * 4 + dNeg]; if (x < 0 || e[x] !== E_ON) break; lenN++; cur = nb[cur * 4 + dNeg]; }
      let lenP = 0; cur = m.b;
      while (true) { const x = ed[cur * 4 + dPos]; if (x < 0 || e[x] !== E_ON) break; lenP++; cur = nb[cur * 4 + dPos]; }
      if (lenN !== lenP || (m.dir === 'C' && lenN < 1)) good = false;
    }
    if (!good) { bad = k; break; }
  }
  e[closingEdge] = prev;
  return bad;
}

/**
 * Exact propagator step for one Mid-loop dot `k`.
 * Calls `setEdge(x, val)` and `setCell(i, val)` callbacks; returns false on contradiction.
 */
export function propagateMidloopDot(P, st, k, setEdge, setCell) {
  const m = P.midloop[k];
  const { ed } = P;
  let info = null;

  if (m.dir !== 'C') {
    if (!setEdge(m.edge, E_ON)) return false;
    info = analyzeMidloopAxis(P, st, m, m.axis);
    if (info.validKs.length === 0) return false;
  } else {
    if (!setCell(m.cell, LOOP)) return false;
    const vInfo = analyzeMidloopAxis(P, st, m, 0);
    const hInfo = analyzeMidloopAxis(P, st, m, 1);
    const vOk = vInfo.validKs.length > 0;
    const hOk = hInfo.validKs.length > 0;
    if (!vOk && !hOk) return false;
    if (vOk && hOk) return true; // orientation still undecided
    info = vOk ? vInfo : hInfo;
    // Perpendicular edges at center vertex must be OFF
    const p0e = ed[m.cell * 4 + info.p0], p1e = ed[m.cell * 4 + info.p1];
    if (p0e >= 0 && !setEdge(p0e, E_OFF)) return false;
    if (p1e >= 0 && !setEdge(p1e, E_OFF)) return false;
  }

  const { validKs, negEdges, posEdges, negCells, posCells, dNeg, dPos } = info;
  const minK = validKs[0];
  for (let j = 1; j <= minK; j++) {
    if (!setEdge(negEdges[j], E_ON)) return false;
    if (!setEdge(posEdges[j], E_ON)) return false;
  }
  if (validKs.length === 1) {
    const capN = ed[negCells[minK] * 4 + dNeg];
    const capP = ed[posCells[minK] * 4 + dPos];
    if (capN >= 0 && !setEdge(capN, E_OFF)) return false;
    if (capP >= 0 && !setEdge(capP, E_OFF)) return false;
  }
  return true;
}

/** Auto-X bookkeeping for Mid-loop: a vertex dot with 1 drawn segment auto-X's its perpendicular edges. */
export function autoXMidloop(P, w, add) {
  if (!P.hasMidloop) return false;
  const { ed, midloop } = P;
  let changed = false;
  for (let k = 0; k < midloop.length; k++) {
    const m = midloop[k];
    if (m.dir !== 'C') continue;
    const i4 = m.cell * 4;
    const u = ed[i4], r = ed[i4 + 1], dn = ed[i4 + 2], l = ed[i4 + 3];
    const vOn = (u >= 0 && w[u] === 1) || (dn >= 0 && w[dn] === 1);
    const hOn = (r >= 0 && w[r] === 1) || (l >= 0 && w[l] === 1);
    if (vOn && !hOn) {
      if (r >= 0 && w[r] !== 1 && add(r)) changed = true;
      if (l >= 0 && w[l] !== 1 && add(l)) changed = true;
    } else if (hOn && !vOn) {
      if (u >= 0 && w[u] !== 1 && add(u)) changed = true;
      if (dn >= 0 && w[dn] !== 1 && add(dn)) changed = true;
    }
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
      const info = analyzeMidloopAxis(P, fakeSt, m, m.axis);
      return info.validKs.length === 0 ? 'bad' : '';
    }
    const vInfo = analyzeMidloopAxis(P, fakeSt, m, 0);
    const hInfo = analyzeMidloopAxis(P, fakeSt, m, 1);
    return (vInfo.validKs.length === 0 && hInfo.validKs.length === 0) ? 'bad' : '';
  });
}

// ------------------------------------------------------------ Human-style Mid-loop rules

/** Measure contiguous drawn ON length on each side of dot `m` along `axis`. */
function drawnArmLengths(P, st, m, axis) {
  const { ed, nb } = P;
  const e = st.e;
  const dNeg = AXIS_NEG[axis], dPos = AXIS_POS[axis];
  let lenN = 0, cur = m.a;
  while (true) {
    const x = ed[cur * 4 + dNeg];
    if (x < 0 || e[x] !== E_ON) break;
    lenN++;
    cur = nb[cur * 4 + dNeg];
  }
  let lenP = 0;
  cur = m.b;
  while (true) {
    const x = ed[cur * 4 + dPos];
    if (x < 0 || e[x] !== E_ON) break;
    lenP++;
    cur = nb[cur * 4 + dPos];
  }
  return { lenN, lenP, endN: cur, dNeg, dPos };
}

/** Measure immediate straight stop distance (first OFF/border/perp-ON/dot) on one side from `start` along `dir`. */
function sideBlockedAt(P, st, start, dir, axis, checkStartPerp) {
  const { ed, nb, midloopAtCell, midloopAtEdge } = P;
  const e = st.e, cell = st.cell;
  const p0 = AXIS_PERP0[axis], p1 = AXIS_PERP1[axis];
  const hasPerpOn = (u) => {
    const x0 = ed[u * 4 + p0], x1 = ed[u * 4 + p1];
    return (x0 >= 0 && e[x0] === E_ON) || (x1 >= 0 && e[x1] === E_ON);
  };
  let cur = start;
  for (let d = 0; ; d++) {
    if ((d > 0 || checkStartPerp) && hasPerpOn(cur)) return { dist: d, edge: ed[cur * 4 + dir], cell: cur };
    const x = ed[cur * 4 + dir];
    if (x < 0 || e[x] === E_OFF) return { dist: d, edge: x, cell: cur };
    if (midloopAtEdge && midloopAtEdge[x] >= 0) return { dist: d, edge: x, cell: cur, hitDot: true };
    const nxt = nb[cur * 4 + dir];
    if (cell && cell[nxt] === OFF) return { dist: d, edge: x, cell: cur };
    if (midloopAtCell && midloopAtCell[nxt] >= 0) return { dist: d, edge: x, cell: cur, hitDot: true };
    cur = nxt;
  }
}

/** Rule 1 (Beginner, weight 1): an edge Mid-loop dot immediately forces its edge ON. */
function findMidEdgeDot(P, st) {
  if (!P.hasMidloop) return [];
  const out = [];
  for (let k = 0; k < P.midloop.length; k++) {
    const m = P.midloop[k];
    if (m.dir === 'C') continue;
    if (st.e[m.edge] === E_UNKNOWN) {
      const sets = [['e', m.edge, E_ON]];
      if (st.cell[m.a] !== LOOP) sets.push(['c', m.a, LOOP]);
      if (st.cell[m.b] !== LOOP) sets.push(['c', m.b, LOOP]);
      out.push({ sets, info: { midIdx: k, cell: m.a, cell2: m.b, edge: m.edge } });
    }
  }
  return out;
}

/**
 * Rule 2 (Beginner, weight 3): a vertex Mid-loop dot whose one axis is locally blocked
 * (border/void/X/perp ON/adjacent dot) must pass straight through along the other axis.
 */
function findMidVertexAxis(P, st) {
  if (!P.hasMidloop) return [];
  const { ed, nb, midloopAtCell, midloopAtEdge } = P;
  const e = st.e, cell = st.cell;
  const out = [];
  const localAxisOk = (i, axis) => {
    const d0 = AXIS_NEG[axis], d1 = AXIS_POS[axis];
    const p0 = AXIS_PERP0[axis], p1 = AXIS_PERP1[axis];
    const xp0 = ed[i * 4 + p0], xp1 = ed[i * 4 + p1];
    if ((xp0 >= 0 && e[xp0] === E_ON) || (xp1 >= 0 && e[xp1] === E_ON)) return false;
    for (const d of [d0, d1]) {
      const x = ed[i * 4 + d];
      if (x < 0 || e[x] === E_OFF) return false;
      if (midloopAtEdge && midloopAtEdge[x] >= 0) return false;
      const j = nb[i * 4 + d];
      if (cell[j] === OFF) return false;
      if (midloopAtCell && midloopAtCell[j] >= 0) return false;
    }
    return true;
  };
  for (let k = 0; k < P.midloop.length; k++) {
    const m = P.midloop[k];
    if (m.dir !== 'C') continue;
    const i = m.cell;
    const vOk = localAxisOk(i, 0);
    const hOk = localAxisOk(i, 1);
    if (vOk === hOk) continue;
    const axis = vOk ? 0 : 1;
    const sets = [];
    const e0 = ed[i * 4 + AXIS_NEG[axis]], e1 = ed[i * 4 + AXIS_POS[axis]];
    const p0 = ed[i * 4 + AXIS_PERP0[axis]], p1 = ed[i * 4 + AXIS_PERP1[axis]];
    if (e[e0] === E_UNKNOWN) sets.push(['e', e0, E_ON]);
    if (e[e1] === E_UNKNOWN) sets.push(['e', e1, E_ON]);
    if (p0 >= 0 && e[p0] === E_UNKNOWN) sets.push(['e', p0, E_OFF]);
    if (p1 >= 0 && e[p1] === E_UNKNOWN) sets.push(['e', p1, E_OFF]);
    if (sets.length) out.push({ sets, info: { midIdx: k, cell: i, axis } });
  }
  return out;
}

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

/**
 * Rule 3 (Beginner, weight 4): symmetric arm extension — if a dot's straight run already extends
 * further on one side (`lenN > lenP` or `lenP > lenN`), extend the shorter side to match!
 */
function findMidSymExtend(P, st) {
  if (!P.hasMidloop) return [];
  const { ed, nb } = P;
  const e = st.e;
  const out = [];
  for (let k = 0; k < P.midloop.length; k++) {
    const m = P.midloop[k];
    const axis = knownAxisOf(P, st, m);
    if (axis < 0) continue;
    const { lenN, lenP, dNeg, dPos } = drawnArmLengths(P, st, m, axis);
    const target = Math.max(lenN, lenP, m.dir === 'C' ? 1 : 0);
    const sets = [];
    const traceSide = (start, dir, want) => {
      let cur = start;
      for (let step = 1; step <= want; step++) {
        const x = ed[cur * 4 + dir];
        if (x < 0 || e[x] === E_OFF) return false;
        if (e[x] === E_UNKNOWN) sets.push(['e', x, E_ON]);
        cur = nb[cur * 4 + dir];
      }
      return true;
    };
    if (!traceSide(m.a, dNeg, target) || !traceSide(m.b, dPos, target)) continue;
    if (sets.length) out.push({ sets, info: { midIdx: k, cell: m.a, cell2: m.b, axis, target } });
  }
  return out;
}

/**
 * Rule 4 (Beginner, weight 5): symmetric turn cap — if one side of a dot's straight run is blocked
 * (border, void, X, perpendicular turn, or another dot) at distance `cap`, and the run already reaches
 * `cap` (including `cap === 0` for an edge dot), the opposite side must also turn at distance `cap`!
 */
function findMidSymCap(P, st) {
  if (!P.hasMidloop) return [];
  const { ed, nb } = P;
  const e = st.e;
  const out = [];
  for (let k = 0; k < P.midloop.length; k++) {
    const m = P.midloop[k];
    const axis = knownAxisOf(P, st, m);
    if (axis < 0) continue;
    const { lenN, lenP, dNeg, dPos } = drawnArmLengths(P, st, m, axis);
    const blkN = sideBlockedAt(P, st, m.a, dNeg, axis, m.dir !== 'C');
    const blkP = sideBlockedAt(P, st, m.b, dPos, axis, m.dir !== 'C');
    const maxSym = Math.min(blkN.dist, blkP.dist);
    const minDrawn = Math.min(lenN, lenP);
    if (minDrawn < maxSym || maxSym < (m.dir === 'C' ? 1 : 0)) continue;
    // Walk exactly maxSym steps on each side and cross out the (maxSym + 1)-th edge if unknown
    const sets = [];
    let curN = m.a, curP = m.b;
    for (let s = 0; s < maxSym; s++) { curN = nb[curN * 4 + dNeg]; curP = nb[curP * 4 + dPos]; }
    const capN = ed[curN * 4 + dNeg];
    const capP = ed[curP * 4 + dPos];
    if (capN >= 0 && e[capN] === E_UNKNOWN) sets.push(['e', capN, E_OFF]);
    if (capP >= 0 && e[capP] === E_UNKNOWN) sets.push(['e', capP, E_OFF]);
    if (sets.length) out.push({ sets, info: { midIdx: k, cell: m.a, cell2: m.b, axis, cap: maxSym, endN: curN, endP: curP } });
  }
  return out;
}

/**
 * Rule 5 (Medium, weight 11): Mid-loop exact-length / gap deduction — along a known axis, when
 * checking all valid symmetric half-lengths (accounting for non-blocking turn endpoints and
 * ON segments ahead that prevent stopping at distance k) forces a larger minimum extension or
 * narrows the run to a single unique half-length.
 */
function findMidLengthForce(P, st) {
  if (!P.hasMidloop) return [];
  const { ed } = P;
  const e = st.e;
  const out = [];
  for (let k = 0; k < P.midloop.length; k++) {
    const m = P.midloop[k];
    const axis = knownAxisOf(P, st, m);
    if (axis < 0) continue;
    const info = analyzeMidloopAxis(P, st, m, axis);
    if (info.validKs.length === 0) continue;
    const minK = info.validKs[0];
    const sets = [];
    for (let j = 1; j <= minK; j++) {
      if (e[info.negEdges[j]] === E_UNKNOWN) sets.push(['e', info.negEdges[j], E_ON]);
      if (e[info.posEdges[j]] === E_UNKNOWN) sets.push(['e', info.posEdges[j], E_ON]);
    }
    if (info.validKs.length === 1) {
      const capN = ed[info.negCells[minK] * 4 + info.dNeg];
      const capP = ed[info.posCells[minK] * 4 + info.dPos];
      if (capN >= 0 && e[capN] === E_UNKNOWN) sets.push(['e', capN, E_OFF]);
      if (capP >= 0 && e[capP] === E_UNKNOWN) sets.push(['e', capP, E_OFF]);
    }
    if (sets.length) {
      out.push({ sets, info: { midIdx: k, cell: m.a, cell2: m.b, axis, minK, exact: info.validKs.length === 1 } });
    }
  }
  return out;
}

/**
 * Rule 6 (Medium, weight 12): Mid-loop vertex axis elimination — an unoriented vertex dot whose
 * one axis has zero feasible symmetric half-lengths (e.g., every matching distance hits a blocked
 * turn endpoint or an ON continuation on one side) must pass straight through along the other axis.
 */
function findMidVertexParity(P, st) {
  if (!P.hasMidloop) return [];
  const { ed } = P;
  const e = st.e;
  const out = [];
  for (let k = 0; k < P.midloop.length; k++) {
    const m = P.midloop[k];
    if (m.dir !== 'C') continue;
    if (knownAxisOf(P, st, m) >= 0) continue;
    const vInfo = analyzeMidloopAxis(P, st, m, 0);
    const hInfo = analyzeMidloopAxis(P, st, m, 1);
    const vOk = vInfo.validKs.length > 0;
    const hOk = hInfo.validKs.length > 0;
    if (vOk === hOk) continue;
    const axis = vOk ? 0 : 1;
    const info = vOk ? vInfo : hInfo;
    const i = m.cell;
    const sets = [];
    const p0 = ed[i * 4 + info.p0], p1 = ed[i * 4 + info.p1];
    if (p0 >= 0 && e[p0] === E_UNKNOWN) sets.push(['e', p0, E_OFF]);
    if (p1 >= 0 && e[p1] === E_UNKNOWN) sets.push(['e', p1, E_OFF]);
    const minK = info.validKs[0];
    for (let j = 1; j <= minK; j++) {
      if (e[info.negEdges[j]] === E_UNKNOWN) sets.push(['e', info.negEdges[j], E_ON]);
      if (e[info.posEdges[j]] === E_UNKNOWN) sets.push(['e', info.posEdges[j], E_ON]);
    }
    if (sets.length) out.push({ sets, info: { midIdx: k, cell: i, axis } });
  }
  return out;
}

/** Lookahead easy-step helper for `js/imagine.js` (fast Beginner Mid-loop deductions). */
export function findEasyMidloopStep(P, st) {
  if (!P.hasMidloop) return null;
  for (const [id, fn] of [
    ['midEdgeDot', findMidEdgeDot],
    ['midVertexAxis', findMidVertexAxis],
    ['midSymExtend', findMidSymExtend],
    ['midSymCap', findMidSymCap],
  ]) {
    const hits = fn(P, st);
    if (hits.length) return { rule: id, sets: hits[0].sets, info: hits[0].info };
  }
  return null;
}

/** Immediate Mid-loop contradiction check for `js/imagine.js`. Returns `{ kind: 'midloop', midIdx, cell }` or null. */
export function midloopContradiction(P, st) {
  if (!P.hasMidloop) return null;
  for (let k = 0; k < P.midloop.length; k++) {
    const m = P.midloop[k];
    if (m.dir !== 'C') {
      if (st.e[m.edge] === E_OFF || analyzeMidloopAxis(P, st, m, m.axis).validKs.length === 0) {
        return { kind: 'midloop', midIdx: k, cell: m.a, cell2: m.b };
      }
    } else {
      if (analyzeMidloopAxis(P, st, m, 0).validKs.length === 0
        && analyzeMidloopAxis(P, st, m, 1).validKs.length === 0) {
        return { kind: 'midloop', midIdx: k, cell: m.cell };
      }
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
function midDotLoc(P, m, { cellName, edgeName }) {
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
      return {
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
