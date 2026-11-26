// Castle Wall constraint module (pure logic, no DOM).
//
// Rules (Palmer Mebane / standard Castle Wall):
//   - Clue tiles sit on blocked void vertices (the loop cannot enter them).
//   - White tiles ('W') must lie strictly INSIDE the single closed loop.
//   - Black tiles ('B') must lie strictly OUTSIDE the single closed loop.
//   - Gray tiles ('G') may lie either inside or outside the loop.
//   - Numbered arrows (`dir` in 'U'|'D'|'L'|'R', `n >= 0`) count the total number of unit
//     loop segments along that ray (all the way to the edge of the grid, looking past other
//     blocked tiles) running PARALLEL to the arrow. Unnumbered tiles (`dir === ''`, `n === -1`)
//     act as pure Inside/Outside/blocked anchors.
//
// CSV tokens: `r:c:CWU2`, `r:c:CBD0`, `r:c:CGL3`, `r:c:CWR1`, or unnumbered `r:c:CW` / `r:c:CB` / `r:c:CG`.
// Works standalone or composed with Masyu, Slitherlink, Mid-loop, Hamilton cycle, givens, and Swiss cheese voids.

const E_UNKNOWN = 0, E_ON = 1, E_OFF = 2;
const OFF = 1;
const DIR_IDX = { U: 0, R: 1, D: 2, L: 3 };
const DIR_STR = ['U', 'R', 'D', 'L'];
const DIR_WORD = ['up', 'right', 'down', 'left'];
const DIR_ARROW = { U: '↑', R: '→', D: '↓', L: '←', '': '' };
const DR = [-1, 0, 1, 0];
const DC = [0, 1, 0, -1];

/**
 * Compile Castle Wall tiles onto puzzle `P`.
 * Expects `P.rows`, `P.cols`, `P.N`, `P.ed`, `P.nb`, `P.edgeA`, `P.isVoid`,
 * `P.faceExterior`, `P.faceRep`, `P.holeList` to already be computed (with Castle Wall cells marked in `P.isVoid`).
 */
export function compileCastle(P, raw) {
  const { rows, cols, N, ed, edgeA, isVoid, faceExterior, faceRep } = P;
  const rawList = raw.castle || [];
  const castle = [];
  const castleAtCell = new Int16Array(N).fill(-1);
  const fr = rows - 1, fc = cols - 1;

  for (const cw of rawList) {
    const { r, c } = cw;
    const wall = cw.wall;
    const dir = cw.dir || '';
    const n = dir ? cw.n : -1;
    if (r < 0 || r >= rows || c < 0 || c >= cols) {
      throw new Error(`Castle Wall tile out of bounds at ${r},${c}`);
    }
    if (wall !== 'W' && wall !== 'B' && wall !== 'G') {
      throw new Error(`invalid Castle Wall color "${wall}" at ${r},${c}`);
    }
    if (dir !== '' && !(dir in DIR_IDX)) {
      throw new Error(`invalid Castle Wall direction "${dir}" at ${r},${c}`);
    }
    if (dir !== '' && (!Number.isInteger(n) || n < 0)) {
      throw new Error(`invalid Castle Wall count "${n}" at ${r},${c}`);
    }
    const cell = r * cols + c;
    if (castleAtCell[cell] >= 0) {
      throw new Error(`duplicate Castle Wall tile at ${r},${c}`);
    }
    if (P.clue && P.clue[cell] !== 0) {
      throw new Error(`Castle Wall tile overlaps circle at ${r},${c}`);
    }
    if (P.midloopAtCell && P.midloopAtCell[cell] >= 0) {
      throw new Error(`Castle Wall tile overlaps Mid-loop dot at ${r},${c}`);
    }

    const d = dir ? DIR_IDX[dir] : -1;
    const rayEdges = [];
    if (d >= 0) {
      // Collect every active lattice edge running parallel to `dir` along the ray from (r, c) to the board edge.
      // Edges are ordered from closest to (r, c) outward toward the border.
      let rr = r + DR[d], cc = c + DC[d];
      while (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
        const nr = rr + DR[d], nc = cc + DC[d];
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) break;
        const u = rr * cols + cc;
        const x = ed[u * 4 + d];
        if (x >= 0 && edgeA[x] >= 0) rayEdges.push(x);
        rr = nr; cc = nc;
      }
    }

    // Representative dual face touching void vertex (r, c) (all up-to-4 touching faces share one hole or exterior)
    let face = -1;
    let isExterior = false;
    if (fr > 0 && fc > 0) {
      for (const [dr, dc] of [[-1, -1], [-1, 0], [0, -1], [0, 0]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= fr || cc < 0 || cc >= fc) continue;
        const f = rr * fc + cc;
        if (faceExterior && faceExterior[f]) { isExterior = true; face = -1; break; }
        face = faceRep ? faceRep[f] : f;
        break;
      }
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        isExterior = true;
        face = -1;
      }
    }

    castleAtCell[cell] = castle.length;
    castle.push({
      r, c, cell, wall, dir, d, n,
      edges: Int32Array.from(rayEdges),
      face,
      isExterior,
    });
  }

  const hasCastle = castle.length > 0;
  P.castle = castle;
  P.hasCastle = hasCastle;
  P.castleAtCell = castleAtCell;

  // Precompute CSR edge -> numbered Castle Wall clue wakeup table + static tables & impossibility check
  let _ecwOff = null, _ecwData = null;
  let _cwEdgeX = null, _cwEdgeFA = null, _cwEdgeFB = null;
  let _cwAnchorF = null, _cwAnchorWant = null, _cwAnchorK = null;
  let _castleWallGroups = null;
  let _castleRayDiffPairs = null;
  let castleByRow = null, castleByCol = null;
  let castleImpossible = false;
  let hasCastleWalls = false;
  if (hasCastle) {
    const counts = new Int32Array(P.numEdges);
    const repWall = new Map(); // canonical face rep -> 'W' | 'B'
    const byRow = Array.from({ length: rows }, () => []);
    const byCol = Array.from({ length: cols }, () => []);
    for (let k = 0; k < castle.length; k++) {
      const cw = castle[k];
      if (cw.dir) {
        if (cw.n > cw.edges.length) castleImpossible = true;
        if (cw.dir === 'L' || cw.dir === 'R') byRow[cw.r].push(k);
        else byCol[cw.c].push(k);
      }
      if (cw.wall === 'W') {
        hasCastleWalls = true;
        if (cw.isExterior || cw.face < 0) castleImpossible = true;
        else {
          const prev = repWall.get(cw.face);
          if (prev && prev !== 'W') castleImpossible = true;
          repWall.set(cw.face, 'W');
        }
      } else if (cw.wall === 'B') {
        hasCastleWalls = true;
        if (!cw.isExterior && cw.face >= 0) {
          const prev = repWall.get(cw.face);
          if (prev && prev !== 'B') castleImpossible = true;
          repWall.set(cw.face, 'B');
        }
      }
      for (let j = 0; j < cw.edges.length; j++) counts[cw.edges[j]]++;
    }
    castleByRow = byRow.map((a) => Int16Array.from(a));
    castleByCol = byCol.map((a) => Int16Array.from(a));
    _ecwOff = new Int32Array(P.numEdges + 1);
    for (let x = 0; x < P.numEdges; x++) _ecwOff[x + 1] = _ecwOff[x] + counts[x];
    _ecwData = new Int32Array(_ecwOff[P.numEdges]);
    const pos = _ecwOff.slice(0, P.numEdges);
    for (let k = 0; k < castle.length; k++) {
      const es = castle[k].edges;
      for (let j = 0; j < es.length; j++) _ecwData[pos[es[j]]++] = k;
    }

    // Precompute collinear same-direction pairs for findCastleRayDiff (c2.edges is always an exact suffix of c1.edges)
    const diffPairs = [];
    for (let i = 0; i < castle.length; i++) {
      const c1 = castle[i];
      if (!c1.dir) continue;
      let bestJ = -1, bestDist = Infinity;
      for (let j = 0; j < castle.length; j++) {
        if (j === i) continue;
        const c2 = castle[j];
        if (c2.dir !== c1.dir) continue;
        let dist = -1;
        if (c1.dir === 'R' && c2.r === c1.r && c2.c > c1.c) dist = c2.c - c1.c;
        else if (c1.dir === 'L' && c2.r === c1.r && c2.c < c1.c) dist = c1.c - c2.c;
        else if (c1.dir === 'D' && c2.c === c1.c && c2.r > c1.r) dist = c2.r - c1.r;
        else if (c1.dir === 'U' && c2.c === c1.c && c2.r < c1.r) dist = c1.r - c2.r;
        if (dist > 0 && dist < bestDist) { bestDist = dist; bestJ = j; }
      }
      if (bestJ < 0) continue;
      const c2 = castle[bestJ];
      const diff = c1.n - c2.n;
      const diffLen = c1.edges.length - c2.edges.length;
      if (diff < 0 || diff > diffLen) { castleImpossible = true; continue; }
      if (diffLen <= 0) continue;
      diffPairs.push({
        i, j: bestJ, cell1: c1.cell, cell2: c2.cell,
        dir: c1.dir, n1: c1.n, n2: c2.n, diff,
        edges: c1.edges.subarray(0, diffLen),
      });
    }
    _castleRayDiffPairs = diffPairs;

    // Precompute flat active-edge canonical face pairs & static wall-boundary edge groups
    if (hasCastleWalls && fr > 0 && fc > 0) {
      const F = fr * fc, EXT = F;
      const canon = (f) => {
        if (f < 0 || f >= F) return EXT;
        if (faceExterior && faceExterior[f]) return EXT;
        return faceRep ? faceRep[f] : f;
      };
      const exList = [], faList = [], fbList = [];
      for (let x = 0; x < P.numEdges; x++) {
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
      _cwEdgeX = Int32Array.from(exList);
      _cwEdgeFA = Int32Array.from(faList);
      _cwEdgeFB = Int32Array.from(fbList);

      const afList = [], awList = [], akList = [];
      const known = new Map();
      known.set(EXT, { par: 0, idx: -1, idxs: [] });
      for (let k = 0; k < castle.length; k++) {
        const cw = castle[k];
        if (cw.wall === 'G') continue;
        const want = cw.wall === 'W' ? 1 : 0;
        const f = cw.isExterior ? EXT : canon(cw.face);
        afList.push(f);
        awList.push(want);
        akList.push(k);
        if (!cw.isExterior && cw.face >= 0) {
          const rec = known.get(f);
          if (!rec) known.set(f, { par: want, idx: k, idxs: [k] });
          else rec.idxs.push(k);
        }
      }
      _cwAnchorF = Int32Array.from(afList);
      _cwAnchorWant = Uint8Array.from(awList);
      _cwAnchorK = Int16Array.from(akList);

      const grouped = new Map();
      for (let i = 0; i < _cwEdgeX.length; i++) {
        const a = _cwEdgeFA[i], b = _cwEdgeFB[i];
        if (a === b) continue;
        const ka = known.get(a), kb = known.get(b);
        if (!ka || !kb || (ka.idx < 0 && kb.idx < 0)) continue;
        const val = (ka.par !== kb.par) ? E_ON : E_OFF;
        const k1 = ka.idx >= 0 ? ka : kb;
        const k2 = ka.idx >= 0 && kb.idx >= 0 ? kb : null;
        const i1 = k1.idx, i2 = k2 ? k2.idx : -1;
        const key = i2 >= 0 ? (i1 < i2 ? `${i1}:${i2}` : `${i2}:${i1}`) : `${i1}:EXT`;
        let rec = grouped.get(key);
        if (!rec) {
          rec = {
            edges: [],
            info: {
              castleIdx: i1,
              castleIdx2: i2,
              castleIdxs: k1.idxs.slice(),
              castleIdxs2: k2 ? k2.idxs.slice() : [],
              val,
            },
          };
          grouped.set(key, rec);
        }
        rec.edges.push(_cwEdgeX[i]);
      }
      _castleWallGroups = [...grouped.values()].map((g) => ({
        edges: Int32Array.from(g.edges),
        info: g.info,
      }));
    } else {
      _castleWallGroups = [];
    }
  }
  let faceExtShade = null;
  if (hasCastle && faceExterior && fr > 0 && fc > 0) {
    const F = fr * fc;
    const isPlain = (u) => isVoid[u] && castleAtCell[u] < 0;
    for (let f = 0; f < F; f++) {
      if (!faceExterior[f]) continue;
      const r = (f / fc) | 0, c = f % fc;
      if (isPlain(r * cols + c) || isPlain(r * cols + c + 1)
        || isPlain((r + 1) * cols + c) || isPlain((r + 1) * cols + c + 1)) continue;
      if (!faceExtShade) faceExtShade = new Uint8Array(F);
      faceExtShade[f] = 1;
    }
  }
  P._ecwOff = _ecwOff;
  P._ecwData = _ecwData;
  P._cwEdgeX = _cwEdgeX;
  P._cwEdgeFA = _cwEdgeFA;
  P._cwEdgeFB = _cwEdgeFB;
  P._cwAnchorF = _cwAnchorF;
  P._cwAnchorWant = _cwAnchorWant;
  P._cwAnchorK = _cwAnchorK;
  P._castleWallGroups = _castleWallGroups;
  P._castleRayDiffPairs = _castleRayDiffPairs;
  P.castleByRow = castleByRow;
  P.castleByCol = castleByCol;
  P.hasCastleWalls = hasCastleWalls;
  P.castleImpossible = castleImpossible;
  P.faceExtShade = faceExtShade;
  // Ensure every Castle Wall cell is marked void (caller marks before void topology; double-check here)
  for (let k = 0; k < castle.length; k++) {
    if (!isVoid[castle[k].cell]) throw new Error(`Castle Wall tile at ${castle[k].r},${castle[k].c} missing from voids`);
  }
  return P;
}

