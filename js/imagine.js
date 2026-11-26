// "Imagine a segment on or off": unified short-to-medium lookahead rule for Masyu rating and Hint.
//
// A hypothesis (e[x] = E_ON or e[x] = E_OFF on an undecided frontier edge) is followed with the easy
// Beginner rules + bookkeeping until something breaks (easy contradiction, or within AREA_STEPS steps
// a topological/parity contradiction). The derivation is then pruned by ablation to keep ONLY the steps
// the contradiction really depends on, and priced by the pruned chain length.
import {
  NONE, WHITE, BLACK, GRAY, UNKNOWN, OFF, LOOP, E_UNKNOWN, E_ON, E_OFF,
  cloneState, propagate, lastPropChanges,
} from './logic.js';
import {
  isSlitherSatisfied, isSlitherEdge, firstUnsatisfiedSlitherOnClose,
  CORNER_SPEC, isBlockedDir,
} from './variants/slitherlink.js';
import {
  firstUnsatisfiedMidloop, isMidloopEdge, firstUnsatisfiedMidloopOnClose,
  findEasyMidloopStep, findMediumMidloopStep, midloopContradiction,
} from './variants/midloop.js';
import {
  firstUnsatisfiedCastle, firstUnsatisfiedCastleOnClose,
  findEasyCastleStep, findMediumCastleStep, castleContradiction,
} from './variants/castlewall.js';

