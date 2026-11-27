// Corral (also known as Bag / Cave) constraint module (pure logic, no DOM).
//
// Rules (Nikoli Bag / Corral):
//   - Every numbered square (dual face `(r, c)` in the `(rows-1) x (cols-1)` square grid) must lie
//     strictly INSIDE the single closed loop.
//   - Each number `n` counts the total number of Inside squares orthogonally visible from that square
//     in all 4 directions (Up, Right, Down, Left), including the numbered square itself, stopping in
//     each direction at the first loop fence (or the outer board boundary).
//
// CSV tokens: `r:c:K<n>` (0-based face row/col, integer `n >= 1`, e.g. `2:3:K5`).
// Works standalone or composed with Masyu, Slitherlink, Mid-loop, Castle Wall, Hamilton cycle,
// givens, and Swiss cheese voids.

const E_UNKNOWN = 0, E_ON = 1, E_OFF = 2;
const DR = [-1, 0, 1, 0];
const DC = [0, 1, 0, -1];
const DIR_WORD = ['up', 'right', 'down', 'left'];

// Reusable scratch buffers for zero-allocation BFS, parity union-find, ray stats, and live states
let scratchOut = new Uint8Array(0);
let scratchBfsQ = new Int32Array(0);
let scratchPar = new Int32Array(0);
let scratchDiff = new Uint8Array(0);
let scratchStack = new Int32Array(0);
let scratchUnk = new Int32Array(0);

// Two zero-allocation rayStats banks (bank 0 for primary, bank 1 for parity comparison)
const RS0 = { minV: new Int16Array(4), maxV: new Int16Array(4), jump: new Int16Array(4), totalMin: 0, totalMax: 0 };
const RS1 = { minV: new Int16Array(4), maxV: new Int16Array(4), jump: new Int16Array(4), totalMin: 0, totalMax: 0 };

// Flat scratch arrays for line scanners (scanSameLineCorral / scanSeparateCorral) and propagateCorralParity
let lineCap = 0;
let slMin = new Int16Array(0);
let slMax = new Int16Array(0);
let slJump = new Int16Array(0);
let slTotMin = new Int16Array(0);
let slTotMax = new Int16Array(0);

// Scratch arrays for zero-allocation outMask & per-clue rayStats cache in propagateCorralParity
let scratchOutMask = new Uint8Array(0);
let propClueCap = 0;
let propMin = new Int16Array(0);
let propMax = new Int16Array(0);
let propJump = new Int16Array(0);
let propTotMin = new Int16Array(0);
let propTotMax = new Int16Array(0);

// Scratch arrays for zero-GC live corralStates CSR adjacency & BFS
let csHead = new Int32Array(0);
let csNext = new Int32Array(0);
let csTo = new Int32Array(0);
let csXor = new Uint8Array(0);
let csCompId = new Int32Array(0);
let csCompCol = new Int8Array(0);
let csWant = new Uint8Array(0);
let csCompBad = new Uint8Array(0);
let csQ = new Int32Array(0);

// Scratch arrays for corralWallCap (on-degree + clue/edge deduplication)
let wcSeen = new Int32Array(0);
let wcStamp = 0;
let wcEdgeSeen = new Int32Array(0);
let wcEdgeStamp = 0;
let wcOnDeg = new Uint8Array(0);

function ensureFaceScratch(F) {
  if (scratchOut.length < F) scratchOut = new Uint8Array(F);
  if (scratchBfsQ.length < F) scratchBfsQ = new Int32Array(F);
}

function ensureParScratch(V, nEdges = 0) {
  if (scratchPar.length < V) scratchPar = new Int32Array(V);
  if (scratchDiff.length < V) scratchDiff = new Uint8Array(V);
  if (scratchStack.length < V) scratchStack = new Int32Array(V);
  if (scratchOutMask.length < V) scratchOutMask = new Uint8Array(V);
  if (nEdges > 0 && scratchUnk.length < nEdges) scratchUnk = new Int32Array(nEdges);
}

function ensurePropClueScratch(K) {
  if (propClueCap >= K) return;
  propClueCap = Math.max(32, K);
  propMin = new Int16Array(propClueCap * 4);
  propMax = new Int16Array(propClueCap * 4);
  propJump = new Int16Array(propClueCap * 4);
  propTotMin = new Int16Array(propClueCap);
  propTotMax = new Int16Array(propClueCap);
}

function ensureLineScratch(len) {
  if (lineCap >= len) return;
  lineCap = Math.max(16, len);
  slMin = new Int16Array(lineCap * 4);
  slMax = new Int16Array(lineCap * 4);
  slJump = new Int16Array(lineCap * 4);
  slTotMin = new Int16Array(lineCap);
  slTotMax = new Int16Array(lineCap);
}

function ensureCsScratch(V, maxHalfEdges) {
  if (csHead.length < V) {
    csHead = new Int32Array(V);
    csCompId = new Int32Array(V);
    csCompCol = new Int8Array(V);
    csWant = new Uint8Array(V);
    csCompBad = new Uint8Array(V);
    csQ = new Int32Array(V);
  }
  if (csTo.length < maxHalfEdges) {
    csNext = new Int32Array(maxHalfEdges);
    csTo = new Int32Array(maxHalfEdges);
    csXor = new Uint8Array(maxHalfEdges);
  }
}

/** True if edge `x` lies on any Corral clue's border or sightline ray. */
export function isCorralEdge(P, x) {
  return Boolean(P.hasCorral && P._ekOff && P._ekOff[x] < P._ekOff[x + 1]);
}

/**
 * Tighter frontier predicate for `imagine.js`: true iff `x` is a direct border edge of a Corral square
 * OR lies on an unblocked ray segment (no E_ON wall between the clue and `x`) of at least one Corral clue.
 */
export function isCorralFrontierEdge(P, st, x) {
  if (!P.hasCorral) return false;
  if (P._krBorderMask[x]) return true;
  const off = P._ekOff;
  const start = off[x], end = off[x + 1];
  if (start >= end) return false;
  const data = P._ekData, dirs = P._ekDir, pos = P._ekPos;
  const corral = P.corral, e = st.e;
  for (let k = start; k < end; k++) {
    const d = dirs[k];
    if (d >= 4) return true; // direct border
    const ray = corral[data[k]].rays[d];
    const p = pos[k];
    let blocked = false;
    for (let i = 0; i < p; i++) {
      const rx = ray[i];
      if (rx >= 0 && e[rx] === E_ON) { blocked = true; break; }
    }
    if (!blocked) return true;
  }
  return false;
}

/**
 * Compile Corral face clues onto puzzle `P`.
 * Expects `P.rows`, `P.cols`, `P.edgeA`, `P.faceEdges`, `P.faceExterior`, `P.faceHoleId`,
 * `P.slitherAt`, and `P.castle` (if any) to already be computed.
 */