/** Serialize Castle Wall tiles into CSV token array `parts`. */
export function serializeCastle(p, parts) {
  if (!p.castle || !p.castle.length) return;
  for (const cw of p.castle) {
    parts.push(cw.dir ? `${cw.r}:${cw.c}:C${cw.wall}${cw.dir}${cw.n}` : `${cw.r}:${cw.c}:C${cw.wall}`);
  }
}

/** Parse one Castle Wall CSV token into `acc.castle`. Returns true if matched. */
export function parseCastleToken(r, c, t, acc) {
  const m = /^C([WBG])(?:([UDLR])(\d+))?$/.exec(t);
  if (!m) return false;
  const wall = m[1];
  const dir = m[2] || '';
  const n = dir ? +m[3] : -1;
  acc.castle.push({ r, c, wall, dir, n });
  return true;
}

/** Transform Castle Wall tiles under a dihedral symmetry `(swap, flipR, flipC)` for `symmetryKey`. */
export function symmetryCastle(p, swap, flipR, flipC) {
  const castle = p.castle || [];
  if (!castle.length) return '';
  const { rows, cols } = p;
  const R = swap ? cols : rows, C = swap ? rows : cols;
  const xformDir = (dir) => {
    if (!dir) return '';
    let d = DIR_IDX[dir];
    if (swap) d = 3 - d; // U(0)<->L(3), R(1)<->D(2)
    if (flipR && (d === 0 || d === 2)) d ^= 2;
    if (flipC && (d === 1 || d === 3)) d ^= 2;
    return DIR_STR[d];
  };
  const items = castle.map((cw) => {
    let r = cw.r, c = cw.c;
    if (swap) [r, c] = [c, r];
    if (flipR) r = R - 1 - r;
    if (flipC) c = C - 1 - c;
    const nd = xformDir(cw.dir);
    return [r * C + c, nd ? `${r}:${c}:C${cw.wall}${nd}${cw.n}` : `${r}:${c}:C${cw.wall}`];
  }).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  return '|C:' + items.join(';');
}

/** Rotate Castle Wall tiles 90° clockwise for `js/rotate.js`. */
export function rotateCastleCW(P) {
  if (!P.hasCastle) return [];
  const { rows } = P;
  return P.castle.map((cw) => ({
    r: cw.c,
    c: rows - 1 - cw.r,
    wall: cw.wall,
    dir: cw.dir ? DIR_STR[(DIR_IDX[cw.dir] + 1) & 3] : '',
    n: cw.dir ? cw.n : -1,
  }));
}

// ------------------------------------------------------------ Exact satisfaction & solver propagation

