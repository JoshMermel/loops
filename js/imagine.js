// "Imagine a segment on or off": unified short-to-medium lookahead rule for Masyu rating and Hint.
//
// A hypothesis (e[x] = E_ON or e[x] = E_OFF on an undecided frontier edge) is followed with the easy
// Beginner rules + bookkeeping until something breaks (easy contradiction, or within AREA_STEPS steps
// a topological/parity contradiction). The derivation is then pruned by ablation to keep ONLY the steps
// the contradiction really depends on, and priced by the pruned chain length.
import {
  NONE, WHITE, BLACK, UNKNOWN, OFF, LOOP, E_UNKNOWN, E_ON, E_OFF,
  cloneState, propagate, lastPropChanges,
} from './logic.js';

export const MEDIUM_MAX = 28; // imagineLocal (22..26) sits in Medium above faceShade (18)
export const HARD_MAX = 75;   // imagineTrace (36..60) sits in Hard; imagineChain (>= 80) sits in Expert
export const AREA_MIN_COST = 98; // minimum possible cost for an area contradiction (1+ step: 80 + 4 + 14)

/** Sound lower bound on classifyImagine() cost given kept step count, area flag, and frontier flag. */
export function minImagineCost(nSteps, area, isFrontier) {
  if (area) return 94 + 4 * nSteps;
  if (!isFrontier) return 84 + 4 * nSteps;
  if (nSteps >= 4) return 80 + 4 * nSteps;
  if (nSteps >= 2) return 36 + 6 * nSteps;
  return 22 + 2 * nSteps;
}

/**
 * Classify a pruned imagined chain by human cognitive load into:
 *   - imagineLocal (Medium, 22..26): 1-step tight local breakage from a circle/open end
 *   - imagineTrace (Hard, 36..60): single connected thread, <= 2 steps (dist <= 4) or 3 steps (dist <= 3), no area
 *   - imagineChain (Expert, >= 80): long (4+ steps), multi-front/branching, non-frontier, or area contradiction
 */
export function classifyImagine(P, baseState, edge, steps, broke, area) {
  const a = P.edgeA[edge], b = P.edgeB[edge];
  const cols = P.cols;
  const dist = (c1, c2) => Math.abs(((c1 / cols) | 0) - ((c2 / cols) | 0)) + Math.abs((c1 % cols) - (c2 % cols));
  const distToEdge = (c) => Math.min(dist(c, a), dist(c, b));

  const isFrontier = baseState.cell[a] === LOOP || baseState.cell[b] === LOOP;
  const nSteps = steps.length;
  const earlyClose = !!(broke && (broke.kind === 'earlyClose' || broke.kind === 'twoLoops'));

  let usesEarlyCloseRule = false;
  let maxDist = 0;
  let disjointJumps = 0;
  let tipSwitches = 0;
  const cluster = new Set([a, b]);
  let prevCells = new Set([a, b]);

  for (let i = 0; i < nSteps; i++) {
    const s = steps[i];
    if (s.rule === 'noEarlyClose') usesEarlyCloseRule = true;
    const curCells = new Set();
    if (s.info && s.info.cell !== undefined && s.info.cell >= 0) curCells.add(s.info.cell);
    for (let k = 0; k < s.sets.length; k++) {
      const [kind, idx] = s.sets[k];
      if (kind === 'c') curCells.add(idx);
      else { curCells.add(P.edgeA[idx]); curCells.add(P.edgeB[idx]); }
    }
    let touchesCluster = false;
    let touchesPrev = false;
    for (const c of curCells) {
      const d = distToEdge(c);
      if (d > maxDist) maxDist = d;
      if (!touchesCluster) for (const p of cluster) if (dist(c, p) <= 1) { touchesCluster = true; break; }
      if (!touchesPrev) for (const p of prevCells) if (dist(c, p) <= 1) { touchesPrev = true; break; }
    }
    if (curCells.size > 0) {
      if (!touchesCluster) disjointJumps++;
      if (!touchesPrev) tipSwitches++;
      for (const c of curCells) cluster.add(c);
      prevCells = curCells;
    }
  }

  // Only measure breakage cell for local breakages (earlyClose.cell is an unrelated loop cell outside the cycle)
  if (broke && !earlyClose && broke.cell !== undefined && broke.cell >= 0) {
    const d = distToEdge(broke.cell);
    if (d > maxDist) maxDist = d;
    let touchesCluster = false;
    for (const p of cluster) if (dist(broke.cell, p) <= 1) { touchesCluster = true; break; }
    if (!touchesCluster) disjointJumps++;
  }

  const contiguous = disjointJumps === 0 && !usesEarlyCloseRule;
  const pureThread = contiguous && tipSwitches === 0;

  if (!area && !earlyClose && isFrontier && contiguous && nSteps <= 1 && maxDist <= 2) {
    const cost = 22 + 2 * nSteps + maxDist;
    return { rule: 'imagineLocal', tier: 'Medium', cost, maxDist, pureThread, isFrontier };
  }
  if (!area && isFrontier && pureThread && ((nSteps <= 2 && maxDist <= 4) || (nSteps === 3 && maxDist <= 3))) {
    const cost = 36 + 6 * nSteps + 2 * maxDist;
    return { rule: 'imagineTrace', tier: 'Hard', cost, maxDist, pureThread, isFrontier };
  }
  const cost = 80 + 4 * nSteps + (area ? 14 : 0) + (pureThread ? 0 : 6) + (isFrontier ? 0 : 4);
  return { rule: 'imagineChain', tier: 'Expert', cost, maxDist, pureThread, isFrontier };
}

