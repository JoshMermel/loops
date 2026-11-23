// SVG Masyu board renderer and pointer gestures (intersection-grid layout).
//
// Coordinates: intersection (r, c) sits at (PAD + c*S, PAD + r*S). Grid tracks connect adjacent
// intersections; circles sit on intersections; drawn segments and small ✕ marks sit directly on tracks;
// dual squares sit between tracks and can be shaded Inside / Outside as a solving aid.
//
// Gestures (purely geometric):
//   * tap a grid track                -> handlers.onEdgeTap(edgeIdx)                   (cycle empty -> line -> ✕ -> empty)
//   * drag across intersections       -> handlers.onStep(fromNode, toNode, isFirst)    (draw/erase loop segments)
//   * right-click a grid track        -> handlers.onEdgeRight(edgeIdx)                 (toggle ✕ directly)
//   * right-drag across intersections -> handlers.onCrossStep(fromNode, toNode, first) (swipe-place/erase ✕)
//   * tap a square center             -> handlers.onFaceTap(faceIdx)                   (cycle blank -> Inside -> Outside -> blank)
//   * right-click a square center     -> handlers.onFaceRight(faceIdx)                 (cycle blank -> Outside -> Inside -> blank)
//   * tap an intersection center      -> no-op (prevents accidental marks)
// handlers.onStart() / handlers.onEnd(cancelled) bracket every gesture (1 undo step per gesture).
import { colName, edgeCells } from './logic.js';
import { makeColorKeeper, assignPathColors } from './pathcolors.js';
import { makeGrace } from './grace.js';
import { otherEnd } from './lineends.js';

export const CELL_SIZE = 44;
const S = CELL_SIZE;
const PAD = 24;        // breathing room around outer intersections for circles, rings, and highlights
export const LABEL = 16;
const EDGE_TOL = 0.26; // perpendicular hit tolerance around a grid track (fraction of S)
const END_DEAD = 0.13; // small neutral pivot right at an intersection crossroad (for clean drags out of a vertex)
const DRAG_SLOP_PX = 6; // ignore sub-6px pointer jitter before starting a drag
const BAD_DELAY_MS = 300;

const cellDist = (P, a, b) => (
  Math.abs(((a / P.cols) | 0) - ((b / P.cols) | 0))
  + Math.abs((a % P.cols) - (b % P.cols))
);

/**
 * Pure drag-gesture progression helper.
 * Supports both intersection-to-intersection drags and edge-to-edge swipes (e.g. pressing on A4-A5
 * and dragging to A5-A6 applies BOTH A4-A5 and A5-A6). Calls `step(fromCell, toCell, isFirst)`.
 */