// Reusable scratch arrays for satisfaction BFS, parity union-find, and zero-alloc ray bounds
let satPar = new Int8Array(0);
let satQ = new Int32Array(0);
let cwPar = new Int32Array(0);
let cwDiff = new Uint8Array(0);
let cwCompBad = new Uint8Array(0);
let cwCompSeen = new Int8Array(0);
let cwUnk = new Int32Array(0);
let lastParityBadIdx = 0;

// Zero-allocation scratch arrays for evalCastleRayBoundFast / propagateCastleMedium
const GRP_SINGLE = 0, GRP_RUN = 1, GRP_EXACT1 = 2, GRP_MAX1 = 3;
let rbUnks = new Int32Array(64);
let rbKind = new Uint8Array(64);
let rbStart = new Int16Array(64);
let rbLen = new Int16Array(64);
let rbMin = new Int16Array(64);
let rbMax = new Int16Array(64);
let rbPerp = new Int32Array(64);

function ensureRbScratch(len) {
  if (rbUnks.length >= len) return;
  const cap = Math.max(len, rbUnks.length * 2);
  rbUnks = new Int32Array(cap);
  rbKind = new Uint8Array(cap);
  rbStart = new Int16Array(cap);
  rbLen = new Int16Array(cap);
  rbMin = new Int16Array(cap);
  rbMax = new Int16Array(cap);
  rbPerp = new Int32Array(cap);
}

/**
 * Check a complete closed loop `e` (E_ON=1 marks) against all Castle Wall constraints.
 * Returns the exact index `k` of the first violated Castle Wall tile (ray count OR W/B parity),
 * or -1 if every Castle Wall tile is satisfied.
 */
export function firstUnsatisfiedCastle(P, e) {
  if (!P.hasCastle) return -1;
  if (P.castleImpossible) return 0;
  const { castle, rows, cols, edgeA } = P;
  for (let k = 0; k < castle.length; k++) {
    const cw = castle[k];
    if (!cw.dir) continue;
    let on = 0;
    const es = cw.edges;
    for (let j = 0; j < es.length; j++) if (e[es[j]] === E_ON) on++;
    if (on !== cw.n) return k;
  }
  if (!P.hasCastleWalls) return -1;
  const fr = rows - 1, fc = cols - 1;
  if (fr <= 0 || fc <= 0) return 0;
  const F = fr * fc;
  if (satPar.length < F) {
    satPar = new Int8Array(F);
    satQ = new Int32Array(F);
  }
  satPar.fill(-1, 0, F);
  let qh = 0, qt = 0;
  const seed = (f, p) => {
    if (satPar[f] !== -1) return satPar[f] === p;
    satPar[f] = p;
    satQ[qt++] = f;
    return true;
  };
  for (let c = 0; c < fc; c++) {
    const topE = 2 * c;
    if (!seed(c, (edgeA[topE] >= 0 && e[topE] === E_ON) ? 1 : 0)) return 0;
    const botE = 2 * ((rows - 1) * cols + c);
    if (!seed((fr - 1) * fc + c, (edgeA[botE] >= 0 && e[botE] === E_ON) ? 1 : 0)) return 0;
  }
  for (let r = 0; r < fr; r++) {
    const leftE = 2 * (r * cols) + 1;
    if (!seed(r * fc, (edgeA[leftE] >= 0 && e[leftE] === E_ON) ? 1 : 0)) return 0;
    const rightE = 2 * (r * cols + cols - 1) + 1;
    if (!seed(r * fc + fc - 1, (edgeA[rightE] >= 0 && e[rightE] === E_ON) ? 1 : 0)) return 0;
  }
  while (qh < qt) {
    const f = satQ[qh++];
    const r = (f / fc) | 0, c = f % fc;
    const fp = satPar[f];
    if (r > 0) {
      const x = 2 * (r * cols + c);
      if (!seed(f - fc, fp ^ ((edgeA[x] >= 0 && e[x] === E_ON) ? 1 : 0))) return 0;
    }
    if (r + 1 < fr) {
      const x = 2 * ((r + 1) * cols + c);
      if (!seed(f + fc, fp ^ ((edgeA[x] >= 0 && e[x] === E_ON) ? 1 : 0))) return 0;
    }
    if (c > 0) {
      const x = 2 * (r * cols + c) + 1;
      if (!seed(f - 1, fp ^ ((edgeA[x] >= 0 && e[x] === E_ON) ? 1 : 0))) return 0;
    }
    if (c + 1 < fc) {
      const x = 2 * (r * cols + c + 1) + 1;
      if (!seed(f + 1, fp ^ ((edgeA[x] >= 0 && e[x] === E_ON) ? 1 : 0))) return 0;
    }
  }
  for (let k = 0; k < castle.length; k++) {
    const cw = castle[k];
    if (cw.wall === 'G') continue;
    const want = cw.wall === 'W' ? 1 : 0;
    const got = cw.isExterior ? 0 : satPar[cw.face];
    if (got !== want) return k;
  }
  return -1;
}

/**
 * Check whether a complete closed loop `e` (E_ON=1 marks) satisfies all Castle Wall constraints.
 */
export function isCastleSatisfied(P, e) {
  return firstUnsatisfiedCastle(P, e) < 0;
}

/**
 * Incremental propagation for one numbered Castle Wall clue during exact search.
 * Returns false on contradiction.
 */
export function propagateCastleClue(P, st, ci, setEdge) {
  const cw = P.castle[ci];
  if (!cw.dir) return true;
  const e = st.e, es = cw.edges, len = es.length;
  let on = 0, unk = 0;
  for (let j = 0; j < len; j++) {
    const v = e[es[j]];
    if (v === E_ON) on++;
    else if (v === E_UNKNOWN) unk++;
  }
  if (on > cw.n || on + unk < cw.n) return false;
  if (unk === 0) return true;
  if (on === cw.n) {
    for (let j = 0; j < len; j++) if (e[es[j]] === E_UNKNOWN && !setEdge(es[j], E_OFF)) return false;
  } else if (on + unk === cw.n) {
    for (let j = 0; j < len; j++) if (e[es[j]] === E_UNKNOWN && !setEdge(es[j], E_ON)) return false;
  }
  return true;
}

/**
 * Fast dual-face Inside/Outside union-find for Castle Wall exact propagation.
 * Uses precomputed flat active-edge canonical face tables (zero div/mod).
 * Pass `setEdge = null` for contradiction-only checks (skips Pass 2 completely).
 * Returns false on contradiction (setting `lastParityBadIdx` to the offending W/B tile).
 */