const MAX_CAND = 10;
const MAX_STEPS = 24;
const AREA_STEPS = 10;

let fullContradiction = () => false;
export const setFullContradiction = (fn) => { fullContradiction = fn; };

const onCount = (P, st, i) => {
  const ed = P.ed, e = st.e, i4 = i * 4;
  let n = 0;
  let x = ed[i4]; if (x >= 0 && e[x] === E_ON) n++;
  x = ed[i4 + 1]; if (x >= 0 && e[x] === E_ON) n++;
  x = ed[i4 + 2]; if (x >= 0 && e[x] === E_ON) n++;
  x = ed[i4 + 3]; if (x >= 0 && e[x] === E_ON) n++;
  return n;
};

const availCount = (P, st, i) => {
  const ed = P.ed, nb = P.nb, e = st.e, cell = st.cell, i4 = i * 4;
  let n = 0;
  for (let d = 0; d < 4; d++) {
    const x = ed[i4 + d];
    if (x < 0) continue;
    const ev = e[x];
    if (ev === E_OFF) continue;
    const j = nb[i4 + d];
    if (cell[j] === OFF) continue;
    if (ev !== E_ON) {
      const j4 = j * 4;
      let jon = 0;
      let y = ed[j4]; if (y >= 0 && e[y] === E_ON) jon++;
      y = ed[j4 + 1]; if (y >= 0 && e[y] === E_ON) jon++;
      y = ed[j4 + 2]; if (y >= 0 && e[y] === E_ON) jon++;
      y = ed[j4 + 3]; if (y >= 0 && e[y] === E_ON) jon++;
      if (jon >= 2) continue;
    }
    n++;
  }
  return n;
};

let scratchOnc = new Int8Array(0);
let scratchChangedMask = new Uint8Array(0);

const insertSortNum = (arr) => {
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i];
    let j = i - 1;
    while (j >= 0 && arr[j] > v) { arr[j + 1] = arr[j]; j--; }
    arr[j + 1] = v;
  }
};

const applySets = (st, sets) => {
  for (const [kind, idx, v] of sets) {
    const arr = kind === 'c' ? st.cell : st.e;
    if (arr[idx] === v) continue;
    if (arr[idx] !== 0) return false;
    arr[idx] = v;
  }
  return true;
};

let scratchParent = new Int16Array(0);
let scratchSize = new Int32Array(0);
let bkQueue = new Int32Array(0);
let bkInQ = new Uint8Array(0);
let propCellBuf = new Int8Array(0);
let propEdgeBuf = new Int8Array(0);
let dirtyFlag = new Uint8Array(0);

/**
 * Easy contradiction check (local rule violations + early closed loop).
 * Optional `scope` restricts local checks to `scope.cells / whites / blacks` (dirty cone from hypothesis)
 * and skips the O(N + E) cycle union-find when `scope.checkCycle === false`.
 * Returns null if OK, or { kind, cell?, edge?, cells? } describing what broke.
 */