export function compileCorral(P, raw) {
  const { rows, cols, numEdges, edgeA, faceEdges } = P;
  const fr = Math.max(0, rows - 1), fc = Math.max(0, cols - 1), F = fr * fc;
  const rawCorral = Array.isArray(raw.corral) ? raw.corral : [];
  const corral = [];
  let corralAt = null, corralNum = null;
  let _ekOff = null, _ekData = null, _ekDir = null, _ekPos = null;
  let _krBorderMask = null;
  let _corralByRow = null, _corralByCol = null;
  let _krMultiRow = null, _krMultiCol = null;
  let _krEdgeX = null, _krEdgeFA = null, _krEdgeFB = null;
  let _krAnchorF = null, _krAnchorWant = null;
  let corralImpossible = false;

  if (rawCorral.length > 0) {
    corralAt = new Int16Array(F).fill(-1);
    corralNum = new Int16Array(F).fill(-1);
    const byRow = Array.from({ length: fr }, () => []);
    const byCol = Array.from({ length: fc }, () => []);
    const faceExt = P.faceExterior || null;
    const faceHole = P.faceHoleId || null;

    for (let k = 0; k < rawCorral.length; k++) {
      const kr = rawCorral[k];
      const { r, c, n } = kr;
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= fr || c >= fc) {
        throw new Error(`corral clue out of bounds at ${r},${c}`);
      }
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`bad corral clue value "${n}" at ${r},${c}`);
      }
      const f = r * fc + c;
      if (faceExt && faceExt[f]) throw new Error(`corral clue on exterior void at ${r},${c}`);
      if (faceHole && faceHole[f] >= 0) throw new Error(`corral clue on void hole at ${r},${c}`);
      if (corralAt[f] >= 0) throw new Error(`duplicate corral clue at ${r},${c}`);
      if (P.slitherAt && P.slitherAt[f] >= 0) throw new Error(`corral clue overlaps Slitherlink clue at ${r},${c}`);

      const rays = [];
      const rayFaces = [];
      let maxPossible = 1;
      for (let d = 0; d < 4; d++) {
        const re = [];
        const rf = [];
        let pr = r, pc = c;
        for (;;) {
          const nr = pr + DR[d], nc = pc + DC[d];
          if (nr < 0 || nr >= fr || nc < 0 || nc >= fc) break;
          const nf = nr * fc + nc;
          if (faceExt && faceExt[nf]) break;
          const x = faceEdges[(pr * fc + pc) * 4 + d];
          re.push(x);
          rf.push(nf);
          pr = nr; pc = nc;
        }
        rays.push(Int32Array.from(re));
        rayFaces.push(Int32Array.from(rf));
        maxPossible += re.length;
      }

      if (n > maxPossible) corralImpossible = true;
      corralAt[f] = corral.length;
      corralNum[f] = n;
      byRow[r].push(corral.length);
      byCol[c].push(corral.length);
      corral.push({ r, c, n, f, rays, rayFaces, maxPossible });
    }

    const multiRow = [], multiCol = [];
    for (let r = 0; r < fr; r++) {
      byRow[r].sort((a, b) => corral[a].c - corral[b].c);
      if (byRow[r].length >= 2) multiRow.push(Int16Array.from(byRow[r]));
    }
    for (let c = 0; c < fc; c++) {
      byCol[c].sort((a, b) => corral[a].r - corral[b].r);
      if (byCol[c].length >= 2) multiCol.push(Int16Array.from(byCol[c]));
    }
    _corralByRow = byRow;
    _corralByCol = byCol;
    _krMultiRow = multiRow;
    _krMultiCol = multiCol;

    // Build deduplicated CSR edge -> Corral clue wakeup table (plus ray direction/pos for active frontier check)
    _krBorderMask = new Uint8Array(numEdges);
    const edgeLists = Array.from({ length: numEdges }, () => []);
    const addWake = (x, ci, d, p) => {
      if (x < 0 || edgeA[x] < 0) return;
      const list = edgeLists[x];
      for (let i = 0; i < list.length; i += 3) {
        if (list[i] === ci) {
          if (p < list[i + 2]) { list[i + 1] = d; list[i + 2] = p; }
          return;
        }
      }
      list.push(ci, d, p);
    };
    for (let ci = 0; ci < corral.length; ci++) {
      const kr = corral[ci];
      const f4 = kr.f * 4;
      for (let d = 0; d < 4; d++) {
        const bx = faceEdges[f4 + d];
        if (bx >= 0 && edgeA[bx] >= 0) {
          _krBorderMask[bx] = 1;
          addWake(bx, ci, 4, 0);
        }
        const ray = kr.rays[d];
        for (let i = 0; i < ray.length; i++) addWake(ray[i], ci, d, i);
      }
    }
    _ekOff = new Int32Array(numEdges + 1);
    let total = 0;
    for (let x = 0; x < numEdges; x++) { _ekOff[x] = total; total += (edgeLists[x].length / 3) | 0; }
    _ekOff[numEdges] = total;
    _ekData = new Int32Array(total);
    _ekDir = new Uint8Array(total);
    _ekPos = new Uint8Array(total);
    for (let x = 0; x < numEdges; x++) {
      const list = edgeLists[x];
      let off = _ekOff[x];
      for (let i = 0; i < list.length; i += 3) {
        _ekData[off] = list[i];
        _ekDir[off] = list[i + 1];
        _ekPos[off] = list[i + 2];
        off++;
      }
    }

    // Precompute flat active-edge canonical dual-face pairs & static Inside/Outside anchors
    const EXT = F;
    const faceRep = P.hasVoids ? P.faceRep : null;
    const canon = (f) => {
      if (f < 0 || f >= F) return EXT;
      if (faceExt) return faceExt[f] ? EXT : faceRep[f];
      return f;
    };
    const exList = [], faList = [], fbList = [];
    for (let x = 0; x < numEdges; x++) {
      if (edgeA[x] < 0) continue;
      const cell = x >> 1;
      const r = (cell / cols) | 0, c = cell % cols;
      const a = (x & 1) === 0
        ? canon(r > 0 && c < fc ? (r - 1) * fc + c : EXT)
        : canon(r < fr && c > 0 ? r * fc + (c - 1) : EXT);
      const b = canon(r < fr && c < fc ? r * fc + c : EXT);
      exList.push(x);
      faList.push(a);
      fbList.push(b);
    }
    _krEdgeX = Int32Array.from(exList);
    _krEdgeFA = Int32Array.from(faList);
    _krEdgeFB = Int32Array.from(fbList);

    const afList = [], awList = [];
    for (let k = 0; k < corral.length; k++) {
      afList.push(canon(corral[k].f));
      awList.push(1);
    }
    if (P.hasCastleWalls) {
      for (let k = 0; k < P.castle.length; k++) {
        const cw = P.castle[k];
        if (cw.wall === 'G') continue;
        if (cw.isExterior || cw.face < 0) {
          if (cw.wall === 'W') corralImpossible = true;
          continue;
        }
        afList.push(canon(cw.face));
        awList.push(cw.wall === 'W' ? 1 : 0);
      }
    }
    _krAnchorF = Int32Array.from(afList);
    _krAnchorWant = Uint8Array.from(awList);
  }

  P.corral = corral;
  P.hasCorral = corral.length > 0;
  P.corralAt = corralAt;
  P.corralNum = corralNum;
  P.corralImpossible = corralImpossible;
  P._ekOff = _ekOff;
  P._ekData = _ekData;
  P._ekDir = _ekDir;
  P._ekPos = _ekPos;
  P._krBorderMask = _krBorderMask;
  P._corralByRow = _corralByRow;
  P._corralByCol = _corralByCol;
  P._krMultiRow = _krMultiRow;
  P._krMultiCol = _krMultiCol;
  P._krEdgeX = _krEdgeX;
  P._krEdgeFA = _krEdgeFA;
  P._krEdgeFB = _krEdgeFB;
  P._krAnchorF = _krAnchorF;
  P._krAnchorWant = _krAnchorWant;
}

/** Append CSV tokens `r:c:K<n>` to `parts`. */
export function serializeCorral(p, parts) {
  for (const kr of p.corral || []) parts.push(`${kr.r}:${kr.c}:K${kr.n}`);
}

/** Parse a `K<n>` CSV clue token. Returns true if consumed. */
export function parseCorralToken(r, c, tag, acc) {
  if (tag.length >= 2 && tag[0] === 'K' && /^\d+$/.test(tag.slice(1))) {
    acc.corral.push({ r, c, n: Number(tag.slice(1)) });
    return true;
  }
  return false;
}

/** Canonical dihedral-transformed Corral string for `symmetryKey`. */
export function symmetryCorral(p, swap, flipR, flipC) {
  const list = p.corral || [];
  if (!list.length) return '';
  const fR = (swap ? p.cols : p.rows) - 1;
  const fC = (swap ? p.rows : p.cols) - 1;
  return '|K:' + list.map((kr) => {
    let r = kr.r, c = kr.c;
    if (swap) [r, c] = [c, r];
    if (flipR) r = fR - 1 - r;
    if (flipC) c = fC - 1 - c;
    return [r * fC + c, `${r}:${c}:${kr.n}`];
  }).sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(';');
}

/** Rotate Corral face clues 90° CW for a board of size R x C -> C x R. */
export function rotateCorralCW(P) {
  const fR = P.rows - 1;
  return (P.corral || []).map((kr) => ({ r: kr.c, c: fR - 1 - kr.r, n: kr.n }));
}

/**
 * Mark all faces Outside a closed loop `edges` (plus optional extra ON edge `extraOnEdge`)
 * via BFS from the outer boundary across non-E_ON edges.
 * Returns scratch Uint8Array(F) where 1 = Outside, 0 = Inside.
 */
function computeOutsideScratch(P, edges, extraOnEdge = -1) {
  const fr = P.rows - 1, fc = P.cols - 1, F = fr * fc;
  ensureFaceScratch(F);
  const out = scratchOut;
  const q = scratchBfsQ;
  for (let f = 0; f < F; f++) out[f] = 0;
  const fe = P.faceEdges;
  const faceExt = P.faceExterior || null;
  let head = 0, tail = 0;
  const isWall = (x) => x >= 0 && (x === extraOnEdge || edges[x] === E_ON);

  for (let r = 0; r < fr; r++) {
    for (let c = 0; c < fc; c++) {
      const f = r * fc + c;
      if (faceExt && faceExt[f]) { out[f] = 1; q[tail++] = f; continue; }
      const f4 = f * 4;
      if ((r === 0 && !isWall(fe[f4]))
        || (c === fc - 1 && !isWall(fe[f4 + 1]))
        || (r === fr - 1 && !isWall(fe[f4 + 2]))
        || (c === 0 && !isWall(fe[f4 + 3]))) {
        out[f] = 1;
        q[tail++] = f;
      }
    }
  }
  while (head < tail) {
    const f = q[head++];
    const r = (f / fc) | 0, c = f % fc;
    const f4 = f * 4;
    if (r > 0 && !out[f - fc] && !isWall(fe[f4])) { out[f - fc] = 1; q[tail++] = f - fc; }
    if (c < fc - 1 && !out[f + 1] && !isWall(fe[f4 + 1])) { out[f + 1] = 1; q[tail++] = f + 1; }
    if (r < fr - 1 && !out[f + fc] && !isWall(fe[f4 + 2])) { out[f + fc] = 1; q[tail++] = f + fc; }
    if (c > 0 && !out[f - 1] && !isWall(fe[f4 + 3])) { out[f - 1] = 1; q[tail++] = f - 1; }
  }
  return out;
}

/**
 * Return the index of the first unsatisfied Corral clue on a closed loop `edges`
 * (optionally treating `extraOnEdge` as E_ON), or -1 if every Corral clue is strictly Inside
 * and sees exact count `n`.
 */
export function firstUnsatisfiedCorral(P, edges, extraOnEdge = -1) {
  if (!P.hasCorral) return -1;
  const outside = computeOutsideScratch(P, edges, extraOnEdge);
  const corral = P.corral;
  for (let ci = 0; ci < corral.length; ci++) {
    const kr = corral[ci];
    if (outside[kr.f]) return ci;
    let vis = 1;
    for (let d = 0; d < 4; d++) {
      const ray = kr.rays[d];
      for (let i = 0; i < ray.length; i++) {
        const x = ray[i];
        if (x >= 0 && (x === extraOnEdge || edges[x] === E_ON)) break;
        vis++;
      }
    }
    if (vis !== kr.n) return ci;
  }
  return -1;
}

/** Exact solution check: every Corral square is strictly Inside and sees exactly `n` Inside squares. */
export function isCorralSatisfied(P, edges) {
  return firstUnsatisfiedCorral(P, edges) < 0;
}

/** Check whether closing `closingEdge` (UNKNOWN -> ON) leaves any Corral clue unsatisfied. */
export function firstUnsatisfiedCorralOnClose(P, st, closingEdge) {
  if (!P.hasCorral) return -1;
  return firstUnsatisfiedCorral(P, st.e, closingEdge);
}

