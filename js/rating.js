// Human-style Masyu scorer and rule table (pure logic, no DOM).
// The same RULES table drives both puzzle difficulty rating and the Hint button.
//
// Each step applies the cheapest applicable rule and never looks at the stored solution.
// A puzzle's `tier` is the tier of the hardest rule it needed; its `score` is the sum of step costs
// (+100 per undecided cell if the rules get stuck, which makes it Expert, "beyond the hints").
import {
  WHITE, BLACK, GRAY, UNKNOWN, OFF, LOOP, E_UNKNOWN, E_ON, E_OFF,
  initialState, cloneState, isSolved,
} from './logic.js';
import { bestImagine, setFullContradiction, easyContradiction, MEDIUM_MAX, HARD_MAX } from './imagine.js';
import { findFaceShade, findFaceCircle, findFaceSlither } from './faceparity.js';
import { SLITHER_RULES, isSlitherEdge, firstUnsatisfiedSlitherOnClose } from './variants/slitherlink.js';
import { MIDLOOP_RULES, firstUnsatisfiedMidloopOnClose } from './variants/midloop.js';

export const TIERS = ['Beginner', 'Medium', 'Hard', 'Expert'];

export const TIER_INFO = {
  Beginner: { name: 'Beginner', blurb: 'basic circle rules, rows of three white circles, dead ends, forced exits, and not closing the loop early' },
  Medium: { name: 'Medium', blurb: 'local multi-segment inferences, basic inside/outside shading, and 1-step local lookahead' },
  Hard: { name: 'Hard', blurb: 'circle-diagonal shading, global topology (pockets, chokepoints, paired ends), and short single-thread lookahead' },
  Expert: { name: 'Expert', blurb: 'long or multi-front lookahead chains, full multi-rule trial and error, or beyond what Hint can explain' },
};

export const beyondHints = (puzzle) => puzzle.rules === 'unsolved';
export const UNDETERMINED_WEIGHT = 100;

// ------------------------------------------------------------ helpers

export function onCount(P, st, i) {
  const ed = P.ed, e = st.e, b = i * 4;
  let n = 0;
  let x = ed[b]; if (x >= 0 && e[x] === E_ON) n++;
  x = ed[b + 1]; if (x >= 0 && e[x] === E_ON) n++;
  x = ed[b + 2]; if (x >= 0 && e[x] === E_ON) n++;
  x = ed[b + 3]; if (x >= 0 && e[x] === E_ON) n++;
  return n;
}

export function availCount(P, st, i) {
  let n = 0;
  for (let d = 0; d < 4; d++) {
    const x = P.ed[i * 4 + d];
    if (x < 0 || st.e[x] === E_OFF) continue;
    const j = P.nb[i * 4 + d];
    if (st.cell[j] === OFF) continue;
    if (st.e[x] !== E_ON && onCount(P, st, j) >= 2) continue;
    n++;
  }
  return n;
}

/** Dynamic clue helpers: zero allocation on standard puzzles (!st.hasGray). */
const clueOf = (P, st) => st.clue || P.clue;
const whitesOf = (P, st) => {
  if (!st.hasGray) return P.whites;
  const out = [...P.whites];
  const cl = st.clue;
  for (let k = 0; k < P.grays.length; k++) if (cl[P.grays[k]] === WHITE) out.push(P.grays[k]);
  return out;
};
const blacksOf = (P, st) => {
  if (!st.hasGray) return P.blacks;
  const out = [...P.blacks];
  const cl = st.clue;
  for (let k = 0; k < P.grays.length; k++) if (cl[P.grays[k]] === BLACK) out.push(P.grays[k]);
  return out;
};
const graysOf = (P, st) => {
  if (!st.hasGray) return [];
  const out = [];
  const cl = st.clue;
  for (let k = 0; k < P.grays.length; k++) if (cl[P.grays[k]] === GRAY) out.push(P.grays[k]);
  return out;
};

/** Apply [['c'|'e'|'g', idx, val], ...]. Returns false on conflict. */
export function applySets(st, sets) {
  for (const [kind, idx, v] of sets) {
    if (kind === 'g') {
      const cur = st.clue[idx];
      if (cur === v) continue;
      if (cur !== GRAY) return false;
      st.clue[idx] = v;
      continue;
    }
    const arr = kind === 'c' ? st.cell : st.e;
    if (arr[idx] === v) continue;
    if (arr[idx] !== 0) return false;
    arr[idx] = v;
  }
  return true;
}

/** Union-find over E_ON edges. Returns { find, size, loopCount, cycleRoot, cycleCount }. */
function onComponents(P, st, opts) {
  if (opts && opts.stepCache && opts.stepCache.onComp) return opts.stepCache.onComp;
  const { N, numEdges, edgeA, edgeB } = P;
  const parent = new Int16Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  let cycleRoot = -1, cycleCount = 0;
  for (let x = 0; x < numEdges; x++) {
    if (st.e[x] !== E_ON) continue;
    const ra = find(edgeA[x]), rb = find(edgeB[x]);
    if (ra === rb) { cycleRoot = ra; cycleCount++; } else parent[ra] = rb;
  }
  const size = new Int32Array(N);
  let loopCount = 0;
  for (let i = 0; i < N; i++) {
    if (st.cell[i] === LOOP) { size[find(i)]++; loopCount++; }
  }
  const res = { find, size, loopCount, cycleRoot: cycleRoot >= 0 ? find(cycleRoot) : -1, cycleCount };
  if (opts && opts.stepCache) opts.stepCache.onComp = res;
  return res;
}

let scratchOnc = new Int8Array(0);
let scratchSeen = new Uint8Array(0);
let scratchIsLoop = new Uint8Array(0);
let scratchCanOpen = new Uint8Array(0);
let scratchTin = new Int32Array(0);
let scratchLow = new Int32Array(0);
let scratchSubLoop = new Int32Array(0);
let scratchSubSize = new Int32Array(0);
let scratchSeen2 = new Uint8Array(0);
let scratchStack = new Int32Array(0);
let scratchBridge = new Uint8Array(0);

function ensureRatingScratch(N, numEdges = 0) {
  if (scratchOnc.length < N) {
    scratchOnc = new Int8Array(N);
    scratchSeen = new Uint8Array(N);
    scratchIsLoop = new Uint8Array(N);
    scratchCanOpen = new Uint8Array(N);
    scratchTin = new Int32Array(N);
    scratchLow = new Int32Array(N);
    scratchSubLoop = new Int32Array(N);
    scratchSubSize = new Int32Array(N);
    scratchSeen2 = new Uint8Array(N);
    scratchStack = new Int32Array(N);
  }
  if (numEdges > 0 && scratchBridge.length < numEdges) {
    scratchBridge = new Uint8Array(numEdges);
  }
}

/**
 * Connected components of needy cells (cell !== OFF && on < 2) linked by E_UNKNOWN edges.
 * Every future segment adds 1 to the degree of two cells in the same group, so each group must hold
 * an EVEN number of open ends (cells with on === 1).
 */
function openEndGroups(P, st) {
  const { N, ed, nb } = P;
  ensureRatingScratch(N);
  const onc = scratchOnc;
  const seen = scratchSeen;
  const stack = scratchStack;
  onc.fill(0, 0, N);
  seen.fill(0, 0, N);
  for (let x = 0; x < P.numEdges; x++) if (st.e[x] === E_ON) { onc[P.edgeA[x]]++; onc[P.edgeB[x]]++; }
  const groups = [];
  for (let i = 0; i < N; i++) {
    if (seen[i] || st.cell[i] === OFF || onc[i] >= 2) continue;
    seen[i] = 1;
    let sp = 0;
    stack[sp++] = i;
    const cells = [], ends = [];
    while (sp > 0) {
      const u = stack[--sp];
      cells.push(u);
      if (onc[u] === 1) ends.push(u);
      for (let d = 0; d < 4; d++) {
        const x = ed[u * 4 + d];
        if (x < 0 || st.e[x] !== E_UNKNOWN) continue;
        const v = nb[u * 4 + d];
        if (seen[v] || st.cell[v] === OFF || onc[v] >= 2) continue;
        seen[v] = 1;
        stack[sp++] = v;
      }
    }
    groups.push({ cells, ends });
  }
  return groups;
}

/** Smallest group with an odd number of open ends, or null if every group is even. */
export function oddOpenEnds(P, st) {
  let best = null;
  for (const g of openEndGroups(P, st)) {
    if ((g.ends.length & 1) === 1) {
      if (!best || g.cells.length < best.cells.length) best = g;
    }
  }
  return best;
}

/**
 * Full-board checkerboard (bipartite) parity check: in any connected component of needy cells,
 * every future segment links one light cell ((r+c)%2===0) to one dark cell ((r+c)%2===1),
 * so total needed segment ends on light cells must equal total needed segment ends on dark cells.
 * Returns the smallest imbalanced component or null.
 */
export function checkerImbalance(P, st) {
  if (!P.fullBoard) return null;
  const { cols } = P;
  const groups = openEndGroups(P, st);
  const onc = scratchOnc;
  let best = null;
  for (const g of groups) {
    let needLight = 0, needDark = 0;
    for (let k = 0; k < g.cells.length; k++) {
      const u = g.cells[k];
      const need = 2 - onc[u];
      if (((((u / cols) | 0) + (u % cols)) & 1) === 0) needLight += need;
      else needDark += need;
    }
    if (needLight !== needDark) {
      if (!best || g.cells.length < best.cells.length) {
        best = { cells: g.cells, ends: g.ends, needLight, needDark };
      }
    }
  }
  return best;
}

/**
 * Check connectivity and 2-vertex-connectivity (chokepoints) of LOOP cells in the active graph
 * (edges that are E_ON or E_UNKNOWN, skipping edges incident to OFF cells or full cells except their E_ON edges).
 * Returns null if OK, or { kind: 'disconnected'|'cutVertex', cut?, area: [cells] }.
 */
export function chokepointCheck(P, st, boolOnly = false, precomp = null) {
  const { N, ed, nb } = P;
  const e = st.e, cell = st.cell;
  ensureRatingScratch(N);
  let isLoop, canOpen, firstLoop, totalLoops;
  if (precomp) {
    isLoop = precomp.isLoop;
    canOpen = precomp.canOpen;
    firstLoop = precomp.firstLoop;
    totalLoops = precomp.totalLoops;
  } else {
    const onc = scratchOnc;
    isLoop = scratchIsLoop;
    canOpen = scratchCanOpen;
    onc.fill(0, 0, N);
    isLoop.fill(0, 0, N);
    for (let x = 0; x < P.numEdges; x++) if (e[x] === E_ON) { onc[P.edgeA[x]]++; onc[P.edgeB[x]]++; }
    firstLoop = -1; totalLoops = 0;
    for (let i = 0; i < N; i++) {
      const s = cell[i];
      if (s === LOOP) { if (firstLoop < 0) firstLoop = i; totalLoops++; isLoop[i] = 1; }
      canOpen[i] = (s !== OFF && onc[i] < 2) ? 1 : 0;
    }
  }
  if (totalLoops < 2) return null;

  const stack = scratchStack;
  let comp0Size = 0;
  if (!boolOnly) {
    // 1. Connectivity of all LOOP cells (also computes comp0Size for smaller-side area sizing)
    const vis = scratchSeen;
    vis.fill(0, 0, N);
    let sp = 0;
    stack[sp++] = firstLoop;
    vis[firstLoop] = 1;
    let seenLoops = 1;
    comp0Size = 1;
    while (sp > 0) {
      const u = stack[--sp];
      const u4 = u * 4, uOpen = canOpen[u];
      for (let d = 0; d < 4; d++) {
        const x = ed[u4 + d];
        if (x < 0) continue;
        const ev = e[x];
        if (ev === E_OFF) continue;
        const v = nb[u4 + d];
        if (ev !== E_ON && (!uOpen || !canOpen[v])) continue;
        if (!vis[v]) {
          vis[v] = 1;
          stack[sp++] = v;
          comp0Size++;
          if (isLoop[v]) seenLoops++;
        }
      }
    }
    if (seenLoops < totalLoops) {
      const comp0 = [], other = [];
      for (let i = 0; i < N; i++) {
        if (vis[i]) comp0.push(i);
        else if (cell[i] !== OFF) other.push(i);
      }
      return { kind: 'disconnected', area: comp0.length <= other.length ? comp0 : other };
    }
  }

  // 2. Tarjan's articulation points + subtree loop counts on the connected component of firstLoop
  const tin = scratchTin;
  const low = scratchLow;
  const subLoop = scratchSubLoop;
  const subSize = scratchSubSize;
  tin.fill(-1, 0, N);
  let timer = 0;
  let bestCut = null;

  const dfs = (u, p) => {
    tin[u] = low[u] = timer++;
    subLoop[u] = isLoop[u];
    subSize[u] = 1;
    let childWithLoop = 0;
    let smallAreaSize = N;
    const u4 = u * 4, uOpen = canOpen[u];
    for (let d = 0; d < 4; d++) {
      const x = ed[u4 + d];
      if (x < 0) continue;
      const ev = e[x];
      if (ev === E_OFF) continue;
      const v = nb[u4 + d];
      if (ev !== E_ON && (!uOpen || !canOpen[v])) continue;
      if (v === p) continue;
      if (tin[v] >= 0) {
        if (tin[v] < low[u]) low[u] = tin[v];
      } else {
        dfs(v, u);
        if (boolOnly && bestCut) return;
        subLoop[u] += subLoop[v];
        subSize[u] += subSize[v];
        if (low[v] < low[u]) low[u] = low[v];
        if (p < 0) {
          if (subLoop[v] > 0) {
            childWithLoop++;
            if (subSize[v] < smallAreaSize) smallAreaSize = subSize[v];
          }
        } else if (low[v] >= tin[u] && subLoop[v] > 0) {
          const outsideLoops = totalLoops - subLoop[v] - isLoop[u];
          if (outsideLoops > 0) {
            if (boolOnly) {
              bestCut = { kind: 'cutVertex', cut: u, seed: v, areaSize: 0 };
              return;
            }
            const sideSize = Math.min(subSize[v], comp0Size - 1 - subSize[v]);
            if (!bestCut || sideSize < bestCut.areaSize) {
              bestCut = { kind: 'cutVertex', cut: u, seed: v, areaSize: sideSize };
            }
          }
        }
      }
    }
    if (p < 0 && childWithLoop >= 2) {
      if (!bestCut || smallAreaSize < bestCut.areaSize) {
        bestCut = { kind: 'cutVertex', cut: u, seed: -1, areaSize: smallAreaSize };
      }
    }
  };
  dfs(firstLoop, -1);
  if (boolOnly) {
    if (bestCut) return { kind: 'cutVertex', cut: bestCut.cut, area: [] };
    if (subLoop[firstLoop] < totalLoops) return { kind: 'disconnected', area: [] };
    return null;
  }
  if (!bestCut) return null;

  // Collect the smaller separated area cells (excluding cut)
  const cut = bestCut.cut;
  const seen2 = scratchSeen2;
  seen2.fill(0, 0, N);
  seen2[cut] = 1;
  let smallestArea = null;
  const cut4 = cut * 4, cutOpen = canOpen[cut];
  for (let d = 0; d < 4; d++) {
    const cx = ed[cut4 + d];
    if (cx < 0) continue;
    const cev = e[cx];
    if (cev === E_OFF) continue;
    const start = nb[cut4 + d];
    if (cev !== E_ON && (!cutOpen || !canOpen[start])) continue;
    if (seen2[start]) continue;
    seen2[start] = 1;
    let qsp = 0;
    stack[qsp++] = start;
    const area = [];
    let hasL = false;
    while (qsp > 0) {
      const u = stack[--qsp];
      area.push(u);
      if (isLoop[u]) hasL = true;
      const u4 = u * 4, uOpen = canOpen[u];
      for (let dd = 0; dd < 4; dd++) {
        const x = ed[u4 + dd];
        if (x < 0) continue;
        const ev = e[x];
        if (ev === E_OFF) continue;
        const v = nb[u4 + dd];
        if (ev !== E_ON && (!uOpen || !canOpen[v])) continue;
        if (!seen2[v]) { seen2[v] = 1; stack[qsp++] = v; }
      }
    }
    if (hasL && (!smallestArea || area.length < smallestArea.length)) smallestArea = area;
  }
  return { kind: 'cutVertex', cut, area: smallestArea || [] };
}