export function easyContradiction(P, st, scope = null) {
  const { N, numEdges, ed, ed2, nb, edgeA, edgeB, clue } = P;
  const { cell, e } = st;
  const whites = scope ? scope.whites : P.whites;
  const blacks = scope ? scope.blacks : P.blacks;

  // 1. Cell degree / OFF consistency
  if (scope) {
    const sc = scope.cells;
    for (let k = 0; k < sc.length; k++) {
      const i = sc[k];
      const s = cell[i];
      if (s === OFF) {
        if (clue[i] !== NONE) return { kind: 'clueOff', cell: i };
        for (let d = 0; d < 4; d++) {
          const x = ed[i * 4 + d];
          if (x >= 0 && e[x] === E_ON) return { kind: 'offLine', cell: i, edge: x };
        }
        continue;
      }
      const on = onCount(P, st, i);
      if (on > 2) return { kind: 'threeLines', cell: i };
      if (s === LOOP || on > 0) {
        const av = availCount(P, st, i);
        if (av < 2) return { kind: 'stranded', cell: i, ways: av };
      }
    }
  } else {
    if (scratchOnc.length < N) scratchOnc = new Int8Array(N);
    const onc = scratchOnc;
    onc.fill(0, 0, N);
    for (let x = 0; x < numEdges; x++) if (e[x] === E_ON) { onc[edgeA[x]]++; onc[edgeB[x]]++; }
    for (let i = 0; i < N; i++) {
      const s = cell[i];
      const on = onc[i];
      if (s === OFF) {
        if (clue[i] !== NONE) return { kind: 'clueOff', cell: i };
        if (on > 0) {
          for (let d = 0; d < 4; d++) {
            const x = ed[i * 4 + d];
            if (x >= 0 && e[x] === E_ON) return { kind: 'offLine', cell: i, edge: x };
          }
        }
        continue;
      }
      if (on > 2) return { kind: 'threeLines', cell: i };
      if (s === LOOP || on > 0) {
        const i4 = i * 4;
        let av = 0;
        for (let d = 0; d < 4; d++) {
          const x = ed[i4 + d];
          if (x < 0) continue;
          const ev = e[x];
          if (ev === E_OFF) continue;
          const j = nb[i4 + d];
          if (cell[j] === OFF) continue;
          if (ev !== E_ON && onc[j] >= 2) continue;
          av++;
        }
        if (av < 2) return { kind: 'stranded', cell: i, ways: av };
      }
    }
  }

  // 2. White circles
  for (let wi = 0; wi < whites.length; wi++) {
    const i = whites[wi];
    const u = ed[i * 4 + 0], r = ed[i * 4 + 1], dn = ed[i * 4 + 2], l = ed[i * 4 + 3];
    const u2 = ed2[i * 4 + 0], r2 = ed2[i * 4 + 1], d2 = ed2[i * 4 + 2], l2 = ed2[i * 4 + 3];
    let vOk = u >= 0 && dn >= 0 && e[u] !== E_OFF && e[dn] !== E_OFF;
    let hOk = r >= 0 && l >= 0 && e[r] !== E_OFF && e[l] !== E_OFF;
    if ((r >= 0 && e[r] === E_ON) || (l >= 0 && e[l] === E_ON)) vOk = false;
    if ((u >= 0 && e[u] === E_ON) || (dn >= 0 && e[dn] === E_ON)) hOk = false;
    if (vOk && u2 >= 0 && e[u2] === E_ON && d2 >= 0 && e[d2] === E_ON) vOk = false;
    if (hOk && r2 >= 0 && e[r2] === E_ON && l2 >= 0 && e[l2] === E_ON) hOk = false;
    if (!vOk && !hOk) return { kind: 'whiteBroken', cell: i };
  }

  // 3. Black circles
  for (let bi = 0; bi < blacks.length; bi++) {
    const i = blacks[bi];
    const can = [false, false, false, false];
    for (let d = 0; d < 4; d++) {
      const x1 = ed[i * 4 + d], x2 = ed2[i * 4 + d], n1 = nb[i * 4 + d];
      let ok = x1 >= 0 && x2 >= 0 && e[x1] !== E_OFF && e[x2] !== E_OFF && cell[n1] !== OFF && cell[P.step2[i * 4 + d]] !== OFF;
      if (ok && clue[n1] === BLACK) ok = false;
      if (ok) {
        const p1 = ed[n1 * 4 + ((d + 1) & 3)], p2 = ed[n1 * 4 + ((d + 3) & 3)];
        if ((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON)) ok = false;
      }
      can[d] = ok;
    }
    const eu = ed[i * 4 + 0], er = ed[i * 4 + 1], edown = ed[i * 4 + 2], el = ed[i * 4 + 3];
    if ((!can[0] && !can[2]) || (!can[1] && !can[3])) return { kind: 'blackBroken', cell: i };
    if (eu >= 0 && edown >= 0 && e[eu] === E_ON && e[edown] === E_ON) return { kind: 'blackStraight', cell: i };
    if (er >= 0 && el >= 0 && e[er] === E_ON && e[el] === E_ON) return { kind: 'blackStraight', cell: i };
    for (let d = 0; d < 4; d++) {
      const x1 = ed[i * 4 + d];
      if (x1 >= 0 && e[x1] === E_ON && !can[d]) return { kind: 'blackBroken', cell: i };
    }
  }

  // 4. Early closed loop (or 2 cycles) — skip when no E_ON edge was added in the hypothesis
  if (scope && !scope.checkCycle) return null;
  if (scratchParent.length < N) { scratchParent = new Int16Array(N); scratchSize = new Int32Array(N); }
  const parent = scratchParent;
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  let cyc = -1, cycCount = 0;
  for (let x = 0; x < numEdges; x++) {
    if (e[x] !== E_ON) continue;
    const ra = find(edgeA[x]), rb = find(edgeB[x]);
    if (ra === rb) { cyc = ra; cycCount++; } else parent[ra] = rb;
  }
  if (cycCount > 1) return { kind: 'twoLoops' };
  if (cyc >= 0) {
    cyc = find(cyc);
    for (let i = 0; i < N; i++) {
      if (cell[i] === LOOP && find(i) !== cyc) return { kind: 'earlyClose', cell: i };
    }
  }
  return null;
}

/**
 * Local queue-based silent bookkeeping (OFF cell -> edges off, ON edge -> cells LOOP, full cell -> other edges off).
 * Touches only cells affected by `seedCells` (or all cells if null), making it O(affected) instead of O(N + E).
 */