/** Fill per-direction ray metrics into `out` (`RS0` or `RS1`) with zero heap allocations. */
function rayStatsInto(kr, e, outMask, out) {
  const minV = out.minV, maxV = out.maxV, jump = out.jump;
  let totalMin = 1, totalMax = 1;
  for (let d = 0; d < 4; d++) {
    const ray = kr.rays[d];
    const len = ray.length;
    let mn = 0;
    while (mn < len && (ray[mn] < 0 || e[ray[mn]] === E_OFF)) mn++;
    let mx;
    if (outMask) {
      const rFaces = kr.rayFaces[d];
      mx = 0;
      while (mx < len) {
        const x = ray[mx];
        if ((x >= 0 && e[x] === E_ON) || outMask[rFaces[mx]]) break;
        mx++;
      }
    } else {
      mx = mn;
      while (mx < len) {
        const x = ray[mx];
        if (x >= 0 && e[x] === E_ON) break;
        mx++;
      }
    }
    let jmp = 0;
    if (mn < len && ray[mn] >= 0 && e[ray[mn]] === E_UNKNOWN) {
      let after = 0;
      while (mn + 1 + after < len && (ray[mn + 1 + after] < 0 || e[ray[mn + 1 + after]] === E_OFF)) after++;
      jmp = 1 + after;
    }
    minV[d] = mn;
    maxV[d] = mx;
    jump[d] = jmp;
    totalMin += mn;
    totalMax += mx;
  }
  out.totalMin = totalMin;
  out.totalMax = totalMax;
  return out;
}

/** Fill flat scratch slot `slot` in `(dstMin, dstMax, dstJump, dstTotMin, dstTotMax)` with rayStats for `kr`. */
function fillStatsSlot(kr, e, outMask, dstMin, dstMax, dstJump, dstTotMin, dstTotMax, slot) {
  const rs = rayStatsInto(kr, e, outMask, RS0);
  const b = slot * 4;
  dstMin[b] = rs.minV[0]; dstMin[b + 1] = rs.minV[1]; dstMin[b + 2] = rs.minV[2]; dstMin[b + 3] = rs.minV[3];
  dstMax[b] = rs.maxV[0]; dstMax[b + 1] = rs.maxV[1]; dstMax[b + 2] = rs.maxV[2]; dstMax[b + 3] = rs.maxV[3];
  dstJump[b] = rs.jump[0]; dstJump[b + 1] = rs.jump[1]; dstJump[b + 2] = rs.jump[2]; dstJump[b + 3] = rs.jump[3];
  dstTotMin[slot] = rs.totalMin;
  dstTotMax[slot] = rs.totalMax;
  return rs;
}

/**
 * Exact local propagation for Corral clue `ci` inside `propagate()`.
 * Applies immediate border/adjacent-clue edge forcing plus 4-ray sightline reach & overshoot bounds.
 * Returns false on contradiction.
 */
export function propagateCorralClue(P, st, ci, setEdge) {
  const kr = P.corral[ci];
  const e = st.e;
  const fr = P.rows - 1, fc = P.cols - 1;
  const fe = P.faceEdges;
  const faceExt = P.faceExterior || null;
  const corralAt = P.corralAt;
  const f4 = kr.f * 4;

  // 1. Border edges of a Corral square must be ON; edges between adjacent Corral squares must be OFF.
  for (let d = 0; d < 4; d++) {
    const x = fe[f4 + d];
    if (x < 0) continue;
    const nr = kr.r + DR[d], nc = kr.c + DC[d];
    if (nr < 0 || nr >= fr || nc < 0 || nc >= fc || (faceExt && faceExt[nr * fc + nc])) {
      if (e[x] === E_OFF) return false;
      if (e[x] === E_UNKNOWN && !setEdge(x, E_ON)) return false;
    } else if (corralAt[nr * fc + nc] >= 0) {
      if (e[x] === E_ON) return false;
      if (e[x] === E_UNKNOWN && !setEdge(x, E_OFF)) return false;
    }
  }

  // 2. 4-ray sightline bounds (reach lower bound & overshoot upper bound)
  const rs = rayStatsInto(kr, e, null, RS0);
  const totalMin = rs.totalMin, totalMax = rs.totalMax;
  if (totalMin > kr.n || totalMax < kr.n) return false;

  const minV = rs.minV, maxV = rs.maxV, jump = rs.jump;
  for (let d = 0; d < 4; d++) {
    const ray = kr.rays[d];
    const need = kr.n - (totalMax - maxV[d]);
    if (need > minV[d]) {
      for (let i = 0; i < need; i++) {
        const x = ray[i];
        if (x < 0) continue;
        if (e[x] === E_ON) return false;
        if (e[x] === E_UNKNOWN && !setEdge(x, E_OFF)) return false;
      }
    }
    if (jump[d] > 0 && totalMin + jump[d] > kr.n) {
      const x = ray[minV[d]];
      if (e[x] === E_OFF) return false;
      if (e[x] === E_UNKNOWN && !setEdge(x, E_ON)) return false;
    }
  }
  return true;
}

/**
 * Fast zero-allocation signed union-find over dual faces using precomputed `_krEdgeX/FA/FB` & `_krAnchorF/Want`.
 * When `buildOutMask` is true, fills `scratchOutMask[0..F-1]` with 1 for every face proven Outside (0 otherwise).
 */
function buildBasicParity(P, e, captureUnk = false, buildOutMask = false) {
  const fr = P.rows - 1, fc = P.cols - 1, F = fr * fc, EXT = F, V = F + 1;
  const ex = P._krEdgeX, fa = P._krEdgeFA, fb = P._krEdgeFB;
  const nEdges = ex.length;
  ensureParScratch(V, captureUnk ? nEdges : 0);
  const par = scratchPar, diff = scratchDiff, stk = scratchStack;
  for (let i = 0; i < V; i++) { par[i] = i; diff[i] = 0; }

  const compress = (u) => {
    let cur = u, sp = 0;
    while (par[cur] !== cur) { stk[sp++] = cur; cur = par[cur]; }
    const root = cur;
    let p = 0;
    for (let i = sp - 1; i >= 0; i--) {
      const node = stk[i];
      p ^= diff[node];
      par[node] = root;
      diff[node] = p;
    }
    return root;
  };
  let conflict = false;
  const link = (u, v, xor) => {
    if (u === v) { if (xor) conflict = true; return; }
    const ru = compress(u), pu = diff[u];
    const rv = compress(v), pv = diff[v];
    if (ru === rv) { if ((pu ^ pv) !== xor) conflict = true; return; }
    if (rv === EXT) { par[ru] = rv; diff[ru] = pu ^ pv ^ xor; }
    else { par[rv] = ru; diff[rv] = pu ^ pv ^ xor; }
  };

  // Static Inside/Outside anchors (Corral clues + Castle Wall W/B tiles)
  const af = P._krAnchorF, aw = P._krAnchorWant;
  for (let k = 0; k < af.length; k++) {
    link(EXT, af[k], aw[k]);
    if (conflict) break;
  }

  // Known ON/OFF active edges
  let nUnk = 0;
  const unk = scratchUnk;
  if (!conflict) {
    for (let i = 0; i < nEdges; i++) {
      const ev = e[ex[i]];
      if (ev === E_UNKNOWN) {
        if (captureUnk) unk[nUnk++] = i;
        continue;
      }
      link(fa[i], fb[i], ev === E_ON ? 1 : 0);
      if (conflict) break;
    }
  }

  let outMask = null;
  if (buildOutMask && !conflict) {
    outMask = scratchOutMask;
    const faceExt = P.hasVoids ? P.faceExterior : null;
    const faceRep = P.hasVoids ? P.faceRep : null;
    if (faceExt) {
      for (let f = 0; f < F; f++) {
        if (faceExt[f]) { outMask[f] = 1; continue; }
        const cf = faceRep[f];
        outMask[f] = (compress(cf) === EXT && diff[cf] === 0) ? 1 : 0;
      }
    } else {
      for (let f = 0; f < F; f++) {
        outMask[f] = (compress(f) === EXT && diff[f] === 0) ? 1 : 0;
      }
    }
  }

  return { EXT, conflict, nUnk, compress, diff, outMask };
}

/**
 * Scan all E_OFF-linked aligned Corral clue runs along rows & columns (zero heap allocations on hot path).
 * Tracks top-2 distinct sources for `sMin` and `sMax` so:
 *   - No clue is ever compared with itself (`ci !== ci2` guaranteed)
 *   - Tied bounds between two clues still fire deductions on both clues
 * When `precomp` is passed (from `propagateCorralParity`), reads directly from precomputed per-clue stats!
 * Invokes `onAction(x, val, info)` for every deduced edge; returns false on contradiction.
 */