export function propagateCastleParity(P, st, setEdge) {
  if (!P.hasCastleWalls) return true;
  if (P.castleImpossible) { lastParityBadIdx = 0; return false; }
  const { rows, cols, _cwEdgeX, _cwEdgeFA, _cwEdgeFB, _cwAnchorF, _cwAnchorWant, _cwAnchorK } = P;
  if (!_cwEdgeX) return true;
  const F = (rows - 1) * (cols - 1), EXT = F, V = F + 1;
  if (cwPar.length < V) {
    cwPar = new Int32Array(V);
    cwDiff = new Uint8Array(V);
    cwCompBad = new Uint8Array(V);
    cwCompSeen = new Int8Array(V);
  }
  for (let i = 0; i < V; i++) { cwPar[i] = i; cwDiff[i] = 0; }
  if (!setEdge) {
    cwCompBad.fill(0, 0, V);
    cwCompSeen.fill(-1, 0, V);
  }
  const find = (u) => {
    let r = u, p = 0;
    while (cwPar[r] !== r) { p ^= cwDiff[r]; r = cwPar[r]; }
    let cur = u, acc = p;
    while (cwPar[cur] !== r) {
      const nxt = cwPar[cur];
      const d = cwDiff[cur];
      cwPar[cur] = r;
      cwDiff[cur] = acc;
      acc ^= d;
      cur = nxt;
    }
    return r;
  };
  const link = (u, v, xor) => {
    const ru = find(u), rv = find(v);
    const pu = cwDiff[u], pv = cwDiff[v];
    if (ru === rv) return (pu ^ pv) === xor;
    if (rv === EXT) { cwPar[ru] = rv; cwDiff[ru] = pu ^ pv ^ xor; if (!setEdge) cwCompBad[rv] |= cwCompBad[ru]; }
    else { cwPar[rv] = ru; cwDiff[rv] = pu ^ pv ^ xor; if (!setEdge) cwCompBad[ru] |= cwCompBad[rv]; }
    return true;
  };

  // Link all known ON/OFF active edges first (capturing unknown edge indices for Pass 2 if setEdge is provided)
  const e = st.e;
  const nEdges = _cwEdgeX.length;
  let nUnk = 0;
  if (setEdge && cwUnk.length < nEdges) cwUnk = new Int32Array(nEdges);
  for (let i = 0; i < nEdges; i++) {
    const ev = e[_cwEdgeX[i]];
    if (ev === E_UNKNOWN) {
      if (setEdge) cwUnk[nUnk++] = i;
      continue;
    }
    const a = _cwEdgeFA[i], b = _cwEdgeFB[i];
    if (!link(a, b, ev === E_ON ? 1 : 0)) {
      if (setEdge) {
        lastParityBadIdx = _cwAnchorK.length ? _cwAnchorK[0] : 0;
        return false;
      }
      // In contradiction-only mode (castleContradiction), mark this edge-edge conflicted component
      // rather than falsely blaming an innocent W/B Castle Wall tile or hijacking unanchored pocket parity!
      cwCompBad[find(a)] = 1;
    }
  }

  if (!setEdge) {
    // Only report a Castle Wall parity contradiction when a W/B anchor actually conflicts in a non-corrupted component
    const extRoot = find(EXT);
    const extBad = cwCompBad[extRoot];
    for (let i = 0; i < _cwAnchorF.length; i++) {
      const f = _cwAnchorF[i], want = _cwAnchorWant[i];
      const r = find(f);
      if (cwCompBad[r]) continue;
      if (r === extRoot) {
        if (!extBad && (cwDiff[f] ^ cwDiff[EXT]) !== want) {
          lastParityBadIdx = _cwAnchorK[i];
          return false;
        }
      } else {
        const eff = cwDiff[f] ^ want;
        const prev = cwCompSeen[r];
        if (prev < 0) cwCompSeen[r] = eff;
        else if (prev !== eff) {
          lastParityBadIdx = _cwAnchorK[i];
          return false;
        }
      }
    }
    return true;
  }

  // Anchor White (1) and Black (0) Castle Wall holes after edges
  for (let i = 0; i < _cwAnchorF.length; i++) {
    if (!link(EXT, _cwAnchorF[i], _cwAnchorWant[i])) {
      lastParityBadIdx = _cwAnchorK[i];
      return false;
    }
  }

  // Pass 2: force any unknown active edge whose two flanking faces are in the same parity component
  for (let j = 0; j < nUnk; j++) {
    const i = cwUnk[j];
    const a = _cwEdgeFA[i], b = _cwEdgeFB[i];
    if (find(a) === find(b)) {
      const want = (cwDiff[a] ^ cwDiff[b]) ? E_ON : E_OFF;
      if (!setEdge(_cwEdgeX[i], want)) return false;
    }
  }
  return true;
}

/**
 * Check whether closing `closingEdge` (currently UNKNOWN -> ON) would leave any Castle Wall
 * constraint unsatisfied (wrong arrow count, or wrong W/B inside/outside parity).
 * Returns the exact first unsatisfied castle index, or -1 if all match.
 */
export function firstUnsatisfiedCastleOnClose(P, st, closingEdge) {
  if (!P.hasCastle) return -1;
  const e = st.e;
  const prev = e[closingEdge];
  e[closingEdge] = E_ON;
  const bad = firstUnsatisfiedCastle(P, e);
  e[closingEdge] = prev;
  return bad;
}

/** Contradiction check for `js/imagine.js` lookahead (ray counts, ray-diff, ray-bound, and W/B parity). */
export function castleContradiction(P, st, scopeCastles = null) {
  if (!P.hasCastle) return null;
  if (P.castleImpossible) return { kind: 'castleBroken', castleIdx: 0, over: false };
  const { castle } = P;
  const e = st.e;
  for (let k = 0; k < castle.length; k++) {
    if (scopeCastles && !scopeCastles[k]) continue;
    const cw = castle[k];
    if (!cw.dir) continue;
    let on = 0, unk = 0;
    const es = cw.edges;
    for (let j = 0; j < es.length; j++) {
      const v = e[es[j]];
      if (v === E_ON) on++;
      else if (v === E_UNKNOWN) unk++;
    }
    if (on > cw.n) return { kind: 'castleBroken', castleIdx: k, over: true };
    if (on + unk < cw.n) return { kind: 'castleBroken', castleIdx: k, over: false };
  }
  const pairs = P._castleRayDiffPairs;
  if (pairs && pairs.length) {
    for (let p = 0; p < pairs.length; p++) {
      const pr = pairs[p];
      if (scopeCastles && !scopeCastles[pr.i] && !scopeCastles[pr.j]) continue;
      const es = pr.edges;
      let on = 0, unk = 0;
      for (let j = 0; j < es.length; j++) {
        const v = e[es[j]];
        if (v === E_ON) on++;
        else if (v === E_UNKNOWN) unk++;
      }
      if (on > pr.diff) return { kind: 'castleBroken', castleIdx: pr.i, over: true };
      if (on + unk < pr.diff) return { kind: 'castleBroken', castleIdx: pr.i, over: false };
    }
  }
  for (let k = 0; k < castle.length; k++) {
    if (scopeCastles && !scopeCastles[k]) continue;
    const rc = propagateCastleRayBoundOne(P, st, k, null);
    if (rc < 0) return { kind: 'castleBroken', castleIdx: k, over: rc === -1 };
  }
  if (P.hasCastleWalls) {
    if (!propagateCastleParity(P, st, null)) {
      return { kind: 'castleParity', castleIdx: lastParityBadIdx };
    }
  }
  return null;
}

// ------------------------------------------------------------ UI Auto-X & live error states

/** Auto-X bookkeeping for Castle Wall: 0 rays and satisfied rays cross out remaining parallel edges. */
export function autoXCastle(P, w, add) {
  if (!P.hasCastle) return false;
  const { castle } = P;
  let changed = false;
  for (let k = 0; k < castle.length; k++) {
    const cw = castle[k];
    if (!cw.dir) continue;
    const es = cw.edges;
    let on = 0;
    for (let j = 0; j < es.length; j++) if (w[es[j]] === 1) on++;
    if (on === cw.n) {
      for (let j = 0; j < es.length; j++) {
        const x = es[j];
        if (w[x] !== 1 && add(x)) changed = true;
      }
    }
  }
  return changed;
}

/**
 * Live error feedback for Castle Wall tiles from player marks alone (never looks at stored solution).
 * Returns array of 'bad' | '' per tile in P.castle.
 */
export function castleStates(P, marks) {
  if (!P.hasCastle) return [];
  const { castle, rows, cols, edgeA, faceExterior, faceRep } = P;
  const e = marks.edges;
  const out = new Array(castle.length).fill('');
  for (let k = 0; k < castle.length; k++) {
    const cw = castle[k];
    if (!cw.dir) continue;
    let on = 0, unk = 0;
    const es = cw.edges;
    for (let j = 0; j < es.length; j++) {
      const v = e[es[j]];
      if (v === 1) on++;
      else if (v === 0) unk++;
    }
    if (on > cw.n || on + unk < cw.n) out[k] = 'bad';
  }
  // Also flag W/B tiles whose Inside/Outside parity is contradicted in non-conflicted components
  if (P.hasCastleWalls && P._cwEdgeX) {
    const { _cwEdgeX, _cwEdgeFA, _cwEdgeFB, _cwAnchorF, _cwAnchorWant, _cwAnchorK } = P;
    const F = (rows - 1) * (cols - 1), EXT = F, V = F + 1;
    const par = new Int32Array(V);
    const diff = new Uint8Array(V);
    const compBad = new Uint8Array(V);
    for (let i = 0; i < V; i++) par[i] = i;
    const find = (u) => {
      let r = u, p = 0;
      while (par[r] !== r) { p ^= diff[r]; r = par[r]; }
      let cur = u, acc = p;
      while (par[cur] !== r) {
        const nxt = par[cur], d = diff[cur];
        par[cur] = r; diff[cur] = acc; acc ^= d; cur = nxt;
      }
      return r;
    };
    const link = (u, v, xor) => {
      const ru = find(u), rv = find(v);
      const pu = diff[u], pv = diff[v];
      if (ru === rv) {
        if ((pu ^ pv) !== xor) compBad[ru] = 1;
        return;
      }
      const bad = compBad[ru] | compBad[rv];
      if (rv === EXT) { par[ru] = rv; diff[ru] = pu ^ pv ^ xor; compBad[rv] = bad; }
      else { par[rv] = ru; diff[rv] = pu ^ pv ^ xor; compBad[ru] = bad; }
    };
    for (let i = 0; i < _cwEdgeX.length; i++) {
      const ev = e[_cwEdgeX[i]];
      if (ev !== 1 && ev !== 2) continue;
      link(_cwEdgeFA[i], _cwEdgeFB[i], ev === 1 ? 1 : 0);
    }
    const extRoot = find(EXT);
    const compWall = new Map(); // root -> { eff, idxs, bad }
    for (let i = 0; i < _cwAnchorF.length; i++) {
      const f = _cwAnchorF[i], want = _cwAnchorWant[i], k = _cwAnchorK[i];
      const r = find(f);
      if (compBad[r]) continue; // skip components with an unrelated edge-cycle mistake
      if (r === extRoot) {
        if ((diff[f] ^ diff[EXT]) !== want) out[k] = 'bad';
      } else {
        const eff = diff[f] ^ want;
        const prev = compWall.get(r);
        if (!prev) compWall.set(r, { eff, idxs: [k], bad: false });
        else {
          prev.idxs.push(k);
          if (prev.eff !== eff) prev.bad = true;
        }
      }
    }
    for (const rec of compWall.values()) {
      if (rec.bad) for (const idx of rec.idxs) out[idx] = 'bad';
    }
  }
  return out;
}