export function advanceDrag(P, g, hit, step) {
  if (!hit) return;

  const fireEdge = (a, b, edgeIdx) => {
    g.dragged = true;
    step(a, b, g.firstStep);
    g.firstStep = false;
    g.lastEdge = edgeIdx;
  };

  const walkCells = (from, to) => {
    let cur = from, safety = 0;
    while (cur !== to && safety++ < 20) {
      const cr = (cur / P.cols) | 0, cc = cur % P.cols;
      const tr = (to / P.cols) | 0, tc = to % P.cols;
      const dr = tr - cr, dc = tc - cc;
      const nxt = Math.abs(dr) >= Math.abs(dc)
        ? (cr + Math.sign(dr)) * P.cols + cc
        : cr * P.cols + (cc + Math.sign(dc));
      let eIdx = -1;
      for (let d = 0; d < 4; d++) if (P.nb[cur * 4 + d] === nxt) { eIdx = P.ed[cur * 4 + d]; break; }
      fireEdge(cur, nxt, eIdx);
      cur = nxt;
    }
    g.curCell = cur;
  };

  if (!g.dragged) {
    if (g.startHit.kind === 'edge' && hit.kind === 'edge' && hit.edge === g.startHit.edge) return;
    if (g.startHit.kind === 'face' && hit.kind === 'face' && hit.face === g.startHit.face) return;
  }

  if (hit.kind === 'edge') {
    const e = hit.edge;
    if (g.dragged && e === g.lastEdge) return;
    const [a, b] = edgeCells(P, e);

    if (!g.dragged && g.startHit.kind === 'edge') {
      const [sa, sb] = edgeCells(P, g.startHit.edge);
      const dSa = Math.min(cellDist(P, sa, a), cellDist(P, sa, b));
      const dSb = Math.min(cellDist(P, sb, a), cellDist(P, sb, b));
      if (dSa < dSb) {
        fireEdge(sb, sa, g.startHit.edge);
        g.curCell = sa;
      } else {
        fireEdge(sa, sb, g.startHit.edge);
        g.curCell = sb;
      }
    }

    const near = cellDist(P, g.curCell, a) <= cellDist(P, g.curCell, b) ? a : b;
    const far = near === a ? b : a;
    if (g.curCell !== near) walkCells(g.curCell, near);
    fireEdge(near, far, e);
    g.curCell = far;
    return;
  }

  const targetCell = hit.cell;
  if (targetCell === g.curCell) return;

  if (!g.dragged && g.startHit.kind === 'edge') {
    const [sa, sb] = edgeCells(P, g.startHit.edge);
    if (cellDist(P, sa, targetCell) < cellDist(P, sb, targetCell)) {
      fireEdge(sb, sa, g.startHit.edge);
      g.curCell = sa;
    } else {
      fireEdge(sa, sb, g.startHit.edge);
      g.curCell = sb;
    }
    if (g.curCell === targetCell) return;
  }

  walkCells(g.curCell, targetCell);
}

/**
 * Pure hit-testing in lattice coordinates where intersection (r, c) is at (c*S, r*S).
 * Returns:
 *   - { kind: 'edge', edge, cell } when near a track midpoint
 *   - { kind: 'face', face, cell, edge: -1 } when inside the center of a dual square
 *   - { kind: 'cell', cell, edge: -1 } when near an intersection vertex (or outer margin)
 *   - null outside the board.
 */
export function hitTestCoords(P, gx, gy) {
  if (!P) return null;
  const maxX = (P.cols - 1) * S, maxY = (P.rows - 1) * S;
  const bound = S * 0.52;
  if (gx < -bound || gy < -bound || gx > maxX + bound || gy > maxY + bound) return null;

  const nc = Math.max(0, Math.min(P.cols - 1, Math.round(gx / S)));
  const nr = Math.max(0, Math.min(P.rows - 1, Math.round(gy / S)));
  const cell = nr * P.cols + nc;

  let bestEdge = -1, bestDist = EDGE_TOL * S;

  // Check nearest horizontal track: row nr, between col fc and fc+1
  const fc = Math.floor(gx / S);
  if (fc >= 0 && fc + 1 < P.cols) {
    const t = gx / S - fc;
    const dist = Math.abs(gy - nr * S);
    if (t > END_DEAD && t < 1 - END_DEAD && dist < bestDist) {
      bestDist = dist;
      bestEdge = 2 * (nr * P.cols + fc);
    }
  }

  // Check nearest vertical track: col nc, between row fr and fr+1
  const fr = Math.floor(gy / S);
  if (fr >= 0 && fr + 1 < P.rows) {
    const t = gy / S - fr;
    const dist = Math.abs(gx - nc * S);
    if (t > END_DEAD && t < 1 - END_DEAD && dist < bestDist) {
      bestDist = dist;
      bestEdge = 2 * (fr * P.cols + nc) + 1;
    }
  }

  if (bestEdge >= 0) return { kind: 'edge', edge: bestEdge, cell };

  // Check interior of a dual square (disjoint from track bands and intersection circles)
  if (fr >= 0 && fr + 1 < P.rows && fc >= 0 && fc + 1 < P.cols) {
    const fx = gx / S - fc, fy = gy / S - fr;
    if (fx >= EDGE_TOL && fx <= 1 - EDGE_TOL && fy >= EDGE_TOL && fy <= 1 - EDGE_TOL) {
      return { kind: 'face', face: fr * (P.cols - 1) + fc, cell, edge: -1 };
    }
  }

  return { kind: 'cell', cell, edge: -1 };
}