/** Full contradiction check: easy contradictions + odd open-end parity + full-board checkerboard parity + disconnected/chokepoint loop cells. */
export function contradiction(P, st, skipEasy = false) {
  if (!skipEasy && easyContradiction(P, st)) return true;
  if (oddOpenEnds(P, st)) return true;
  if (P.fullBoard && checkerImbalance(P, st)) return true;
  if (chokepointCheck(P, st, true)) return true;
  return false;
}

setFullContradiction(contradiction);

// ------------------------------------------------------------ rule finders

function findEdgesOffCellOff(P, st) {
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] !== OFF) continue;
    const sets = [];
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
    }
    if (sets.length) out.push({ sets, info: { cell: i } });
  }
  return out;
}

function findEdgeEnds(P, st) {
  const out = [];
  for (let x = 0; x < P.numEdges; x++) {
    if (st.e[x] !== E_ON) continue;
    const a = P.edgeA[x], b = P.edgeB[x];
    const sets = [];
    if (st.cell[a] === UNKNOWN) sets.push(['c', a, LOOP]);
    if (st.cell[b] === UNKNOWN) sets.push(['c', b, LOOP]);
    if (sets.length) out.push({ sets, info: { edge: x } });
  }
  return out;
}

function findFullCell(P, st) {
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (onCount(P, st, i) !== 2) continue;
    const sets = [];
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
    }
    if (sets.length) out.push({ sets, info: { cell: i } });
  }
  return out;
}

function findIsolatedCellOff(P, st) {
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] !== UNKNOWN) continue;
    let hasOpen = false;
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] !== E_OFF) { hasOpen = true; break; }
    }
    if (!hasOpen) out.push({ sets: [['c', i, OFF]], info: { cell: i } });
  }
  return out;
}

function findClosedLoopRestOff(P, st) {
  if (!isSolved(P, st.e)) return [];
  const sets = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] === UNKNOWN) sets.push(['c', i, OFF]);
  }
  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] >= 0 && st.e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
  }
  return sets.length ? [{ sets, info: {} }] : [];
}

function findGrayFromShape(P, st) {
  if (!st.hasGray) return [];
  const sets = [];
  for (const i of graysOf(P, st)) {
    if (onCount(P, st, i) !== 2) continue;
    const u = P.ed[i * 4], r = P.ed[i * 4 + 1], dn = P.ed[i * 4 + 2], l = P.ed[i * 4 + 3];
    const straight = (u >= 0 && dn >= 0 && st.e[u] === E_ON && st.e[dn] === E_ON)
      || (r >= 0 && l >= 0 && st.e[r] === E_ON && st.e[l] === E_ON);
    sets.push(['g', i, straight ? WHITE : BLACK]);
  }
  return sets.length ? [{ sets, info: {} }] : [];
}

function canGrayBeBlackLeg(P, st, i, d) {
  const cl = clueOf(P, st);
  const x1 = P.ed[i * 4 + d], x2 = P.ed2[i * 4 + d], n1 = P.nb[i * 4 + d], n2 = P.step2[i * 4 + d];
  if (x1 < 0 || x2 < 0 || n1 < 0 || n2 < 0) return false;
  if (st.e[x1] === E_OFF || st.e[x2] === E_OFF || st.cell[n1] === OFF || st.cell[n2] === OFF) return false;
  const opp = P.ed[i * 4 + (d ^ 2)];
  if (opp >= 0 && st.e[opp] === E_ON) return false;
  if (cl[n1] === BLACK) return false;
  const p1 = P.ed[n1 * 4 + ((d + 1) & 3)], p2 = P.ed[n1 * 4 + ((d + 3) & 3)];
  return !((p1 >= 0 && st.e[p1] === E_ON) || (p2 >= 0 && st.e[p2] === E_ON));
}

function findGrayMustBeBlack(P, st) {
  if (!st.hasGray) return [];
  const out = [];
  for (const i of graysOf(P, st)) {
    const u = P.ed[i * 4 + 0], r = P.ed[i * 4 + 1], dn = P.ed[i * 4 + 2], l = P.ed[i * 4 + 3];
    const u2 = P.ed2[i * 4 + 0], r2 = P.ed2[i * 4 + 1], d2 = P.ed2[i * 4 + 2], l2 = P.ed2[i * 4 + 3];
    let vOk = u >= 0 && dn >= 0 && st.e[u] !== E_OFF && st.e[dn] !== E_OFF;
    let hOk = r >= 0 && l >= 0 && st.e[r] !== E_OFF && st.e[l] !== E_OFF;
    if ((r >= 0 && st.e[r] === E_ON) || (l >= 0 && st.e[l] === E_ON)) vOk = false;
    if ((u >= 0 && st.e[u] === E_ON) || (dn >= 0 && st.e[dn] === E_ON)) hOk = false;
    if (vOk && u2 >= 0 && st.e[u2] === E_ON && d2 >= 0 && st.e[d2] === E_ON) vOk = false;
    if (hOk && r2 >= 0 && st.e[r2] === E_ON && l2 >= 0 && st.e[l2] === E_ON) hOk = false;
    if (!vOk && !hOk) {
      const corner = (u < 0 || dn < 0) && (r < 0 || l < 0);
      let inward = false;
      for (let d = 0; d < 4; d++) {
        const x = P.ed[i * 4 + d], opp = P.ed[i * 4 + (d ^ 2)];
        if (x >= 0 && st.e[x] === E_ON && (opp < 0 || st.e[opp] === E_OFF)) inward = true;
      }
      const reason = corner ? 'corner' : inward ? 'inward' : 'blocked';
      out.push({ sets: [['g', i, BLACK]], info: { cell: i, reason } });
    }
  }
  return out;
}

function findGrayMustBeWhite(P, st) {
  if (!st.hasGray) return [];
  const out = [];
  for (const i of graysOf(P, st)) {
    const can0 = canGrayBeBlackLeg(P, st, i, 0);
    const can1 = canGrayBeBlackLeg(P, st, i, 1);
    const can2 = canGrayBeBlackLeg(P, st, i, 2);
    const can3 = canGrayBeBlackLeg(P, st, i, 3);
    const canV = can0 || can2, canH = can1 || can3;
    if (!canV || !canH) {
      let shortDir = -1;
      const canArr = [can0, can1, can2, can3];
      for (let d = 0; d < 4; d++) {
        const x = P.ed[i * 4 + d];
        if (x >= 0 && st.e[x] === E_ON && !canArr[d]) { shortDir = d; break; }
      }
      const reason = shortDir >= 0 ? 'shortLeg' : 'axisBlocked';
      const axis = !canV && !canH ? 'both' : (!canV ? 'v' : 'h');
      out.push({ sets: [['g', i, WHITE]], info: { cell: i, reason, axis, dir: shortDir } });
    }
  }
  return out;
}

function findGrayWhiteNoTurn(P, st) {
  if (!st.hasGray) return [];
  const out = [];
  for (const i of graysOf(P, st)) {
    const u = P.ed[i * 4 + 0], r = P.ed[i * 4 + 1], dn = P.ed[i * 4 + 2], l = P.ed[i * 4 + 3];
    const axisOk = (d1, d2, p1, p2) => {
      const e1 = P.ed[i * 4 + d1], e2 = P.ed[i * 4 + d2];
      if (e1 < 0 || e2 < 0 || st.e[e1] === E_OFF || st.e[e2] === E_OFF) return false;
      const ep1 = P.ed[i * 4 + p1], ep2 = P.ed[i * 4 + p2];
      if ((ep1 >= 0 && st.e[ep1] === E_ON) || (ep2 >= 0 && st.e[ep2] === E_ON)) return false;
      const r1 = forcedStraightReason(P, st, i, d1);
      const r2 = r1 ? forcedStraightReason(P, st, i, d2) : null;
      return !(r1 && r2);
    };
    if (!axisOk(0, 2, 1, 3) && !axisOk(1, 3, 0, 2)) {
      out.push({ sets: [['g', i, BLACK]], info: { cell: i } });
    }
  }
  return out;
}

function findWhiteStraight(P, st) {
  const out = [];
  for (const i of whitesOf(P, st)) {
    const u = P.ed[i * 4 + 0], r = P.ed[i * 4 + 1], dn = P.ed[i * 4 + 2], l = P.ed[i * 4 + 3];
    let vOk = u >= 0 && dn >= 0 && st.e[u] !== E_OFF && st.e[dn] !== E_OFF;
    let hOk = r >= 0 && l >= 0 && st.e[r] !== E_OFF && st.e[l] !== E_OFF;
    if ((r >= 0 && st.e[r] === E_ON) || (l >= 0 && st.e[l] === E_ON)) vOk = false;
    if ((u >= 0 && st.e[u] === E_ON) || (dn >= 0 && st.e[dn] === E_ON)) hOk = false;
    if (vOk && !hOk) {
      const sets = [];
      if (st.e[u] === E_UNKNOWN) sets.push(['e', u, E_ON]);
      if (st.e[dn] === E_UNKNOWN) sets.push(['e', dn, E_ON]);
      if (r >= 0 && st.e[r] === E_UNKNOWN) sets.push(['e', r, E_OFF]);
      if (l >= 0 && st.e[l] === E_UNKNOWN) sets.push(['e', l, E_OFF]);
      if (sets.length) out.push({ sets, info: { cell: i, axis: 'v' } });
    } else if (hOk && !vOk) {
      const sets = [];
      if (st.e[r] === E_UNKNOWN) sets.push(['e', r, E_ON]);
      if (st.e[l] === E_UNKNOWN) sets.push(['e', l, E_ON]);
      if (u >= 0 && st.e[u] === E_UNKNOWN) sets.push(['e', u, E_OFF]);
      if (dn >= 0 && st.e[dn] === E_UNKNOWN) sets.push(['e', dn, E_OFF]);
      if (sets.length) out.push({ sets, info: { cell: i, axis: 'h' } });
    }
  }
  return out;
}

function findBlackExtend(P, st) {
  const out = [];
  for (const i of blacksOf(P, st)) {
    for (let d = 0; d < 4; d++) {
      const x1 = P.ed[i * 4 + d];
      if (x1 < 0 || st.e[x1] !== E_ON) continue;
      const x2 = P.ed2[i * 4 + d], opp = P.ed[i * 4 + (d ^ 2)];
      const sets = [];
      if (x2 >= 0 && st.e[x2] === E_UNKNOWN) sets.push(['e', x2, E_ON]);
      if (opp >= 0 && st.e[opp] === E_UNKNOWN) sets.push(['e', opp, E_OFF]);
      if (sets.length) out.push({ sets, info: { cell: i, dir: d } });
    }
  }
  return out;
}

function findBlackWall(P, st) {
  const out = [];
  for (const i of blacksOf(P, st)) {
    for (let d = 0; d < 4; d++) {
      const x1 = P.ed[i * 4 + d], x2 = P.ed2[i * 4 + d], n1 = P.nb[i * 4 + d], n2 = P.step2[i * 4 + d];
      const opp1 = P.ed[i * 4 + (d ^ 2)], opp2 = P.ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      const blocked = x1 < 0 || x2 < 0 || st.e[x1] === E_OFF || st.e[x2] === E_OFF || st.cell[n1] === OFF || st.cell[n2] === OFF;
      if (!blocked) continue;
      const sets = [];
      if (x1 >= 0 && st.e[x1] === E_UNKNOWN) sets.push(['e', x1, E_OFF]);
      if (st.e[opp1] === E_UNKNOWN) sets.push(['e', opp1, E_ON]);
      if (st.e[opp2] === E_UNKNOWN) sets.push(['e', opp2, E_ON]);
      if (sets.length) out.push({ sets, info: { cell: i, dir: d ^ 2, blockedDir: d, nearEdge: x1 < 0 || x2 < 0 } });
    }
  }
  return out;
}

function findBlackAdjacent(P, st) {
  const out = [];
  const cl = clueOf(P, st);
  for (const i of blacksOf(P, st)) {
    for (let d = 0; d < 4; d++) {
      const n1 = P.nb[i * 4 + d];
      if (n1 < 0 || cl[n1] !== BLACK) continue;
      const x1 = P.ed[i * 4 + d], opp1 = P.ed[i * 4 + (d ^ 2)], opp2 = P.ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      const sets = [];
      if (st.e[x1] === E_UNKNOWN) sets.push(['e', x1, E_OFF]);
      if (st.e[opp1] === E_UNKNOWN) sets.push(['e', opp1, E_ON]);
      if (st.e[opp2] === E_UNKNOWN) sets.push(['e', opp2, E_ON]);
      if (sets.length) out.push({ sets, info: { cell: i, other: n1, dir: d ^ 2 } });
    }
  }
  return out;
}

function findWhiteMustTurn(P, st) {
  const out = [];
  for (const i of whitesOf(P, st)) {
    for (const [d1, d2] of [[0, 2], [1, 3]]) {
      const e1 = P.ed[i * 4 + d1], e2 = P.ed[i * 4 + d2];
      if (e1 < 0 || e2 < 0 || st.e[e1] !== E_ON || st.e[e2] !== E_ON) continue;
      const ext1 = P.ed2[i * 4 + d1], ext2 = P.ed2[i * 4 + d2];
      if (ext1 >= 0 && st.e[ext1] === E_ON && ext2 >= 0 && st.e[ext2] === E_UNKNOWN) {
        out.push({ sets: [['e', ext2, E_OFF]], info: { cell: i, straightEnd: P.nb[i * 4 + d1], turnEnd: P.nb[i * 4 + d2], edge: ext2 } });
      }
      if (ext2 >= 0 && st.e[ext2] === E_ON && ext1 >= 0 && st.e[ext1] === E_UNKNOWN) {
        out.push({ sets: [['e', ext1, E_OFF]], info: { cell: i, straightEnd: P.nb[i * 4 + d2], turnEnd: P.nb[i * 4 + d1], edge: ext1 } });
      }
    }
  }
  return out;
}

function findDeadEnd(P, st) {
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] !== UNKNOWN) continue;
    if (availCount(P, st, i) < 2) {
      const edgeSets = [];
      for (let d = 0; d < 4; d++) {
        const x = P.ed[i * 4 + d];
        if (x >= 0 && st.e[x] === E_UNKNOWN) edgeSets.push(['e', x, E_OFF]);
      }
      if (edgeSets.length) out.push({ sets: [['c', i, OFF], ...edgeSets], info: { cell: i } });
    }
  }
  return out;
}

function findForcedExits(P, st) {
  const out = [];
  const { N, ed, nb } = P;
  const { cell, e } = st;
  for (let i = 0; i < N; i++) {
    if (cell[i] !== LOOP) continue;
    const i4 = i * 4;
    let on = 0, uCnt = 0, u0 = -1, u1 = -1;
    for (let d = 0; d < 4; d++) {
      const x = ed[i4 + d];
      if (x < 0) continue;
      const ev = e[x];
      if (ev === E_ON) on++;
      else if (ev === E_UNKNOWN && cell[nb[i4 + d]] !== OFF) {
        if (uCnt === 0) u0 = x;
        else if (uCnt === 1) u1 = x;
        uCnt++;
      }
    }
    if (uCnt > 0 && on + uCnt === 2) {
      if (uCnt === 1) out.push({ sets: [['e', u0, E_ON]], info: { cell: i, edges: [u0] } });
      else out.push({ sets: [['e', u0, E_ON], ['e', u1, E_ON]], info: { cell: i, edges: [u0, u1] } });
    }
  }
  return out;
}