// ------------------------------------------------------------ Human-style solving rules

/** Beginner Rule 1: a 0 arrow crosses out every parallel segment along its ray. */
export function findCastleZero(P, st) {
  if (!P.hasCastle) return [];
  const { castle } = P;
  const e = st.e;
  const out = [];
  for (let k = 0; k < castle.length; k++) {
    const cw = castle[k];
    if (!cw.dir || cw.n !== 0) continue;
    const sets = [];
    const es = cw.edges;
    for (let j = 0; j < es.length; j++) {
      if (e[es[j]] === E_UNKNOWN) sets.push(['e', es[j], E_OFF]);
    }
    if (sets.length) out.push({ sets, info: { castleIdx: k, cell: cw.cell, dir: cw.dir, n: 0 } });
  }
  return out;
}

/** Beginner Rule 2: ray count completion (on === n -> X rest; on + unk === n -> draw rest). */
export function findCastleCount(P, st) {
  if (!P.hasCastle) return [];
  const { castle } = P;
  const e = st.e;
  const out = [];
  for (let k = 0; k < castle.length; k++) {
    const cw = castle[k];
    if (!cw.dir || cw.n === 0) continue;
    const es = cw.edges;
    let on = 0, unk = 0;
    for (let j = 0; j < es.length; j++) {
      const v = e[es[j]];
      if (v === E_ON) on++;
      else if (v === E_UNKNOWN) unk++;
    }
    if (unk === 0) continue;
    if (on === cw.n || on + unk === cw.n) {
      const val = on === cw.n ? E_OFF : E_ON;
      const sets = [];
      for (let j = 0; j < es.length; j++) {
        if (e[es[j]] === E_UNKNOWN) sets.push(['e', es[j], val]);
      }
      if (sets.length) {
        out.push({
          sets,
          info: { castleIdx: k, cell: cw.cell, dir: cw.dir, n: cw.n, mode: val === E_ON ? 'fill' : 'done' },
        });
      }
    }
  }
  return out;
}

/**
 * Beginner Rule 3: direct 1-hop Inside/Outside wall edge (uses precomputed static boundary groups).
 */
export function findCastleWallEdge(P, st) {
  const groups = P._castleWallGroups;
  if (!groups || !groups.length) return [];
  const e = st.e;
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const gr = groups[i];
    const es = gr.edges;
    let sets = null;
    for (let j = 0; j < es.length; j++) {
      if (e[es[j]] === E_UNKNOWN) {
        if (!sets) sets = [];
        sets.push(['e', es[j], gr.info.val]);
      }
    }
    if (sets) out.push({ sets, info: gr.info });
  }
  return out;
}

/**
 * Medium Rule 4: collinear same-direction ray difference (uses precomputed collinear suffix pairs).
 */
export function findCastleRayDiff(P, st) {
  const pairs = P._castleRayDiffPairs;
  if (!pairs || !pairs.length) return [];
  const e = st.e;
  const out = [];
  for (let p = 0; p < pairs.length; p++) {
    const pr = pairs[p];
    const es = pr.edges;
    let on = 0, unk = 0;
    for (let k = 0; k < es.length; k++) {
      const v = e[es[k]];
      if (v === E_ON) on++;
      else if (v === E_UNKNOWN) unk++;
    }
    if (unk === 0) continue;
    if (on === pr.diff || on + unk === pr.diff) {
      const val = on === pr.diff ? E_OFF : E_ON;
      const sets = [];
      for (let k = 0; k < es.length; k++) {
        if (e[es[k]] === E_UNKNOWN) sets.push(['e', es[k], val]);
      }
      if (sets.length) {
        out.push({
          sets,
          info: {
            castleIdx: pr.i, castleIdx2: pr.j, cell: pr.cell1, cell2: pr.cell2,
            dir: pr.dir, n1: pr.n1, n2: pr.n2, diff: pr.diff, mode: val === E_ON ? 'fill' : 'done',
          },
        });
      }
    }
  }
  return out;
}

// Hoisted helpers for findCastleRayBound / propagateCastleMedium
function cwIsBlk(ed, nb, e, cell, v, d) {
  const x = ed[v * 4 + d];
  if (x < 0 || e[x] === E_OFF) return true;
  const j = nb[v * 4 + d];
  return j < 0 || cell[j] === OFF;
}
function cwIsOn(ed, e, v, d) {
  const x = ed[v * 4 + d];
  return x >= 0 && e[x] === E_ON;
}
function cwSharedVert(edgeA, edgeB, xA, xB) {
  const a1 = edgeA[xA], b1 = edgeB[xA];
  const a2 = edgeA[xB], b2 = edgeB[xB];
  if (a1 === a2 || a1 === b2) return a1;
  if (b1 === a2 || b1 === b2) return b1;
  return -1;
}

/**
 * Evaluate ray-bound partition for one Castle Wall clue `k`.
 * Returns:
 *   - `{ contradiction: true }` if `rem < minTotal || rem > maxTotal`
 *   - `{ sets, info }` if a deduction is found
 *   - `null` otherwise
 */