function scanSameLineCorral(P, e, outMask, dirtyCorrals, onAction, precomp = false) {
  const corral = P.corral;
  const fe = P.faceEdges;
  const fc = P.cols - 1;
  const faceExt = P.faceExterior || null;
  const useMin = precomp ? propMin : slMin;
  const useMax = precomp ? propMax : slMax;
  const useJump = precomp ? propJump : slJump;

  const otherSrc = (s1, s2, self) => (s1 >= 0 && s1 !== self ? s1 : (s2 >= 0 && s2 !== self ? s2 : -1));

  const processAxis = (groups, isRow) => {
    const posDir = isRow ? 1 : 2;
    const negDir = isRow ? 3 : 0;
    const perpA = isRow ? 0 : 1;
    const perpB = isRow ? 2 : 3;
    const axisName = isRow ? 'row' : 'col';

    for (let gi = 0; gi < groups.length; gi++) {
      const line = groups[gi];
      const len = line.length;
      if (dirtyCorrals) {
        let anyDirty = false;
        for (let i = 0; i < len; i++) if (dirtyCorrals[line[i]]) { anyDirty = true; break; }
        if (!anyDirty) continue;
      }

      // Partition sorted clues into maximal E_OFF-connected runs
      let start = 0;
      while (start < len) {
        let end = start;
        while (end + 1 < len) {
          const a = corral[line[end]];
          const b = corral[line[end + 1]];
          const steps = isRow ? (b.c - a.c) : (b.r - a.r);
          let connected = true;
          let cr = a.r, cc = a.c;
          for (let s = 0; s < steps; s++) {
            const x = fe[(cr * fc + cc) * 4 + posDir];
            if (x >= 0 && e[x] !== E_OFF) { connected = false; break; }
            cr += DR[posDir]; cc += DC[posDir];
            if (faceExt && faceExt[cr * fc + cc]) { connected = false; break; }
          }
          if (!connected) break;
          end++;
        }

        if (end > start) {
          const runLen = end - start + 1;
          if (!precomp) {
            ensureLineScratch(runLen);
            for (let ri = 0; ri < runLen; ri++) {
              fillStatsSlot(corral[line[start + ri]], e, outMask, slMin, slMax, slJump, slTotMin, slTotMax, ri);
            }
          }

          const firstCi = line[start], lastCi = line[end];
          const first = corral[firstCi], last = corral[lastCi];
          const spanLen = (isRow ? (last.c - first.c) : (last.r - first.r)) + 1;
          const bFirst = (precomp ? firstCi : 0) * 4;
          const bLast = (precomp ? lastCi : (runLen - 1)) * 4;

          const firstMinNeg = useMin[bFirst + negDir], firstMaxNeg = useMax[bFirst + negDir], firstJumpNeg = useJump[bFirst + negDir];
          const lastMinPos = useMin[bLast + posDir], lastMaxPos = useMax[bLast + posDir], lastJumpPos = useJump[bLast + posDir];
          const axisMin = spanLen + firstMinNeg + lastMinPos;
          const axisMax = spanLen + firstMaxNeg + lastMaxPos;

          let sMin = axisMin, minSrc = -1, minSrc2 = -1;
          let sMax = axisMax, maxSrc = -1, maxSrc2 = -1;
          for (let ri = 0; ri < runLen; ri++) {
            const ci = line[start + ri];
            const kr = corral[ci];
            const b = (precomp ? ci : ri) * 4;
            const pMin = useMin[b + perpA] + useMin[b + perpB];
            const pMax = useMax[b + perpA] + useMax[b + perpB];
            const cMin = kr.n - pMax;
            const cMax = kr.n - pMin;
            if (cMin > sMin) { sMin = cMin; minSrc = ci; minSrc2 = -1; }
            else if (cMin === sMin && minSrc >= 0 && minSrc2 < 0) { minSrc2 = ci; }
            if (cMax < sMax) { sMax = cMax; maxSrc = ci; maxSrc2 = -1; }
            else if (cMax === sMax && maxSrc >= 0 && maxSrc2 < 0) { maxSrc2 = ci; }
          }
          if (sMin > sMax) return false;

          if (onAction) {
            const needNeg = sMin - (spanLen + lastMaxPos);
            const srcNegExt = otherSrc(minSrc, minSrc2, firstCi);
            if (needNeg > firstMinNeg && srcNegExt >= 0) {
              const ray = first.rays[negDir];
              for (let i = 0; i < needNeg; i++) {
                const x = ray[i];
                if (x >= 0 && e[x] === E_UNKNOWN) {
                  if (!onAction(x, E_OFF, { ci: firstCi, ci2: srcNegExt, dir: negDir, axis: axisName, mode: 'axisExtend' })) return false;
                }
              }
            }
            const srcNegCap = otherSrc(maxSrc, maxSrc2, firstCi);
            if (firstJumpNeg > 0 && axisMin + firstJumpNeg > sMax && srcNegCap >= 0) {
              const x = first.rays[negDir][firstMinNeg];
              if (x >= 0 && e[x] === E_UNKNOWN) {
                if (!onAction(x, E_ON, { ci: firstCi, ci2: srcNegCap, dir: negDir, axis: axisName, mode: 'axisCap' })) return false;
              }
            }
            const needPos = sMin - (spanLen + firstMaxNeg);
            const srcPosExt = otherSrc(minSrc, minSrc2, lastCi);
            if (needPos > lastMinPos && srcPosExt >= 0) {
              const ray = last.rays[posDir];
              for (let i = 0; i < needPos; i++) {
                const x = ray[i];
                if (x >= 0 && e[x] === E_UNKNOWN) {
                  if (!onAction(x, E_OFF, { ci: lastCi, ci2: srcPosExt, dir: posDir, axis: axisName, mode: 'axisExtend' })) return false;
                }
              }
            }
            const srcPosCap = otherSrc(maxSrc, maxSrc2, lastCi);
            if (lastJumpPos > 0 && axisMin + lastJumpPos > sMax && srcPosCap >= 0) {
              const x = last.rays[posDir][lastMinPos];
              if (x >= 0 && e[x] === E_UNKNOWN) {
                if (!onAction(x, E_ON, { ci: lastCi, ci2: srcPosCap, dir: posDir, axis: axisName, mode: 'axisCap' })) return false;
              }
            }

            for (let ri = 0; ri < runLen; ri++) {
              const ci = line[start + ri];
              const kr = corral[ci];
              const b = (precomp ? ci : ri) * 4;
              const pMin = useMin[b + perpA] + useMin[b + perpB];
              const srcPExt = otherSrc(maxSrc, maxSrc2, ci);
              const srcPCap = otherSrc(minSrc, minSrc2, ci);
              for (let pi = 0; pi < 2; pi++) {
                const d = pi === 0 ? perpA : perpB;
                const otherD = pi === 0 ? perpB : perpA;
                const ray = kr.rays[d];
                if (srcPExt >= 0) {
                  const needP = (kr.n - sMax) - useMax[b + otherD];
                  if (needP > useMin[b + d]) {
                    for (let i = 0; i < needP; i++) {
                      const x = ray[i];
                      if (x >= 0 && e[x] === E_UNKNOWN) {
                        if (!onAction(x, E_OFF, { ci, ci2: srcPExt, dir: d, axis: axisName, mode: 'perpExtend' })) return false;
                      }
                    }
                  }
                }
                const jmp = useJump[b + d];
                if (srcPCap >= 0 && jmp > 0 && sMin + pMin + jmp > kr.n) {
                  const x = ray[useMin[b + d]];
                  if (x >= 0 && e[x] === E_UNKNOWN) {
                    if (!onAction(x, E_ON, { ci, ci2: srcPCap, dir: d, axis: axisName, mode: 'perpCap' })) return false;
                  }
                }
              }
            }
          }
        }
        start = end + 1;
      }
    }
    return true;
  };

  if (!processAxis(P._krMultiRow, true)) return false;
  if (!processAxis(P._krMultiCol, false)) return false;
  return true;
}

/**
 * Scan collinear Corral clue pairs that CANNOT see each other (connecting them would exceed one of the two
 * numbers), capping each clue's reach toward the other and forcing extensions in its other directions
 * (or forcing the single separating fence E_ON when gap = 1).
 * When `precomp` is passed (from `propagateCorralParity`), reads directly from precomputed per-clue stats!
 * 100% sound in both `propagateCorralParity` and human `corralSeparate`. Returns false on contradiction.
 */