export class Board {
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers;
    this.P = null;
    this.gesture = null;
    this.hoverCell = -1;
    this.hoverEdge = -1;
    this.hoverFace = -1;
    this.opts = { colorLines: false, pathColors: null, pathAlike: null, markCircles: true };
    this.grace = makeGrace();
    this._badTimer = 0;
    this._graceNow = true;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', () => this.cancel());
    el.addEventListener('pointerleave', () => { if (!this.gesture) this.setHover(-1, -1, -1); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setPuzzle(P) {
    this.P = P;
    this.colors = null;
    this.grace.reset();
    clearTimeout(this._badTimer);
    this._graceNow = true;
  }

  setOptions(opts) {
    if (opts.pathColors && this.opts.pathColors && opts.pathColors.length !== this.opts.pathColors.length) {
      this.colors = null;
    }
    Object.assign(this.opts, opts);
    if (this.marks) this.render(this.marks, this.info, this.hint);
  }

  size() {
    if (!this.P) return { W: 0, H: 0 };
    return {
      W: (this.P.cols - 1) * S + 2 * PAD + LABEL,
      H: (this.P.rows - 1) * S + 2 * PAD + LABEL,
    };
  }

  analyseLines(marks) {
    const P = this.P;
    const deg = new Uint8Array(P.N);
    const onOnly = new Uint8Array(P.numEdges);
    const parent = new Int32Array(P.N);
    for (let i = 0; i < P.N; i++) parent[i] = i;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (let x = 0; x < P.numEdges; x++) {
      if (marks.edges[x] !== 1) continue;
      onOnly[x] = 1;
      const a = P.edgeA[x], b = P.edgeB[x];
      if (a < 0) continue;
      deg[a]++; deg[b]++;
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
    if (!this.colors || this.colors.birth.length !== P.numEdges) this.colors = makeColorKeeper(P.numEdges);
    const alike = this.opts.pathAlike;
    const near = alike ? { cols: P.cols, alike: (i, j) => alike[i][j] } : null;
    const colorOf = assignPathColors(this.colors, onOnly, (x) => find(P.edgeA[x]), (this.opts.pathColors || [0]).length, near);
    return { deg, colorOf, find };
  }

  render(marks, info, hint = null) {
    const P = this.P;
    if (!P) { this.el.innerHTML = ''; return; }
    this.marks = marks; this.info = info; this.hint = hint;

    const wanted = new Set();
    (info.clueState || []).forEach((st, k) => { if (st === 'bad') wanted.add(`c${k}`); });
    if (info.badFaces) for (const f of info.badFaces) wanted.add(`f${f}`);
    if (info.earlyLoops) for (const x of info.earlyLoops) wanted.add(`l${x}`);
    const { show, waiting, fresh } = this.grace.update(wanted, this._graceNow);
    this._graceNow = false;
    if (!waiting.size) clearTimeout(this._badTimer);
    else if (fresh) {
      clearTimeout(this._badTimer);
      this._badTimer = setTimeout(() => {
        this.grace.commit();
        if (this.marks) this.render(this.marks, this.info, this.hint);
      }, BAD_DELAY_MS);
    }

    const { W, H } = this.size();
    const vx = (c) => PAD + c * S;
    const vy = (r) => PAD + r * S;
    const ix = (i) => PAD + (i % P.cols) * S;
    const iy = (i) => PAD + ((i / P.cols) | 0) * S;
    const segCoords = (x) => {
      const [a, b] = edgeCells(P, x);
      return [ix(a), iy(a), ix(b), iy(b)];
    };

    const { deg, colorOf, find } = this.analyseLines(marks);
    const boardW = (P.cols - 1) * S + 2 * PAD;
    const boardH = (P.rows - 1) * S + 2 * PAD;

    let g = `<rect class="board-bg" x="1" y="1" width="${boardW - 2}" height="${boardH - 2}" rx="8"/>`;

    // Dual-face Inside / Outside shading (under grid lines and hint overlays)
    const fr = P.rows - 1, fc = P.cols - 1;
    if (marks.faces && fr > 0 && fc > 0) {
      for (let f = 0; f < fr * fc; f++) {
        const v = marks.faces[f];
        if (!v) continue;
        const r = (f / fc) | 0, c = f % fc;
        const cls = (v === 1 ? 'face-in' : 'face-out') + (marks.autoF && marks.autoF[f] ? ' auto' : '');
        g += `<rect class="${cls}" x="${vx(c)}" y="${vy(r)}" width="${S}" height="${S}"/>`;
        if (show.has(`f${f}`)) {
          g += `<rect class="face-bad" x="${vx(c) + 2.5}" y="${vy(r) + 2.5}" width="${S - 5}" height="${S - 5}" rx="3"/>`;
        }
      }
    }
    if (!this.gesture && this.hoverFace >= 0 && fr > 0 && fc > 0) {
      const r = (this.hoverFace / fc) | 0, c = this.hoverFace % fc;
      g += `<rect class="face-hover" x="${vx(c) + 3}" y="${vy(r) + 3}" width="${S - 6}" height="${S - 6}" rx="4"/>`;
    }

    // Hint dual-tile tints (centered on intersections, under the lattice tracks)
    if (hint) {
      if (hint.faces && fr > 0 && fc > 0) {
        for (const f of hint.faces.in || []) {
          const r = (f / fc) | 0, c = f % fc;
          g += `<rect class="hint-face-in" x="${vx(c) + 2}" y="${vy(r) + 2}" width="${S - 4}" height="${S - 4}" rx="4"/>`;
        }
        for (const f of hint.faces.out || []) {
          const r = (f / fc) | 0, c = f % fc;
          g += `<rect class="hint-face-out" x="${vx(c) + 2}" y="${vy(r) + 2}" width="${S - 4}" height="${S - 4}" rx="4"/>`;
        }
      }
      const tile = (i, cls, pad = 0) => `<rect class="${cls}" x="${ix(i) - S / 2 + pad}" y="${iy(i) - S / 2 + pad}" width="${S - 2 * pad}" height="${S - 2 * pad}" rx="${pad ? 8 : 0}"/>`;
      for (const i of hint.undecided || []) g += tile(i, 'hint-undecided', 2);
      const roles = hint.roles || {};
      for (const i of roles.area || []) g += tile(i, 'hint-area', 0);
      for (const role of ['clue', 'path', 'problem', 'focus']) {
        for (const i of roles[role] || []) g += tile(i, `hint-${role}`, 3);
      }
    }

    // Lattice tracks (horizontal and vertical lines connecting intersections)
    for (let r = 0; r < P.rows; r++) {
      g += `<line class="grid-line" x1="${vx(0)}" y1="${vy(r)}" x2="${vx(P.cols - 1)}" y2="${vy(r)}"/>`;
    }
    for (let c = 0; c < P.cols; c++) {
      g += `<line class="grid-line" x1="${vx(c)}" y1="${vy(0)}" x2="${vx(c)}" y2="${vy(P.rows - 1)}"/>`;
    }

    // Subtle anchor dots at empty intersections so the lattice vertices read crisply
    for (let i = 0; i < P.N; i++) {
      if (P.clue[i] || deg[i] > 0) continue;
      g += `<circle class="grid-dot" cx="${ix(i)}" cy="${iy(i)}" r="1.4"/>`;
    }

    // Branching error ring (deg > 2)
    for (let i = 0; i < P.N; i++) {
      if (deg[i] > 2) g += `<circle class="over" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.30}"/>`;
    }

    // White circle interior fills (below loop segments so segments clearly pass straight through)
    const rWhite = S * 0.21;
    const rBlack = S * 0.22;
    for (let k = 0; k < P.clues.length; k++) {
      const cl = P.clues[k];
      if (cl.t !== 'W') continue;
      const st = this.opts.markCircles && info.clueState[k] === 'bad' && show.has(`c${k}`) ? 'bad' : '';
      g += `<circle class="pearl-white-fill ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rWhite}"/>`;
    }

    // Drawn loop segments directly along the lattice tracks (with red highlight + glow on early-closed loops)
    const pc = this.opts.pathColors;
    for (let x = 0; x < P.numEdges; x++) {
      if (marks.edges[x] !== 1 || !show.has(`l${x}`)) continue;
      const [x1, y1, x2, y2] = segCoords(x);
      g += `<line class="seg-bad-halo" stroke-width="${S * 0.30}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }
    for (let x = 0; x < P.numEdges; x++) {
      if (marks.edges[x] !== 1) continue;
      const [x1, y1, x2, y2] = segCoords(x);
      const isBadLoop = show.has(`l${x}`);
      const a = P.edgeA[x];
      const style = !isBadLoop && this.opts.colorLines && pc
        ? ` style="stroke:${pc[colorOf.get(find(a)) % pc.length]}"`
        : '';
      g += `<line class="seg${isBadLoop ? ' bad' : ''}"${style} stroke-width="${S * 0.14}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }

    // Circle outlines (white) and solid discs (black) on intersections
    for (let k = 0; k < P.clues.length; k++) {
      const cl = P.clues[k];
      const st = this.opts.markCircles && info.clueState[k] === 'bad' && show.has(`c${k}`) ? 'bad' : '';
      if (cl.t === 'W') {
        g += `<circle class="pearl-white-ring ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rWhite}"/>`;
      } else {
        g += `<circle class="pearl-black ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rBlack}"/>`;
      }
    }

    // Small crisp ✕ marks on crossed-out lattice tracks (auto-placed ones are fainter)
    for (let x = 0; x < P.numEdges; x++) {
      if (marks.edges[x] !== 2) continue;
      const [x1, y1, x2, y2] = segCoords(x);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, d = S * 0.085;
      const path = `M${mx - d} ${my - d}L${mx + d} ${my + d}M${mx - d} ${my + d}L${mx + d} ${my - d}`;
      const autoCls = marks.autoE && marks.autoE[x] ? ' auto' : '';
      g += `<path class="edge-x-halo${autoCls}" d="${path}"/><path class="edge-x${autoCls}" d="${path}"/>`;
    }

    // Hint overlays
    if (hint) {
      const roles = hint.roles || {};
      const targets = hint.targets || {};
      for (const i of roles.exit || []) g += `<circle class="hint-exit" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.30}"/>`;
      for (const i of roles.focus || []) g += `<circle class="hint-focus-ring" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.32}"/>`;
      for (const x of hint.chain || []) {
        const [x1, y1, x2, y2] = segCoords(x);
        g += `<line class="chain-seg" stroke-width="${S * 0.11}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
      }
      for (const x of targets.segOn || []) {
        const [x1, y1, x2, y2] = segCoords(x);
        const len = Math.hypot(x2 - x1, y2 - y1), k = (S * 0.24) / len;
        g += `<line class="ghost-seg" stroke-width="${S * 0.14}" x1="${x1 + (x2 - x1) * k}" y1="${y1 + (y2 - y1) * k}" x2="${x2 - (x2 - x1) * k}" y2="${y2 - (y2 - y1) * k}"/>`;
      }
      for (const x of targets.segOff || []) {
        const [x1, y1, x2, y2] = segCoords(x);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, d = S * 0.11;
        const path = `M${mx - d} ${my - d}L${mx + d} ${my + d}M${mx - d} ${my + d}L${mx + d} ${my - d}`;
        g += `<path class="ghost-x-halo" d="${path}"/><path class="ghost-x" d="${path}"/>`;
      }
      for (const x of hint.wrongEdges || []) {
        const [x1, y1, x2, y2] = segCoords(x);
        g += `<line class="wrong-seg" stroke-width="${S * 0.2}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
      }
    }

    // Hover feedback (track midpoint highlight, or open line-end rings on degree-1 endpoints)
    if (!this.gesture) {
      if (this.hoverEdge >= 0) {
        const [x1, y1, x2, y2] = segCoords(this.hoverEdge);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        g += `<circle class="edge-hover" cx="${mx}" cy="${my}" r="${S * 0.16}"/>`;
      } else if (this.hoverCell >= 0 && deg[this.hoverCell] === 1) {
        const far = otherEnd(P, marks.edges, this.hoverCell);
        if (far >= 0) {
          for (const i of [this.hoverCell, far]) {
            g += `<circle class="line-end-halo" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.18}"/>`;
            g += `<circle class="line-end" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.18}"/>`;
          }
        }
      }
    }

    // Axis labels aligned directly with the grid lines
    const hc = !this.gesture && this.hoverCell >= 0 ? this.hoverCell % P.cols : -1;
    const hr = !this.gesture && this.hoverCell >= 0 ? (this.hoverCell / P.cols) | 0 : -1;
    let labels = '';
    for (let c = 0; c < P.cols; c++) {
      labels += `<text class="axis-label${c === hc ? ' here' : ''}" x="${LABEL + vx(c)}" y="${LABEL - 3}">${colName(c)}</text>`;
    }
    for (let r = 0; r < P.rows; r++) {
      labels += `<text class="axis-label side${r === hr ? ' here' : ''}" x="${LABEL - 4}" y="${LABEL + vy(r)}">${r + 1}</text>`;
    }

    const defs = `<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-bg" width="8" height="8"/><line class="hatch-line" x1="0" y1="0" x2="0" y2="8" stroke-width="3"/></pattern></defs>`;
    this.el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${defs}${labels}<g transform="translate(${LABEL} ${LABEL})">${g}</g></svg>`;
  }

  // ---- pointer handling

  hitFromEvent(e) {
    const svg = this.el.querySelector('svg');
    if (!svg || !this.P) return null;
    const rect = svg.getBoundingClientRect();
    const { W, H } = this.size();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const sy = ((e.clientY - rect.top) / rect.height) * H;
    return hitTestCoords(this.P, sx - LABEL - PAD, sy - LABEL - PAD);
  }

  setHover(cell, edge, face = -1) {
    if (this.hoverCell === cell && this.hoverEdge === edge && this.hoverFace === face) return;
    this.hoverCell = cell;
    this.hoverEdge = edge;
    this.hoverFace = face;
    if (this.marks) this.render(this.marks, this.info, this.hint);
  }

  down(e) {
    if (!this.P || e.button === 1) return;
    const hit = this.hitFromEvent(e);
    if (!hit) return;
    e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.h.onStart();
    this.gesture = {
      id: e.pointerId,
      right: e.button === 2,
      startHit: hit,
      startX: e.clientX,
      startY: e.clientY,
      curCell: hit.cell,
      dragged: false,
      firstStep: true,
      lastEdge: -1,
    };
  }

  move(e) {
    if (!this.P) return;
    const hit = this.hitFromEvent(e);
    if (!this.gesture) {
      if (!hit) this.setHover(-1, -1, -1);
      else if (hit.kind === 'face') this.setHover(-1, -1, hit.face);
      else this.setHover(hit.cell, hit.kind === 'edge' ? hit.edge : -1, -1);
      return;
    }
    if (e.pointerId !== this.gesture.id || !hit) return;
    if (!this.gesture.dragged && Math.hypot(e.clientX - this.gesture.startX, e.clientY - this.gesture.startY) < DRAG_SLOP_PX) {
      return;
    }
    const step = this.gesture.right
      ? (a, b, first) => this.h.onCrossStep(a, b, first)
      : (a, b, first) => this.h.onStep(a, b, first);
    advanceDrag(this.P, this.gesture, hit, step);
  }

  up(e) {
    if (!this.gesture || e.pointerId !== this.gesture.id) return;
    const g = this.gesture;
    this.gesture = null;
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!g.dragged) {
      if (g.startHit.kind === 'edge') {
        if (g.right) this.h.onEdgeRight(g.startHit.edge);
        else this.h.onEdgeTap(g.startHit.edge);
      } else if (g.startHit.kind === 'face') {
        if (g.right) this.h.onFaceRight?.(g.startHit.face);
        else this.h.onFaceTap?.(g.startHit.face);
      }
    }
    this.h.onEnd(false);
  }

  cancel() {
    if (!this.gesture) return;
    this.gesture = null;
    this.h.onEnd(true);
  }
}