function evalCastleRayBoundOne(P, st, k) {
  const cw = P.castle[k];
  if (!cw.dir) return null;
  const { ed, nb, edgeA, edgeB } = P;
  const e = st.e, cell = st.cell;
  const es = cw.edges;
  let on = 0;
  const unks = [];
  for (let j = 0; j < es.length; j++) {
    const v = e[es[j]];
    if (v === E_ON) on++;
    else if (v === E_UNKNOWN) unks.push(es[j]);
  }
  const rem = cw.n - on;
  if (unks.length <= 1 || rem <= 0 || rem >= unks.length) return null;

  const p0 = (cw.d + 1) & 3, p1 = (cw.d + 3) & 3;
  const groups = [];
  let i = 0;
  while (i < unks.length) {
    if (i + 1 < unks.length) {
      const sv = cwSharedVert(edgeA, edgeB, unks[i], unks[i + 1]);
      if (sv >= 0) {
        const on0 = cwIsOn(ed, e, sv, p0), on1 = cwIsOn(ed, e, sv, p1);
        if (on0 !== on1) {
          const otherBlk = on0 ? cwIsBlk(ed, nb, e, cell, sv, p1) : cwIsBlk(ed, nb, e, cell, sv, p0);
          const otherPerp = on0 ? ed[sv * 4 + p1] : ed[sv * 4 + p0];
          groups.push({
            kind: otherBlk ? 'exact1' : 'max1',
            edges: [unks[i], unks[i + 1]],
            min: otherBlk ? 1 : 0,
            max: 1,
            otherPerp: otherBlk ? -1 : otherPerp,
          });
          i += 2;
          continue;
        }
      }
    }
    const run = [unks[i]];
    while (i + 1 < unks.length) {
      const sv = cwSharedVert(edgeA, edgeB, unks[i], unks[i + 1]);
      if (sv < 0) break;
      if (!cwIsBlk(ed, nb, e, cell, sv, p0) || !cwIsBlk(ed, nb, e, cell, sv, p1)) break;
      run.push(unks[i + 1]);
      i++;
    }
    groups.push({
      kind: run.length >= 2 ? 'run' : 'single',
      edges: run,
      min: 0,
      max: run.length,
      otherPerp: -1,
    });
    i++;
  }

  let minTotal = 0, maxTotal = 0;
  let oddIdx = -1, oddCount = 0;
  for (let g = 0; g < groups.length; g++) {
    const gr = groups[g];
    minTotal += gr.min;
    maxTotal += gr.max;
    if (gr.kind === 'run' || gr.kind === 'single') {
      if ((gr.max & 1) === 1) { oddIdx = g; oddCount++; }
    } else if (gr.kind === 'max1') {
      oddIdx = g; oddCount++;
    }
  }

  if (rem < minTotal || rem > maxTotal || (oddCount === 0 && ((rem - minTotal) & 1) === 1)) {
    return { contradiction: true };
  }

  const sets = [];
  let reason = null;
  if (rem === minTotal) {
    for (let g = 0; g < groups.length; g++) {
      const gr = groups[g];
      if (gr.min === 0 && gr.max > 0) {
        for (let j = 0; j < gr.edges.length; j++) sets.push(['e', gr.edges[j], E_OFF]);
      }
    }
    reason = 'turnCap';
  } else if (rem === maxTotal) {
    for (let g = 0; g < groups.length; g++) {
      const gr = groups[g];
      if (gr.kind === 'run' || gr.kind === 'single') {
        for (let j = 0; j < gr.edges.length; j++) sets.push(['e', gr.edges[j], E_ON]);
      } else if (gr.kind === 'max1' && gr.otherPerp >= 0 && e[gr.otherPerp] === E_UNKNOWN) {
        sets.push(['e', gr.otherPerp, E_OFF]);
      }
    }
    reason = 'turnNeed';
  } else {
    // Emit only matching-reason runs so explanation stays exact (runTooLong first, else runRequired)
    for (let g = 0; g < groups.length; g++) {
      const gr = groups[g];
      if (gr.kind !== 'run') continue;
      if (minTotal + gr.max > rem && (!reason || reason === 'runTooLong')) {
        for (let j = 0; j < gr.edges.length; j++) sets.push(['e', gr.edges[j], E_OFF]);
        reason = 'runTooLong';
      } else if (maxTotal - gr.max < rem && (!reason || reason === 'runRequired')) {
        for (let j = 0; j < gr.edges.length; j++) sets.push(['e', gr.edges[j], E_ON]);
        reason = 'runRequired';
      }
    }
    if (!sets.length && oddCount === 1) {
      const gr = groups[oddIdx];
      const needOdd = ((rem - minTotal) & 1) === 1;
      if (gr.kind === 'run' || gr.kind === 'single') {
        const val = needOdd ? E_ON : E_OFF;
        for (let j = 0; j < gr.edges.length; j++) sets.push(['e', gr.edges[j], val]);
        reason = 'rayParity';
      } else if (gr.kind === 'max1') {
        if (needOdd) {
          if (gr.otherPerp >= 0 && e[gr.otherPerp] === E_UNKNOWN) {
            sets.push(['e', gr.otherPerp, E_OFF]);
            reason = 'rayParity';
          }
        } else {
          for (let j = 0; j < gr.edges.length; j++) sets.push(['e', gr.edges[j], E_OFF]);
          reason = 'rayParity';
        }
      }
    }
  }

  if (!sets.length) return null;
  return {
    sets,
    info: { castleIdx: k, cell: cw.cell, dir: cw.dir, n: cw.n, rem, reason },
  };
}

/**
 * Medium Rule 5: coupled straight runs & forced/at-most-1 turn pairs along a Castle Wall ray.
 */
export function findCastleRayBound(P, st) {
  if (!P.hasCastle) return [];
  const out = [];
  for (let k = 0; k < P.castle.length; k++) {
    const res = evalCastleRayBoundOne(P, st, k);
    if (res && !res.contradiction) out.push(res);
  }
  return out;
}

/**
 * Zero-allocation ray-bound partition & propagator for one Castle Wall clue `k`.
 * If `setEdge` is null, runs as a fast contradiction-only check.
 * Returns:
 *   -1 if `rem < minTotal` (over-committed)
 *   -2 if `rem > maxTotal` (under-capacity) or `setEdge` rejected
 *    0 if consistent (all forced edges emitted via `setEdge` when provided)
 */
function propagateCastleRayBoundOne(P, st, k, setEdge) {
  const cw = P.castle[k];
  if (!cw.dir) return 0;
  const { ed, nb, edgeA, edgeB } = P;
  const e = st.e, cell = st.cell;
  const es = cw.edges;
  ensureRbScratch(es.length);
  let on = 0, nUnk = 0;
  for (let j = 0; j < es.length; j++) {
    const x = es[j];
    const v = e[x];
    if (v === E_ON) on++;
    else if (v === E_UNKNOWN) rbUnks[nUnk++] = x;
  }
  const rem = cw.n - on;
  if (nUnk <= 1 || rem <= 0 || rem >= nUnk) return 0;

  const p0 = (cw.d + 1) & 3, p1 = (cw.d + 3) & 3;
  let ng = 0;
  let i = 0;
  while (i < nUnk) {
    if (i + 1 < nUnk) {
      const sv = cwSharedVert(edgeA, edgeB, rbUnks[i], rbUnks[i + 1]);
      if (sv >= 0) {
        const on0 = cwIsOn(ed, e, sv, p0), on1 = cwIsOn(ed, e, sv, p1);
        if (on0 !== on1) {
          const otherBlk = on0 ? cwIsBlk(ed, nb, e, cell, sv, p1) : cwIsBlk(ed, nb, e, cell, sv, p0);
          rbKind[ng] = otherBlk ? GRP_EXACT1 : GRP_MAX1;
          rbStart[ng] = i;
          rbLen[ng] = 2;
          rbMin[ng] = otherBlk ? 1 : 0;
          rbMax[ng] = 1;
          rbPerp[ng] = otherBlk ? -1 : (on0 ? ed[sv * 4 + p1] : ed[sv * 4 + p0]);
          ng++;
          i += 2;
          continue;
        }
      }
    }
    const start = i;
    while (i + 1 < nUnk) {
      const sv = cwSharedVert(edgeA, edgeB, rbUnks[i], rbUnks[i + 1]);
      if (sv < 0) break;
      if (!cwIsBlk(ed, nb, e, cell, sv, p0) || !cwIsBlk(ed, nb, e, cell, sv, p1)) break;
      i++;
    }
    const len = i - start + 1;
    rbKind[ng] = len >= 2 ? GRP_RUN : GRP_SINGLE;
    rbStart[ng] = start;
    rbLen[ng] = len;
    rbMin[ng] = 0;
    rbMax[ng] = len;
    rbPerp[ng] = -1;
    ng++;
    i++;
  }

  let minTotal = 0, maxTotal = 0;
  let oddIdx = -1, oddCount = 0;
  for (let g = 0; g < ng; g++) {
    minTotal += rbMin[g];
    maxTotal += rbMax[g];
    const kd = rbKind[g];
    if (kd === GRP_RUN || kd === GRP_SINGLE) {
      if ((rbMax[g] & 1) === 1) { oddIdx = g; oddCount++; }
    } else if (kd === GRP_MAX1) {
      oddIdx = g; oddCount++;
    }
  }

  if (rem < minTotal) return -1;
  if (rem > maxTotal || (oddCount === 0 && ((rem - minTotal) & 1) === 1)) return -2;
  if (!setEdge) return 0;

  if (rem === minTotal) {
    for (let g = 0; g < ng; g++) {
      if (rbMin[g] === 0 && rbMax[g] > 0) {
        const s = rbStart[g], end = s + rbLen[g];
        for (let j = s; j < end; j++) if (!setEdge(rbUnks[j], E_OFF)) return -2;
      }
    }
  } else if (rem === maxTotal) {
    for (let g = 0; g < ng; g++) {
      const kd = rbKind[g];
      if (kd === GRP_RUN || kd === GRP_SINGLE) {
        const s = rbStart[g], end = s + rbLen[g];
        for (let j = s; j < end; j++) if (!setEdge(rbUnks[j], E_ON)) return -2;
      } else if (kd === GRP_MAX1) {
        const px = rbPerp[g];
        if (px >= 0 && e[px] === E_UNKNOWN && !setEdge(px, E_OFF)) return -2;
      }
    }
  } else {
    let emitted = false;
    for (let g = 0; g < ng; g++) {
      if (rbKind[g] !== GRP_RUN) continue;
      if (minTotal + rbMax[g] > rem) {
        const s = rbStart[g], end = s + rbLen[g];
        for (let j = s; j < end; j++) if (!setEdge(rbUnks[j], E_OFF)) return -2;
        emitted = true;
      } else if (maxTotal - rbMax[g] < rem) {
        const s = rbStart[g], end = s + rbLen[g];
        for (let j = s; j < end; j++) if (!setEdge(rbUnks[j], E_ON)) return -2;
        emitted = true;
      }
    }
    if (!emitted && oddCount === 1) {
      const kd = rbKind[oddIdx];
      const needOdd = ((rem - minTotal) & 1) === 1;
      if (kd === GRP_RUN || kd === GRP_SINGLE) {
        const val = needOdd ? E_ON : E_OFF;
        const s = rbStart[oddIdx], end = s + rbLen[oddIdx];
        for (let j = s; j < end; j++) if (!setEdge(rbUnks[j], val)) return -2;
      } else if (kd === GRP_MAX1) {
        if (needOdd) {
          const px = rbPerp[oddIdx];
          if (px >= 0 && e[px] === E_UNKNOWN && !setEdge(px, E_OFF)) return -2;
        } else {
          const s = rbStart[oddIdx], end = s + rbLen[oddIdx];
          for (let j = s; j < end; j++) if (!setEdge(rbUnks[j], E_OFF)) return -2;
        }
      }
    }
  }
  return 0;
}