function scanSeparateCorral(P, e, outMask, dirtyCorrals, onAction, precomp = false) {
  const corral = P.corral;
  const useMin = precomp ? propMin : slMin;
  const useMax = precomp ? propMax : slMax;
  const useTotMax = precomp ? propTotMax : slTotMax;

  const processAxis = (groups, isRow) => {
    const posDir = isRow ? 1 : 2;
    const negDir = isRow ? 3 : 0;
    const perpA = isRow ? 0 : 1;
    const perpB = isRow ? 2 : 3;
    const axisName = isRow ? 'row' : 'col';

    for (let gi = 0; gi < groups.length; gi++) {
      const line = groups[gi];
      const len = line.length;
      if (dirtyCorrals) {
        let anyDirty = false;
        for (let i = 0; i < len; i++) if (dirtyCorrals[line[i]]) { anyDirty = true; break; }
        if (!anyDirty) continue;
      }
      if (!precomp) {
        ensureLineScratch(len);
        for (let i = 0; i < len; i++) {
          fillStatsSlot(corral[line[i]], e, outMask, slMin, slMax, slJump, slTotMin, slTotMax, i);
        }
      }

      for (let i = 0; i < len; i++) {
        const ciA = line[i];
        const krA = corral[ciA];
        const slotA = precomp ? ciA : i;
        const bA = slotA * 4;
        const aMinPos = useMin[bA + posDir], aMaxPos = useMax[bA + posDir];
        const aMinNeg = useMin[bA + negDir], aMaxNeg = useMax[bA + negDir];
        const aPerp = useMin[bA + perpA] + useMin[bA + perpB];

        let bestPosCap = aMaxPos, posBlocker = -1;
        for (let j = i + 1; j < len; j++) {
          const ciB = line[j];
          const krB = corral[ciB];
          const dist = isRow ? (krB.c - krA.c) : (krB.r - krA.r);
          if (dist > aMaxPos) break;
          const bB = (precomp ? ciB : j) * 4;
          const bMinNeg = useMin[bB + negDir], bMinPos = useMin[bB + posDir];
          const bPerp = useMin[bB + perpA] + useMin[bB + perpB];
          const minSpan = (dist + 1) + aMinNeg + bMinPos;
          if (minSpan + aPerp > krA.n || minSpan + bPerp > krB.n) {
            const cap = dist - 1 - bMinNeg;
            if (cap < 0) return false;
            if (cap < bestPosCap) { bestPosCap = cap; posBlocker = ciB; }
          }
        }

        let bestNegCap = aMaxNeg, negBlocker = -1;
        for (let j = i - 1; j >= 0; j--) {
          const ciB = line[j];
          const krB = corral[ciB];
          const dist = isRow ? (krA.c - krB.c) : (krA.r - krB.r);
          if (dist > aMaxNeg) break;
          const bB = (precomp ? ciB : j) * 4;
          const bMinNeg = useMin[bB + negDir], bMinPos = useMin[bB + posDir];
          const bPerp = useMin[bB + perpA] + useMin[bB + perpB];
          const minSpan = (dist + 1) + bMinNeg + aMinPos;
          if (minSpan + aPerp > krA.n || minSpan + bPerp > krB.n) {
            const cap = dist - 1 - bMinPos;
            if (cap < 0) return false;
            if (cap < bestNegCap) { bestNegCap = cap; negBlocker = ciB; }
          }
        }

        if (bestPosCap === aMaxPos && bestNegCap === aMaxNeg) continue;

        const tightTotalMax = useTotMax[slotA] - (aMaxPos - bestPosCap) - (aMaxNeg - bestNegCap);
        if (tightTotalMax < krA.n) return false;

        if (!onAction) continue;

        if (posBlocker >= 0 && bestPosCap === aMinPos) {
          const x = krA.rays[posDir][bestPosCap];
          if (x >= 0 && e[x] === E_UNKNOWN) {
            if (!onAction(x, E_ON, { ci: ciA, ci2: posBlocker, dir: posDir, blockDir: posDir, axis: axisName, mode: 'cap' })) return false;
          }
        }
        if (negBlocker >= 0 && bestNegCap === aMinNeg) {
          const x = krA.rays[negDir][bestNegCap];
          if (x >= 0 && e[x] === E_UNKNOWN) {
            if (!onAction(x, E_ON, { ci: ciA, ci2: negBlocker, dir: negDir, blockDir: negDir, axis: axisName, mode: 'cap' })) return false;
          }
        }

        for (let d = 0; d < 4; d++) {
          const mMax = d === posDir ? bestPosCap : d === negDir ? bestNegCap : useMax[bA + d];
          const need = krA.n - (tightTotalMax - mMax);
          if (need <= useMin[bA + d]) continue;
          const blk = (d === posDir ? negBlocker : d === negDir ? posBlocker : (posBlocker >= 0 ? posBlocker : negBlocker));
          const blkDir = blk === posBlocker ? posDir : negDir;
          if (blk < 0) continue;
          const ray = krA.rays[d];
          for (let s = 0; s < need; s++) {
            const x = ray[s];
            if (x >= 0 && e[x] === E_UNKNOWN) {
              if (!onAction(x, E_OFF, { ci: ciA, ci2: blk, dir: d, blockDir: blkDir, axis: axisName, mode: 'extend', need })) return false;
            }
          }
        }
      }
    }
    return true;
  };

  if (!processAxis(P._krMultiRow, true)) return false;
  if (!processAxis(P._krMultiCol, false)) return false;
  return true;
}

/**
 * Exact parity + aligned-clue + separation propagation for Corral inside `propagate()`.
 * Computes `outMask` and per-clue `rayStats` ONCE and shares them across bounds, same-line, and separation.
 * Returns false on contradiction.
 */
export function propagateCorralParity(P, st, setEdge) {
  if (!P.hasCorral) return true;
  const e = st.e;
  const bp = buildBasicParity(P, e, true, true);
  if (bp.conflict) return false;

  const { nUnk, compress, diff, outMask } = bp;
  const ex = P._krEdgeX, fa = P._krEdgeFA, fb = P._krEdgeFB;
  const unk = scratchUnk;

  // 1. Force any undecided active edge whose two flanking faces are in the same parity component
  let parityChanged = false;
  for (let j = 0; j < nUnk; j++) {
    const i = unk[j];
    const a = fa[i], b = fb[i];
    if (compress(a) === compress(b)) {
      const want = (diff[a] ^ diff[b]) ? E_ON : E_OFF;
      if (!setEdge(ex[i], want)) return false;
      parityChanged = true;
    }
  }
  if (parityChanged) return true; // let cheap local worklist drain before scanning rays

  // 2. Single-pass rayStats into propMin/Max/Jump + parity-tightened sightline bounds
  const corral = P.corral;
  const K = corral.length;
  ensurePropClueScratch(K);
  let boundChanged = false;
  for (let ci = 0; ci < K; ci++) {
    const kr = corral[ci];
    const rs = fillStatsSlot(kr, e, outMask, propMin, propMax, propJump, propTotMin, propTotMax, ci);
    if (rs.totalMin > kr.n || rs.totalMax < kr.n) return false;
    const minV = rs.minV, maxV = rs.maxV, totalMax = rs.totalMax;
    for (let d = 0; d < 4; d++) {
      const need = kr.n - (totalMax - maxV[d]);
      if (need > minV[d]) {
        const ray = kr.rays[d];
        for (let i = 0; i < need; i++) {
          const x = ray[i];
          if (x < 0) continue;
          if (e[x] === E_ON) return false;
          if (e[x] === E_UNKNOWN) {
            if (!setEdge(x, E_OFF)) return false;
            boundChanged = true;
          }
        }
      }
    }
  }
  if (boundChanged) return true;

  // 3. Aligned E_OFF-connected clues along rows & columns (reusing propMin/Max/Jump)
  if (!scanSameLineCorral(P, e, outMask, null, (x, val) => setEdge(x, val), true)) return false;

  // 4. Incompatible collinear clue separation bounds (reusing propMin/Max/TotMax)
  if (!scanSeparateCorral(P, e, outMask, null, (x, val) => setEdge(x, val), true)) return false;

  return true;
}

// ------------------------------------------------------------ Live error highlights & Auto-X

/**
 * Live Corral error feedback from player edge marks alone (never looks at P.solution).
 * Zero-GC implementation using precomputed `_krEdgeX/FA/FB` and flat CSR typed arrays.
 * Returns an array of 'bad' | '' per Corral clue with ZERO false positives on any partial valid solution.
 */
export function corralStates(P, marks) {
  if (!P.hasCorral) return [];
  const e = marks.edges; // 0 empty, 1 segment, 2 cross (matches E_UNKNOWN=0, E_ON=1, E_OFF=2)
  const fr = P.rows - 1, fc = P.cols - 1, F = fr * fc, EXT = F, V = F + 1;
  const ex = P._krEdgeX, fa = P._krEdgeFA, fb = P._krEdgeFB;
  const nEdges = ex.length;
  ensureCsScratch(V, nEdges * 2);

  const head = csHead, next = csNext, to = csTo, xorArr = csXor;
  const compId = csCompId, compCol = csCompCol, want = csWant, compBad = csCompBad, q = csQ;
  head.fill(-1, 0, V);
  compId.fill(-1, 0, V);
  compCol.fill(-1, 0, V);
  want.fill(0, 0, V);

  let ptr = 0;
  for (let i = 0; i < nEdges; i++) {
    const ev = e[ex[i]];
    if (ev !== 1 && ev !== 2) continue;
    const a = fa[i], b = fb[i], x = ev === 1 ? 1 : 0;
    to[ptr] = b; xorArr[ptr] = x; next[ptr] = head[a]; head[a] = ptr++;
    to[ptr] = a; xorArr[ptr] = x; next[ptr] = head[b]; head[b] = ptr++;
  }

  // Anchor bitmask: bit 0 = wants Outside (EXT / Black Castle), bit 1 = wants Inside (Corral / White Castle)
  want[EXT] |= 1;
  const af = P._krAnchorF, aw = P._krAnchorWant;
  for (let k = 0; k < af.length; k++) want[af[k]] |= (aw[k] ? 2 : 1);

  let nComp = 0;
  for (let s = 0; s < V; s++) {
    if (compId[s] >= 0) continue;
    const cid = nComp++;
    compId[s] = cid;
    compCol[s] = 0;
    let bad = 0;
    let s0w0 = false, s0w1 = false, s1w0 = false, s1w1 = false;
    let qh = 0, qt = 0;
    q[qt++] = s;
    while (qh < qt) {
      const u = q[qh++];
      const cu = compCol[u];
      const wu = want[u];
      if (wu & 1) { if (cu === 0) s0w0 = true; else s1w0 = true; }
      if (wu & 2) { if (cu === 0) s0w1 = true; else s1w1 = true; }
      for (let ei = head[u]; ei >= 0; ei = next[ei]) {
        const v = to[ei];
        const cv = cu ^ xorArr[ei];
        if (compId[v] < 0) { compId[v] = cid; compCol[v] = cv; q[qt++] = v; }
        else if (compCol[v] !== cv) bad = 1;
      }
    }
    const okNormal = !s0w1 && !s1w0;
    const okFlipped = !s0w0 && !s1w1;
    if (!okNormal && !okFlipped) bad = 1;
    compBad[cid] = bad;
  }

  const faceExt = P.hasVoids ? P.faceExterior : null;
  const faceRep = P.hasVoids ? P.faceRep : null;
  const canon = faceExt
    ? (f) => (f < 0 || f >= F ? EXT : (faceExt[f] ? EXT : faceRep[f]))
    : (f) => (f < 0 || f >= F ? EXT : f);

  const extCid = compId[EXT];
  const extColor = compCol[EXT];
  let outMask = null;
  if (!compBad[extCid]) {
    if (scratchOutMask.length < F) scratchOutMask = new Uint8Array(F);
    outMask = scratchOutMask;
    if (faceExt) {
      for (let f = 0; f < F; f++) {
        if (faceExt[f]) { outMask[f] = 1; continue; }
        const cf = faceRep[f];
        outMask[f] = (compId[cf] === extCid && compCol[cf] === extColor) ? 1 : 0;
      }
    } else {
      for (let f = 0; f < F; f++) {
        outMask[f] = (compId[f] === extCid && compCol[f] === extColor) ? 1 : 0;
      }
    }
  }

  const fe = P.faceEdges;
  const corralAt = P.corralAt;
  const corral = P.corral;
  const out = new Array(corral.length).fill('');

  for (let ci = 0; ci < corral.length; ci++) {
    const kr = corral[ci];
    if (compBad[compId[canon(kr.f)]]) { out[ci] = 'bad'; continue; }
    const f4 = kr.f * 4;
    let directBad = false;
    for (let d = 0; d < 4; d++) {
      const x = fe[f4 + d];
      if (x < 0) continue;
      const nr = kr.r + DR[d], nc = kr.c + DC[d];
      if (nr < 0 || nr >= fr || nc < 0 || nc >= fc || (faceExt && faceExt[nr * fc + nc])) {
        if (e[x] === 2) { directBad = true; break; }
      } else if (corralAt[nr * fc + nc] >= 0) {
        if (e[x] === 1) { directBad = true; break; }
      }
    }
    if (directBad) { out[ci] = 'bad'; continue; }
    const rs = rayStatsInto(kr, e, outMask, RS0);
    if (rs.totalMin > kr.n || rs.totalMax < kr.n) out[ci] = 'bad';
  }
  return out;
}