function runBookkeeping(P, st, seedCells = null, onTouch = null) {
  const { N, ed, nb } = P;
  const { cell, e } = st;
  if (bkQueue.length < N) {
    bkQueue = new Int32Array(N);
    bkInQ = new Uint8Array(N);
  }
  let head = 0, tail = 0;
  const push = (i) => {
    if (i >= 0 && !bkInQ[i]) { bkInQ[i] = 1; bkQueue[tail++] = i; }
  };

  if (seedCells) {
    for (let k = 0; k < seedCells.length; k++) push(seedCells[k]);
  } else {
    for (let i = 0; i < N; i++) push(i);
  }

  let ok = true;
  while (head < tail) {
    const i = bkQueue[head++];
    bkInQ[i] = 0;
    if (!ok) continue;
    const base = i * 4;
    if (cell[i] === OFF) {
      for (let d = 0; d < 4; d++) {
        const x = ed[base + d];
        if (x < 0) continue;
        if (e[x] === E_ON) { ok = false; break; }
        if (e[x] === E_UNKNOWN) {
          e[x] = E_OFF;
          const j = nb[base + d];
          if (onTouch) onTouch(j, false);
          push(j);
        }
      }
      continue;
    }
    let on = 0, unk = 0;
    for (let d = 0; d < 4; d++) {
      const x = ed[base + d];
      if (x < 0) continue;
      if (e[x] === E_ON) {
        on++;
        const j = nb[base + d];
        if (cell[j] === OFF) { ok = false; break; }
        if (cell[j] === UNKNOWN) { cell[j] = LOOP; if (onTouch) onTouch(j, true); push(j); }
      } else if (e[x] === E_UNKNOWN) {
        unk++;
      }
    }
    if (!ok) continue;
    if (on > 0 && cell[i] === UNKNOWN) { cell[i] = LOOP; if (onTouch) onTouch(i, true); }
    if (on > 2) { ok = false; continue; }
    if (on === 2 && unk > 0) {
      for (let d = 0; d < 4; d++) {
        const x = ed[base + d];
        if (x >= 0 && e[x] === E_UNKNOWN) {
          e[x] = E_OFF;
          const j = nb[base + d];
          if (onTouch) onTouch(j, false);
          push(j);
        }
      }
    }
  }
  // Ensure bkInQ is clean if we broke early
  while (head < tail) bkInQ[bkQueue[head++]] = 0;
  return ok;
}

/**
 * Find one easy Beginner deduction in `st`, skipping any step whose signature is in `forbid`.
 * When `scope` is provided (dirty cone from hypothesis), only checks cells/circles touched by the
 * hypothesis (sorted in exact board order for bit-for-bit identical rule selection).
 */