export const isFrontierEdge = (P, st, x) => (
  st.cell[P.edgeA[x]] === LOOP || st.cell[P.edgeB[x]] === LOOP
  || isSlitherEdge(P, x) || isMidloopEdge(P, x)
  || (P.hasCastle && P._ecwOff[x] < P._ecwOff[x + 1])
);

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
export function classifyImagine(P, baseState, edge, steps, broke, area, grayCell = -1) {
  const a = grayCell >= 0 ? grayCell : P.edgeA[edge];
  const b = grayCell >= 0 ? grayCell : P.edgeB[edge];
  const cols = P.cols;
  const dist = (c1, c2) => Math.abs(((c1 / cols) | 0) - ((c2 / cols) | 0)) + Math.abs((c1 % cols) - (c2 % cols));
  const distToEdge = (c) => Math.min(dist(c, a), dist(c, b));

  const isFrontier = grayCell >= 0 || isFrontierEdge(P, baseState, edge);
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
      if (kind === 'c' || kind === 'g') curCells.add(idx);
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
    if (kind === 'g') {
      if (st.clue[idx] === v) continue;
      if (st.clue[idx] !== GRAY) return false;
      st.clue[idx] = v;
      continue;
    }
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
let propClueBuf = new Uint8Array(0);
let dirtyFlag = new Uint8Array(0);
let dirtyFaceFlag = new Uint8Array(0);
let dirtyMidFlag = new Uint8Array(0);
let dirtyCastleFlag = new Uint8Array(0);

/**
 * Easy contradiction check (local rule violations + early closed loop).
 * Optional `scope` restricts local checks to `scope.cells / whites / blacks` (dirty cone from hypothesis)
 * and skips the O(N + E) cycle union-find when `scope.checkCycle === false`.
 * Returns null if OK, or { kind, cell?, edge?, cells? } describing what broke.
 */
export function easyContradiction(P, st, scope = null) {
  const { N, numEdges, ed, ed2, nb, edgeA, edgeB } = P;
  const clue = st.clue || P.clue;
  const { cell, e } = st;
  const whites = scope ? scope.whites : (st.hasGray ? P.clueCells.filter((i) => clue[i] === WHITE) : P.whites);
  const blacks = scope ? scope.blacks : (st.hasGray ? P.clueCells.filter((i) => clue[i] === BLACK) : P.blacks);
  const grays = !st.hasGray ? null : P.grays.filter((i) => clue[i] === GRAY);

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

  // 3b. Unresolved gray circles: must remain compatible with at least one of white or black
  if (grays) {
    for (let gi = 0; gi < grays.length; gi++) {
      const i = grays[gi];
      const u = ed[i * 4 + 0], r = ed[i * 4 + 1], dn = ed[i * 4 + 2], l = ed[i * 4 + 3];
      const u2 = ed2[i * 4 + 0], r2 = ed2[i * 4 + 1], d2 = ed2[i * 4 + 2], l2 = ed2[i * 4 + 3];
      let vOk = u >= 0 && dn >= 0 && e[u] !== E_OFF && e[dn] !== E_OFF;
      let hOk = r >= 0 && l >= 0 && e[r] !== E_OFF && e[l] !== E_OFF;
      if ((r >= 0 && e[r] === E_ON) || (l >= 0 && e[l] === E_ON)) vOk = false;
      if ((u >= 0 && e[u] === E_ON) || (dn >= 0 && e[dn] === E_ON)) hOk = false;
      if (vOk && u2 >= 0 && e[u2] === E_ON && d2 >= 0 && e[d2] === E_ON) vOk = false;
      if (hOk && r2 >= 0 && e[r2] === E_ON && l2 >= 0 && e[l2] === E_ON) hOk = false;
      if (vOk || hOk) continue;

      const canLeg = (d) => {
        const x1 = ed[i * 4 + d], x2 = ed2[i * 4 + d], n1 = nb[i * 4 + d], opp = ed[i * 4 + (d ^ 2)];
        if (x1 < 0 || x2 < 0 || e[x1] === E_OFF || e[x2] === E_OFF || cell[n1] === OFF || cell[P.step2[i * 4 + d]] === OFF) return false;
        if (opp >= 0 && e[opp] === E_ON) return false;
        if (clue[n1] === BLACK) return false;
        const p1 = ed[n1 * 4 + ((d + 1) & 3)], p2 = ed[n1 * 4 + ((d + 3) & 3)];
        return !((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON));
      };
      if (!((canLeg(0) || canLeg(2)) && (canLeg(1) || canLeg(3)))) {
        return { kind: 'grayBroken', cell: i };
      }
    }
  }

  // 3c. Slitherlink numbered faces: on <= n <= on + unk
  if (P.hasSlither) {
    const fe = P.faceEdges;
    const sf = scope && scope.faces ? scope.faces : null;
    const slLen = sf ? sf.length : P.slither.length;
    for (let k = 0; k < slLen; k++) {
      const sc = P.slither[sf ? sf[k] : k];
      const f4 = sc.f * 4;
      let on = 0, unk = 0;
      const e0 = fe[f4], e1 = fe[f4 + 1], e2 = fe[f4 + 2], e3 = fe[f4 + 3];
      if (e0 >= 0) { const v = e[e0]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (e1 >= 0) { const v = e[e1]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (e2 >= 0) { const v = e[e2]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (e3 >= 0) { const v = e[e3]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (on > sc.n || on + unk < sc.n) return { kind: 'slitherBroken', face: sc.f, n: sc.n, over: on > sc.n };
    }
  }

  // 3d. Mid-loop dot contradiction (before O(N+E) cycle check; scoped to dirty rows/cols when scoped)
  if (P.hasMidloop) {
    const mc = midloopContradiction(P, st, scope ? scope.mids : null);
    if (mc) return mc;
  }

  // 3e. Castle Wall ray/parity contradiction
  if (P.hasCastle) {
    const cc = castleContradiction(P, st, scope ? scope.castles : null);
    if (cc) return cc;
  }

  // 4. Early closed loop (or 2 cycles) — skip when no E_ON edge was added in the hypothesis
  if (scope) {
    if (!scope.checkCycle) return null;
    if (scope.newOn) {
      const newOn = scope.newOn;
      let closed = false;
      for (let k = 0; k < newOn.length; k++) {
        const ex = newOn[k];
        const a = edgeA[ex], b = edgeB[ex];
        let prev = b, cur = a;
        for (let hop = 0; hop <= N; hop++) {
          const c4 = cur * 4;
          let nxt = -1;
          let y = ed[c4];
          if (y >= 0 && e[y] === E_ON && nb[c4] !== prev) nxt = nb[c4];
          else {
            y = ed[c4 + 1];
            if (y >= 0 && e[y] === E_ON && nb[c4 + 1] !== prev) nxt = nb[c4 + 1];
            else {
              y = ed[c4 + 2];
              if (y >= 0 && e[y] === E_ON && nb[c4 + 2] !== prev) nxt = nb[c4 + 2];
              else {
                y = ed[c4 + 3];
                if (y >= 0 && e[y] === E_ON && nb[c4 + 3] !== prev) nxt = nb[c4 + 3];
              }
            }
          }
          if (nxt < 0) break;
          if (nxt === b) { closed = true; break; }
          prev = cur;
          cur = nxt;
        }
        if (closed) break;
      }
      newOn.length = 0;
      if (!closed) return null;
    }
  }
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
    if (P.hasSlither && !isSlitherSatisfied(P, e)) {
      const fe = P.faceEdges;
      for (let si = 0; si < P.slither.length; si++) {
        const sc = P.slither[si];
        const f4 = sc.f * 4;
        let on = 0;
        for (let d = 0; d < 4; d++) if (fe[f4 + d] >= 0 && e[fe[f4 + d]] === E_ON) on++;
        if (on !== sc.n) return { kind: 'earlyClose', face: sc.f, n: sc.n };
      }
    }
    if (P.hasMidloop) {
      const badMid = firstUnsatisfiedMidloop(P, e);
      if (badMid >= 0) {
        const mc = midloopContradiction(P, st, null);
        return mc || { kind: 'earlyClose', midIdx: badMid };
      }
    }
    if (P.hasCastle) {
      const badCw = firstUnsatisfiedCastle(P, e);
      if (badCw >= 0) {
        const cc = castleContradiction(P, st, null);
        return cc || { kind: 'earlyClose', castleIdx: badCw };
      }
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
    if (on === 2) {
      if (st.hasGray && st.clue[i] === GRAY) {
        const u = ed[base], dn = ed[base + 2], r = ed[base + 1], l = ed[base + 3];
        const straight = (u >= 0 && dn >= 0 && e[u] === E_ON && e[dn] === E_ON)
          || (r >= 0 && l >= 0 && e[r] === E_ON && e[l] === E_ON);
        st.clue[i] = straight ? WHITE : BLACK;
      }
      if (unk > 0) {
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
  const { N, numEdges, ed, ed2, nb, step2, edgeA, edgeB } = P;
  const clue = st.clue || P.clue;
  const { cell, e } = st;
  const whites = scope ? scope.whites : (st.hasGray ? P.clueCells.filter((i) => clue[i] === WHITE) : P.whites);
  const blacks = scope ? scope.blacks : (st.hasGray ? P.clueCells.filter((i) => clue[i] === BLACK) : P.blacks);

  const tryEmit = (rule, sets, info = {}) => {
    const fresh = sets.filter(([k, idx, v]) => (k === 'g' ? clue[idx] === GRAY : (k === 'c' ? cell[idx] : e[idx]) === 0));
    if (!fresh.length) return null;
    const sig = `${rule}:${fresh.map(([k, idx, v]) => `${k}${idx}=${v}`).sort().join(',')}`;
    if (forbid && forbid.has(sig)) return null;
    return { rule, sets: fresh, sig, info };
  };

  // 0a. Mid-loop easy rules (passes tryEmit so forbid ablation never skips later hits/rules)
  if (P.hasMidloop) {
    const emitted = findEasyMidloopStep(P, st, tryEmit, scope ? scope.mids : null);
    if (emitted) return emitted;
  }

  // 0a2. Castle Wall easy rules
  if (P.hasCastle) {
    const emitted = findEasyCastleStep(P, st, tryEmit, scope ? scope.castles : null);
    if (emitted) return emitted;
  }

  // 0b. Slitherlink easy rules (slitherZero / slitherCount / slitherCorner 3&1 / slitherLineIn)
  if (P.hasSlither) {
    const fe = P.faceEdges, cols = P.cols;
    const sf = scope && scope.faces ? scope.faces : null;
    const slLen = sf ? sf.length : P.slither.length;
    for (let k = 0; k < slLen; k++) {
      const sc = P.slither[sf ? sf[k] : k];
      const f4 = sc.f * 4;
      const e0 = fe[f4], e1 = fe[f4 + 1], e2 = fe[f4 + 2], e3 = fe[f4 + 3];
      let on = 0, unk = 0;
      if (e0 >= 0) { const v = e[e0]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (e1 >= 0) { const v = e[e1]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (e2 >= 0) { const v = e[e2]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (e3 >= 0) { const v = e[e3]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (unk === 0) continue;
      if (sc.n === 0 || on === sc.n || on + unk === sc.n) {
        const val = (sc.n === 0 || on === sc.n) ? E_OFF : E_ON;
        const sets = [];
        if (e0 >= 0 && e[e0] === E_UNKNOWN) sets.push(['e', e0, val]);
        if (e1 >= 0 && e[e1] === E_UNKNOWN) sets.push(['e', e1, val]);
        if (e2 >= 0 && e[e2] === E_UNKNOWN) sets.push(['e', e2, val]);
        if (e3 >= 0 && e[e3] === E_UNKNOWN) sets.push(['e', e3, val]);
        const s = sc.n === 0
          ? tryEmit('slitherZero', sets, { face: sc.f, n: 0 })
          : tryEmit('slitherCount', sets, { face: sc.f, n: sc.n, mode: val === E_OFF ? 'done' : 'fill' });
        if (s) return s;
      }
    }
    // 0c. Slitherlink blocked corners on 3 and 1
    for (let k = 0; k < slLen; k++) {
      const sc = P.slither[sf ? sf[k] : k];
      if (sc.n !== 3 && sc.n !== 1) continue;
      const f4 = sc.f * 4;
      const val = sc.n === 3 ? E_ON : E_OFF;
      for (let ci = 0; ci < 4; ci++) {
        const [dr, dc, fea, feb, , , odA, odB] = CORNER_SPEC[ci];
        const ea = fe[f4 + fea], eb = fe[f4 + feb];
        if (ea < 0 || eb < 0 || (e[ea] !== E_UNKNOWN && e[eb] !== E_UNKNOWN)) continue;
        const v = (sc.r + dr) * cols + (sc.c + dc);
        if (!isBlockedDir(P, st, v, odA) || !isBlockedDir(P, st, v, odB)) continue;
        const sets = [];
        if (e[ea] === E_UNKNOWN) sets.push(['e', ea, val]);
        if (e[eb] === E_UNKNOWN) sets.push(['e', eb, val]);
        const s = tryEmit('slitherCorner', sets, { face: sc.f, n: sc.n, cell: v });
        if (s) return s;
      }
    }
    // 0d. Slitherlink generalized line-in (unk === rem + 1)
    for (let k = 0; k < slLen; k++) {
      const sc = P.slither[sf ? sf[k] : k];
      if (sc.n === 0) continue;
      const f4 = sc.f * 4;
      let on = 0, unk = 0;
      const e0 = fe[f4], e1 = fe[f4 + 1], e2 = fe[f4 + 2], e3 = fe[f4 + 3];
      if (e0 >= 0) { const v = e[e0]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (e1 >= 0) { const v = e[e1]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (e2 >= 0) { const v = e[e2]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (e3 >= 0) { const v = e[e3]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      const rem = sc.n - on;
      if (rem < 1 || unk !== rem + 1 || unk < 2) continue;
      for (let ci = 0; ci < 4; ci++) {
        const [dr, dc, fea, feb, oppA, oppB, odA, odB] = CORNER_SPEC[ci];
        const ea = fe[f4 + fea], eb = fe[f4 + feb];
        if (ea < 0 || eb < 0 || e[ea] !== E_UNKNOWN || e[eb] !== E_UNKNOWN) continue;
        const v = (sc.r + dr) * cols + (sc.c + dc);
        const xA = ed[v * 4 + odA], xB = ed[v * 4 + odB];
        const onA = xA >= 0 && e[xA] === E_ON;
        const onB = xB >= 0 && e[xB] === E_ON;
        if (onA === onB) continue;
        const otherOut = onA ? xB : xA;
        const eoA = fe[f4 + oppA], eoB = fe[f4 + oppB];
        if ((eoA < 0 || e[eoA] !== E_UNKNOWN) && (eoB < 0 || e[eoB] !== E_UNKNOWN)
          && (otherOut < 0 || e[otherOut] !== E_UNKNOWN)) continue;
        const sets = [];
        if (eoA >= 0 && e[eoA] === E_UNKNOWN) sets.push(['e', eoA, E_ON]);
        if (eoB >= 0 && e[eoB] === E_UNKNOWN) sets.push(['e', eoB, E_ON]);
        if (otherOut >= 0 && e[otherOut] === E_UNKNOWN) sets.push(['e', otherOut, E_OFF]);
        const s = tryEmit('slitherLineIn', sets, { face: sc.f, n: sc.n, cell: v, rem, unk });
        if (s) return s;
      }
    }
  }

  // 0. Gray circle direct resolutions (grayMustBeBlack / grayMustBeWhite)
  if (st.hasGray) {
    for (let gi = 0; gi < P.grays.length; gi++) {
      const i = P.grays[gi];
      if (clue[i] !== GRAY) continue;
      const u = ed[i * 4 + 0], r = ed[i * 4 + 1], dn = ed[i * 4 + 2], l = ed[i * 4 + 3];
      const u2 = ed2[i * 4 + 0], r2 = ed2[i * 4 + 1], d2 = ed2[i * 4 + 2], l2 = ed2[i * 4 + 3];
      let vOk = u >= 0 && dn >= 0 && e[u] !== E_OFF && e[dn] !== E_OFF;
      let hOk = r >= 0 && l >= 0 && e[r] !== E_OFF && e[l] !== E_OFF;
      if ((r >= 0 && e[r] === E_ON) || (l >= 0 && e[l] === E_ON)) vOk = false;
      if ((u >= 0 && e[u] === E_ON) || (dn >= 0 && e[dn] === E_ON)) hOk = false;
      if (vOk && u2 >= 0 && e[u2] === E_ON && d2 >= 0 && e[d2] === E_ON) vOk = false;
      if (hOk && r2 >= 0 && e[r2] === E_ON && l2 >= 0 && e[l2] === E_ON) hOk = false;
      if (!vOk && !hOk) {
        const step = tryEmit('grayMustBeBlack', [['g', i, BLACK]], { cell: i, reason: 'blocked' });
        if (step) return step;
      }
      const canLeg = (d) => {
        const x1 = ed[i * 4 + d], x2 = ed2[i * 4 + d], n1 = nb[i * 4 + d], opp = ed[i * 4 + (d ^ 2)];
        if (x1 < 0 || x2 < 0 || e[x1] === E_OFF || e[x2] === E_OFF || cell[n1] === OFF || cell[step2[i * 4 + d]] === OFF) return false;
        if (opp >= 0 && e[opp] === E_ON) return false;
        if (clue[n1] === BLACK) return false;
        const p1 = ed[n1 * 4 + ((d + 1) & 3)], p2 = ed[n1 * 4 + ((d + 3) & 3)];
        return !((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON));
      };
      if (!((canLeg(0) || canLeg(2)) && (canLeg(1) || canLeg(3)))) {
        const step = tryEmit('grayMustBeWhite', [['g', i, WHITE]], { cell: i, reason: 'axisBlocked' });
        if (step) return step;
      }
    }
  }

  // 1. whiteStraight
  for (let wi = 0; wi < whites.length; wi++) {
    const i = whites[wi];
    const u = ed[i * 4 + 0], r = ed[i * 4 + 1], dn = ed[i * 4 + 2], l = ed[i * 4 + 3];
    if ((u < 0 || e[u] !== E_UNKNOWN) && (r < 0 || e[r] !== E_UNKNOWN)
      && (dn < 0 || e[dn] !== E_UNKNOWN) && (l < 0 || e[l] !== E_UNKNOWN)) continue;
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
      if ((x2 < 0 || e[x2] !== E_UNKNOWN) && (opp < 0 || e[opp] !== E_UNKNOWN)) continue;
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
      const x1 = ed[i * 4 + d], opp1 = ed[i * 4 + (d ^ 2)], opp2 = ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      if (e[opp1] !== E_UNKNOWN && e[opp2] !== E_UNKNOWN && (x1 < 0 || e[x1] !== E_UNKNOWN)) continue;
      const x2 = ed2[i * 4 + d], n1 = nb[i * 4 + d], n2 = step2[i * 4 + d];
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
    if ((u < 0 || e[u] !== E_UNKNOWN) && (r < 0 || e[r] !== E_UNKNOWN)
      && (dn < 0 || e[dn] !== E_UNKNOWN) && (l < 0 || e[l] !== E_UNKNOWN)) continue;
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

  // 7b. Mid-loop & Castle Wall medium rules
  if (P.hasMidloop) {
    const emitted = findMediumMidloopStep(P, st, tryEmit, scope ? scope.mids : null);
    if (emitted) return emitted;
  }
  if (P.hasCastle) {
    const emitted = findMediumCastleStep(P, st, tryEmit, scope ? scope.castles : null);
    if (emitted) return emitted;
  }

  // 8. noEarlyClose (skip when no E_ON / LOOP cell has been added in this hypothesis)
  if (scope && !scope.hasOn) return null;
  let loopCount = -1;
  for (let x = 0; x < numEdges; x++) {
    if (e[x] !== E_UNKNOWN) continue;
    const a = edgeA[x];
    if (a < 0) continue;
    const b = edgeB[x];
    if (cell[a] !== LOOP || cell[b] !== LOOP) continue;
    if (onCount(P, st, a) !== 1 || onCount(P, st, b) !== 1) continue;
    // Trace the simple E_ON path from a; ra === find(b) iff it terminates at b
    let prev = -1, cur = a, pathVerts = 1;
    let hitsB = false;
    for (let hop = 0; hop < N; hop++) {
      const c4 = cur * 4;
      let nxt = -1;
      let y = ed[c4];
      if (y >= 0 && e[y] === E_ON && nb[c4] !== prev) nxt = nb[c4];
      else {
        y = ed[c4 + 1];
        if (y >= 0 && e[y] === E_ON && nb[c4 + 1] !== prev) nxt = nb[c4 + 1];
        else {
          y = ed[c4 + 2];
          if (y >= 0 && e[y] === E_ON && nb[c4 + 2] !== prev) nxt = nb[c4 + 2];
          else {
            y = ed[c4 + 3];
            if (y >= 0 && e[y] === E_ON && nb[c4 + 3] !== prev) nxt = nb[c4 + 3];
          }
        }
      }
      if (nxt < 0) break;
      pathVerts++;
      if (nxt === b) { hitsB = true; break; }
      prev = cur;
      cur = nxt;
    }
    if (!hitsB) continue;
    if (loopCount < 0) {
      loopCount = 0;
      for (let i = 0; i < N; i++) if (cell[i] === LOOP) loopCount++;
    }
    const slFace = pathVerts < loopCount ? -1 : firstUnsatisfiedSlitherOnClose(P, st, x);
    const midIdx = (pathVerts < loopCount || slFace >= 0) ? -1 : firstUnsatisfiedMidloopOnClose(P, st, x);
    const castleIdx = (pathVerts < loopCount || slFace >= 0 || midIdx >= 0) ? -1 : firstUnsatisfiedCastleOnClose(P, st, x);
    if (pathVerts < loopCount || slFace >= 0 || midIdx >= 0 || castleIdx >= 0) {
      const info = slFace >= 0 ? { edge: x, a, b, slitherFace: slFace }
        : midIdx >= 0 ? { edge: x, a, b, midIdx }
        : castleIdx >= 0 ? { edge: x, a, b, castleIdx }
        : { edge: x, a, b };
      const step = tryEmit('noEarlyClose', [['e', x, E_OFF]], info);
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
function runHypothesis(P, baseState, edge, val, {
  maxSteps = MAX_STEPS, checkArea = false, forbid = null, scoped = true, grayCell = -1,
} = {}) {
  const st = cloneState(baseState);
  if (grayCell >= 0) st.clue[grayCell] = val;
  else st.e[edge] = val;
  // On gray puzzles (small N), run unscoped so mid-chain gray->W/B promotions never miss dirty-cone wakeups
  if (st.hasGray) scoped = false;

  let scope = null;
  let dirtyAdded = false;
  let dirtyFaceAdded = false;
  let dirtyMidAdded = false;
  const cols = P.cols, fr = P.rows - 1, fc = cols - 1;
  const slitherAt = P.hasSlither ? P.slitherAt : null;
  const hasMid = Boolean(P.hasMidloop);
  const midByRow = P.midloopByRow, midByCol = P.midloopByCol;
  const hasCastle = Boolean(P.hasCastle);
  const castleByRow = P.castleByRow, castleByCol = P.castleByCol;
  const markCastleIdx = (ci) => {
    if (ci < 0 || dirtyCastleFlag[ci]) return;
    dirtyCastleFlag[ci] = 1;
    scope.castleList.push(ci);
  };
  const markCellCastles = (c) => {
    const r = (c / cols) | 0, col = c - r * cols;
    const rl = castleByRow[r];
    for (let j = 0; j < rl.length; j++) markCastleIdx(rl[j]);
    const cl = castleByCol[col];
    for (let j = 0; j < cl.length; j++) markCastleIdx(cl[j]);
  };
  const markFace = (f) => {
    const si = slitherAt[f];
    if (si < 0 || dirtyFaceFlag[si]) return;
    dirtyFaceFlag[si] = 1;
    scope.faces.push(si);
    dirtyFaceAdded = true;
  };
  const markCellFaces = (c) => {
    const r = (c / cols) | 0, col = c - r * cols;
    if (r > 0 && col > 0) markFace((r - 1) * fc + (col - 1));
    if (r > 0 && col < fc) markFace((r - 1) * fc + col);
    if (r < fr && col > 0) markFace(r * fc + (col - 1));
    if (r < fr && col < fc) markFace(r * fc + col);
  };
  const markCellMids = (c) => {
    const r = (c / cols) | 0, col = c - r * cols;
    const rl = midByRow[r];
    for (let j = 0; j < rl.length; j++) {
      const mi = rl[j];
      if (!dirtyMidFlag[mi]) { dirtyMidFlag[mi] = 1; scope.mids.push(mi); dirtyMidAdded = true; }
    }
    const cl = midByCol[col];
    for (let j = 0; j < cl.length; j++) {
      const mi = cl[j];
      if (!dirtyMidFlag[mi]) { dirtyMidFlag[mi] = 1; scope.mids.push(mi); dirtyMidAdded = true; }
    }
  };
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
    if (slitherAt) markCellFaces(i);
    if (hasMid) markCellMids(i);
    if (hasCastle) markCellCastles(i);
    markCell(i);
    const b = i * 4;
    for (let d = 0; d < 4; d++) {
      markCell(P.nb[b + d]);
      markCell(P.step2[b + d]);
    }
  };
  const sortScope = () => {
    if (dirtyAdded) {
      dirtyAdded = false;
      insertSortNum(scope.cells);
      insertSortNum(scope.whites);
      insertSortNum(scope.blacks);
    }
    if (dirtyFaceAdded) {
      dirtyFaceAdded = false;
      insertSortNum(scope.faces);
    }
    if (dirtyMidAdded) {
      dirtyMidAdded = false;
      insertSortNum(scope.mids);
    }
  };
  const clearDirty = () => {
    if (!scope) return;
    for (let k = 0; k < scope.cells.length; k++) dirtyFlag[scope.cells[k]] = 0;
    if (scope.faces) {
      for (let k = 0; k < scope.faces.length; k++) dirtyFaceFlag[scope.faces[k]] = 0;
    }
    if (scope.mids) {
      for (let k = 0; k < scope.mids.length; k++) dirtyMidFlag[scope.mids[k]] = 0;
    }
    if (scope.castleList) {
      for (let k = 0; k < scope.castleList.length; k++) dirtyCastleFlag[scope.castleList[k]] = 0;
    }
  };

  if (scoped) {
    if (dirtyFlag.length < P.N) dirtyFlag = new Uint8Array(P.N);
    if (slitherAt && dirtyFaceFlag.length < P.slither.length) dirtyFaceFlag = new Uint8Array(P.slither.length);
    if (hasMid && dirtyMidFlag.length < P.midloop.length) dirtyMidFlag = new Uint8Array(P.midloop.length);
    if (hasCastle && dirtyCastleFlag.length < P.castle.length) dirtyCastleFlag = new Uint8Array(P.castle.length);
    scope = {
      cells: [],
      whites: [],
      blacks: [],
      faces: slitherAt ? [] : null,
      mids: hasMid ? [] : null,
      castles: hasCastle ? dirtyCastleFlag : null,
      castleList: hasCastle ? [] : null,
      newOn: val === E_ON ? [edge] : [],
      hasOn: val === E_ON,
      checkCycle: val === E_ON,
    };
    touchCell(P.edgeA[edge], val === E_ON);
    touchCell(P.edgeB[edge], val === E_ON);
  }

  try {
    const seedCells = grayCell >= 0 ? [grayCell] : [P.edgeA[edge], P.edgeB[edge]];
    if (!runBookkeeping(P, st, seedCells, scoped ? touchCell : null)) {
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
      if (scope) { scope.checkCycle = false; scope.newOn.length = 0; }
      for (let k = 0; k < step.sets.length; k++) {
        const [kind, idx, v] = step.sets[k];
        if (kind === 'g') {
          touched.push(idx);
        } else if (kind === 'c') {
          touched.push(idx);
          if (scoped) touchCell(idx, v === LOOP);
        } else {
          const a = P.edgeA[idx], b = P.edgeB[idx];
          touched.push(a, b);
          if (scoped) {
            if (v === E_ON) scope.newOn.push(idx);
            touchCell(a, v === E_ON);
            touchCell(b, v === E_ON);
          }
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
function pruneChain(P, baseState, edge, val, rawSteps, area, costCap, grayCell = -1, rawBroke = null) {
  const isFrontier = grayCell >= 0 || isFrontierEdge(P, baseState, edge);
  if (minImagineCost(0, area, isFrontier) >= costCap) return null;
  // Early reject: earlyClose/twoLoops contradictions cannot qualify as imagineLocal (cost <= MEDIUM_MAX)
  if (costCap <= MEDIUM_MAX && rawBroke && (rawBroke.kind === 'earlyClose' || rawBroke.kind === 'twoLoops')) return null;
  const forbid = new Set();
  const kept = [];
  for (let k = rawSteps.length - 1; k >= 0; k--) {
    const sig = rawSteps[k].sig;
    forbid.add(sig);
    const r = runHypothesis(P, baseState, edge, val, {
      maxSteps: rawSteps.length + 2,
      checkArea: area,
      forbid,
      grayCell,
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
    grayCell,
  });
  if (!clean.broke) return null;
  const cls = classifyImagine(P, baseState, edge, clean.steps, clean.broke, clean.area, grayCell);
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
      if (edgeA[x] >= 0 && isFrontierEdge(P, st, x)) primary.push(x);
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
  if (P.hasSlither) {
    for (let si = 0; si < P.slither.length; si++) {
      const sc = P.slither[si];
      if (sc.n === 0) continue;
      const f4 = sc.f * 4;
      for (let d = 0; d < 4; d++) {
        const x = P.faceEdges[f4 + d];
        if (x >= 0) { near[edgeA[x]] = 1; near[edgeB[x]] = 1; }
      }
    }
  }
  if (P.hasMidloop) {
    // Include step-1 and step-2 vertices along each Mid-loop dot's ray(s) so ray-distance-2 hypotheses are tested
    for (let mi = 0; mi < P.midloop.length; mi++) {
      const m = P.midloop[mi];
      if (m.dir === 'C') {
        const i4 = m.cell * 4;
        for (let d = 0; d < 4; d++) {
          const n1 = nb[i4 + d];
          if (n1 >= 0) {
            near[n1] = 1;
            const n2 = nb[n1 * 4 + d];
            if (n2 >= 0) near[n2] = 1;
          }
        }
      } else {
        const dNeg = m.axis === 0 ? 0 : 3;
        const dPos = m.axis === 0 ? 2 : 1;
        let n1 = nb[m.a * 4 + dNeg];
        if (n1 >= 0) { near[n1] = 1; const n2 = nb[n1 * 4 + dNeg]; if (n2 >= 0) near[n2] = 1; }
        n1 = nb[m.b * 4 + dPos];
        if (n1 >= 0) { near[n1] = 1; const n2 = nb[n1 * 4 + dPos]; if (n2 >= 0) near[n2] = 1; }
      }
    }
  }
  if (P.hasCastle) {
    // Include ray edges of numbered Castle Wall clues and edges adjacent to W/B walls
    for (let k = 0; k < P.castle.length; k++) {
      const cw = P.castle[k];
      for (let j = 0; j < cw.edges.length; j++) {
        const x = cw.edges[j];
        near[edgeA[x]] = 1; near[edgeB[x]] = 1;
      }
      if (cw.wall !== 'G') {
        const r = cw.r, c = cw.c;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && rr < P.rows && cc >= 0 && cc < P.cols && !P.isVoid[rr * P.cols + cc]) {
              near[rr * P.cols + cc] = 1;
            }
          }
        }
      }
    }
  }
  const secondary = [];
  for (let x = 0; x < numEdges; x++) {
    if (e[x] !== E_UNKNOWN) continue;
    const a = edgeA[x], b = edgeB[x];
    if (a < 0) continue;
    if (isFrontierEdge(P, st, x)) primary.push(x);
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
 * Optional `stepCache`: reuses frontier pass across `costCap` escalations within the same `nextSteps` call.
 */
export function bestImagine(P, st, { costCap = Infinity, without = null, stepCache = null } = {}) {
  const frontierOnly = costCap <= 84;
  const unresolvedGrays = st.hasGray ? P.grays.filter((i) => st.clue[i] === GRAY) : [];
  if (propCellBuf.length < P.N) propCellBuf = new Int8Array(P.N);
  if (propEdgeBuf.length < P.numEdges) propEdgeBuf = new Int8Array(P.numEdges);
  if (st.hasGray && propClueBuf.length < P.N) propClueBuf = new Uint8Array(P.N);
  const stProp = {
    cell: propCellBuf.subarray(0, P.N),
    e: propEdgeBuf.subarray(0, P.numEdges),
    clue: st.hasGray ? propClueBuf.subarray(0, P.N) : P.clue,
    hasGray: Boolean(st.hasGray),
    cycle: false,
  };

  let ic = stepCache && stepCache.imagine ? stepCache.imagine : null;
  if (!ic) {
    // Check once whether `st` is already a propagate() fixed point (including UNKNOWN->LOOP endpoints)
    // so trial calls can safely use O(local) seedEdge
    stProp.cell.set(st.cell);
    stProp.e.set(st.e);
    if (st.hasGray) stProp.clue.set(st.clue);
    stProp.cycle = st.cycle;
    let baseFixed = !st.hasGray && propagate(P, stProp) && lastPropChanges === 0;
    if (baseFixed) {
      for (let i = 0; i < P.N; i++) {
        if (stProp.cell[i] !== st.cell[i]) { baseFixed = false; break; }
      }
    }
    ic = {
      baseFixed,
      edges: [],
      edgeSeen: new Set(),
      changed: [],
      easyHits: [],
      easyHitSet: new Set(),
      noAreaSet: new Set(),
      graysDone: false,
      allDone: false,
    };
    if (stepCache) stepCache.imagine = ic;
  }

  const baseFixed = ic.baseFixed;
  const wantEdges = ic.allDone ? ic.edges : candidateEdges(P, st, frontierOnly);
  if (!wantEdges.length && !unresolvedGrays.length) return null;

  const evalEdgeBatch = (list) => {
    for (let ei = 0; ei < list.length; ei++) {
      const x = list[ei];
      if (ic.edgeSeen.has(x)) continue;
      ic.edgeSeen.add(x);
      const slot = ic.edges.length;
      ic.edges.push(x);
      const isFront = isFrontierEdge(P, st, x);
      for (let vi = 0; vi < 2; vi++) {
        const val = vi === 0 ? E_ON : E_OFF;
        stProp.cell.set(st.cell);
        stProp.e.set(st.e);
        if (st.hasGray) stProp.clue.set(st.clue);
        stProp.cycle = st.cycle;
        stProp.e[x] = val;
        if (!propagate(P, stProp, baseFixed ? x : -1, -1)) {
          ic.changed[slot * 2 + vi] = 1;
          const r = runHypothesis(P, st, x, val, { maxSteps: MAX_STEPS, checkArea: false });
          if (r.broke) {
            ic.easyHits.push({ edge: x, grayCell: -1, hyp: val, rawSteps: r.steps, rawBroke: r.broke, area: false, isFront });
            ic.easyHitSet.add((x << 2) | val);
          } else if (r.steps.length === 0) {
            // Zero easy steps fired -> loop 2 cannot produce a >=1-step area hit either
            ic.noAreaSet.add((x << 2) | val);
          }
        } else {
          ic.changed[slot * 2 + vi] = lastPropChanges > 0 ? 1 : 0;
        }
      }
    }
  };

  if (!ic.allDone) {
    evalEdgeBatch(wantEdges);
    if (!frontierOnly) ic.allDone = true;
  }

  if (!ic.graysDone) {
    ic.graysDone = true;
    // Also test imagining each unresolved gray pearl as WHITE or BLACK (natural human technique for Gray Masyu!)
    for (let gi = 0; gi < unresolvedGrays.length; gi++) {
      const gc = unresolvedGrays[gi];
      for (const hypColor of [WHITE, BLACK]) {
        stProp.cell.set(st.cell);
        stProp.e.set(st.e);
        stProp.clue.set(st.clue);
        stProp.cycle = st.cycle;
        stProp.clue[gc] = hypColor;
        if (!propagate(P, stProp)) {
          const r = runHypothesis(P, st, -1, hypColor, { maxSteps: MAX_STEPS, checkArea: false, grayCell: gc });
          if (r.broke) {
            ic.easyHits.push({ edge: -1, grayCell: gc, hyp: hypColor, rawSteps: r.steps, rawBroke: r.broke, area: false, isFront: true });
          }
        }
      }
    }
  }

  const easyHits = frontierOnly ? ic.easyHits.filter((c) => c.isFront) : ic.easyHits;
  // Prune easy hits FIRST (frontier candidates first, then shortest raw chain):
  // if an easy hit already achieves cost <= AREA_MIN_COST, we skip the O(edges) Tarjan/parity area scan!
  easyHits.sort((a, b) => (b.isFront ? 1 : 0) - (a.isFront ? 1 : 0) || a.rawSteps.length - b.rawSteps.length);
  let best = null;
  const evalCandidates = (list, limit) => {
    let accepted = 0;
    for (const c of list) {
      if (accepted >= limit) break;
      const cap = best ? best.cost : costCap;
      const gc = c.grayCell ?? -1;
      const pr = pruneChain(P, st, c.edge, c.hyp, c.rawSteps, c.area, cap, gc, c.rawBroke);
      if (!pr || pr.cost >= costCap) continue;
      if (without && without.includes(pr.rule)) continue;
      accepted++;
      if (!best || pr.cost < best.cost) {
        best = {
          edge: c.edge,
          grayCell: gc,
          hyp: c.hyp,
          deduce: gc >= 0 ? (c.hyp === WHITE ? BLACK : WHITE) : (c.hyp === E_ON ? E_OFF : E_ON),
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
    return accepted;
  };
  const easyChecked = without
    ? evalCandidates(easyHits, MAX_CAND)
    : (evalCandidates(easyHits.slice(0, MAX_CAND), MAX_CAND), easyHits.length);

  // Area contradictions require >= 1 easy step (min cost AREA_MIN_COST = 98); skip whenever effectiveCap <= AREA_MIN_COST
  const effectiveCap = best ? Math.min(costCap, best.cost) : costCap;
  if (easyChecked < MAX_CAND && effectiveCap > AREA_MIN_COST) {
    const areaHits = [];
    const edges = ic.edges;
    for (let ei = 0; ei < edges.length; ei++) {
      const x = edges[ei];
      for (let vi = 0; vi < 2; vi++) {
        const val = vi === 0 ? E_ON : E_OFF;
        const key = (x << 2) | val;
        if (ic.easyHitSet.has(key) || ic.noAreaSet.has(key)) continue;
        // If propagate made 0 edge/OFF deductions beyond `x = val`, findEasyStep fires 0 steps -> cannot be an area hit
        if (baseFixed && !ic.changed[ei * 2 + vi]) continue;
        stProp.cell.set(st.cell);
        stProp.e.set(st.e);
        if (st.hasGray) stProp.clue.set(st.clue);
        stProp.cycle = st.cycle;
        stProp.e[x] = val;
        // skipEasy=true when propagate succeeded (already guaranteed no easy contradiction);
        // if propagate contradicted beyond MAX_STEPS, still check for a shorter <=AREA_STEPS area hit
        if (!propagate(P, stProp, baseFixed ? x : -1, -1) || fullContradiction(P, stProp, true)) {
          const r = runHypothesis(P, st, x, val, { maxSteps: AREA_STEPS, checkArea: true });
          if (r.broke) {
            areaHits.push({ edge: x, grayCell: -1, hyp: val, rawSteps: r.steps, rawBroke: r.broke, area: r.area });
          } else {
            ic.noAreaSet.add(key);
          }
        }
      }
    }
    for (let gi = 0; gi < unresolvedGrays.length; gi++) {
      const gc = unresolvedGrays[gi];
      for (const hypColor of [WHITE, BLACK]) {
        stProp.cell.set(st.cell);
        stProp.e.set(st.e);
        stProp.clue.set(st.clue);
        stProp.cycle = st.cycle;
        stProp.clue[gc] = hypColor;
        if (!propagate(P, stProp) || fullContradiction(P, stProp, true)) {
          const r = runHypothesis(P, st, -1, hypColor, { maxSteps: AREA_STEPS, checkArea: true, grayCell: gc });
          if (r.broke && r.area) {
            areaHits.push({ edge: -1, grayCell: gc, hyp: hypColor, rawSteps: r.steps, rawBroke: r.broke, area: true });
          }
        }
      }
    }
    areaHits.sort((a, b) => a.rawSteps.length - b.rawSteps.length);
    const areaBudget = Math.max(0, MAX_CAND - easyChecked);
    evalCandidates(without ? areaHits : areaHits.slice(0, areaBudget), areaBudget);
  }
  return best;
}

/** Replay a pruned imagine step from `baseState` to produce the exact final state and forced edges (for Hint). */
export function replayImagine(P, baseState, info) {
  const forbid = new Set(info.forbid || []);
  const grayCell = info.grayCell !== undefined && info.grayCell >= 0 ? info.grayCell : -1;
  return runHypothesis(P, baseState, info.edge ?? -1, info.hyp, {
    maxSteps: (info.steps ? info.steps.length : MAX_STEPS) + 2,
    checkArea: !!info.area,
    forbid,
    grayCell,
  });
}