/**
 * Medium Castle Wall propagation pass (ray-diff + zero-alloc ray bounds) for `propagate()` in `js/logic.js`.
 * Pass optional `dirtyFlags` (`Uint8Array` indexed by castleIdx) to scan only dirty rays!
 */
export function propagateCastleMedium(P, st, setEdge, dirtyFlags = null) {
  if (!P.hasCastle) return true;
  const e = st.e;
  const pairs = P._castleRayDiffPairs;
  if (pairs && pairs.length) {
    for (let p = 0; p < pairs.length; p++) {
      const pr = pairs[p];
      if (dirtyFlags && !dirtyFlags[pr.i] && !dirtyFlags[pr.j]) continue;
      const es = pr.edges;
      let on = 0, unk = 0;
      for (let k = 0; k < es.length; k++) {
        const v = e[es[k]];
        if (v === E_ON) on++;
        else if (v === E_UNKNOWN) unk++;
      }
      if (on > pr.diff || on + unk < pr.diff) return false;
      if (unk === 0) continue;
      if (on === pr.diff || on + unk === pr.diff) {
        const val = on === pr.diff ? E_OFF : E_ON;
        for (let k = 0; k < es.length; k++) {
          if (e[es[k]] === E_UNKNOWN && !setEdge(es[k], val)) return false;
        }
      }
    }
  }
  for (let k = 0; k < P.castle.length; k++) {
    if (dirtyFlags && !dirtyFlags[k]) continue;
    if (propagateCastleRayBoundOne(P, st, k, setEdge) < 0) return false;
  }
  return true;
}

export const CASTLE_RULES = [
  { id: 'castleZero', tier: 'Beginner', weight: 2, find: findCastleZero, label: 'a 0 arrow crosses out every parallel segment along its ray' },
  { id: 'castleCount', tier: 'Beginner', weight: 2, find: findCastleCount, label: 'a numbered arrow whose open segments match its count fills or crosses out the rest of its ray' },
  { id: 'castleWallEdge', tier: 'Beginner', weight: 3, find: findCastleWallEdge, label: 'an edge directly separating a white (inside) wall from the border or a black (outside) wall must be drawn, while same-color gaps are crossed out' },
  { id: 'castleRayDiff', tier: 'Medium', weight: 10, find: findCastleRayDiff, label: 'two same-direction arrows in the same row or column pin the exact segment count in the gap between them' },
  { id: 'castleRayBound', tier: 'Medium', weight: 12, find: findCastleRayBound, label: 'coupled straight corridors and forced turns along an arrow ray bound which segments can fit its count' },
];

/** Fast short-circuiting Beginner-level step for `js/imagine.js` lookahead propagation. */
export function findEasyCastleStep(P, st, tryEmit, scopeCastles = null) {
  if (!P.hasCastle) return null;
  const { castle } = P;
  const e = st.e;
  // 1. castleZero & castleCount
  for (let k = 0; k < castle.length; k++) {
    if (scopeCastles && !scopeCastles[k]) continue;
    const cw = castle[k];
    if (!cw.dir) continue;
    const es = cw.edges;
    if (cw.n === 0) {
      let sets = null;
      for (let j = 0; j < es.length; j++) {
        if (e[es[j]] === E_UNKNOWN) {
          if (!sets) sets = [];
          sets.push(['e', es[j], E_OFF]);
        }
      }
      if (sets) {
        const em = tryEmit('castleZero', sets, { castleIdx: k, cell: cw.cell, dir: cw.dir, n: 0 });
        if (em) return em;
      }
      continue;
    }
    let on = 0, unk = 0;
    for (let j = 0; j < es.length; j++) {
      const v = e[es[j]];
      if (v === E_ON) on++;
      else if (v === E_UNKNOWN) unk++;
    }
    if (unk === 0) continue;
    if (on === cw.n || on + unk === cw.n) {
      const val = on === cw.n ? E_OFF : E_ON;
      const sets = [];
      for (let j = 0; j < es.length; j++) {
        if (e[es[j]] === E_UNKNOWN) sets.push(['e', es[j], val]);
      }
      if (sets.length) {
        const em = tryEmit('castleCount', sets, { castleIdx: k, cell: cw.cell, dir: cw.dir, n: cw.n, mode: val === E_ON ? 'fill' : 'done' });
        if (em) return em;
      }
    }
  }
  // 2. castleWallEdge (static precomputed groups are tiny and already decided after turn 1;
  //    skip scope filter so multi-tile holes touching a distant anchor are never missed)
  const groups = P._castleWallGroups;
  if (groups && groups.length) {
    for (let i = 0; i < groups.length; i++) {
      const gr = groups[i];
      const es = gr.edges;
      let sets = null;
      for (let j = 0; j < es.length; j++) {
        if (e[es[j]] === E_UNKNOWN) {
          if (!sets) sets = [];
          sets.push(['e', es[j], gr.info.val]);
        }
      }
      if (sets) {
        const em = tryEmit('castleWallEdge', sets, gr.info);
        if (em) return em;
      }
    }
  }
  return null;
}

/** Medium-level step for `js/imagine.js` lookahead (used when easy steps are exhausted). */
export function findMediumCastleStep(P, st, tryEmit, scopeCastles = null) {
  if (!P.hasCastle) return null;
  const e = st.e;
  const pairs = P._castleRayDiffPairs;
  if (pairs && pairs.length) {
    for (let p = 0; p < pairs.length; p++) {
      const pr = pairs[p];
      if (scopeCastles && !scopeCastles[pr.i] && !scopeCastles[pr.j]) continue;
      const es = pr.edges;
      let on = 0, unk = 0;
      for (let k = 0; k < es.length; k++) {
        const v = e[es[k]];
        if (v === E_ON) on++;
        else if (v === E_UNKNOWN) unk++;
      }
      if (unk === 0) continue;
      if (on === pr.diff || on + unk === pr.diff) {
        const val = on === pr.diff ? E_OFF : E_ON;
        const sets = [];
        for (let k = 0; k < es.length; k++) {
          if (e[es[k]] === E_UNKNOWN) sets.push(['e', es[k], val]);
        }
        if (sets.length) {
          const em = tryEmit('castleRayDiff', sets, {
            castleIdx: pr.i, castleIdx2: pr.j, cell: pr.cell1, cell2: pr.cell2,
            dir: pr.dir, n1: pr.n1, n2: pr.n2, diff: pr.diff, mode: val === E_ON ? 'fill' : 'done',
          });
          if (em) return em;
        }
      }
    }
  }
  for (let k = 0; k < P.castle.length; k++) {
    if (scopeCastles && !scopeCastles[k]) continue;
    const res = evalCastleRayBoundOne(P, st, k);
    if (res && !res.contradiction) {
      const em = tryEmit('castleRayBound', res.sets, res.info);
      if (em) return em;
    }
  }
  return null;
}