function findEasyStep(P, st, forbid, scope = null) {
  const { N, numEdges, ed, ed2, nb, step2, edgeA, edgeB, clue } = P;
  const { cell, e } = st;
  const whites = scope ? scope.whites : P.whites;
  const blacks = scope ? scope.blacks : P.blacks;

  const tryEmit = (rule, sets, info = {}) => {
    const fresh = sets.filter(([k, idx, v]) => (k === 'c' ? cell[idx] : e[idx]) === 0);
    if (!fresh.length) return null;
    const sig = `${rule}:${fresh.map(([k, idx, v]) => `${k}${idx}=${v}`).sort().join(',')}`;
    if (forbid && forbid.has(sig)) return null;
    return { rule, sets: fresh, sig, info };
  };

  // 1. whiteStraight
  for (let wi = 0; wi < whites.length; wi++) {
    const i = whites[wi];
    const u = ed[i * 4 + 0], r = ed[i * 4 + 1], dn = ed[i * 4 + 2], l = ed[i * 4 + 3];
    let vOk = u >= 0 && dn >= 0 && e[u] !== E_OFF && e[dn] !== E_OFF;
    let hOk = r >= 0 && l >= 0 && e[r] !== E_OFF && e[l] !== E_OFF;
    if ((r >= 0 && e[r] === E_ON) || (l >= 0 && e[l] === E_ON)) vOk = false;
    if ((u >= 0 && e[u] === E_ON) || (dn >= 0 && e[dn] === E_ON)) hOk = false;
    if (vOk && !hOk) {
      const sets = [['e', u, E_ON], ['e', dn, E_ON]];
      if (r >= 0) sets.push(['e', r, E_OFF]);
      if (l >= 0) sets.push(['e', l, E_OFF]);
      const step = tryEmit('whiteStraight', sets, { cell: i, axis: 'v' });
      if (step) return step;
    } else if (hOk && !vOk) {
      const sets = [['e', r, E_ON], ['e', l, E_ON]];
      if (u >= 0) sets.push(['e', u, E_OFF]);
      if (dn >= 0) sets.push(['e', dn, E_OFF]);
      const step = tryEmit('whiteStraight', sets, { cell: i, axis: 'h' });
      if (step) return step;
    }
  }

  // 2. blackExtend
  for (let bi = 0; bi < blacks.length; bi++) {
    const i = blacks[bi];
    for (let d = 0; d < 4; d++) {
      const x1 = ed[i * 4 + d];
      if (x1 < 0 || e[x1] !== E_ON) continue;
      const x2 = ed2[i * 4 + d], opp = ed[i * 4 + (d ^ 2)];
      const sets = [];
      if (x2 >= 0) sets.push(['e', x2, E_ON]);
      if (opp >= 0) sets.push(['e', opp, E_OFF]);
      const step = tryEmit('blackExtend', sets, { cell: i, dir: d });
      if (step) return step;
    }
  }

  // 3. blackWall / blackAdjacent / blackPerp
  for (let bi = 0; bi < blacks.length; bi++) {
    const i = blacks[bi];
    for (let d = 0; d < 4; d++) {
      const x1 = ed[i * 4 + d], x2 = ed2[i * 4 + d], n1 = nb[i * 4 + d], n2 = step2[i * 4 + d];
      const opp1 = ed[i * 4 + (d ^ 2)], opp2 = ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      let reason = null;
      if (x1 < 0 || x2 < 0 || e[x1] === E_OFF || e[x2] === E_OFF || cell[n1] === OFF || cell[n2] === OFF) reason = 'blackWall';
      else if (clue[n1] === BLACK) reason = 'blackAdjacent';
      else {
        const p1 = ed[n1 * 4 + ((d + 1) & 3)], p2 = ed[n1 * 4 + ((d + 3) & 3)];
        if ((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON)) reason = 'blackPerp';
      }
      if (!reason) continue;
      const sets = [['e', opp1, E_ON], ['e', opp2, E_ON]];
      if (x1 >= 0) sets.push(['e', x1, E_OFF]);
      const step = tryEmit(reason, sets, { cell: i, dir: d ^ 2, blockedDir: d, sideCell: n1, other: n1 });
      if (step) return step;
    }
  }

  // 4. whiteMustTurn
  for (let wi = 0; wi < whites.length; wi++) {
    const i = whites[wi];
    for (const [d1, d2] of [[0, 2], [1, 3]]) {
      const e1 = ed[i * 4 + d1], e2 = ed[i * 4 + d2];
      if (e1 < 0 || e2 < 0 || e[e1] !== E_ON || e[e2] !== E_ON) continue;
      const ext1 = ed2[i * 4 + d1], ext2 = ed2[i * 4 + d2];
      if (ext1 >= 0 && e[ext1] === E_ON && ext2 >= 0 && e[ext2] === E_UNKNOWN) {
        const step = tryEmit('whiteMustTurn', [['e', ext2, E_OFF]], { cell: i, straightDir: d1, turnDir: d2 });
        if (step) return step;
      }
      if (ext2 >= 0 && e[ext2] === E_ON && ext1 >= 0 && e[ext1] === E_UNKNOWN) {
        const step = tryEmit('whiteMustTurn', [['e', ext1, E_OFF]], { cell: i, straightDir: d2, turnDir: d1 });
        if (step) return step;
      }
    }
  }

  // 5. deadEnd (unknown cell with < 2 exits -> OFF)
  if (scope) {
    const sc = scope.cells;
    for (let k = 0; k < sc.length; k++) {
      const i = sc[k];
      if (cell[i] !== UNKNOWN) continue;
      if (availCount(P, st, i) < 2) {
        const step = tryEmit('deadEnd', [['c', i, OFF]], { cell: i });
        if (step) return step;
      }
    }
  } else {
    for (let i = 0; i < N; i++) {
      if (cell[i] !== UNKNOWN) continue;
      if (availCount(P, st, i) < 2) {
        const step = tryEmit('deadEnd', [['c', i, OFF]], { cell: i });
        if (step) return step;
      }
    }
  }

  // 6. forcedExits (LOOP cell with on + unk === 2 -> remaining edges ON)
  if (scope) {
    const sc = scope.cells;
    for (let k = 0; k < sc.length; k++) {
      const i = sc[k];
      if (cell[i] !== LOOP) continue;
      let on = 0;
      const open = [];
      for (let d = 0; d < 4; d++) {
        const x = ed[i * 4 + d];
        if (x < 0) continue;
        if (e[x] === E_ON) on++;
        else if (e[x] === E_UNKNOWN && cell[nb[i * 4 + d]] !== OFF) open.push(x);
      }
      if (open.length > 0 && on + open.length === 2) {
        const step = tryEmit('forcedExits', open.map((x) => ['e', x, E_ON]), { cell: i });
        if (step) return step;
      }
    }
  } else {
    for (let i = 0; i < N; i++) {
      if (cell[i] !== LOOP) continue;
      let on = 0;
      const open = [];
      for (let d = 0; d < 4; d++) {
        const x = ed[i * 4 + d];
        if (x < 0) continue;
        if (e[x] === E_ON) on++;
        else if (e[x] === E_UNKNOWN && cell[nb[i * 4 + d]] !== OFF) open.push(x);
      }
      if (open.length > 0 && on + open.length === 2) {
        const step = tryEmit('forcedExits', open.map((x) => ['e', x, E_ON]), { cell: i });
        if (step) return step;
      }
    }
  }

  // 7. whiteBothStraight
  for (let wi = 0; wi < whites.length; wi++) {
    const i = whites[wi];
    const u = ed[i * 4 + 0], r = ed[i * 4 + 1], dn = ed[i * 4 + 2], l = ed[i * 4 + 3];
    const u2 = ed2[i * 4 + 0], r2 = ed2[i * 4 + 1], d2 = ed2[i * 4 + 2], l2 = ed2[i * 4 + 3];
    if (u2 >= 0 && e[u2] === E_ON && d2 >= 0 && e[d2] === E_ON && r >= 0 && l >= 0) {
      const sets = [['e', r, E_ON], ['e', l, E_ON]];
      if (u >= 0) sets.push(['e', u, E_OFF]);
      if (dn >= 0) sets.push(['e', dn, E_OFF]);
      const step = tryEmit('whiteBothStraight', sets, { cell: i, axis: 'h' });
      if (step) return step;
    }
    if (r2 >= 0 && e[r2] === E_ON && l2 >= 0 && e[l2] === E_ON && u >= 0 && dn >= 0) {
      const sets = [['e', u, E_ON], ['e', dn, E_ON]];
      if (r >= 0) sets.push(['e', r, E_OFF]);
      if (l >= 0) sets.push(['e', l, E_OFF]);
      const step = tryEmit('whiteBothStraight', sets, { cell: i, axis: 'v' });
      if (step) return step;
    }
  }

  // 8. noEarlyClose (skip when no E_ON / LOOP cell has been added in this hypothesis)
  if (scope && !scope.hasOn) return null;
  if (scratchParent.length < N) { scratchParent = new Int16Array(N); scratchSize = new Int32Array(N); }
  const parent = scratchParent, size = scratchSize;
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  let loopCount = 0;
  for (let i = 0; i < N; i++) if (cell[i] === LOOP) loopCount++;
  for (let x = 0; x < numEdges; x++) {
    if (e[x] !== E_ON) continue;
    const ra = find(edgeA[x]), rb = find(edgeB[x]);
    if (ra !== rb) parent[ra] = rb;
  }
  size.fill(0, 0, N);
  for (let i = 0; i < N; i++) if (cell[i] === LOOP) size[find(i)]++;
  for (let x = 0; x < numEdges; x++) {
    if (e[x] !== E_UNKNOWN) continue;
    const a = edgeA[x];
    if (a < 0) continue;
    const b = edgeB[x];
    if (cell[a] !== LOOP || cell[b] !== LOOP) continue;
    const ra = find(a);
    if (ra === find(b) && size[ra] < loopCount) {
      const step = tryEmit('noEarlyClose', [['e', x, E_OFF]], { edge: x, a, b });
      if (step) return step;
    }
  }

  return null;
}