/** Auto-X helper for Corral: cross out shared edges between adjacent Corral clues (guaranteed Inside-Inside). */
export function autoXCorral(P, w, add) {
  if (!P.hasCorral) return;
  const fr = P.rows - 1, fc = P.cols - 1;
  const fe = P.faceEdges;
  const corralAt = P.corralAt;
  for (let ci = 0; ci < P.corral.length; ci++) {
    const kr = P.corral[ci];
    const f4 = kr.f * 4;
    // Only check Right (1) and Down (2) to visit each adjacent pair once
    if (kr.c + 1 < fc && corralAt[kr.f + 1] >= 0) {
      const x = fe[f4 + 1];
      if (x >= 0 && w[x] === 0) add(x);
    }
    if (kr.r + 1 < fr && corralAt[kr.f + fc] >= 0) {
      const x = fe[f4 + 2];
      if (x >= 0 && w[x] === 0) add(x);
    }
  }
}

// ------------------------------------------------------------ Sound human rules

function findCorralEdge(P, st) {
  if (!P.hasCorral) return [];
  const out = [];
  const e = st.e;
  const fr = P.rows - 1, fc = P.cols - 1;
  const fe = P.faceEdges;
  const faceExt = P.faceExterior || null;
  const corralAt = P.corralAt;

  for (let ci = 0; ci < P.corral.length; ci++) {
    const kr = P.corral[ci];
    const f4 = kr.f * 4;
    const borderOn = [];
    for (let d = 0; d < 4; d++) {
      const x = fe[f4 + d];
      if (x < 0 || e[x] !== E_UNKNOWN) continue;
      const nr = kr.r + DR[d], nc = kr.c + DC[d];
      if (nr < 0 || nr >= fr || nc < 0 || nc >= fc || (faceExt && faceExt[nr * fc + nc])) {
        borderOn.push(x);
      } else if (corralAt[nr * fc + nc] >= 0 && (d === 1 || d === 2)) {
        const ci2 = corralAt[nr * fc + nc];
        out.push({
          sets: [['e', x, E_OFF]],
          info: { corralIdx: ci, corralIdx2: ci2, face: kr.f, face2: nr * fc + nc, val: E_OFF },
        });
      }
    }
    if (borderOn.length) {
      out.push({
        sets: borderOn.map((x) => ['e', x, E_ON]),
        info: { corralIdx: ci, corralIdx2: -1, face: kr.f, val: E_ON },
      });
    }
  }
  return out;
}