function findBlackPerp(P, st) {
  const out = [];
  for (const i of blacksOf(P, st)) {
    for (let d = 0; d < 4; d++) {
      const n1 = P.nb[i * 4 + d], x1 = P.ed[i * 4 + d];
      if (n1 < 0 || x1 < 0) continue;
      const p1 = P.ed[n1 * 4 + ((d + 1) & 3)], p2 = P.ed[n1 * 4 + ((d + 3) & 3)];
      if (!((p1 >= 0 && st.e[p1] === E_ON) || (p2 >= 0 && st.e[p2] === E_ON))) continue;
      const opp1 = P.ed[i * 4 + (d ^ 2)], opp2 = P.ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      const sets = [];
      if (st.e[x1] === E_UNKNOWN) sets.push(['e', x1, E_OFF]);
      if (st.e[opp1] === E_UNKNOWN) sets.push(['e', opp1, E_ON]);
      if (st.e[opp2] === E_UNKNOWN) sets.push(['e', opp2, E_ON]);
      if (sets.length) out.push({ sets, info: { cell: i, sideCell: n1, dir: d ^ 2 } });
    }
  }
  return out;
}

function findWhiteBothStraight(P, st) {
  const out = [];
  for (const i of whitesOf(P, st)) {
    const u = P.ed[i * 4 + 0], r = P.ed[i * 4 + 1], dn = P.ed[i * 4 + 2], l = P.ed[i * 4 + 3];
    const u2 = P.ed2[i * 4 + 0], r2 = P.ed2[i * 4 + 1], d2 = P.ed2[i * 4 + 2], l2 = P.ed2[i * 4 + 3];
    if (u2 >= 0 && st.e[u2] === E_ON && d2 >= 0 && st.e[d2] === E_ON && r >= 0 && l >= 0) {
      const sets = [];
      if (st.e[r] === E_UNKNOWN) sets.push(['e', r, E_ON]);
      if (st.e[l] === E_UNKNOWN) sets.push(['e', l, E_ON]);
      if (u >= 0 && st.e[u] === E_UNKNOWN) sets.push(['e', u, E_OFF]);
      if (dn >= 0 && st.e[dn] === E_UNKNOWN) sets.push(['e', dn, E_OFF]);
      if (sets.length) out.push({ sets, info: { cell: i, axis: 'h', blockedAxis: 'v' } });
    }
    if (r2 >= 0 && st.e[r2] === E_ON && l2 >= 0 && st.e[l2] === E_ON && u >= 0 && dn >= 0) {
      const sets = [];
      if (st.e[u] === E_UNKNOWN) sets.push(['e', u, E_ON]);
      if (st.e[dn] === E_UNKNOWN) sets.push(['e', dn, E_ON]);
      if (r >= 0 && st.e[r] === E_UNKNOWN) sets.push(['e', r, E_OFF]);
      if (l >= 0 && st.e[l] === E_UNKNOWN) sets.push(['e', l, E_OFF]);
      if (sets.length) out.push({ sets, info: { cell: i, axis: 'v', blockedAxis: 'h' } });
    }
  }
  return out;
}

function findNoEarlyClose(P, st, opts) {
  const { find, size, loopCount, cycleRoot } = onComponents(P, st, opts);
  if (cycleRoot >= 0) return [];
  const out = [];
  for (let x = 0; x < P.numEdges; x++) {
    if (st.e[x] !== E_UNKNOWN) continue;
    const a = P.edgeA[x], b = P.edgeB[x];
    if (a < 0) continue;
    const ra = find(a);
    if (ra !== find(b)) continue;
    const missesLoop = size[ra] < loopCount;
    const slFace = missesLoop ? -1 : firstUnsatisfiedSlitherOnClose(P, st, x);
    const midIdx = (missesLoop || slFace >= 0) ? -1 : firstUnsatisfiedMidloopOnClose(P, st, x);
    if (missesLoop || slFace >= 0 || midIdx >= 0) {
      const info = slFace >= 0 ? { edge: x, a, b, slitherFace: slFace }
        : midIdx >= 0 ? { edge: x, a, b, midIdx }
        : { edge: x, a, b };
      out.push({ sets: [['e', x, E_OFF]], info });
    }
  }
  return out;
}

function findSamePathExits(P, st, opts) {
  const { find, size, loopCount, cycleRoot } = onComponents(P, st, opts);
  if (cycleRoot >= 0) return [];
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] !== LOOP || onCount(P, st, i) !== 0) continue;
    const exits = [];
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] === E_UNKNOWN && st.cell[P.nb[i * 4 + d]] !== OFF) exits.push([x, P.nb[i * 4 + d]]);
    }
    if (exits.length !== 3) continue;
    for (const [p, q, r] of [[0, 1, 2], [0, 2, 1], [1, 2, 0]]) {
      const ra = find(exits[p][1]), rb = find(exits[q][1]);
      if (ra === rb && size[ra] >= 2 && size[ra] + 1 < loopCount) {
        out.push({ sets: [['e', exits[r][0], E_ON]], info: { cell: i, a: exits[p][1], b: exits[q][1], edge: exits[r][0] } });
        break;
      }
    }
  }
  return out;
}

function findClosingCell(P, st, opts) {
  const { find, size, loopCount, cycleRoot } = onComponents(P, st, opts);
  if (cycleRoot >= 0) return [];
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] !== UNKNOWN) continue;
    const exits = [];
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] === E_UNKNOWN && st.cell[P.nb[i * 4 + d]] !== OFF) exits.push([x, P.nb[i * 4 + d]]);
    }
    if (exits.length !== 2) continue;
    const ra = find(exits[0][1]), rb = find(exits[1][1]);
    if (ra === rb && size[ra] >= 2 && size[ra] < loopCount) {
      out.push({
        sets: [['c', i, OFF], ['e', exits[0][0], E_OFF], ['e', exits[1][0], E_OFF]],
        info: { cell: i, a: exits[0][1], b: exits[1][1] },
      });
    }
  }
  return out;
}