/**
 * Follow hypothesis `e[edge] = val` with easy rules up to `maxSteps` steps.
 * Tracks the dirty causal cone of cells within orthogonal radius 2 of touched cells so
 * `findEasyStep` and `easyContradiction` stay O(local cone) instead of O(N) per step.
 */
function runHypothesis(P, baseState, edge, val, { maxSteps = MAX_STEPS, checkArea = false, forbid = null, scoped = true } = {}) {
  const st = cloneState(baseState);
  st.e[edge] = val;

  let scope = null;
  let dirtyAdded = false;
  const markCell = (c) => {
    if (c < 0 || dirtyFlag[c]) return;
    dirtyFlag[c] = 1;
    scope.cells.push(c);
    if (P.clue[c] === WHITE) scope.whites.push(c);
    else if (P.clue[c] === BLACK) scope.blacks.push(c);
    dirtyAdded = true;
  };
  const touchCell = (i, addedOn) => {
    if (addedOn) { scope.hasOn = true; scope.checkCycle = true; }
    markCell(i);
    const b = i * 4;
    for (let d = 0; d < 4; d++) {
      markCell(P.nb[b + d]);
      markCell(P.step2[b + d]);
    }
  };
  const sortScope = () => {
    if (!dirtyAdded) return;
    dirtyAdded = false;
    insertSortNum(scope.cells);
    insertSortNum(scope.whites);
    insertSortNum(scope.blacks);
  };
  const clearDirty = () => {
    if (!scope) return;
    for (let k = 0; k < scope.cells.length; k++) dirtyFlag[scope.cells[k]] = 0;
  };

  if (scoped) {
    if (dirtyFlag.length < P.N) dirtyFlag = new Uint8Array(P.N);
    scope = { cells: [], whites: [], blacks: [], hasOn: val === E_ON, checkCycle: val === E_ON };
    touchCell(P.edgeA[edge], val === E_ON);
    touchCell(P.edgeB[edge], val === E_ON);
  }

  try {
    if (!runBookkeeping(P, st, [P.edgeA[edge], P.edgeB[edge]], scoped ? touchCell : null)) {
      const c = easyContradiction(P, st, null);
      return { broke: c || { kind: 'conflict' }, area: false, steps: [], state: st };
    }
    if (scoped) sortScope();
    const c0 = easyContradiction(P, st, scope);
    if (c0) return { broke: c0, area: false, steps: [], state: st };
    // Direct 0-step area contradictions belong to dedicated rules (chokepoint / parityPocket / chokepointArea / parityForces),
    // never hijacked by imagine or wrapped in spurious extra easy steps.
    if (checkArea && fullContradiction(P, st, true)) return { broke: null, area: false, steps: [], state: st };

    const steps = [];
    const touched = [];
    for (let n = 0; n < maxSteps; n++) {
      if (scoped) sortScope();
      const step = findEasyStep(P, st, forbid, scope);
      if (!step) break;
      if (!applySets(st, step.sets)) return { broke: { kind: 'conflict', step }, area: false, steps, state: st };
      steps.push(step);
      touched.length = 0;
      if (scope) scope.checkCycle = false;
      for (let k = 0; k < step.sets.length; k++) {
        const [kind, idx, v] = step.sets[k];
        if (kind === 'c') {
          touched.push(idx);
          if (scoped) touchCell(idx, v === LOOP);
        } else {
          const a = P.edgeA[idx], b = P.edgeB[idx];
          touched.push(a, b);
          if (scoped) { touchCell(a, v === E_ON); touchCell(b, v === E_ON); }
        }
      }
      if (!runBookkeeping(P, st, touched, scoped ? touchCell : null)) {
        const c = easyContradiction(P, st, null);
        return { broke: c || { kind: 'conflict', step }, area: false, steps, state: st };
      }
      if (scoped) sortScope();
      const c = easyContradiction(P, st, scope);
      if (c) return { broke: c, area: false, steps, state: st };
      if (checkArea && steps.length <= AREA_STEPS && fullContradiction(P, st, true)) {
        return { broke: { kind: 'area' }, area: true, steps, state: st };
      }
    }
    return { broke: null, area: false, steps, state: st };
  } finally {
    clearDirty();
  }
}