/** Describe a Castle Wall step inside an imagined chain. Returns null for non-Castle rules. */
export function describeCastleChainStep(P, s, { cellName }) {
  const { rule, info = {} } = s;
  const cw = info.castleIdx !== undefined && P.castle ? P.castle[info.castleIdx] : null;
  const cn = cw ? cellName(P, cw.cell) : (info.cell !== undefined ? cellName(P, info.cell) : '');
  const arrow = cw && cw.dir ? `${cw.n}${DIR_ARROW[cw.dir]}` : '';
  switch (rule) {
    case 'castleZero':
      return `the ${arrow} clue at ${cn} crosses out its ray`;
    case 'castleCount':
      return info.mode === 'fill'
        ? `the ${arrow} clue at ${cn} needs all of its remaining open segments`
        : `the ${arrow} clue at ${cn} already has ${info.n} segment${info.n === 1 ? '' : 's'}, so the rest of its ray is off`;
    case 'castleWallEdge':
      return info.val === E_ON
        ? `the white/black inside-outside wall at ${cn} forces a separating loop edge`
        : `same-side walls around ${cn} cross out the separating edge`;
    case 'castleRayDiff':
      return `comparing the collinear arrows at ${cn} and ${cellName(P, info.cell2)} forces the gap between them`;
    case 'castleRayBound':
      return `corridor and turn bounds along the ${arrow} ray from ${cn} force its remaining segments`;
    default:
      return null;
  }
}

/** Explain a Castle Wall human rule step for Hint. Returns { text, nudge } or null if not a Castle rule. */
export function explainCastleStep(P, step, helpers) {
  const { rule, info = {}, targets } = step;
  const { cellName, describeMarks, roles, nudgeRoles } = helpers;
  const cw = info.castleIdx !== undefined && P.castle ? P.castle[info.castleIdx] : null;
  const cn = cw ? cellName(P, cw.cell) : (info.cell !== undefined ? cellName(P, info.cell) : '');
  const marks = describeMarks(P, targets);
  const arrow = cw && cw.dir ? `${cw.n}${DIR_ARROW[cw.dir]}` : '';
  const dirWord = cw && cw.d >= 0 ? DIR_WORD[cw.d] : '';

  switch (rule) {
    case 'castleZero':
      if (cw) { roles.clue.push(cw.cell); nudgeRoles.clue.push(cw.cell); }
      return {
        nudge: `Look ${dirWord} from the 0 clue at ${cn}.`,
        text: `The ${arrow} clue at ${cn} allows zero parallel loop segments ${dirWord} from it — ${marks}.`,
      };
    case 'castleCount':
      if (cw) { roles.clue.push(cw.cell); nudgeRoles.clue.push(cw.cell); }
      return {
        nudge: `Count the remaining segments ${dirWord} from the ${arrow} clue at ${cn}.`,
        text: info.mode === 'fill'
          ? `The ${arrow} clue at ${cn} needs every remaining open segment ${dirWord} from it to reach ${info.n} — ${marks}.`
          : `The ${arrow} clue at ${cn} already has ${info.n === 1 ? 'its 1 segment' : `all ${info.n} segments`} ${dirWord} from it, so the rest of its ray is off — ${marks}.`,
      };
    case 'castleWallEdge': {
      const cw2 = info.castleIdx2 >= 0 && P.castle ? P.castle[info.castleIdx2] : null;
      const list1 = info.castleIdxs && info.castleIdxs.length ? info.castleIdxs : (cw ? [info.castleIdx] : []);
      const list2 = info.castleIdxs2 && info.castleIdxs2.length ? info.castleIdxs2 : (cw2 ? [info.castleIdx2] : []);
      for (const idx of list1) {
        const cObj = P.castle[idx];
        if (cObj) { roles.clue.push(cObj.cell); nudgeRoles.clue.push(cObj.cell); }
      }
      for (const idx of list2) {
        const cObj = P.castle[idx];
        if (cObj) { roles.clue.push(cObj.cell); nudgeRoles.clue.push(cObj.cell); }
      }
      const namesOf = (list) => list.map((idx) => cellName(P, P.castle[idx].cell)).join('/');
      const n1 = list1.length ? namesOf(list1) : cn;
      const n2 = list2.length ? namesOf(list2) : (cw2 ? cellName(P, cw2.cell) : '');
      const colorWord = (w) => (w === 'W' ? 'white (inside)' : 'black (outside)');
      if (!cw2) {
        return {
          nudge: `Look between the ${colorWord(cw.wall)} wall at ${n1} and the outer edge of the board.`,
          text: cw.wall === 'W'
            ? `The white wall${list1.length > 1 ? 's' : ''} at ${n1} must lie inside the loop while the board edge is outside, so the loop must pass between them — ${marks}.`
            : `Both the black wall${list1.length > 1 ? 's' : ''} at ${n1} and the board edge lie outside the loop, so no loop segment can separate them — ${marks}.`,
        };
      }
      return {
        nudge: `Look between the ${colorWord(cw.wall)} wall at ${n1} and the ${colorWord(cw2.wall)} wall at ${n2}.`,
        text: info.val === E_ON
          ? `The ${colorWord(cw.wall)} wall at ${n1} and the ${colorWord(cw2.wall)} wall at ${n2} lie on opposite sides of the loop, so the loop must separate them — ${marks}.`
          : `Both walls at ${n1} and ${n2} lie on the same side of the loop, so no loop segment can separate them — ${marks}.`,
      };
    }
    case 'castleRayDiff': {
      const cw2 = P.castle[info.castleIdx2];
      roles.clue.push(cw.cell, cw2.cell);
      nudgeRoles.clue.push(cw.cell, cw2.cell);
      const a1 = `${info.n1}${DIR_ARROW[info.dir]}`, a2 = `${info.n2}${DIR_ARROW[info.dir]}`;
      return {
        nudge: `Compare the two ${dirWord}-pointing arrows at ${cn} (${a1}) and ${cellName(P, cw2.cell)} (${a2}).`,
        text: info.diff === 0
          ? `Both ${a1} at ${cn} and ${a2} at ${cellName(P, cw2.cell)} count the same total ${dirWord}, so there can be zero segments in the gap between them — ${marks}.`
          : `Comparing ${a1} at ${cn} with ${a2} at ${cellName(P, cw2.cell)} leaves exactly ${info.diff} segment${info.diff === 1 ? '' : 's'} in the gap between them — ${marks}.`,
      };
    }
    case 'castleRayBound': {
      if (cw) { roles.clue.push(cw.cell); nudgeRoles.clue.push(cw.cell); }
      const why = info.reason === 'runTooLong'
        ? `a forced straight corridor along the ray is longer than the ${info.rem} remaining segment${info.rem === 1 ? '' : 's'} allowed`
        : info.reason === 'runRequired'
          ? `the remaining edges outside a forced straight corridor cannot reach the ${info.rem} needed segment${info.rem === 1 ? '' : 's'}`
          : info.reason === 'turnCap'
            ? `forced turns along the ray already account for ${info.rem === 1 ? 'the 1 remaining segment' : `all ${info.rem} remaining segments`}`
            : info.reason === 'turnNeed'
              ? `turn limits along the ray leave zero spare capacity to reach ${info.rem} remaining segment${info.rem === 1 ? '' : 's'}`
              : `even/odd corridor parity along the ray pins the only odd-length segment`;
      return {
        nudge: `Look at the straight corridors and turns ${dirWord} from the ${arrow} clue at ${cn}.`,
        text: `Along the ${arrow} ray from ${cn}, ${why} — ${marks}.`,
      };
    }
    default:
      return null;
  }
}

export const castlewallVariant = {
  id: 'castlewall',
  name: 'Castle Wall',
  active: (P) => Boolean(P && P.hasCastle),
  compile: compileCastle,
  serialize: serializeCastle,
  parseToken: parseCastleToken,
  symmetry: symmetryCastle,
  rotateCW: rotateCastleCW,
  isSatisfied: isCastleSatisfied,
  propagateClue: propagateCastleClue,
  propagateParity: propagateCastleParity,
  clueStates: castleStates,
  autoX: autoXCastle,
  rules: CASTLE_RULES,
  explain: explainCastleStep,
  describeChainStep: describeCastleChainStep,
};