function findThreeWhites(P, st) {
  const out = [];
  const cl = clueOf(P, st);
  for (const mid of whitesOf(P, st)) {
    for (const [d1, d2, p1, p2] of [[1, 3, 0, 2], [0, 2, 1, 3]]) {
      const a = P.nb[mid * 4 + d1], b = P.nb[mid * 4 + d2];
      if (a < 0 || b < 0 || cl[a] !== WHITE || cl[b] !== WHITE) continue;
      // All three must cross along (p1, p2); push each shared (d1,d2) edge once
      const sets = [];
      let ok = true;
      for (const c of [a, mid, b]) {
        const ep1 = P.ed[c * 4 + p1], ep2 = P.ed[c * 4 + p2];
        if (ep1 < 0 || ep2 < 0) { ok = false; break; }
        if (st.e[ep1] === E_UNKNOWN) sets.push(['e', ep1, E_ON]);
        if (st.e[ep2] === E_UNKNOWN) sets.push(['e', ep2, E_ON]);
      }
      if (!ok) continue;
      for (const x of [P.ed[a * 4 + d1], P.ed[mid * 4 + d1], P.ed[mid * 4 + d2], P.ed[b * 4 + d2]]) {
        if (x >= 0 && st.e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
      }
      if (sets.length) out.push({ sets, info: { cells: [a, mid, b], axis: p1 === 0 ? 'v' : 'h' } });
    }
  }
  return out;
}

function findTwoWhitesStraight(P, st) {
  const out = [];
  const cl = clueOf(P, st);
  for (const w1 of whitesOf(P, st)) {
    for (let d = 0; d < 4; d++) {
      const w2 = P.nb[w1 * 4 + d];
      if (w2 < 0 || cl[w2] !== WHITE) continue;
      // If edge continuing straight past w1 (opposite side from w2) is ON, w1 and w2 cannot connect along d
      const far = P.ed2[w1 * 4 + (d ^ 2)];
      if (far < 0 || st.e[far] !== E_ON) continue;
      const p1 = (d + 1) & 3, p2 = (d + 3) & 3;
      const sets = [];
      let ok = true;
      for (const c of [w1, w2]) {
        const ep1 = P.ed[c * 4 + p1], ep2 = P.ed[c * 4 + p2];
        if (ep1 < 0 || ep2 < 0) { ok = false; break; }
        if (st.e[ep1] === E_UNKNOWN) sets.push(['e', ep1, E_ON]);
        if (st.e[ep2] === E_UNKNOWN) sets.push(['e', ep2, E_ON]);
      }
      if (!ok) continue;
      for (const x of [P.ed[w1 * 4 + (d ^ 2)], P.ed[w1 * 4 + d], P.ed[w2 * 4 + d]]) {
        if (x >= 0 && st.e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
      }
      if (sets.length) out.push({ sets, info: { w1, w2, farEdge: far, axis: p1 === 0 || p2 === 0 ? 'v' : 'h' } });
    }
  }
  return out;
}

/** Why cell `n` cannot turn 90° if entered from direction `d` (moving along `d`), or null if it can turn. */
function forcedStraightReason(P, st, i, d) {
  const n = P.nb[i * 4 + d];
  if (n < 0) return null;
  const ext = P.ed[n * 4 + d];
  if (ext >= 0 && st.e[ext] === E_ON) return 'straight';
  if (clueOf(P, st)[n] === WHITE) return 'white';
  const p1 = P.ed[n * 4 + ((d + 1) & 3)], p2 = P.ed[n * 4 + ((d + 3) & 3)];
  const can1 = p1 >= 0 && st.e[p1] !== E_OFF && st.cell[P.nb[n * 4 + ((d + 1) & 3)]] !== OFF;
  const can2 = p2 >= 0 && st.e[p2] !== E_OFF && st.cell[P.nb[n * 4 + ((d + 3) & 3)]] !== OFF;
  return !can1 && !can2 ? 'blocked' : null;
}

function findWhiteNoTurnAxis(P, st) {
  const out = [];
  for (const i of whitesOf(P, st)) {
    for (const [d1, d2, p1, p2] of [[0, 2, 1, 3], [1, 3, 0, 2]]) {
      const e1 = P.ed[i * 4 + d1], e2 = P.ed[i * 4 + d2];
      if (e1 < 0 || e2 < 0 || st.e[e1] === E_OFF || st.e[e2] === E_OFF) continue;
      const r1 = forcedStraightReason(P, st, i, d1);
      const r2 = r1 ? forcedStraightReason(P, st, i, d2) : null;
      if (r1 && r2) {
        const ep1 = P.ed[i * 4 + p1], ep2 = P.ed[i * 4 + p2];
        if (ep1 < 0 || ep2 < 0) continue;
        const sets = [];
        if (st.e[ep1] === E_UNKNOWN) sets.push(['e', ep1, E_ON]);
        if (st.e[ep2] === E_UNKNOWN) sets.push(['e', ep2, E_ON]);
        if (st.e[e1] === E_UNKNOWN) sets.push(['e', e1, E_OFF]);
        if (st.e[e2] === E_UNKNOWN) sets.push(['e', e2, E_OFF]);
        if (sets.length) {
          out.push({
            sets,
            info: {
              cell: i,
              ends: [P.nb[i * 4 + d1], P.nb[i * 4 + d2]],
              reasons: [r1, r2],
              axis: p1 === 0 ? 'v' : 'h',
              blockedAxis: p1 === 0 ? 'h' : 'v',
            },
          });
        }
      }
    }
  }
  return out;
}

function findBlackBlockedTarget(P, st) {
  const out = [];
  const cl = clueOf(P, st);
  for (const i of blacksOf(P, st)) {
    for (let d = 0; d < 4; d++) {
      const x1 = P.ed[i * 4 + d], x2 = P.ed2[i * 4 + d], n2 = P.step2[i * 4 + d];
      if (x1 < 0 || x2 < 0 || n2 < 0 || st.e[x1] === E_OFF || st.e[x2] === E_OFF) continue;
      let bad = false, reason = '';
      if (cl[n2] === WHITE) {
        const nextE = P.ed[n2 * 4 + d];
        if (nextE < 0 || st.e[nextE] === E_OFF) { bad = true; reason = 'whiteWall'; }
      } else if (cl[n2] === BLACK) {
        const nextE = P.ed[n2 * 4 + d];
        if (nextE >= 0 && st.e[nextE] === E_ON) { bad = true; reason = 'blackStraight'; }
      }
      if (!bad) continue;
      const opp1 = P.ed[i * 4 + (d ^ 2)], opp2 = P.ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      const sets = [];
      if (st.e[x1] === E_UNKNOWN) sets.push(['e', x1, E_OFF]);
      if (st.e[opp1] === E_UNKNOWN) sets.push(['e', opp1, E_ON]);
      if (st.e[opp2] === E_UNKNOWN) sets.push(['e', opp2, E_ON]);
      if (sets.length) out.push({ sets, info: { cell: i, target: n2, dir: d ^ 2, reason } });
    }
  }
  return out;
}

/**
 * A black circle flanked by two diagonally adjacent white circles on one side (e.g. NW and NE)
 * cannot extend between them: doing so would force both whites perpendicular into the black's
 * side neighbors, leaving no room for the black's second leg. So it extends two cells the opposite way.
 */
function findBlackTwoDiagWhites(P, st) {
  const out = [];
  const cl = clueOf(P, st);
  for (const i of blacksOf(P, st)) {
    for (let d = 0; d < 4; d++) {
      const mid = P.nb[i * 4 + d];
      if (mid < 0) continue;
      const w1 = P.nb[mid * 4 + ((d + 1) & 3)];
      const w2 = P.nb[mid * 4 + ((d + 3) & 3)];
      if (w1 < 0 || w2 < 0 || cl[w1] !== WHITE || cl[w2] !== WHITE) continue;
      const x = P.ed[i * 4 + d];
      if (x < 0 || st.e[x] === E_ON) continue;
      const opp1 = P.ed[i * 4 + (d ^ 2)], opp2 = P.ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      const sets = [];
      if (st.e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
      if (st.e[opp1] === E_UNKNOWN) sets.push(['e', opp1, E_ON]);
      if (st.e[opp2] === E_UNKNOWN) sets.push(['e', opp2, E_ON]);
      if (sets.length) out.push({ sets, info: { cell: i, whites: [w1, w2], blockedDir: d, dir: d ^ 2 } });
    }
  }
  return out;
}

/**
 * A black circle cannot send its 2-step ray into a white circle 2 cells away if the intersection
 * beyond that white cannot turn (e.g. another white circle, already straight, or both turns blocked).
 */
function findBlackWhiteNoTurn(P, st) {
  const out = [];
  const cl = clueOf(P, st);
  for (const i of blacksOf(P, st)) {
    for (let d = 0; d < 4; d++) {
      const x1 = P.ed[i * 4 + d], x2 = P.ed2[i * 4 + d], n2 = P.step2[i * 4 + d];
      if (x1 < 0 || x2 < 0 || n2 < 0 || cl[n2] !== WHITE) continue;
      if (st.e[x1] === E_ON || st.e[x1] === E_OFF || st.e[x2] === E_OFF) continue;
      const nextE = P.ed[n2 * 4 + d];
      if (nextE < 0 || st.e[nextE] === E_OFF) continue; // handled by blackBlockedTarget
      const reason = forcedStraightReason(P, st, n2, d);
      if (!reason) continue;
      const opp1 = P.ed[i * 4 + (d ^ 2)], opp2 = P.ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      const sets = [];
      if (st.e[x1] === E_UNKNOWN) sets.push(['e', x1, E_OFF]);
      if (st.e[opp1] === E_UNKNOWN) sets.push(['e', opp1, E_ON]);
      if (st.e[opp2] === E_UNKNOWN) sets.push(['e', opp2, E_ON]);
      if (sets.length) {
        out.push({ sets, info: { cell: i, target: n2, farCell: P.nb[n2 * 4 + d], dir: d ^ 2, reason } });
      }
    }
  }
  return out;
}

/**
 * A black circle at one end of an open path cannot extend two cells straight into the other end
 * of that same path while other loop cells lie outside (closing the loop early).
 */
function findBlackNoEarlyClose(P, st, opts) {
  const blacks = blacksOf(P, st);
  if (!blacks.length) return [];
  const { find, size, loopCount, cycleRoot } = onComponents(P, st, opts);
  if (cycleRoot >= 0) return [];
  const out = [];
  for (const i of blacks) {
    if (onCount(P, st, i) !== 1) continue;
    const ra = find(i);
    if (size[ra] < 2) continue;
    for (let d = 0; d < 4; d++) {
      const x1 = P.ed[i * 4 + d], x2 = P.ed2[i * 4 + d];
      const n1 = P.nb[i * 4 + d], n2 = P.step2[i * 4 + d];
      if (x1 < 0 || x2 < 0 || n1 < 0 || n2 < 0) continue;
      if (st.e[x1] !== E_UNKNOWN || st.e[x2] !== E_UNKNOWN) continue;
      if (onCount(P, st, n1) !== 0 || onCount(P, st, n2) !== 1) continue;
      if (find(n2) !== ra) continue;
      const covered = size[ra] + (st.cell[n1] === LOOP ? 1 : 0);
      if (covered >= loopCount) continue;
      const opp1 = P.ed[i * 4 + (d ^ 2)], opp2 = P.ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      const sets = [['e', x1, E_OFF]];
      if (st.e[opp1] === E_UNKNOWN) sets.push(['e', opp1, E_ON]);
      if (st.e[opp2] === E_UNKNOWN) sets.push(['e', opp2, E_ON]);
      out.push({ sets, info: { cell: i, target: n2, mid: n1, blockedDir: d, dir: d ^ 2 } });
    }
  }
  return out;
}

/**
 * White corner pinch: if an empty corner intersection diagonally adjacent to a white circle has only
 * two exits left — pointing to the white's two orthogonal neighbors — and both of those neighbors
 * already have a drawn segment (not touching the white), entering the corner would fill both
 * neighbors to degree 2 and block the white circle on both axes. So the corner cannot be visited.
 */
function findWhiteCornerPinch(P, st) {
  const out = [];
  for (const w of whitesOf(P, st)) {
    for (const d1 of [0, 2]) {
      const u = P.nb[w * 4 + d1];
      if (u < 0) continue;
      const wu = P.ed[w * 4 + d1];
      if (st.e[wu] !== E_UNKNOWN || onCount(P, st, u) < 1) continue;
      for (const d2 of [1, 3]) {
        const v = P.nb[w * 4 + d2];
        if (v < 0) continue;
        const wv = P.ed[w * 4 + d2];
        if (st.e[wv] !== E_UNKNOWN || onCount(P, st, v) < 1) continue;
        const k = P.nb[u * 4 + d2];
        if (k < 0 || st.cell[k] !== UNKNOWN || onCount(P, st, k) !== 0) continue;
        const eku = P.ed[k * 4 + (d2 ^ 2)], ekv = P.ed[k * 4 + (d1 ^ 2)];
        if (st.e[eku] !== E_UNKNOWN || st.e[ekv] !== E_UNKNOWN) continue;
        const eo1 = P.ed[k * 4 + d1], eo2 = P.ed[k * 4 + d2];
        if ((eo1 >= 0 && st.e[eo1] !== E_OFF) || (eo2 >= 0 && st.e[eo2] !== E_OFF)) continue;
        out.push({
          sets: [['e', eku, E_OFF], ['e', ekv, E_OFF], ['c', k, OFF]],
          info: { cell: k, white: w, neighbors: [u, v] },
        });
      }
    }
  }
  return out;
}

/**
 * White dead-end pinch (twin of whiteCornerPinch): in a 2x2 square (w, u, v, k) around white circle w,
 * if v and diagonal corner k each already have 1 segment while empty neighbor u has only 2 exits left
 * (u-k and u-w), drawing v-k fills v (blocking w on one axis) and turns u into a dead end (blocking w
 * on the other axis). So v-k must be crossed out.
 */
function findWhiteDeadEndPinch(P, st) {
  const out = [];
  const seen = new Set();
  for (const w of whitesOf(P, st)) {
    for (let d1 = 0; d1 < 4; d1++) {
      const u = P.nb[w * 4 + d1];
      if (u < 0 || st.cell[u] !== UNKNOWN || onCount(P, st, u) !== 0 || availCount(P, st, u) !== 2) continue;
      const wu = P.ed[w * 4 + d1];
      if (st.e[wu] !== E_UNKNOWN) continue;
      for (const d2 of [(d1 + 1) & 3, (d1 + 3) & 3]) {
        const v = P.nb[w * 4 + d2];
        if (v < 0 || onCount(P, st, v) !== 1) continue;
        const wv = P.ed[w * 4 + d2];
        if (st.e[wv] !== E_UNKNOWN) continue;
        const k = P.nb[u * 4 + d2];
        if (k < 0 || onCount(P, st, k) !== 1) continue;
        const uk = P.ed[u * 4 + d2], vk = P.ed[v * 4 + d1];
        if (st.e[uk] !== E_UNKNOWN || st.e[vk] !== E_UNKNOWN) continue;
        if (seen.has(vk)) continue;
        seen.add(vk);
        out.push({
          sets: [['e', vk, E_OFF]],
          info: { edge: vk, white: w, dead: u, active: [v, k] },
        });
      }
    }
  }
  return out;
}

/**
 * 2x2 box strand: for an unknown edge a-b where a and b each already have 1 segment, look at an adjacent
 * 2x2 square (a, b, c, d) whose opposite cells c and d each have only 2 unknown exits left (a-c, c-d, b-d)
 * and exactly one of {c, d} already has 1 segment. Drawing a-b fills both a and b, cutting off both escapes
 * a-c and b-d simultaneously and stranding the open end inside {c, d}. So a-b must be crossed out.
 */
function findBoxStrand(P, st) {
  const out = [];
  for (let x = 0; x < P.numEdges; x++) {
    if (st.e[x] !== E_UNKNOWN) continue;
    const a = P.edgeA[x], b = P.edgeB[x];
    if (a < 0) continue;
    if (onCount(P, st, a) !== 1 || onCount(P, st, b) !== 1) continue;
    const horiz = (x & 1) === 0;
    const pds = horiz ? [0, 2] : [1, 3];
    for (const pd of pds) {
      const c = P.nb[a * 4 + pd], d = P.nb[b * 4 + pd];
      if (c < 0 || d < 0 || st.cell[c] === OFF || st.cell[d] === OFF) continue;
      const eac = P.ed[a * 4 + pd], ebd = P.ed[b * 4 + pd];
      const ecd = horiz ? P.ed[c * 4 + 1] : P.ed[c * 4 + 2];
      if (eac < 0 || ebd < 0 || ecd < 0) continue;
      if (st.e[eac] !== E_UNKNOWN || st.e[ebd] !== E_UNKNOWN || st.e[ecd] !== E_UNKNOWN) continue;
      const onc = onCount(P, st, c), ond = onCount(P, st, d);
      if ((onc === 1 && ond === 0) || (onc === 0 && ond === 1)) {
        if (availCount(P, st, c) - onc !== 2 || availCount(P, st, d) - ond !== 2) continue;
        out.push({
          sets: [['e', x, E_OFF]],
          info: { edge: x, a, b, active: onc === 1 ? c : d, stranded: onc === 1 ? d : c },
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Forced corridor early close (multi-cell generalization of closingCell): a chain of 2+ empty 2-exit
 * cells connecting the two ends of one open path while other loop cells lie outside cannot be entered,
 * so every edge and cell in the corridor is off the loop.
 */
function findCorridorNoEarlyClose(P, st, opts) {
  const { find, size, loopCount, cycleRoot } = onComponents(P, st, opts);
  if (cycleRoot >= 0) return [];
  const isCorr = new Uint8Array(P.N);
  const exitsOf = new Array(P.N);
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] !== UNKNOWN || onCount(P, st, i) !== 0) continue;
    const ex = [];
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] === E_UNKNOWN && st.cell[P.nb[i * 4 + d]] !== OFF) ex.push([x, P.nb[i * 4 + d]]);
    }
    if (ex.length === 2) { isCorr[i] = 1; exitsOf[i] = ex; }
  }

  const visited = new Uint8Array(P.N);
  const out = [];
  for (let start = 0; start < P.N; start++) {
    if (!isCorr[start] || visited[start]) continue;
    const walk = (firstEdge, firstNbr) => {
      const cells = [], edges = [firstEdge];
      let prev = start, cur = firstNbr;
      while (isCorr[cur]) {
        if (cur === start) return { closed: true, term: start, cells, edges };
        visited[cur] = 1;
        cells.push(cur);
        const [e0, e1] = exitsOf[cur];
        const next = e0[1] === prev ? e1 : e0;
        edges.push(next[0]);
        prev = cur;
        cur = next[1];
      }
      return { closed: false, term: cur, cells, edges };
    };
    visited[start] = 1;
    const w1 = walk(exitsOf[start][0][0], exitsOf[start][0][1]);
    if (w1.closed) continue;
    const w2 = walk(exitsOf[start][1][0], exitsOf[start][1][1]);
    if (w2.closed) continue;
    const cells = [...w1.cells.reverse(), start, ...w2.cells];
    if (cells.length < 2) continue; // length 1 handled by closingCell
    const t1 = w1.term, t2 = w2.term;
    if (t1 === t2 || onCount(P, st, t1) !== 1 || onCount(P, st, t2) !== 1) continue;
    const ra = find(t1);
    if (ra !== find(t2) || size[ra] < 2 || size[ra] >= loopCount) continue;
    const edges = [...w1.edges.reverse(), ...w2.edges];
    const sets = [];
    for (const c of cells) sets.push(['c', c, OFF]);
    for (const x of edges) sets.push(['e', x, E_OFF]);
    out.push({ sets, info: { cells, edges, a: t1, b: t2 } });
  }
  return out;
}

function findTwoEndsJoin(P, st, opts) {
  const { find, size, loopCount, cycleRoot } = onComponents(P, st, opts);
  if (cycleRoot >= 0) return [];
  const out = [];
  for (const g of openEndGroups(P, st)) {
    if (g.ends.length !== 2) continue;
    const [u, v] = g.ends;
    const ru = find(u), rv = find(v);
    if (ru === rv) continue; // already same path (contradiction handled elsewhere)
    // Count distinct LOOP cells in path(u) U path(v) U g.cells
    const inArea = new Set(g.cells);
    let covered = size[ru] + size[rv];
    for (const c of g.cells) if (st.cell[c] === LOOP && find(c) !== ru && find(c) !== rv) covered++;
    if (covered >= loopCount) continue; // joining their far ends wouldn't leave any LOOP cell outside
    // Find the far ends of path(u) and path(v)
    const farEnd = (start, root) => {
      for (let i = 0; i < P.N; i++) {
        if (i !== start && st.cell[i] === LOOP && find(i) === root && onCount(P, st, i) === 1) return i;
      }
      return -1;
    };
    const uFar = farEnd(u, ru), vFar = farEnd(v, rv);
    if (uFar < 0 || vFar < 0) continue;
    // If there is an undecided edge directly between uFar and vFar (and outside g), it cannot be ON
    for (let d = 0; d < 4; d++) {
      if (P.nb[uFar * 4 + d] === vFar) {
        const x = P.ed[uFar * 4 + d];
        if (x >= 0 && st.e[x] === E_UNKNOWN && !(inArea.has(uFar) && inArea.has(vFar))) {
          out.push({ sets: [['e', x, E_OFF]], info: { edge: x, u, v, uFar, vFar, area: g.cells } });
        }
      }
    }
  }
  return out;
}

function computeAllChokepoints(P, st) {
  const { N, numEdges, edgeA, edgeB } = P;
  const out = [];
  const onc = new Int8Array(N);
  const isLoop = new Uint8Array(N);
  const canOpen = new Uint8Array(N);
  for (let x = 0; x < numEdges; x++) if (st.e[x] === E_ON) { onc[edgeA[x]]++; onc[edgeB[x]]++; }
  let firstLoop = -1, totalLoops = 0;
  for (let i = 0; i < N; i++) {
    const s = st.cell[i];
    if (s === LOOP) { if (firstLoop < 0) firstLoop = i; totalLoops++; isLoop[i] = 1; }
    canOpen[i] = (s !== OFF && onc[i] < 2) ? 1 : 0;
  }
  if (totalLoops < 2) return out;
  const precomp = { isLoop, canOpen, firstLoop, totalLoops };
  if (chokepointCheck(P, st, true, precomp)) return out;
  const s2 = cloneState(st);
  for (let x = 0; x < numEdges; x++) {
    if (st.e[x] !== E_UNKNOWN) continue;
    const a = edgeA[x];
    if (a < 0) continue;
    const b = edgeB[x];
    if (!canOpen[a] || !canOpen[b]) continue;
    s2.e[x] = E_OFF;
    const hit = chokepointCheck(P, s2, true, precomp);
    if (hit) {
      const ck = chokepointCheck(P, s2, false, precomp);
      if (ck) out.push({ sets: [['e', x, E_ON]], info: { edge: x, kind: ck.kind, cut: ck.cut, area: ck.area } });
    }
    s2.e[x] = E_UNKNOWN;
  }
  out.sort((p, q) => p.info.area.length - q.info.area.length);
  return out;
}

function findChokepoint(smallOnly) {
  return (P, st, opts) => {
    const cache = opts && opts.stepCache;
    const all = cache ? (cache.chokepoints || (cache.chokepoints = computeAllChokepoints(P, st))) : computeAllChokepoints(P, st);
    return all.filter((f) => (f.info.area.length <= 12) === smallOnly);
  };
}

/**
 * Mark bridges of the needy-cell unknown-edge graph G_unk(st) in `scratchBridge` (single O(N) Tarjan DFS).
 * When st has no existing odd open-end component:
 *   - Setting E_OFF on a non-bridge edge cannot disconnect any component or change any open-end parity.
 *   - Setting E_ON on a non-bridge edge whose endpoints both have onc===0 keeps both endpoints needy
 *     and adds +2 open ends to the same component, so parity cannot change.
 */
function markUnknownBridges(P, st, onc) {
  const { N, numEdges, ed, nb } = P;
  ensureRatingScratch(N, numEdges);
  const tin = scratchTin, low = scratchLow, bridge = scratchBridge;
  tin.fill(-1, 0, N);
  bridge.fill(0, 0, numEdges);
  let timer = 0;
  const dfs = (u, parentEdge) => {
    tin[u] = low[u] = timer++;
    const u4 = u * 4;
    for (let d = 0; d < 4; d++) {
      const x = ed[u4 + d];
      if (x < 0 || x === parentEdge || st.e[x] !== E_UNKNOWN) continue;
      const v = nb[u4 + d];
      if (st.cell[v] === OFF || onc[v] >= 2) continue;
      if (tin[v] >= 0) {
        if (tin[v] < low[u]) low[u] = tin[v];
      } else {
        dfs(v, x);
        if (low[v] < low[u]) low[u] = low[v];
        if (low[v] > tin[u]) bridge[x] = 1;
      }
    }
  };
  for (let i = 0; i < N; i++) {
    if (tin[i] < 0 && st.cell[i] !== OFF && onc[i] < 2) dfs(i, -1);
  }
  return bridge;
}

function computeAllParities(P, st) {
  const { N, numEdges, edgeA, edgeB } = P;
  const out = [];
  const onc = new Int8Array(N);
  for (let x = 0; x < numEdges; x++) if (st.e[x] === E_ON) { onc[edgeA[x]]++; onc[edgeB[x]]++; }
  if (oddOpenEnds(P, st) !== null) return out;
  const bridge = markUnknownBridges(P, st, onc);
  const s2 = cloneState(st);
  for (let x = 0; x < numEdges; x++) {
    if (st.e[x] !== E_UNKNOWN) continue;
    const a = edgeA[x];
    if (a < 0) continue;
    const b = edgeB[x];
    if (st.cell[a] === OFF || st.cell[b] === OFF) continue;
    const isB = !bridge || bridge[x] === 1;
    const tryOn = isB || onc[a] >= 1 || onc[b] >= 1;
    const tryOff = isB;
    if (tryOn) {
      s2.e[x] = E_ON;
      const easy = easyContradiction(P, s2);
      const odd = easy ? null : oddOpenEnds(P, s2);
      s2.e[x] = E_UNKNOWN;
      if (odd) {
        out.push({ sets: [['e', x, E_OFF]], info: { edge: x, hyp: E_ON, ends: odd.ends, area: odd.cells } });
      }
    }
    if (tryOff) {
      s2.e[x] = E_OFF;
      const easy = easyContradiction(P, s2);
      const odd = easy ? null : oddOpenEnds(P, s2);
      s2.e[x] = E_UNKNOWN;
      if (odd) {
        out.push({ sets: [['e', x, E_ON]], info: { edge: x, hyp: E_OFF, ends: odd.ends, area: odd.cells } });
      }
    }
  }
  out.sort((p, q) => p.info.area.length - q.info.area.length);
  return out;
}

function findParity(smallOnly) {
  return (P, st, opts) => {
    const cache = opts && opts.stepCache;
    const all = cache ? (cache.parities || (cache.parities = computeAllParities(P, st))) : computeAllParities(P, st);
    return all.filter((f) => (f.info.ends.length <= 3 && f.info.area.length <= 9) === smallOnly);
  };
}

/**
 * Full-board checkerboard (bipartite) parity deductions:
 *   1. Single-edge seal: if drawing/crossing an edge seals off a component with unequal light/dark needed ends.
 *   2. Rectangle/band saturation: on a row/col band, corner quadrant, or small rectangle (<= 4x4),
 *      if `diff = needLight - needDark` equals `kL` (all light exits ON, all dark exits OFF)
 *      or `-kD` (all dark exits ON, all light exits OFF).
 */
function computeAllChecker(P, st) {
  if (!P.fullBoard) return [];
  const { rows, cols, N, numEdges, ed, nb, edgeA, edgeB } = P;
  if (checkerImbalance(P, st) !== null) return [];
  const onc = new Int8Array(N);
  for (let x = 0; x < numEdges; x++) if (st.e[x] === E_ON) { onc[edgeA[x]]++; onc[edgeB[x]]++; }
  for (let i = 0; i < N; i++) if (onc[i] > 2) return [];

  const out = [];
  const seenSig = new Set();
  const pushUnique = (sets, info) => {
    const sig = sets.map(([k, x, v]) => `${k}:${x}:${v}`).sort().join('|');
    if (seenSig.has(sig)) return;
    seenSig.add(sig);
    out.push({ sets, info });
  };

  // 1. Single-edge seal (mirrors computeAllParities using Tarjan bridges + degree-1 endpoints)
  const bridge = markUnknownBridges(P, st, onc);
  const s2 = cloneState(st);
  for (let x = 0; x < numEdges; x++) {
    if (st.e[x] !== E_UNKNOWN) continue;
    const a = edgeA[x];
    if (a < 0) continue;
    const b = edgeB[x];
    if (onc[a] >= 2 || onc[b] >= 2) continue;
    const isB = !bridge || bridge[x] === 1;
    if (isB || onc[a] >= 1 || onc[b] >= 1) {
      s2.e[x] = E_ON;
      const imb = easyContradiction(P, s2) ? null : checkerImbalance(P, s2);
      s2.e[x] = E_UNKNOWN;
      if (imb) {
        pushUnique([['e', x, E_OFF]], {
          mode: 'hyp', edge: x, hyp: E_ON, area: imb.cells,
          needLight: imb.needLight, needDark: imb.needDark,
        });
      }
    }
    if (isB) {
      s2.e[x] = E_OFF;
      const imb = easyContradiction(P, s2) ? null : checkerImbalance(P, s2);
      s2.e[x] = E_UNKNOWN;
      if (imb) {
        pushUnique([['e', x, E_ON]], {
          mode: 'hyp', edge: x, hyp: E_OFF, area: imb.cells,
          needLight: imb.needLight, needDark: imb.needDark,
        });
      }
    }
  }

  // 2. Multi-exit rectangle / band saturation (row cuts, col cuts, corner quadrants, small rects <= 4x4)
  const checkRect = (r1, r2, c1, c2) => {
    let needLight = 0, needDark = 0;
    const lightExits = [], darkExits = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const u = r * cols + c;
        if (st.cell[u] === OFF) continue;
        const need = 2 - onc[u];
        if (need <= 0) continue;
        const isLight = ((r + c) & 1) === 0;
        if (isLight) needLight += need; else needDark += need;
        const u4 = u * 4;
        if (r === r1 && r > 0) {
          const x = ed[u4 + 0];
          if (x >= 0 && st.e[x] === E_UNKNOWN && onc[nb[u4 + 0]] < 2) (isLight ? lightExits : darkExits).push(x);
        }
        if (r === r2 && r + 1 < rows) {
          const x = ed[u4 + 2];
          if (x >= 0 && st.e[x] === E_UNKNOWN && onc[nb[u4 + 2]] < 2) (isLight ? lightExits : darkExits).push(x);
        }
        if (c === c1 && c > 0) {
          const x = ed[u4 + 3];
          if (x >= 0 && st.e[x] === E_UNKNOWN && onc[nb[u4 + 3]] < 2) (isLight ? lightExits : darkExits).push(x);
        }
        if (c === c2 && c + 1 < cols) {
          const x = ed[u4 + 1];
          if (x >= 0 && st.e[x] === E_UNKNOWN && onc[nb[u4 + 1]] < 2) (isLight ? lightExits : darkExits).push(x);
        }
      }
    }
    const kL = lightExits.length, kD = darkExits.length;
    if (kL + kD === 0) return;
    const diff = needLight - needDark;
    if (diff > kL || diff < -kD) return;
    let sets = null;
    if (diff === kL) {
      sets = [
        ...lightExits.map((x) => ['e', x, E_ON]),
        ...darkExits.map((x) => ['e', x, E_OFF]),
      ];
    } else if (diff === -kD) {
      sets = [
        ...darkExits.map((x) => ['e', x, E_ON]),
        ...lightExits.map((x) => ['e', x, E_OFF]),
      ];
    }
    if (!sets || !sets.length) return;
    const area = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) area.push(r * cols + c);
    pushUnique(sets, { mode: 'rect', rect: [r1, r2, c1, c2], area, needLight, needDark, diff });
  };

  for (let r1 = 0; r1 < rows; r1++) {
    for (let c1 = 0; c1 < cols; c1++) {
      for (let h = 1; h <= 4 && r1 + h <= rows; h++) {
        for (let w = 1; w <= 4 && c1 + w <= cols; w++) {
          if (h === 1 && w === 1) continue;
          checkRect(r1, r1 + h - 1, c1, c1 + w - 1);
        }
      }
    }
  }
  for (let r = 0; r < rows - 1; r++) checkRect(0, r, 0, cols - 1);
  for (let c = 0; c < cols - 1; c++) checkRect(0, rows - 1, 0, c);
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    checkRect(0, r, 0, c);
    checkRect(0, r, c + 1, cols - 1);
    checkRect(r + 1, rows - 1, 0, c);
    checkRect(r + 1, rows - 1, c + 1, cols - 1);
  }

  out.sort((p, q) => p.info.area.length - q.info.area.length || p.sets.length - q.sets.length);
  return out;
}