/**
 * Prune a successful hypothesis chain by ablation: forbid derived steps from back to front;
 * if the contradiction still occurs without a step, drop it.
 */
function pruneChain(P, baseState, edge, val, rawSteps, area, costCap) {
  const isFrontier = baseState.cell[P.edgeA[edge]] === LOOP || baseState.cell[P.edgeB[edge]] === LOOP;
  if (minImagineCost(0, area, isFrontier) >= costCap) return null;
  const forbid = new Set();
  const kept = [];
  for (let k = rawSteps.length - 1; k >= 0; k--) {
    const sig = rawSteps[k].sig;
    forbid.add(sig);
    const r = runHypothesis(P, baseState, edge, val, {
      maxSteps: rawSteps.length + 2,
      checkArea: area,
      forbid,
    });
    if (!r.broke) {
      // Needed!
      forbid.delete(sig);
      kept.push(rawSteps[k]);
      if (minImagineCost(kept.length, area, isFrontier) >= costCap) return null;
    }
  }
  // Replay once with final `forbid` to get the exact clean chronological trace and final contradiction
  const clean = runHypothesis(P, baseState, edge, val, {
    maxSteps: rawSteps.length + 2,
    checkArea: area,
    forbid,
  });
  if (!clean.broke) return null;
  const cls = classifyImagine(P, baseState, edge, clean.steps, clean.broke, clean.area);
  return {
    steps: clean.steps,
    broke: clean.broke,
    area: clean.area,
    rule: cls.rule,
    tier: cls.tier,
    cost: cls.cost,
    maxDist: cls.maxDist,
    pureThread: cls.pureThread,
    forbid: [...forbid],
    state: clean.state,
  };
}

/** Frontier edges worth hypothesizing on: undecided edges near a LOOP cell or circle. */
function candidateEdges(P, st, frontierOnly = false) {
  const { numEdges, edgeA, edgeB, clue, nb } = P;
  const { cell, e } = st;
  const primary = [];
  if (frontierOnly) {
    for (let x = 0; x < numEdges; x++) {
      if (e[x] !== E_UNKNOWN) continue;
      const a = edgeA[x], b = edgeB[x];
      if (a >= 0 && (cell[a] === LOOP || cell[b] === LOOP)) primary.push(x);
    }
    return primary;
  }
  const near = new Uint8Array(P.N);
  for (let i = 0; i < P.N; i++) {
    if (cell[i] === LOOP || clue[i] !== NONE) {
      near[i] = 1;
      for (let d = 0; d < 4; d++) {
        const j = nb[i * 4 + d];
        if (j >= 0) near[j] = 1;
      }
    }
  }
  const secondary = [];
  for (let x = 0; x < numEdges; x++) {
    if (e[x] !== E_UNKNOWN) continue;
    const a = edgeA[x], b = edgeB[x];
    if (a < 0) continue;
    if (cell[a] === LOOP || cell[b] === LOOP) primary.push(x);
    else if (near[a] && near[b]) secondary.push(x);
  }
  return primary.concat(secondary);
}

/**
 * Search for the cheapest "imagine a segment ON or OFF" contradiction in `st`.
 * Uses `propagate()` as an exact O(1)-allocation superset pre-filter:
 *   - If `propagate(P, st + [x=val])` succeeds, no sequence of easy rules can contradict.
 *   - Because oddOpenEnds and chokepointCheck are monotone, `fullContradiction` on the propagated
 *     fixed point is also an exact pre-filter for area contradictions.
 * Optional `costCap`: skip candidates that cannot beat `costCap` (strictly `< costCap`).
 */