function findCorralBound(P, st) {
  if (!P.hasCorral) return [];
  const out = [];
  const e = st.e;
  const corral = P.corral;
  for (let ci = 0; ci < corral.length; ci++) {
    const kr = corral[ci];
    const rs = rayStatsInto(kr, e, null, RS0);
    if (rs.totalMin > kr.n || rs.totalMax < kr.n) continue;
    const minV = rs.minV, maxV = rs.maxV, jump = rs.jump;
    const totalMin = rs.totalMin, totalMax = rs.totalMax;
    for (let d = 0; d < 4; d++) {
      const ray = kr.rays[d];
      const need = kr.n - (totalMax - maxV[d]);
      if (need > minV[d]) {
        const sets = [];
        for (let i = 0; i < need; i++) {
          const x = ray[i];
          if (x >= 0 && e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
        }
        if (sets.length) {
          out.push({
            sets,
            info: { corralIdx: ci, face: kr.f, n: kr.n, dir: d, mode: 'extend', need, totalMax },
          });
        }
      }
      if (jump[d] > 0 && totalMin + jump[d] > kr.n) {
        const x = ray[minV[d]];
        if (x >= 0 && e[x] === E_UNKNOWN) {
          out.push({
            sets: [['e', x, E_ON]],
            info: {
              corralIdx: ci, face: kr.f, n: kr.n, dir: d,
              mode: totalMin === kr.n ? 'exactCap' : 'overshootCap',
              totalMin, jump: jump[d],
            },
          });
        }
      }
    }
  }
  return out;
}

/**
 * Scan for `corralWallCap` deductions: drawing an undecided edge `y` completes degree 2 at
 * one or both endpoints, forcing the remaining unknown edge(s) there to E_OFF (`fullCell`),
 * which opens a Corral clue's sightline past `n` (or crosses a Corral border edge) -> `y = E_OFF`.
 * Fast O(E_ON + deg1-vertices) scan instead of scanning all board edges.
 */
function scanWallCapCorral(P, st, dirtyCorrals, onHit) {
  const e = st.e;
  const ed = P.ed, edgeA = P.edgeA, edgeB = P.edgeB;
  const ekOff = P._ekOff, ekData = P._ekData;
  const corral = P.corral;
  const fe = P.faceEdges, fr = P.rows - 1, fc = P.cols - 1;
  const faceExt = P.faceExterior || null;
  const N = P.N;

  if (wcSeen.length < corral.length) wcSeen = new Int32Array(corral.length);
  if (wcEdgeSeen.length < P.numEdges) wcEdgeSeen = new Int32Array(P.numEdges);
  if (wcOnDeg.length < N) wcOnDeg = new Uint8Array(N);
  wcOnDeg.fill(0, 0, N);

  const ex = P._krEdgeX;
  for (let ei = 0; ei < ex.length; ei++) {
    const x = ex[ei];
    if (e[x] === E_ON) { wcOnDeg[edgeA[x]]++; wcOnDeg[edgeB[x]]++; }
  }

  wcEdgeStamp++;
  if (wcEdgeStamp === 0x7fffffff) { wcEdgeSeen.fill(0); wcEdgeStamp = 1; }

  const forcedOff = [0, 0, 0, 0, 0, 0];
  const verts = [0, 0];

  for (let v = 0; v < N; v++) {
    if (wcOnDeg[v] !== 1) continue;
    const v4 = v * 4;
    // Collect all unknown edges incident to degree-1 vertex v
    let vUnk0 = -1, vUnk1 = -1, vUnk2 = -1, vUnkN = 0;
    for (let d = 0; d < 4; d++) {
      const ux = ed[v4 + d];
      if (ux >= 0 && e[ux] === E_UNKNOWN) {
        if (vUnkN === 0) vUnk0 = ux;
        else if (vUnkN === 1) vUnk1 = ux;
        else vUnk2 = ux;
        vUnkN++;
      }
    }
    if (vUnkN === 0) continue;

    for (let ui = 0; ui < vUnkN; ui++) {
      const y = ui === 0 ? vUnk0 : ui === 1 ? vUnk1 : vUnk2;
      if (wcEdgeSeen[y] === wcEdgeStamp) continue;
      wcEdgeSeen[y] = wcEdgeStamp;

      let nOff = 0, nVerts = 0;
      const a = edgeA[y], b = edgeB[y];
      if (wcOnDeg[a] === 1) {
        const a4 = a * 4;
        let added = false;
        for (let d = 0; d < 4; d++) {
          const ux = ed[a4 + d];
          if (ux >= 0 && ux !== y && e[ux] === E_UNKNOWN) { forcedOff[nOff++] = ux; added = true; }
        }
        if (added) verts[nVerts++] = a;
      }
      if (wcOnDeg[b] === 1) {
        const b4 = b * 4;
        let added = false;
        for (let d = 0; d < 4; d++) {
          const ux = ed[b4 + d];
          if (ux >= 0 && ux !== y && e[ux] === E_UNKNOWN) { forcedOff[nOff++] = ux; added = true; }
        }
        if (added) verts[nVerts++] = b;
      }
      if (nOff === 0) continue;

      let anyWake = false;
      for (let k = 0; k < nOff; k++) {
        const fx = forcedOff[k];
        if (ekOff[fx] < ekOff[fx + 1]) { anyWake = true; break; }
      }
      if (!anyWake) continue;

      wcStamp++;
      if (wcStamp === 0x7fffffff) { wcSeen.fill(0); wcStamp = 1; }
      e[y] = E_ON;
      for (let k = 0; k < nOff; k++) e[forcedOff[k]] = E_OFF;

      let hit = null;
      for (let k = 0; k < nOff && !hit; k++) {
        const fx = forcedOff[k];
        const s0 = ekOff[fx], s1 = ekOff[fx + 1];
        for (let wi = s0; wi < s1; wi++) {
          const ci = ekData[wi];
          if (wcSeen[ci] === wcStamp) continue;
          wcSeen[ci] = wcStamp;
          if (dirtyCorrals && !dirtyCorrals[ci]) continue;
          const kr = corral[ci];

          let borderHit = false;
          const f4 = kr.f * 4;
          for (let d = 0; d < 4; d++) {
            const bx = fe[f4 + d];
            if (bx < 0 || e[bx] !== E_OFF) continue;
            const nr = kr.r + DR[d], nc = kr.c + DC[d];
            if (nr < 0 || nr >= fr || nc < 0 || nc >= fc || (faceExt && faceExt[nr * fc + nc])) {
              borderHit = true;
              break;
            }
          }
          if (borderHit) {
            hit = {
              edge: y, corralIdx: ci, face: kr.f, n: kr.n,
              verts: verts.slice(0, nVerts), forcedOff: forcedOff.slice(0, nOff),
              got: -1, mode: 'border',
            };
            break;
          }

          let totalMin = 1;
          for (let d = 0; d < 4; d++) {
            const ray = kr.rays[d];
            const rlen = ray.length;
            let mn = 0;
            while (mn < rlen && (ray[mn] < 0 || e[ray[mn]] === E_OFF)) mn++;
            totalMin += mn;
          }
          if (totalMin > kr.n) {
            hit = {
              edge: y, corralIdx: ci, face: kr.f, n: kr.n,
              verts: verts.slice(0, nVerts), forcedOff: forcedOff.slice(0, nOff),
              got: totalMin, mode: 'overshoot',
            };
            break;
          }
        }
      }

      e[y] = E_UNKNOWN;
      for (let k = 0; k < nOff; k++) e[forcedOff[k]] = E_UNKNOWN;

      if (hit && onHit(hit)) return;
    }
  }
}

function findCorralWallCap(P, st) {
  if (!P.hasCorral) return [];
  const out = [];
  scanWallCapCorral(P, st, null, (info) => {
    out.push({ sets: [['e', info.edge, E_OFF]], info });
    return false;
  });
  return out;
}

function findCorralSameLine(P, st) {
  if (!P.hasCorral) return [];
  const out = [];
  const seen = new Set();
  scanSameLineCorral(P, st.e, null, null, (x, val, info) => {
    const key = x * 3 + val;
    if (seen.has(key)) return true;
    seen.add(key);
    const kr1 = P.corral[info.ci];
    const kr2 = P.corral[info.ci2];
    out.push({
      sets: [['e', x, val]],
      info: {
        corralIdx: info.ci, corralIdx2: info.ci2,
        face: kr1.f, face2: kr2.f, n: kr1.n, n2: kr2.n,
        dir: info.dir, axis: info.axis, mode: info.mode, val,
      },
    });
    return true;
  });
  return out;
}

function findCorralSeparate(P, st) {
  if (!P.hasCorral) return [];
  const out = [];
  const seen = new Set();
  scanSeparateCorral(P, st.e, null, null, (x, val, info) => {
    const key = x * 3 + val;
    if (seen.has(key)) return true;
    seen.add(key);
    const kr1 = P.corral[info.ci];
    const kr2 = P.corral[info.ci2];
    out.push({
      sets: [['e', x, val]],
      info: {
        corralIdx: info.ci, corralIdx2: info.ci2,
        face: kr1.f, face2: kr2.f, n: kr1.n, n2: kr2.n,
        dir: info.dir, blockDir: info.blockDir, axis: info.axis,
        mode: info.mode, need: info.need, val,
      },
    });
    return true;
  });
  return out;
}

function findCorralParityBound(P, st) {
  if (!P.hasCorral) return [];
  const e = st.e;
  const bp = buildBasicParity(P, e, false, true);
  if (bp.conflict) return [];
  const outMask = bp.outMask;
  const out = [];
  const corral = P.corral;

  for (let ci = 0; ci < corral.length; ci++) {
    const kr = corral[ci];
    const base = rayStatsInto(kr, e, null, RS0);
    const tight = rayStatsInto(kr, e, outMask, RS1);
    if (tight.totalMin > kr.n || tight.totalMax < kr.n) continue;
    if (tight.totalMax >= base.totalMax) continue; // parity didn't tighten any ray
    const outFaces = [];
    for (let d = 0; d < 4; d++) {
      if (tight.maxV[d] < base.maxV[d]) outFaces.push(kr.rayFaces[d][tight.maxV[d]]);
    }
    for (let d = 0; d < 4; d++) {
      const need = kr.n - (tight.totalMax - tight.maxV[d]);
      if (need > tight.minV[d]) {
        const sets = [];
        const ray = kr.rays[d];
        for (let i = 0; i < need; i++) {
          const x = ray[i];
          if (x >= 0 && e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
        }
        if (sets.length) {
          out.push({
            sets,
            info: { corralIdx: ci, face: kr.f, n: kr.n, dir: d, outFaces, need },
          });
        }
      }
    }
  }
  return out;
}

export const CORRAL_RULES = [
  {
    id: 'corralEdge',
    tier: 'Beginner',
    weight: 3,
    find: findCorralEdge,
    label: 'a Corral number sits strictly inside the loop (border edges are on, adjacent Corral numbers cannot have a line between them)',
  },
  {
    id: 'corralBound',
    tier: 'Beginner',
    weight: 4,
    find: findCorralBound,
    label: 'a Corral number must extend far enough to reach its count and must close off any direction that would overshoot it',
  },
  {
    id: 'corralWallCap',
    tier: 'Medium',
    weight: 12,
    find: findCorralWallCap,
    label: 'a segment completing degree 2 at a corner would cross out its perpendicular edge(s) and make a Corral number see too many squares',
  },
  {
    id: 'corralSameLine',
    tier: 'Medium',
    weight: 13,
    find: findCorralSameLine,
    label: 'two Corral numbers seeing each other along a row or column share that sightline span, tightening their remaining directions',
  },
  {
    id: 'corralSeparate',
    tier: 'Medium',
    weight: 14,
    find: findCorralSeparate,
    label: 'two Corral numbers in the same row or column that would exceed one of their counts if connected must be separated by a fence, capping reach toward each other',
  },
  {
    id: 'corralParityBound',
    tier: 'Medium',
    weight: 15,
    find: findCorralParityBound,
    label: 'Outside squares block a Corral number’s sightline, forcing it to extend further in the other directions',
  },
];

// ------------------------------------------------------------ imagine.js hooks

/** Fast contradiction detector for Corral inside imagine.js lookahead. */
export function corralContradiction(P, st, dirtyCorrals = null) {
  if (!P.hasCorral) return null;
  const e = st.e;
  const fr = P.rows - 1, fc = P.cols - 1;
  const fe = P.faceEdges;
  const faceExt = P.faceExterior || null;
  const corralAt = P.corralAt;
  const corral = P.corral;

  for (let ci = 0; ci < corral.length; ci++) {
    if (dirtyCorrals && !dirtyCorrals[ci]) continue;
    const kr = corral[ci];
    const f4 = kr.f * 4;
    for (let d = 0; d < 4; d++) {
      const x = fe[f4 + d];
      if (x < 0) continue;
      const nr = kr.r + DR[d], nc = kr.c + DC[d];
      if (nr < 0 || nr >= fr || nc < 0 || nc >= fc || (faceExt && faceExt[nr * fc + nc])) {
        if (e[x] === E_OFF) return { kind: 'corralOutside', corralIdx: ci, face: kr.f, n: kr.n };
      } else if (corralAt[nr * fc + nc] >= 0) {
        if (e[x] === E_ON) return { kind: 'corralSplit', corralIdx: ci, face: kr.f, face2: nr * fc + nc };
      }
    }
    const rs = rayStatsInto(kr, e, null, RS0);
    if (rs.totalMin > kr.n) return { kind: 'corralHigh', corralIdx: ci, face: kr.f, n: kr.n, got: rs.totalMin };
    if (rs.totalMax < kr.n) return { kind: 'corralLow', corralIdx: ci, face: kr.f, n: kr.n, max: rs.totalMax };
  }
  return null;
}

/** Find one easy Corral step inside imagine.js lookahead. */
export function findEasyCorralStep(P, st, tryEmit, dirtyCorrals = null) {
  if (!P.hasCorral) return null;
  const e = st.e;
  const fr = P.rows - 1, fc = P.cols - 1;
  const fe = P.faceEdges;
  const faceExt = P.faceExterior || null;
  const corralAt = P.corralAt;
  const corral = P.corral;

  for (let ci = 0; ci < corral.length; ci++) {
    if (dirtyCorrals && !dirtyCorrals[ci]) continue;
    const kr = corral[ci];
    const f4 = kr.f * 4;
    for (let d = 0; d < 4; d++) {
      const x = fe[f4 + d];
      if (x < 0 || e[x] !== E_UNKNOWN) continue;
      const nr = kr.r + DR[d], nc = kr.c + DC[d];
      if (nr < 0 || nr >= fr || nc < 0 || nc >= fc || (faceExt && faceExt[nr * fc + nc])) {
        const res = tryEmit('corralEdge', [['e', x, E_ON]], { corralIdx: ci, corralIdx2: -1, face: kr.f, val: E_ON });
        if (res) return res;
      } else if (corralAt[nr * fc + nc] >= 0) {
        const res = tryEmit('corralEdge', [['e', x, E_OFF]], { corralIdx: ci, corralIdx2: corralAt[nr * fc + nc], face: kr.f, face2: nr * fc + nc, val: E_OFF });
        if (res) return res;
      }
    }
    const rs = rayStatsInto(kr, e, null, RS0);
    if (rs.totalMin > kr.n || rs.totalMax < kr.n) continue;
    const minV = rs.minV, maxV = rs.maxV, jump = rs.jump;
    const totalMin = rs.totalMin, totalMax = rs.totalMax;
    for (let d = 0; d < 4; d++) {
      const ray = kr.rays[d];
      const need = kr.n - (totalMax - maxV[d]);
      if (need > minV[d]) {
        const sets = [];
        for (let i = 0; i < need; i++) {
          const x = ray[i];
          if (x >= 0 && e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
        }
        if (sets.length) {
          const res = tryEmit('corralBound', sets, { corralIdx: ci, face: kr.f, n: kr.n, dir: d, mode: 'extend', need });
          if (res) return res;
        }
      }
      if (jump[d] > 0 && totalMin + jump[d] > kr.n) {
        const x = ray[minV[d]];
        if (x >= 0 && e[x] === E_UNKNOWN) {
          const res = tryEmit('corralBound', [['e', x, E_ON]], {
            corralIdx: ci, face: kr.f, n: kr.n, dir: d,
            mode: totalMin === kr.n ? 'exactCap' : 'overshootCap', totalMin, jump: jump[d],
          });
          if (res) return res;
        }
      }
    }
  }
  return null;
}

/** Find one Medium Corral step inside imagine.js lookahead (scoped to `dirtyCorrals` when provided). */
export function findMediumCorralStep(P, st, tryEmit, dirtyCorrals = null) {
  if (!P.hasCorral) return null;
  let emitted = null;
  scanWallCapCorral(P, st, dirtyCorrals, (info) => {
    const res = tryEmit('corralWallCap', [['e', info.edge, E_OFF]], info);
    if (res) { emitted = res; return true; }
    return false;
  });
  if (emitted) return emitted;

  scanSameLineCorral(P, st.e, null, dirtyCorrals, (x, val, info) => {
    if (emitted) return true;
    const kr1 = P.corral[info.ci];
    const kr2 = P.corral[info.ci2];
    const res = tryEmit('corralSameLine', [['e', x, val]], {
      corralIdx: info.ci, corralIdx2: info.ci2,
      face: kr1.f, face2: kr2.f, n: kr1.n, n2: kr2.n,
      dir: info.dir, axis: info.axis, mode: info.mode, val,
    });
    if (res) emitted = res;
    return true;
  });
  if (emitted) return emitted;

  scanSeparateCorral(P, st.e, null, dirtyCorrals, (x, val, info) => {
    if (emitted) return true;
    const kr1 = P.corral[info.ci];
    const kr2 = P.corral[info.ci2];
    const res = tryEmit('corralSeparate', [['e', x, val]], {
      corralIdx: info.ci, corralIdx2: info.ci2,
      face: kr1.f, face2: kr2.f, n: kr1.n, n2: kr2.n,
      dir: info.dir, blockDir: info.blockDir, axis: info.axis,
      mode: info.mode, need: info.need, val,
    });
    if (res) emitted = res;
    return true;
  });
  return emitted;
}

// ------------------------------------------------------------ Explanations

/** Describe a Corral step inside an imagined chain. Returns null for non-Corral rules. */
export function describeCorralChainStep(P, s, { faceName, edgeName }) {
  const { rule, info = {} } = s;
  const fn = info.face !== undefined ? faceName(P, info.face) : '';
  switch (rule) {
    case 'corralEdge':
      return info.val === E_ON
        ? `the Corral number at ${fn} sits inside the loop, forcing its border fence`
        : `adjacent Corral numbers at ${fn} and ${faceName(P, info.face2)} are both inside, so no fence can separate them`;
    case 'corralBound':
      return info.mode === 'extend'
        ? `the ${info.n} at ${fn} must extend ${DIR_WORD[info.dir]} to reach ${info.n} visible squares`
        : `the ${info.n} at ${fn} must close off ${DIR_WORD[info.dir]} so it does not exceed ${info.n}`;
    case 'corralWallCap':
      return `drawing ${edgeName ? edgeName(P, info.edge) : 'that segment'} would force a degree-2 cross that breaks the ${info.n} at ${fn}`;
    case 'corralSameLine':
      return `comparing the aligned ${info.n} at ${fn} and ${info.n2} at ${faceName(P, info.face2)} forces an edge`;
    case 'corralSeparate':
      return `the ${info.n} at ${fn} cannot connect to the ${info.n2} at ${faceName(P, info.face2)}, forcing its ${DIR_WORD[info.dir]} sightline`;
    case 'corralParityBound':
      return `Outside shading caps the ${info.n} at ${fn}, forcing it to extend ${DIR_WORD[info.dir]}`;
    default:
      return null;
  }
}

/** Explain a Corral human rule step for Hint. Returns { text, nudge, faces } or null if not a Corral rule. */
export function explainCorralStep(P, step, helpers) {
  const { rule, info = {}, targets } = step;
  const { faceName, cellName, edgeName, joinList, describeMarks, roles, nudgeRoles } = helpers;
  const fn = info.face !== undefined ? faceName(P, info.face) : '';
  const marks = describeMarks(P, targets);
  const dirWord = info.dir !== undefined ? DIR_WORD[info.dir] : '';

  switch (rule) {
    case 'corralEdge': {
      const fList = info.face2 !== undefined && info.face2 >= 0 ? [info.face, info.face2] : [info.face];
      const faces = { in: fList, out: [], clue: fList, focus: [], anchored: true };
      if (info.val === E_ON) {
        return {
          nudge: `Look along the border of the Corral square ${fn}.`,
          text: `The Corral square ${fn} must lie strictly inside the loop, so its outer border edge${targets.segOn.length > 1 ? 's' : ''} must be on the loop — ${marks}.`,
          faces,
        };
      }
      return {
        nudge: `Look between the two adjacent Corral squares ${fn} and ${faceName(P, info.face2)}.`,
        text: `Both Corral squares ${fn} and ${faceName(P, info.face2)} lie inside the loop, so no loop fence can separate them — ${marks}.`,
        faces,
      };
    }
    case 'corralBound': {
      const faces = { in: [info.face], out: [], clue: [info.face], focus: [], anchored: true };
      if (info.mode === 'extend') {
        return {
          nudge: `Count the maximum squares the ${info.n} at ${fn} can still see in the other directions.`,
          text: `Even taking every open square in the other directions, the ${info.n} at ${fn} must see at least ${info.need} square${info.need === 1 ? '' : 's'} ${dirWord} to reach ${info.n} — ${marks}.`,
          faces,
        };
      }
      if (info.mode === 'exactCap') {
        return {
          nudge: `Count how many squares the ${info.n} at ${fn} already sees.`,
          text: `The ${info.n} at ${fn} already sees all ${info.n} squares, so its sightline ${dirWord} must stop here — ${marks}.`,
          faces,
        };
      }
      return {
        nudge: `Check what happens if the ${info.n} at ${fn} extends ${dirWord}.`,
        text: `Extending the ${info.n} at ${fn} ${dirWord} would open ${info.jump} more square${info.jump === 1 ? '' : 's'} (total ${info.totalMin + info.jump} > ${info.n}), so a fence must block it here — ${marks}.`,
        faces,
      };
    }
    case 'corralWallCap': {
      const faces = { in: [info.face], out: [], clue: [info.face], focus: [], anchored: true };
      if (info.verts && roles) {
        for (const v of info.verts) { roles.focus.push(v); nudgeRoles.focus.push(v); }
      }
      const en = edgeName ? edgeName(P, info.edge) : '';
      const vText = info.verts && cellName && joinList
        ? joinList(info.verts.map((v) => cellName(P, v)))
        : 'that corner';
      const offText = info.forcedOff && edgeName && joinList
        ? joinList(info.forcedOff.map((x) => edgeName(P, x)))
        : 'its perpendicular edge';
      const consequence = info.mode === 'border'
        ? `leaving the Corral square ${fn} open to the outside`
        : `making the ${info.n} at ${fn} see at least ${info.got} squares (> ${info.n})`;
      return {
        nudge: `Check what happens to the ${info.n} at ${fn} if a fence segment finishes degree 2 at ${vText}.`,
        text: `Drawing ${en} would complete degree 2 at ${vText} (crossing out ${offText}), ${consequence} — ${marks}.`,
        faces,
      };
    }
    case 'corralSameLine': {
      const f2 = faceName(P, info.face2);
      const faces = { in: [info.face, info.face2], out: [], clue: [info.face, info.face2], focus: [], anchored: true };
      return {
        nudge: `Compare the aligned Corral clues ${info.n} at ${fn} and ${info.n2} at ${f2} along their shared ${info.axis}.`,
        text: `The ${info.n} at ${fn} and ${info.n2} at ${f2} see each other and share the same ${info.axis} span, which tightens the ${dirWord} sightline — ${marks}.`,
        faces,
      };
    }
    case 'corralSeparate': {
      const f2 = faceName(P, info.face2);
      const faces = { in: [info.face, info.face2], out: [], clue: [info.face, info.face2], focus: [], anchored: true };
      if (info.mode === 'cap') {
        return {
          nudge: `Check whether the ${info.n} at ${fn} and the ${info.n2} at ${f2} can see each other along their ${info.axis}.`,
          text: `If the ${info.n} at ${fn} connected to the ${info.n2} at ${f2}, their shared ${info.axis} span would exceed one of their counts, so a fence must separate them — ${marks}.`,
          faces,
        };
      }
      const bWord = DIR_WORD[info.blockDir];
      return {
        nudge: `Check whether the ${info.n} at ${fn} can reach the ${info.n2} at ${f2} ${bWord}.`,
        text: `The ${info.n} at ${fn} cannot connect to the ${info.n2} at ${f2} ${bWord} without exceeding a clue count, capping its ${bWord} reach and forcing it to extend ${dirWord} — ${marks}.`,
        faces,
      };
    }
    case 'corralParityBound': {
      const faces = { in: [info.face], out: info.outFaces || [], clue: [info.face], focus: [], anchored: true };
      return {
        nudge: `Use Inside/Outside shading to see where the ${info.n} at ${fn} is blocked by an Outside square.`,
        text: `Inside/Outside shading proves a square along one ray of ${info.n} at ${fn} is Outside, forcing it to extend ${dirWord} to reach ${info.n} — ${marks}.`,
        faces,
      };
    }
    default:
      return null;
  }
}

export const corralVariant = {
  id: 'corral',
  name: 'Corral',
  active: (P) => Boolean(P && P.hasCorral),
  compile: compileCorral,
  serialize: serializeCorral,
  parseToken: parseCorralToken,
  symmetry: symmetryCorral,
  rotateCW: rotateCorralCW,
  isSatisfied: isCorralSatisfied,
  propagateClue: propagateCorralClue,
  propagateParity: propagateCorralParity,
  clueStates: corralStates,
  autoX: autoXCorral,
  rules: CORRAL_RULES,
  explain: explainCorralStep,
  describeChainStep: describeCorralChainStep,
};