function findChecker(smallOnly) {
  return (P, st, opts) => {
    if (!P.fullBoard) return [];
    const cache = opts && opts.stepCache;
    const all = cache ? (cache.checkers || (cache.checkers = computeAllChecker(P, st))) : computeAllChecker(P, st);
    return all.filter((f) => (f.info.area.length <= 6) === smallOnly);
  };
}

let cpVOn = new Int16Array(0);
let cpVUnk = new Int16Array(0);
let cpHOn = new Int16Array(0);
let cpHUnk = new Int16Array(0);

function findCrossingParity(P, st) {
  const { rows, cols, ed } = P;
  const W = cols + 1, H = rows + 1;
  const vSize = rows * W, hSize = cols * H;
  if (cpVOn.length < vSize) { cpVOn = new Int16Array(vSize); cpVUnk = new Int16Array(vSize); }
  if (cpHOn.length < hSize) { cpHOn = new Int16Array(hSize); cpHUnk = new Int16Array(hSize); }

  // Vertical boundary prefix sums: row r (1..rows-1) holds edges between row r-1 and row r
  for (let r = 1; r < rows; r++) {
    const base = r * W;
    let sOn = 0, sUnk = 0;
    cpVOn[base] = 0;
    cpVUnk[base] = 0;
    for (let c = 0; c < cols; c++) {
      const x = ed[(r * cols + c) * 4 + 0];
      const ev = x >= 0 ? st.e[x] : E_OFF;
      if (ev === E_ON) sOn++;
      else if (ev === E_UNKNOWN) sUnk++;
      cpVOn[base + c + 1] = sOn;
      cpVUnk[base + c + 1] = sUnk;
    }
  }
  // Horizontal boundary prefix sums: col c (1..cols-1) holds edges between col c-1 and col c
  for (let c = 1; c < cols; c++) {
    const base = c * H;
    let sOn = 0, sUnk = 0;
    cpHOn[base] = 0;
    cpHUnk[base] = 0;
    for (let r = 0; r < rows; r++) {
      const x = ed[(r * cols + c) * 4 + 3];
      const ev = x >= 0 ? st.e[x] : E_OFF;
      if (ev === E_ON) sOn++;
      else if (ev === E_UNKNOWN) sUnk++;
      cpHOn[base + r + 1] = sOn;
      cpHUnk[base + r + 1] = sUnk;
    }
  }

  const seen = new Set();
  const out = [];
  const checkRect = (r1, r2, c1, c2) => {
    const topUnk = r1 > 0 ? cpVUnk[r1 * W + c2 + 1] - cpVUnk[r1 * W + c1] : 0;
    if (topUnk > 1) return;
    const botUnk = r2 < rows - 1 ? cpVUnk[(r2 + 1) * W + c2 + 1] - cpVUnk[(r2 + 1) * W + c1] : 0;
    if (topUnk + botUnk > 1) return;
    const leftUnk = c1 > 0 ? cpHUnk[c1 * H + r2 + 1] - cpHUnk[c1 * H + r1] : 0;
    if (topUnk + botUnk + leftUnk > 1) return;
    const rightUnk = c2 < cols - 1 ? cpHUnk[(c2 + 1) * H + r2 + 1] - cpHUnk[(c2 + 1) * H + r1] : 0;
    if (topUnk + botUnk + leftUnk + rightUnk !== 1) return;

    let lastX = -1;
    if (topUnk === 1) {
      for (let c = c1; c <= c2; c++) { const x = ed[(r1 * cols + c) * 4 + 0]; if (x >= 0 && st.e[x] === E_UNKNOWN) { lastX = x; break; } }
    } else if (botUnk === 1) {
      for (let c = c1; c <= c2; c++) { const x = ed[(r2 * cols + c) * 4 + 2]; if (x >= 0 && st.e[x] === E_UNKNOWN) { lastX = x; break; } }
    } else if (leftUnk === 1) {
      for (let r = r1; r <= r2; r++) { const x = ed[(r * cols + c1) * 4 + 3]; if (x >= 0 && st.e[x] === E_UNKNOWN) { lastX = x; break; } }
    } else {
      for (let r = r1; r <= r2; r++) { const x = ed[(r * cols + c2) * 4 + 1]; if (x >= 0 && st.e[x] === E_UNKNOWN) { lastX = x; break; } }
    }
    if (lastX < 0 || seen.has(lastX)) return;
    seen.add(lastX);

    const on = (r1 > 0 ? cpVOn[r1 * W + c2 + 1] - cpVOn[r1 * W + c1] : 0)
      + (r2 < rows - 1 ? cpVOn[(r2 + 1) * W + c2 + 1] - cpVOn[(r2 + 1) * W + c1] : 0)
      + (c1 > 0 ? cpHOn[c1 * H + r2 + 1] - cpHOn[c1 * H + r1] : 0)
      + (c2 < cols - 1 ? cpHOn[(c2 + 1) * H + r2 + 1] - cpHOn[(c2 + 1) * H + r1] : 0);
    const val = (on & 1) ? E_ON : E_OFF;
    const area = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const u = r * cols + c;
      if (!P.hasVoids || !P.isVoid[u]) area.push(u);
    }
    out.push({ sets: [['e', lastX, val]], info: { edge: lastX, val, rect: [r1, r2, c1, c2], on, area } });
  };

  // 1. Row cuts and column cuts (cheapest to see)
  for (let r = 0; r < rows - 1; r++) checkRect(0, r, 0, cols - 1);
  for (let c = 0; c < cols - 1; c++) checkRect(0, rows - 1, 0, c);
  // 2. Corner-anchored quadrants
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    checkRect(0, r, 0, c);
    checkRect(0, r, c + 1, cols - 1);
    checkRect(r + 1, rows - 1, 0, c);
    checkRect(r + 1, rows - 1, c + 1, cols - 1);
  }
  // 3. Small rectangles up to 4x4
  for (let r1 = 0; r1 < rows; r1++) {
    for (let c1 = 0; c1 < cols; c1++) {
      for (let h = 1; h <= 4 && r1 + h <= rows; h++) {
        for (let w = 1; w <= 4 && c1 + w <= cols; w++) {
          if (h === 1 && w === 1) continue; // single cell is just forcedExits / deadEnd
          checkRect(r1, r1 + h - 1, c1, c1 + w - 1);
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ Symmetry uniqueness inference

const SYM_DEFS = [
  { id: 'flipH', refl: true, square: false, map: (r, c, R, C) => [r, C - 1 - c] },
  { id: 'flipV', refl: true, square: false, map: (r, c, R, C) => [R - 1 - r, c] },
  { id: 'rot180', refl: false, square: false, map: (r, c, R, C) => [R - 1 - r, C - 1 - c] },
  { id: 'transpose', refl: true, square: true, map: (r, c) => [c, r] },
  { id: 'antiTranspose', refl: true, square: true, map: (r, c, R, C) => [C - 1 - c, R - 1 - r] },
  { id: 'rot90', refl: false, square: true, map: (r, c, R) => [c, R - 1 - r] },
];

/**
 * Detect all non-identity dihedral automorphisms of puzzle `P` (preserving dimensions, voids,
 * circle positions & colors, and permanent givens). Cached on `P._syms`.
 */
export function detectSymmetries(P) {
  if (P._syms) return P._syms;
  const { rows, cols, N, numEdges, clue, isVoid, hasGivens, givenE, edgeA, edgeB, nb, ed } = P;
  const out = [];

  for (const def of SYM_DEFS) {
    if (def.square && rows !== cols) continue;
    const cellMap = new Int16Array(N);
    let ok = true;
    for (let r = 0; r < rows && ok; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const [r2, c2] = def.map(r, c, rows, cols);
        const j = r2 * cols + c2;
        if (isVoid[i] !== isVoid[j] || clue[i] !== clue[j]) { ok = false; break; }
        cellMap[i] = j;
      }
    }
    if (!ok) continue;

    const edgeMap = new Int16Array(numEdges).fill(-1);
    for (let x = 0; x < numEdges && ok; x++) {
      const a = edgeA[x];
      if (a < 0) continue;
      const b = edgeB[x];
      const a2 = cellMap[a], b2 = cellMap[b];
      let tx = -1;
      for (let d = 0; d < 4; d++) {
        if (nb[a2 * 4 + d] === b2) { tx = ed[a2 * 4 + d]; break; }
      }
      if (tx < 0) { ok = false; break; }
      if (hasGivens && givenE[x] !== givenE[tx]) { ok = false; break; }
      edgeMap[x] = tx;
    }
    if (!ok) continue;

    if (P.hasSlither) {
      const fr = rows - 1, fc = cols - 1;
      for (let r = 0; r < fr && ok; r++) {
        for (let c = 0; c < fc; c++) {
          const [r2, c2] = def.map(r, c, fr, fc);
          if (P.slitherNum[r * fc + c] !== P.slitherNum[r2 * fc + c2]) { ok = false; break; }
        }
      }
    }
    if (ok && P.hasMidloop) {
      for (let i = 0; i < N && ok; i++) {
        if ((P.midloopAtCell[i] >= 0) !== (P.midloopAtCell[cellMap[i]] >= 0)) ok = false;
      }
      for (let x = 0; x < numEdges && ok; x++) {
        if (edgeA[x] < 0) continue;
        if ((P.midloopAtEdge[x] >= 0) !== (P.midloopAtEdge[edgeMap[x]] >= 0)) ok = false;
      }
    }
    if (!ok) continue;
    out.push({ id: def.id, refl: def.refl, cellMap, edgeMap });
  }

  P._syms = out;
  return out;
}

/**
 * Uniqueness-based symmetry inference: on a puzzle with exact dihedral symmetry and a unique solution,
 * the unique solution must have the exact same symmetry (otherwise reflecting/rotating it yields a second solution).
 * Deduces:
 *   1. Direct symmetry copy of known edges / resolved gray circles
 *   2. 180° rotational center avoidance (odd×odd center vertex, even×odd center edge)
 *   3. Odd-axis reflection edges (cannot run along the mirror line) & diagonal vertex exit pairing
 *   4. Reflection exact-2-crossings law (a single symmetric closed loop crosses any mirror axis exactly twice)
 *   5. Symmetric early-loop / degree-3 rejection (adding an edge together with its symmetry orbit)
 */
export function findSymmetry(P, st, opts) {
  if (opts && opts.noUniqueness) return [];
  const syms = detectSymmetries(P);
  if (!syms.length) return [];

  const { rows, cols, N, numEdges, ed, edgeA, edgeB, isVoid } = P;
  const out = [];
  const seenEdge = new Set();

  // 1. Direct mirror/rotation copy of known edges and resolved gray pearls
  for (const sym of syms) {
    const { edgeMap, cellMap } = sym;
    for (let x = 0; x < numEdges; x++) {
      if (edgeA[x] < 0) continue;
      const v = st.e[x];
      if (v === E_UNKNOWN) continue;
      const tx = edgeMap[x];
      if (tx >= 0 && tx !== x && st.e[tx] === E_UNKNOWN && !seenEdge.has(tx)) {
        seenEdge.add(tx);
        out.push({
          sets: [['e', tx, v]],
          info: { kind: 'copy', sym: sym.id, src: x, dst: tx, val: v },
        });
      }
    }
    if (st.hasGray) {
      for (const i of P.grays) {
        const cv = st.clue[i];
        if (cv !== WHITE && cv !== BLACK) continue;
        const ti = cellMap[i];
        if (ti !== i && st.clue[ti] === GRAY) {
          out.push({
            sets: [['g', ti, cv]],
            info: { kind: 'copy', sym: sym.id, srcCell: i, dstCell: ti, grayVal: cv },
          });
        }
      }
    }
  }
  if (out.length) return out;

  // 2. Center & reflection axis laws
  for (const sym of syms) {
    const { id, cellMap, edgeMap } = sym;

    // 2a. rot180 center avoidance
    if (id === 'rot180') {
      if ((rows & 1) && (cols & 1)) {
        const mid = ((rows - 1) >> 1) * cols + ((cols - 1) >> 1);
        if (!isVoid[mid]) {
          const sets = [];
          for (let d = 0; d < 4; d++) {
            const x = ed[mid * 4 + d];
            if (x >= 0 && st.e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
          }
          if (sets.length) {
            out.push({ sets, info: { kind: 'center', sym: id, cells: [mid] } });
          }
        }
      } else if ((rows & 1) !== (cols & 1)) {
        for (let x = 0; x < numEdges; x++) {
          if (edgeA[x] >= 0 && edgeMap[x] === x && st.e[x] === E_UNKNOWN) {
            out.push({
              sets: [['e', x, E_OFF]],
              info: { kind: 'center', sym: id, cells: [edgeA[x], edgeB[x]], edge: x },
            });
          }
        }
      }
      continue;
    }

    if (!sym.refl) continue;

    // 2b. Odd flipH / flipV: edges running along the mirror axis cannot be on the loop
    if ((id === 'flipH' && (cols & 1)) || (id === 'flipV' && (rows & 1))) {
      const axisEdges = [];
      const axisCells = [];
      for (let x = 0; x < numEdges; x++) {
        const a = edgeA[x];
        if (a < 0 || edgeMap[x] !== x) continue;
        const b = edgeB[x];
        if (cellMap[a] === a && cellMap[b] === b && st.e[x] === E_UNKNOWN) {
          axisEdges.push(['e', x, E_OFF]);
          axisCells.push(a, b);
        }
      }
      if (axisEdges.length) {
        out.push({ sets: axisEdges, info: { kind: 'axisEdge', sym: id, cells: axisCells } });
      }
    }

    // 2c. Diagonal reflection (transpose / antiTranspose): exit pairing on each diagonal vertex
    if (id === 'transpose' || id === 'antiTranspose') {
      const pair1 = id === 'transpose' ? [0, 3] : [0, 1];
      const pair2 = id === 'transpose' ? [2, 1] : [2, 3];
      for (let k = 0; k < rows; k++) {
        const v = id === 'transpose' ? k * cols + k : k * cols + (cols - 1 - k);
        if (isVoid[v]) continue;
        const e1a = ed[v * 4 + pair1[0]], e1b = ed[v * 4 + pair1[1]];
        const e2a = ed[v * 4 + pair2[0]], e2b = ed[v * 4 + pair2[1]];
        const p1On = (e1a >= 0 && st.e[e1a] === E_ON) || (e1b >= 0 && st.e[e1b] === E_ON);
        const p2On = (e2a >= 0 && st.e[e2a] === E_ON) || (e2b >= 0 && st.e[e2b] === E_ON);
        const p1Off = e1a < 0 || e1b < 0 || st.e[e1a] === E_OFF || st.e[e1b] === E_OFF;
        const p2Off = e2a < 0 || e2b < 0 || st.e[e2a] === E_OFF || st.e[e2b] === E_OFF;
        const sets = [];
        const pushE = (x, val) => { if (x >= 0 && st.e[x] === E_UNKNOWN) sets.push(['e', x, val]); };
        if (p1On) {
          pushE(e1a, E_ON); pushE(e1b, E_ON);
          pushE(e2a, E_OFF); pushE(e2b, E_OFF);
        } else if (p2On) {
          pushE(e2a, E_ON); pushE(e2b, E_ON);
          pushE(e1a, E_OFF); pushE(e1b, E_OFF);
        } else {
          if (p1Off) { pushE(e1a, E_OFF); pushE(e1b, E_OFF); }
          if (p2Off) { pushE(e2a, E_OFF); pushE(e2b, E_OFF); }
          if (st.cell[v] === LOOP) {
            if (p1Off && !p2Off) { pushE(e2a, E_ON); pushE(e2b, E_ON); }
            else if (p2Off && !p1Off) { pushE(e1a, E_ON); pushE(e1b, E_ON); }
          }
        }
        if (sets.length) {
          out.push({ sets, info: { kind: 'diagPair', sym: id, cell: v } });
        }
      }
    }

    // 2d. Reflection exact-2-crossings law across the mirror axis
    const slots = [];
    if ((id === 'flipH' && (cols & 1) === 0) || (id === 'flipV' && (rows & 1) === 0)) {
      for (let x = 0; x < numEdges; x++) {
        if (edgeA[x] >= 0 && edgeMap[x] === x) {
          const ev = st.e[x];
          slots.push({
            status: ev === E_ON ? 1 : ev === E_OFF ? -1 : 0,
            cells: [edgeA[x], edgeB[x]],
            setOn: () => [['e', x, E_ON]],
            setOff: () => [['e', x, E_OFF]],
          });
        }
      }
    } else if (id === 'flipH' || id === 'flipV') {
      const dA = id === 'flipH' ? 3 : 0;
      const dB = id === 'flipH' ? 1 : 2;
      const len = id === 'flipH' ? rows : cols;
      const mid = (id === 'flipH' ? cols : rows) >> 1;
      for (let k = 0; k < len; k++) {
        const v = id === 'flipH' ? k * cols + mid : mid * cols + k;
        if (isVoid[v]) continue;
        const eA = ed[v * 4 + dA], eB = ed[v * 4 + dB];
        const isOn = st.cell[v] === LOOP || (eA >= 0 && st.e[eA] === E_ON) || (eB >= 0 && st.e[eB] === E_ON);
        const isOff = st.cell[v] === OFF || eA < 0 || eB < 0 || st.e[eA] === E_OFF || st.e[eB] === E_OFF;
        slots.push({
          status: isOn ? 1 : isOff ? -1 : 0,
          cells: [v],
          setOn: () => {
            const s = [];
            if (eA >= 0 && st.e[eA] === E_UNKNOWN) s.push(['e', eA, E_ON]);
            if (eB >= 0 && st.e[eB] === E_UNKNOWN) s.push(['e', eB, E_ON]);
            return s;
          },
          setOff: () => {
            const s = [];
            if (eA >= 0 && st.e[eA] === E_UNKNOWN) s.push(['e', eA, E_OFF]);
            if (eB >= 0 && st.e[eB] === E_UNKNOWN) s.push(['e', eB, E_OFF]);
            return s;
          },
        });
      }
    } else if (id === 'transpose' || id === 'antiTranspose') {
      const pair1 = id === 'transpose' ? [0, 3] : [0, 1];
      const pair2 = id === 'transpose' ? [2, 1] : [2, 3];
      for (let k = 0; k < rows; k++) {
        const v = id === 'transpose' ? k * cols + k : k * cols + (cols - 1 - k);
        if (isVoid[v]) continue;
        const e1a = ed[v * 4 + pair1[0]], e1b = ed[v * 4 + pair1[1]];
        const e2a = ed[v * 4 + pair2[0]], e2b = ed[v * 4 + pair2[1]];
        const p1Off = e1a < 0 || e1b < 0 || st.e[e1a] === E_OFF || st.e[e1b] === E_OFF;
        const p2Off = e2a < 0 || e2b < 0 || st.e[e2a] === E_OFF || st.e[e2b] === E_OFF;
        const anyOn = (e1a >= 0 && st.e[e1a] === E_ON) || (e1b >= 0 && st.e[e1b] === E_ON)
          || (e2a >= 0 && st.e[e2a] === E_ON) || (e2b >= 0 && st.e[e2b] === E_ON);
        const isOn = st.cell[v] === LOOP || anyOn;
        const isOff = st.cell[v] === OFF || (p1Off && p2Off);
        slots.push({
          status: isOn ? 1 : isOff ? -1 : 0,
          cells: [v],
          setOn: () => {
            const s = [];
            if (st.cell[v] === UNKNOWN) s.push(['c', v, LOOP]);
            if (p1Off && !p2Off) {
              if (e2a >= 0 && st.e[e2a] === E_UNKNOWN) s.push(['e', e2a, E_ON]);
              if (e2b >= 0 && st.e[e2b] === E_UNKNOWN) s.push(['e', e2b, E_ON]);
            } else if (p2Off && !p1Off) {
              if (e1a >= 0 && st.e[e1a] === E_UNKNOWN) s.push(['e', e1a, E_ON]);
              if (e1b >= 0 && st.e[e1b] === E_UNKNOWN) s.push(['e', e1b, E_ON]);
            }
            return s;
          },
          setOff: () => {
            const s = [];
            for (let d = 0; d < 4; d++) {
              const x = ed[v * 4 + d];
              if (x >= 0 && st.e[x] === E_UNKNOWN) s.push(['e', x, E_OFF]);
            }
            return s;
          },
        });
      }
    }

    if (slots.length) {
      const onSlots = slots.filter((s) => s.status === 1);
      const unkSlots = slots.filter((s) => s.status === 0);
      if (onSlots.length === 2 && unkSlots.length > 0) {
        const sets = [];
        const axisCells = [];
        for (const s of unkSlots) {
          const add = s.setOff();
          if (add.length) { sets.push(...add); axisCells.push(...s.cells); }
        }
        if (sets.length) {
          out.push({
            sets,
            info: { kind: 'twoCrossings', sym: id, onCount: 2, onCells: onSlots.flatMap((s) => s.cells), cells: axisCells },
          });
        }
      } else if (onSlots.length + unkSlots.length === 2 && unkSlots.length > 0) {
        const sets = [];
        const axisCells = [];
        for (const s of unkSlots) {
          const add = s.setOn();
          if (add.length) { sets.push(...add); axisCells.push(...s.cells); }
        }
        if (sets.length) {
          out.push({
            sets,
            info: { kind: 'twoCrossings', sym: id, onCount: onSlots.length, onCells: onSlots.flatMap((s) => s.cells), cells: axisCells },
          });
        }
      }
    }
  }
  if (out.length) return out;

  // 3. Symmetric orbit early-loop / degree-3 rejection (adding an edge together with its symmetric twins)
  const baseDeg = new Uint8Array(N);
  const basePar = new Int32Array(N);
  const baseLoopInComp = new Int32Array(N);
  const baseEdgesInComp = new Int32Array(N);
  let totalLoopCells = 0, totalOnEdges = 0;
  for (let i = 0; i < N; i++) {
    basePar[i] = i;
    if (st.cell[i] === LOOP) { totalLoopCells++; baseLoopInComp[i] = 1; }
  }
  const bFind = (a) => { while (basePar[a] !== a) { basePar[a] = basePar[basePar[a]]; a = basePar[a]; } return a; };
  for (let x = 0; x < numEdges; x++) {
    if (st.e[x] !== E_ON) continue;
    const a = edgeA[x], b = edgeB[x];
    baseDeg[a]++; baseDeg[b]++;
    totalOnEdges++;
    const ra = bFind(a), rb = bFind(b);
    if (ra !== rb) {
      basePar[rb] = ra;
      baseLoopInComp[ra] += baseLoopInComp[rb];
      baseEdgesInComp[ra] += baseEdgesInComp[rb] + 1;
    } else {
      baseEdgesInComp[ra]++;
    }
  }
  const needLoopCount = P.fullBoard ? P.activeCount : totalLoopCells;

  const orbVisited = new Uint8Array(numEdges);
  for (let x = 0; x < numEdges; x++) {
    if (edgeA[x] < 0 || st.e[x] !== E_UNKNOWN || orbVisited[x]) continue;
    const orbit = [x];
    orbVisited[x] = 1;
    for (let qi = 0; qi < orbit.length; qi++) {
      const cur = orbit[qi];
      for (const sym of syms) {
        const nxt = sym.edgeMap[cur];
        if (nxt >= 0 && !orbVisited[nxt]) {
          orbVisited[nxt] = 1;
          orbit.push(nxt);
        }
      }
    }
    if (orbit.length < 2) continue;
    if (orbit.some((e) => st.e[e] !== E_UNKNOWN)) continue;

    const touchedDeg = new Map();
    let branchCell = -1;
    for (const oe of orbit) {
      const a = edgeA[oe], b = edgeB[oe];
      const da = (touchedDeg.get(a) ?? baseDeg[a]) + 1;
      const db = (touchedDeg.get(b) ?? baseDeg[b]) + 1;
      touchedDeg.set(a, da);
      touchedDeg.set(b, db);
      if (da > 2) { branchCell = a; break; }
      if (db > 2) { branchCell = b; break; }
    }
    if (branchCell >= 0) {
      out.push({
        sets: orbit.map((oe) => ['e', oe, E_OFF]),
        info: { kind: 'orbitClose', reason: 'branch', sym: syms[0].id, edge: x, orbit, branchCell },
      });
      continue;
    }

    const locPar = new Map();
    const locLoop = new Map();
    const locEdges = new Map();
    const lFind = (r) => {
      let cur = r;
      while (locPar.has(cur) && locPar.get(cur) !== cur) cur = locPar.get(cur);
      return cur;
    };
    const initRoot = (u) => {
      const r = bFind(u);
      if (!locPar.has(r)) {
        locPar.set(r, r);
        locLoop.set(r, baseLoopInComp[r]);
        locEdges.set(r, baseEdgesInComp[r]);
      }
      return lFind(r);
    };

    let earlyClose = false;
    let cycCells = [];
    for (const oe of orbit) {
      const a = edgeA[oe], b = edgeB[oe];
      const ra = initRoot(a), rb = initRoot(b);
      if (ra === rb) {
        const edgeCnt = locEdges.get(ra) + 1;
        locEdges.set(ra, edgeCnt);
        const loopCnt = locLoop.get(ra);
        const missesLoop = loopCnt < needLoopCount;
        const leavesOtherSegs = edgeCnt < totalOnEdges + orbit.length;
        if (missesLoop || leavesOtherSegs) {
          earlyClose = true;
          cycCells = orbit.flatMap((e) => [edgeA[e], edgeB[e]]);
          break;
        }
      } else {
        locPar.set(rb, ra);
        locLoop.set(ra, locLoop.get(ra) + locLoop.get(rb));
        locEdges.set(ra, locEdges.get(ra) + locEdges.get(rb) + 1);
      }
    }
    if (earlyClose) {
      out.push({
        sets: orbit.map((oe) => ['e', oe, E_OFF]),
        info: { kind: 'orbitClose', reason: 'earlyLoop', sym: syms[0].id, edge: x, orbit, cells: cycCells },
      });
    }
  }
  return out;
}

function findTryEdge(P, st, { upto }) {
  // Prefer edges touching LOOP cells or nonzero Slitherlink faces first, then fall back to remaining edges
  const primary = [];
  const rest = [];
  for (let x = 0; x < P.numEdges; x++) {
    if (st.e[x] !== E_UNKNOWN) continue;
    const a = P.edgeA[x], b = P.edgeB[x];
    if (a < 0) continue;
    if (st.cell[a] === LOOP || st.cell[b] === LOOP || isSlitherEdge(P, x)) primary.push(x);
    else rest.push(x);
  }
  let best = null;
  const tryList = (list) => {
    for (const x of list) {
      for (const val of [E_ON, E_OFF]) {
        const s2 = cloneState(st);
        s2.e[x] = val;
        const r = closure(P, s2, upto, best ? best.info.steps - 1 : Infinity);
        if (r.contradiction) {
          const cand = {
            sets: [['e', x, val === E_ON ? E_OFF : E_ON]],
            info: { edge: x, hyp: val, steps: r.steps, trace: r.trace },
          };
          if (!best || r.steps < best.info.steps) best = cand;
          if (r.steps <= 2) return true;
        }
      }
    }
    return false;
  };
  if (tryList(primary)) return [best];
  if (!best && rest.length && tryList(rest)) return [best];
  if (st.hasGray) {
    for (const i of graysOf(P, st)) {
      for (const val of [WHITE, BLACK]) {
        const s2 = cloneState(st);
        s2.clue[i] = val;
        const r = closure(P, s2, upto, best ? best.info.steps - 1 : Infinity);
        if (r.contradiction) {
          const cand = {
            sets: [['g', i, val === WHITE ? BLACK : WHITE]],
            info: { grayCell: i, hyp: val, steps: r.steps, trace: r.trace },
          };
          if (!best || r.steps < best.info.steps) best = cand;
          if (r.steps <= 2) return [best];
        }
      }
    }
  }
  return best ? [best] : [];
}

// ------------------------------------------------------------ rule table

const extraFaceCircle = (P, st, f) => Math.max(0, (f.info.hops || 1) - 3) * 2;
const extraParity = (P, st, f) => Math.max(0, (f.info.ends ? f.info.ends.length : 0) - 3) * 2;
const extraTrial = (P, st, f) => (f.info.steps || 0) * 2;

function imagineFind(P, st) {
  const f = bestImagine(P, st);
  return f ? [imagineFiring(f)] : [];
}

function imagineFiring(f) {
  const isGray = f.grayCell !== undefined && f.grayCell >= 0;
  return {
    sets: isGray ? [['g', f.grayCell, f.deduce]] : [['e', f.edge, f.deduce]],
    info: {
      edge: f.edge,
      ...(isGray ? { grayCell: f.grayCell } : {}),
      hyp: f.hyp,
      deduce: f.deduce,
      cost: f.cost,
      maxDist: f.maxDist,
      pureThread: f.pureThread,
      area: f.area,
      steps: f.steps,
      broke: f.broke,
      forbid: f.forbid,
    },
  };
}

function imagineStep(f) {
  return { rule: f.rule, tier: f.tier, weight: f.cost, firings: [imagineFiring(f)] };
}

function defRule(r) {
  // Expose both `id`/`name`, `weight`/`cost`, and `find`/`apply` for clean interoperability
  return {
    ...r,
    name: r.id,
    cost: r.weight,
    apply: r.find,
  };
}

export const RULES = [
  // Bookkeeping (cost 1, applied silently before each step, charged once per step where they fire)
  defRule({ id: 'edgesOffCellOff', tier: 'Beginner', weight: 1, free: true, find: findEdgesOffCellOff, label: 'a segment touching an off-loop cell is off' }),
  defRule({ id: 'edgeEnds', tier: 'Beginner', weight: 1, free: true, find: findEdgeEnds, label: 'a segment puts both of its cells on the loop' }),
  defRule({ id: 'fullCell', tier: 'Beginner', weight: 1, free: true, find: findFullCell, label: 'a cell with two segments takes no more' }),
  defRule({ id: 'isolatedCellOff', tier: 'Beginner', weight: 1, free: true, find: findIsolatedCellOff, label: 'a cell with all its edges off is not on the loop' }),
  defRule({ id: 'closedLoopRestOff', tier: 'Beginner', weight: 1, free: true, find: findClosedLoopRestOff, label: 'once the single loop is closed, all remaining cells are off the loop' }),
  defRule({ id: 'grayFromShape', tier: 'Beginner', weight: 1, free: true, find: findGrayFromShape, label: 'a gray circle with two drawn segments resolves to white (straight) or black (turn)' }),

  // Beginner (single-segment / direct rule violations + iconic three-whites + Slitherlink & Mid-loop basics)
  ...SLITHER_RULES.filter((r) => r.tier === 'Beginner').map((r) => defRule({ ...r, slitherOnly: true })),
  ...MIDLOOP_RULES.filter((r) => r.tier === 'Beginner').map((r) => defRule({ ...r, midloopOnly: true })),
  defRule({ id: 'grayMustBeBlack', tier: 'Beginner', weight: 2, grayOnly: true, find: findGrayMustBeBlack, label: 'a gray circle that cannot go straight along either axis must be black' }),
  defRule({ id: 'whiteStraight', tier: 'Beginner', weight: 2, circleOnly: true, find: findWhiteStraight, label: 'a white circle blocked on one axis goes straight along the other' }),
  defRule({ id: 'blackExtend', tier: 'Beginner', weight: 2, circleOnly: true, find: findBlackExtend, label: 'a black circle continues straight two cells from an existing segment and turns away from the opposite side' }),
  defRule({ id: 'blackWall', tier: 'Beginner', weight: 2, circleOnly: true, find: findBlackWall, label: 'a black circle blocked within two cells of a wall or cross must extend two cells the opposite way' }),
  defRule({ id: 'grayMustBeWhite', tier: 'Beginner', weight: 3, grayOnly: true, find: findGrayMustBeWhite, label: 'a gray circle that cannot extend two straight segments along both axes must be white' }),
  defRule({ id: 'blackAdjacent', tier: 'Beginner', weight: 3, circleOnly: true, find: findBlackAdjacent, label: 'two touching black circles cannot connect, so each extends two cells away from the other' }),
  defRule({ id: 'whiteMustTurn', tier: 'Beginner', weight: 3, circleOnly: true, find: findWhiteMustTurn, label: 'a white circle that goes straight at one end must turn at the other' }),
  defRule({ id: 'deadEnd', tier: 'Beginner', weight: 4, find: findDeadEnd, label: 'an empty cell with fewer than two exits left cannot be on the loop' }),
  defRule({ id: 'forcedExits', tier: 'Beginner', weight: 4, find: findForcedExits, label: 'a loop cell with only two exits left must use both' }),
  defRule({ id: 'blackPerp', tier: 'Beginner', weight: 5, circleOnly: true, find: findBlackPerp, label: 'a black circle cannot enter a neighbor that already has a perpendicular segment' }),
  defRule({ id: 'noEarlyClose', tier: 'Beginner', weight: 6, find: findNoEarlyClose, label: 'a segment joining the two ends of one path would close the loop early' }),
  defRule({ id: 'threeWhites', tier: 'Beginner', weight: 8, circleOnly: true, find: findThreeWhites, label: 'three white circles in a row must all cross perpendicular to the row' }),

  // Medium (local multi-segment inferences, Auto-Shade border parity, and 1-step local lookahead)
  ...SLITHER_RULES.filter((r) => r.tier === 'Medium').map((r) => defRule({ ...r, slitherOnly: true })),
  ...MIDLOOP_RULES.filter((r) => r.tier === 'Medium').map((r) => defRule({ ...r, midloopOnly: true })),
  defRule({ id: 'whiteBothStraight', tier: 'Medium', weight: 10, circleOnly: true, find: findWhiteBothStraight, label: 'a white circle cannot use an axis where both neighbors already continue straight' }),
  defRule({ id: 'closingCell', tier: 'Medium', weight: 11, find: findClosingCell, label: 'an empty cell whose only two exits meet one path cannot be on the loop' }),
  defRule({ id: 'samePathExits', tier: 'Medium', weight: 11, find: findSamePathExits, label: 'a loop cell with three exits where two meet one path must use the third' }),
  defRule({ id: 'twoWhitesStraight', tier: 'Medium', weight: 12, circleOnly: true, find: findTwoWhitesStraight, label: 'two touching white circles with a straight segment entering one cannot connect, so both cross perpendicular' }),
  defRule({ id: 'grayWhiteNoTurn', tier: 'Medium', weight: 12, grayOnly: true, find: findGrayWhiteNoTurn, label: 'a gray circle that cannot make a valid white-circle turn on either axis must be black' }),
  defRule({ id: 'whiteNoTurnAxis', tier: 'Medium', weight: 14, circleOnly: true, find: findWhiteNoTurnAxis, label: 'a white circle cannot use an axis whose two neighbors are both unable to turn' }),
  defRule({ id: 'blackNoEarlyClose', tier: 'Medium', weight: 14, circleOnly: true, find: findBlackNoEarlyClose, label: 'a black circle cannot extend two cells into the other end of its own path and close the loop early' }),
  defRule({ id: 'blackBlockedTarget', tier: 'Medium', weight: 15, circleOnly: true, find: findBlackBlockedTarget, label: 'a black circle cannot extend toward a circle two cells away that cannot accept a straight segment' }),
  defRule({ id: 'blackTwoDiagWhites', tier: 'Medium', weight: 15, circleOnly: true, find: findBlackTwoDiagWhites, label: 'a black circle flanked by two diagonally adjacent white circles cannot extend between them' }),
  defRule({ id: 'blackWhiteNoTurn', tier: 'Medium', weight: 16, circleOnly: true, find: findBlackWhiteNoTurn, label: 'a black circle cannot extend into a white circle two cells away whose far side cannot turn' }),
  defRule({ id: 'whiteCornerPinch', tier: 'Medium', weight: 17, circleOnly: true, find: findWhiteCornerPinch, label: 'a two-exit corner diagonally next to a white circle cannot pinch both of its already-active neighbors' }),
  defRule({ id: 'whiteDeadEndPinch', tier: 'Medium', weight: 17, circleOnly: true, find: findWhiteDeadEndPinch, label: 'a segment completing two sides of a 2×2 square beside a white circle cannot pinch both of its axes' }),
  defRule({ id: 'faceShade', tier: 'Medium', weight: 18, find: findFaceShade, label: 'basic inside/outside shading (crossing lines and X marks from the border) puts known colors on both sides of an edge' }),
  defRule({ id: 'checkerPocket', tier: 'Medium', weight: 18, fullBoardOnly: true, find: findChecker(true), label: 'checkerboard light/dark dot counts in a small full-board pocket force its exit segments' }),
  defRule({ id: 'boxStrand', tier: 'Medium', weight: 20, find: findBoxStrand, label: 'closing two active corners of a 2×2 square cannot seal off both escapes of an open end on the opposite side' }),

  // Hard (circle-diagonal shading, global topology, and short single-thread lookahead)
  defRule({ id: 'corridorNoEarlyClose', tier: 'Hard', weight: 30, find: findCorridorNoEarlyClose, label: 'a forced multi-cell corridor joining the two ends of one path would close the loop early' }),
  defRule({ id: 'checkerParity', tier: 'Hard', weight: 36, fullBoardOnly: true, find: findChecker(false), label: 'checkerboard light/dark dot counts in a full-board region force its exit segments' }),
  defRule({ id: 'faceCircle', tier: 'Hard', weight: 38, find: (P, st, o) => (!P.clueCells.length && P.hasSlither ? [] : findFaceCircle(P, st, o)), extra: extraFaceCircle, label: 'advanced inside/outside shading (white-circle or Mid-loop diagonals, black 3-to-1 corners, or relative coloring) forces an edge' }),
  defRule({ id: 'faceSlither', tier: 'Hard', weight: 30, slitherOnly: true, find: findFaceSlither, extra: extraFaceCircle, label: 'inside/outside shading around numbered Slitherlink squares (and circles on hybrids) forces an edge' }),
  defRule({ id: 'twoEndsJoin', tier: 'Hard', weight: 44, find: findTwoEndsJoin, label: 'a sealed area with just two open ends must connect them, so their far ends cannot join early' }),
  defRule({ id: 'chokepoint', tier: 'Hard', weight: 48, costly: true, find: findChokepoint(true), label: 'blocking this segment would cut off a small area or leave a single chokepoint cell' }),
  defRule({ id: 'parityPocket', tier: 'Hard', weight: 52, costly: true, find: findParity(true), label: 'the other choice would seal off a small pocket with an odd number of open ends' }),
  defRule({ id: 'crossingParity', tier: 'Hard', weight: 58, find: findCrossingParity, label: 'the loop crosses the border of any rectangle or band an even number of times' }),
  defRule({ id: 'chokepointArea', tier: 'Hard', weight: 64, costly: true, find: findChokepoint(false), label: 'blocking this segment would cut off a large area or leave a single chokepoint cell' }),
  defRule({ id: 'parityForces', tier: 'Hard', weight: 68, costly: true, find: findParity(false), extra: extraParity, label: 'the other choice would seal off an area with an odd number of open ends' }),
  defRule({ id: 'symmetry', tier: 'Hard', weight: 70, usesUniqueness: true, find: findSymmetry, label: 'a puzzle with exact symmetry and a unique solution must have a symmetric loop' }),

  // Expert (long/multi-front lookahead chains and full trial-and-error)
  defRule({ id: 'tryEdge', tier: 'Expert', weight: 120, lookahead: true, find: findTryEdge, extra: extraTrial, label: 'trying a segment one way leads to a contradiction' }),

  // Unified imagine rules (priced dynamically by cognitive load and slotted into HUMAN_ORDER by cost)
  defRule({ id: 'imagineLocal', tier: 'Medium', weight: MEDIUM_MAX, virtual: true, costly: true, find: imagineFind, label: 'imagine a segment on or off at a circle or open end: one local step immediately breaks a rule' }),
  defRule({ id: 'imagineTrace', tier: 'Hard', weight: 54, virtual: true, costly: true, find: imagineFind, label: 'imagine a segment on or off and trace one single thread 2–3 steps ahead until something breaks' }),
  defRule({ id: 'imagineChain', tier: 'Expert', weight: 90, virtual: true, costly: true, find: imagineFind, label: 'imagine a segment on or off and follow a long, multi-front, or area-parity chain until something breaks' }),
];

export const HUMAN_ORDER = RULES
  .map((r, i) => [r, i])
  .filter(([r]) => !r.free && !r.virtual)
  .sort((a, b) => a[0].weight - b[0].weight || a[1] - b[1])
  .map(([r]) => r);

export const FIRST_LOOKAHEAD = RULES.findIndex((r) => r.lookahead);
export const RULE_IDS = RULES.map((r) => r.id);
export const tierOfRule = (id) => (id === 'unsolved' ? 'Expert' : RULES.find((r) => r.id === id).tier);
export const ruleLabel = (id) => (id === 'unsolved' ? 'none of the current rules finishes it' : RULES.find((r) => r.id === id).label);

// ------------------------------------------------------------ closure / stepping / rating

const IMAGINE_AFTER = 20; // Beginner + local Medium + faceShade + boxStrand (<= 20) always run before searching imagined chains (min cost 22)

const ruleApplies = (rule, P, st) => (
  (!rule.slitherOnly || P.hasSlither)
  && (!rule.midloopOnly || P.hasMidloop)
  && (!rule.circleOnly || P.clueCells.length > 0)
  && (!rule.grayOnly || st.hasGray)
  && (!rule.fullBoardOnly || P.fullBoard)
);

/** Apply all non-costly rules below `upto` until fixed point, contradiction, or `maxSteps`. Mutates `st`. */
export function closure(P, st, upto = FIRST_LOOKAHEAD, maxSteps = Infinity, checkContra = true) {
  const allowed = Array.isArray(upto) ? new Set(upto) : null;
  const limit = allowed ? RULES.length : upto;
  let steps = 0;
  const trace = [];
  for (let guard = 0; guard < 5000; guard++) {
    // Drain free bookkeeping rules first (they don't affect `steps` or `trace`, avoiding redundant contradiction scans)
    if (!runFreeBookkeeping(P, st, null, limit)) return { contradiction: true, steps, trace };
    if (checkContra && contradiction(P, st)) return { contradiction: true, steps, trace };
    if (steps >= maxSteps) return { contradiction: false, steps, trace };
    const stepCache = {};
    let fired = false;
    for (let r = 0; r < limit; r++) {
      const rule = RULES[r];
      if (rule.free || rule.usesUniqueness) continue;
      if (!ruleApplies(rule, P, st)) continue;
      if (allowed && !allowed.has(rule.id)) continue;
      if (!allowed && rule.costly) continue;
      const fs = rule.find(P, st, { upto: r, fast: true, stepCache });
      if (!fs.length) continue;
      for (const f of fs) {
        if (!applySets(st, f.sets)) return { contradiction: true, steps, trace };
        if (trace.length < 16) trace.push({ rule: rule.id, sets: f.sets, info: f.info });
      }
      steps++;
      fired = true;
      break;
    }
    if (!fired) return { contradiction: false, steps, trace };
  }
  return { contradiction: false, steps, trace };
}

/** Drain all free bookkeeping rules in-place into `st`, returning false on conflict. */
function runFreeBookkeeping(P, st, bookkeeping = null, limit = 6) {
  const { N, numEdges, ed, edgeA, edgeB } = P;
  const { cell, e } = st;
  const maxFree = Math.min(limit, 6);
  for (;;) {
    let any = false;

    // 0. edgesOffCellOff: OFF cell -> all unknown incident edges OFF
    if (maxFree > 0) {
      let ch = false;
      for (let i = 0; i < N; i++) {
        if (cell[i] !== OFF) continue;
        const b = i * 4;
        let x = ed[b]; if (x >= 0 && e[x] === E_UNKNOWN) { e[x] = E_OFF; ch = true; }
        x = ed[b + 1]; if (x >= 0 && e[x] === E_UNKNOWN) { e[x] = E_OFF; ch = true; }
        x = ed[b + 2]; if (x >= 0 && e[x] === E_UNKNOWN) { e[x] = E_OFF; ch = true; }
        x = ed[b + 3]; if (x >= 0 && e[x] === E_UNKNOWN) { e[x] = E_OFF; ch = true; }
      }
      if (ch) { any = true; if (bookkeeping) bookkeeping.edgesOffCellOff = true; }
    }

    // 1. edgeEnds: ON edge -> UNKNOWN endpoints become LOOP
    let totalOn = 0;
    if (maxFree > 1) {
      let ch = false;
      for (let x = 0; x < numEdges; x++) {
        if (e[x] !== E_ON) continue;
        totalOn++;
        const a = edgeA[x], b = edgeB[x];
        if (cell[a] === UNKNOWN) { cell[a] = LOOP; ch = true; }
        if (cell[b] === UNKNOWN) { cell[b] = LOOP; ch = true; }
      }
      if (ch) { any = true; if (bookkeeping) bookkeeping.edgeEnds = true; }
    }

    // 2. fullCell: cell with 2 ON edges -> remaining unknown incident edges OFF
    let maybeSolved = totalOn >= 4;
    if (maxFree > 2) {
      let ch = false;
      const clue = st.clue || P.clue;
      for (let i = 0; i < N; i++) {
        const b = i * 4;
        const x0 = ed[b], x1 = ed[b + 1], x2 = ed[b + 2], x3 = ed[b + 3];
        let on = 0;
        if (x0 >= 0 && e[x0] === E_ON) on++;
        if (x1 >= 0 && e[x1] === E_ON) on++;
        if (x2 >= 0 && e[x2] === E_ON) on++;
        if (x3 >= 0 && e[x3] === E_ON) on++;
        if (maybeSolved && ((on === 1 || on > 2) || (clue[i] !== 0 && on !== 2))) maybeSolved = false;
        if (on === 2) {
          if (x0 >= 0 && e[x0] === E_UNKNOWN) { e[x0] = E_OFF; ch = true; }
          if (x1 >= 0 && e[x1] === E_UNKNOWN) { e[x1] = E_OFF; ch = true; }
          if (x2 >= 0 && e[x2] === E_UNKNOWN) { e[x2] = E_OFF; ch = true; }
          if (x3 >= 0 && e[x3] === E_UNKNOWN) { e[x3] = E_OFF; ch = true; }
        }
      }
      if (ch) { any = true; if (bookkeeping) bookkeeping.fullCell = true; }
    }

    // 3. isolatedCellOff: UNKNOWN cell with all incident edges OFF -> OFF
    if (maxFree > 3) {
      let ch = false;
      for (let i = 0; i < N; i++) {
        if (cell[i] !== UNKNOWN) continue;
        const b = i * 4;
        const x0 = ed[b], x1 = ed[b + 1], x2 = ed[b + 2], x3 = ed[b + 3];
        if ((x0 < 0 || e[x0] === E_OFF) && (x1 < 0 || e[x1] === E_OFF)
          && (x2 < 0 || e[x2] === E_OFF) && (x3 < 0 || e[x3] === E_OFF)) {
          cell[i] = OFF;
          ch = true;
        }
      }
      if (ch) { any = true; if (bookkeeping) bookkeeping.isolatedCellOff = true; }
    }

    // 4. closedLoopRestOff: if solved, all remaining UNKNOWN cells/edges become OFF
    if (maxFree > 4 && maybeSolved && isSolved(P, e)) {
      let ch = false;
      for (let i = 0; i < N; i++) if (cell[i] === UNKNOWN) { cell[i] = OFF; ch = true; }
      for (let x = 0; x < numEdges; x++) if (edgeA[x] >= 0 && e[x] === E_UNKNOWN) { e[x] = E_OFF; ch = true; }
      if (ch) { any = true; if (bookkeeping) bookkeeping.closedLoopRestOff = true; }
    }

    // 5. grayFromShape: unresolved gray circle with 2 ON edges resolves to WHITE or BLACK
    if (maxFree > 5 && st.hasGray) {
      let ch = false;
      const cl = st.clue, grays = P.grays;
      for (let k = 0; k < grays.length; k++) {
        const i = grays[k];
        if (cl[i] !== GRAY) continue;
        const b = i * 4;
        const u = ed[b], r = ed[b + 1], dn = ed[b + 2], l = ed[b + 3];
        let on = 0;
        if (u >= 0 && e[u] === E_ON) on++;
        if (r >= 0 && e[r] === E_ON) on++;
        if (dn >= 0 && e[dn] === E_ON) on++;
        if (l >= 0 && e[l] === E_ON) on++;
        if (on !== 2) continue;
        const straight = (u >= 0 && dn >= 0 && e[u] === E_ON && e[dn] === E_ON)
          || (r >= 0 && l >= 0 && e[r] === E_ON && e[l] === E_ON);
        cl[i] = straight ? WHITE : BLACK;
        ch = true;
      }
      if (ch) { any = true; if (bookkeeping) bookkeeping.grayFromShape = true; }
    }

    if (!any) break;
  }
  return true;
}

/**
 * Find the cheapest applicable rule in `st`, returning { rule, tier, weight, firings } or null.
 * Applies silent bookkeeping to `st` first (recording any active bookkeeping rules in `bookkeeping`).
 */
export function nextSteps(P, st, bookkeeping = null, without = null) {
  if (!runFreeBookkeeping(P, st, bookkeeping)) return null;
  const noImagine = !!without
    && without.includes('imagineLocal') && without.includes('imagineTrace') && without.includes('imagineChain');
  const stepCache = {};
  const imagineAllowed = (f) => !!f && !(without && without.includes(f.rule));
  let found;
  let foundCap = 0;
  const imagined = (costCap = Infinity) => {
    if (noImagine) return null;
    if (found === undefined || (found === null && costCap > foundCap)) {
      found = bestImagine(P, st, { costCap, without, stepCache });
      foundCap = costCap;
    }
    return imagineAllowed(found) ? found : null;
  };

  for (const rule of HUMAN_ORDER) {
    if (without && without.includes(rule.id)) continue;
    if (!ruleApplies(rule, P, st)) continue;
    // Before costly or lookahead rules, search imagine up to the current tier ceiling so cheaper imagine
    // skips expensive Tarjan/parity scans (while Hard ceiling HARD_MAX+1 skips non-frontier & area scans).
    if (rule.costly || rule.lookahead) {
      const cap = rule.weight <= HARD_MAX ? HARD_MAX + 1 : Infinity;
      const f = imagined(cap);
      if (f && f.cost < rule.weight) return imagineStep(f);
    } else if (imagineAllowed(found) && found.cost < rule.weight) {
      return imagineStep(found);
    }
    const firings = rule.find(P, st, { upto: FIRST_LOOKAHEAD, stepCache });
    if (firings.length) {
      if (rule.weight > IMAGINE_AFTER) {
        const ruleCost = rule.weight + (rule.extra ? rule.extra(P, st, firings[0]) : 0);
        const f = imagined(ruleCost);
        if (f && f.cost < ruleCost) return imagineStep(f);
      }
      return { rule: rule.id, tier: rule.tier, weight: rule.weight, firings };
    }
  }
  const f = imagined(Infinity);
  return f ? imagineStep(f) : null;
}

export function nextStep(P, st, bookkeeping = null, without = null) {
  const r = nextSteps(P, st, bookkeeping, without);
  if (!r) return null;
  const rule = RULES[RULE_IDS.indexOf(r.rule)];
  const f = r.firings[0];
  const extra = rule.extra ? rule.extra(P, st, f) : 0;
  return { rule: r.rule, tier: r.tier, weight: r.weight, extra, sets: f.sets, info: f.info };
}

/**
 * Solve like a human. Never looks at P.solution.
 * Returns { solved, rules, tier, score, steps, counts, state }.
 */
export function rate(P, { without = null } = {}) {
  const st = initialState(P);
  const steps = [];
  const counts = {};

  for (let guard = 0; guard < 3000; guard++) {
    if (isSolved(P, st.e)) break;
    if (guard === 0 && contradiction(P, st)) break;
    const bk = {};
    const step = nextStep(P, st, bk, without);
    for (const id of Object.keys(bk)) {
      const rule = RULES.find((q) => q.id === id);
      steps.push({ rule: id, tier: rule.tier, weight: rule.weight, sets: [], info: { bookkeeping: true } });
      counts[id] = (counts[id] || 0) + 1;
    }
    if (!step) break;
    if (!applySets(st, step.sets)) break;
    steps.push(step);
    counts[step.rule] = (counts[step.rule] || 0) + 1;
  }

  // Final tidy bookkeeping (e.g. closedLoopRestOff) — never re-run expensive non-free finders
  const finalBk = {};
  runFreeBookkeeping(P, st, finalBk);
  for (const id of Object.keys(finalBk)) {
    const rule = RULES.find((q) => q.id === id);
    steps.push({ rule: id, tier: rule.tier, weight: rule.weight, sets: [], info: { bookkeeping: true } });
    counts[id] = (counts[id] || 0) + 1;
  }

  const solved = isSolved(P, st.e);
  let hardest = 'unsolved';
  if (solved) {
    const rank = (s) => {
      const idx = RULE_IDS.indexOf(s.rule);
      const tIdx = TIERS.indexOf(s.tier);
      return tIdx * 100000 + (s.weight + (s.extra || 0)) * 100 + idx;
    };
    const nonFree = steps.filter((s) => !RULES[RULE_IDS.indexOf(s.rule)].free);
    const pool = nonFree.length ? nonFree : steps;
    hardest = pool.length ? pool.reduce((best, s) => (rank(s) > rank(best) ? s : best), pool[0]).rule : 'whiteStraight';
  }

  // Count undecided cells (cells with at least one undecided incident edge, or UNKNOWN cell state)
  let unknown = 0;
  if (!solved) {
    for (let i = 0; i < P.N; i++) {
      let hasUnk = st.cell[i] === UNKNOWN;
      if (!hasUnk) {
        for (let d = 0; d < 4; d++) {
          const x = P.ed[i * 4 + d];
          if (x >= 0 && st.e[x] === E_UNKNOWN) { hasUnk = true; break; }
        }
      }
      if (hasUnk) unknown++;
    }
  }

  const score = steps.reduce((a, s) => a + s.weight + (s.extra || 0), 0) + (solved ? 0 : unknown * UNDETERMINED_WEIGHT);
  return { solved, rules: hardest, tier: tierOfRule(hardest), score, steps, counts, state: st };
}

/**
 * Sound rule solvability check (fast, excludes costly/lookahead rules by default).
 * Because every rule below FIRST_LOOKAHEAD is sound, a puzzle they solve is guaranteed to have a unique solution.
 */
export function solvedByRules(P, upto = FIRST_LOOKAHEAD) {
  const st = initialState(P);
  const r = closure(P, st, upto, Infinity, false);
  return { solved: !r.contradiction && isSolved(P, st.e), state: st, steps: r.steps };
}