export function bestImagine(P, st, { costCap = Infinity } = {}) {
  const frontierOnly = costCap <= 84;
  const edges = candidateEdges(P, st, frontierOnly);
  if (!edges.length) return null;
  if (propCellBuf.length < P.N) propCellBuf = new Int8Array(P.N);
  if (propEdgeBuf.length < P.numEdges) propEdgeBuf = new Int8Array(P.numEdges);
  const stProp = {
    cell: propCellBuf.subarray(0, P.N),
    e: propEdgeBuf.subarray(0, P.numEdges),
    cycle: false,
  };

  // Check once whether `st` is already a propagate() fixed point (including UNKNOWN->LOOP endpoints)
  // so trial calls can safely use O(local) seedEdge
  stProp.cell.set(st.cell);
  stProp.e.set(st.e);
  stProp.cycle = st.cycle;
  let baseFixed = propagate(P, stProp) && lastPropChanges === 0;
  if (baseFixed) {
    for (let i = 0; i < P.N; i++) {
      if (stProp.cell[i] !== st.cell[i]) { baseFixed = false; break; }
    }
  }

  const needMask = edges.length * 2;
  if (scratchChangedMask.length < needMask) scratchChangedMask = new Uint8Array(needMask);
  const changedMask = scratchChangedMask;

  const easyHits = [];
  const easyHitSet = new Set();

  for (let ei = 0; ei < edges.length; ei++) {
    const x = edges[ei];
    const isFront = st.cell[P.edgeA[x]] === LOOP || st.cell[P.edgeB[x]] === LOOP;
    for (let vi = 0; vi < 2; vi++) {
      const val = vi === 0 ? E_ON : E_OFF;
      stProp.cell.set(st.cell);
      stProp.e.set(st.e);
      stProp.cycle = st.cycle;
      stProp.e[x] = val;
      if (!propagate(P, stProp, baseFixed ? x : -1, -1)) {
        changedMask[ei * 2 + vi] = 1;
        const r = runHypothesis(P, st, x, val, { maxSteps: MAX_STEPS, checkArea: false });
        if (r.broke) {
          easyHits.push({ edge: x, hyp: val, rawSteps: r.steps, area: false, isFront });
          easyHitSet.add((x << 2) | val);
        }
      } else {
        changedMask[ei * 2 + vi] = lastPropChanges > 0 ? 1 : 0;
      }
    }
  }

  // Prune easy hits FIRST (frontier candidates first, then shortest raw chain):
  // if an easy hit already achieves cost <= AREA_MIN_COST, we skip the O(edges) Tarjan/parity area scan!
  easyHits.sort((a, b) => (b.isFront ? 1 : 0) - (a.isFront ? 1 : 0) || a.rawSteps.length - b.rawSteps.length);
  let best = null;
  const evalCandidates = (list) => {
    for (const c of list) {
      const cap = best ? best.cost : costCap;
      const pr = pruneChain(P, st, c.edge, c.hyp, c.rawSteps, c.area, cap);
      if (!pr || pr.cost >= costCap) continue;
      if (!best || pr.cost < best.cost) {
        best = {
          edge: c.edge,
          hyp: c.hyp,
          deduce: c.hyp === E_ON ? E_OFF : E_ON,
          rule: pr.rule,
          tier: pr.tier,
          cost: pr.cost,
          maxDist: pr.maxDist,
          pureThread: pr.pureThread,
          area: pr.area,
          steps: pr.steps,
          broke: pr.broke,
          forbid: pr.forbid,
        };
      }
    }
  };
  evalCandidates(easyHits.slice(0, MAX_CAND));

  // Area contradictions require >= 1 easy step (min cost AREA_MIN_COST = 98); skip whenever effectiveCap <= AREA_MIN_COST
  const effectiveCap = best ? Math.min(costCap, best.cost) : costCap;
  if (easyHits.length < MAX_CAND && effectiveCap > AREA_MIN_COST) {
    const areaHits = [];
    for (let ei = 0; ei < edges.length; ei++) {
      const x = edges[ei];
      for (let vi = 0; vi < 2; vi++) {
        const val = vi === 0 ? E_ON : E_OFF;
        if (easyHitSet.has((x << 2) | val)) continue;
        // If propagate made 0 edge/OFF deductions beyond `x = val`, findEasyStep fires 0 steps -> cannot be an area hit
        if (baseFixed && !changedMask[ei * 2 + vi]) continue;
        stProp.cell.set(st.cell);
        stProp.e.set(st.e);
        stProp.cycle = st.cycle;
        stProp.e[x] = val;
        // skipEasy=true when propagate succeeded (already guaranteed no easy contradiction);
        // if propagate contradicted beyond MAX_STEPS, still check for a shorter <=AREA_STEPS area hit
        if (!propagate(P, stProp, baseFixed ? x : -1, -1) || fullContradiction(P, stProp, true)) {
          const r = runHypothesis(P, st, x, val, { maxSteps: AREA_STEPS, checkArea: true });
          if (r.broke) {
            areaHits.push({ edge: x, hyp: val, rawSteps: r.steps, area: r.area });
          }
        }
      }
    }
    areaHits.sort((a, b) => a.rawSteps.length - b.rawSteps.length);
    evalCandidates(areaHits.slice(0, Math.max(0, MAX_CAND - easyHits.length)));
  }
  return best;
}

/** Replay a pruned imagine step from `baseState` to produce the exact final state and forced edges (for Hint). */
export function replayImagine(P, baseState, info) {
  const forbid = new Set(info.forbid || []);
  return runHypothesis(P, baseState, info.edge, info.hyp, {
    maxSteps: (info.steps ? info.steps.length : MAX_STEPS) + 2,
    checkArea: !!info.area,
    forbid,
  });
}
