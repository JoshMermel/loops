// App controller: books, deep links, marks, undo/redo, persistence, Correct-so-far, Hint, Browse, Settings, Print.
import {
  compile, parseCsv, puzzleHash, isSolved, decodeSolution, WHITE, BLACK,
} from './logic.js';
import { TIER_INFO, beyondHints } from './rating.js';
import { computeHint, advanceHint, checkMarksAgainstSolution } from './hintstep.js';
import { ROLES, describeMarks } from './explain.js';
import {
  cycleEdgeMark, toggleEdgeCross, cycleFaceMark, cycleFaceMarkReverse, numFacesOf, setFaceGroup,
  cycleGrayLabel, cycleGrayLabelReverse, reconcileAutoGray,
  reconcileAutoX, applyAutoX, reconcileAutoShade, applyAutoShade, shadeConflicts,
  facesFromSolvedLoop,
} from './marks.js';
import { clueStates, earlyLoopEdges, trappedFullCells } from './clues.js';
import { Board, CELL_SIZE } from './board.js';
import { rotatePuzzleCW, rotateMarksCW, unrotateMarksCW, chooseLayout } from './rotate.js';
import {
  PRESETS, CUSTOM, MIN_CUSTOM, MAX_CUSTOM, sanitizeCustom, validId,
  lightColors, resolvePalette, eyesOf, alikeMatrix,
} from './palettes.js';
import { parseSelection, planPrint, buildPrintRoot } from './print.js';
import {
  isOfflineSupported, getOfflineStatus, enableOffline, disableOffline, syncMissingBooks,
} from './offline.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const state = {
  books: [],
  groups: [],
  loaded: new Map(),
  book: null,
  idx: 0,
  baseP: null,
  rotP: null,
  rotated: false,
  rotOverride: null, // null = auto, true = forced rotated, false = forced canonical
  P: null,
  marks: null,
  undo: [],
  redo: [],
  pending: null,
  dragStack: [],
  drawMode: 1,
  solved: false,
  hint: null, // { sig, kind, index, hints, ... }
};

const savedCustom = (() => { try { return sanitizeCustom(JSON.parse(store.get('ms_pathCustom'))); } catch { return null; } })();
const settings = {
  colorLines: store.get('ms_colorLines') === '1',
  palette: validId(store.get('ms_pathPalette'), savedCustom),
  custom: savedCustom,
  autoX: store.get('ms_autoX') !== '0',
  autoShade: store.get('ms_autoShade') !== '0',
  incrementalHints: store.get('ms_incrementalHints') !== '0',
};

const board = new Board($('board'), {
  onStart: () => { state.pending = snapshot(); state.dragStack = []; },
  onBeginDrag: () => { if (state.pending) state.marks = cloneMarks(state.pending); state.dragStack = []; },
  onEdgeTap: (edge) => cycleEdge(edge),
  onEdgeRight: (edge) => toggleEdge(edge),
  onCellTap: (cell) => cycleGray(cell, false),
  onCellRight: (cell) => cycleGray(cell, true),
  onFaceTap: (face) => cycleFace(face, false),
  onFaceRight: (face) => cycleFace(face, true),
  onFaceDrag: (face) => paintFaceStep(face),
  onStep: (a, b, first) => dragStep(a, b, first),
  onCrossStep: (a, b, first) => crossStep(a, b, first),
  onUndoStep: () => undoDragStep(),
  onEnd: (cancelled) => endGesture(cancelled),
});

const themeName = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
const pathColors = () => resolvePalette(settings.palette, settings.custom, themeName());
const paletteOptions = () => {
  const list = pathColors();
  return { pathColors: list, pathAlike: alikeMatrix(list, eyesOf(settings.palette)) };
};
board.setOptions({ colorLines: settings.colorLines, ...paletteOptions() });

// ------------------------------------------------------------ marks & undo

const isGivenEdge = (P, x) => Boolean(P && P.hasGivens && P.givenE[x] !== 0);

const emptyMarks = (P) => {
  const edges = new Uint8Array(P.numEdges);
  if (P.hasGivens) {
    for (const gv of P.givens) edges[gv.edge] = gv.v ? 1 : 2;
  }
  return {
    edges,
    autoE: new Uint8Array(P.numEdges),
    faces: new Uint8Array(numFacesOf(P)),
    autoF: new Uint8Array(numFacesOf(P)),
    grays: new Uint8Array(P.grays ? P.grays.length : 0),
    autoG: new Uint8Array(P.grays ? P.grays.length : 0),
  };
};
const freshMarks = (P) => {
  const m = emptyMarks(P);
  reconcileAuto(P, m);
  return m;
};
const cloneMarks = (m) => ({
  edges: m.edges.slice(),
  autoE: m.autoE.slice(),
  faces: m.faces.slice(),
  autoF: m.autoF.slice(),
  grays: m.grays.slice(),
  autoG: m.autoG.slice(),
});
const snapshot = () => cloneMarks(state.marks);
const sameMarks = (a, b) => (
  a.edges.every((v, i) => v === b.edges[i])
  && a.autoE.every((v, i) => v === b.autoE[i])
  && a.faces.every((v, i) => v === b.faces[i])
  && a.autoF.every((v, i) => v === b.autoF[i])
  && a.grays.every((v, i) => v === b.grays[i])
  && a.autoG.every((v, i) => v === b.autoG[i])
);
const isPristine = (m, P = state.P) => (
  m.edges.every((v, x) => isGivenEdge(P, x) || v === 0 || (v === 2 && m.autoE[x]))
  && m.faces.every((v, f) => v === 0 || m.autoF[f])
  && m.grays.every((v, k) => v === 0 || m.autoG[k])
);

function edgeBetween(P, a, b) {
  for (let d = 0; d < 4; d++) if (P.nb[a * 4 + d] === b) return P.ed[a * 4 + d];
  return -1;
}

const reconcileAuto = (P, m) => {
  reconcileAutoGray(P, m);
  reconcileAutoX(P, m, settings.autoX, { useShade: settings.autoShade });
  reconcileAutoShade(P, m, settings.autoShade);
};

const isAutoX = (m, x) => m.edges[x] === 2 && !!m.autoE[x];

function cycleGray(cell, reverse = false) {
  const P = state.P, m = state.marks;
  const k = P.grayAt ? P.grayAt[cell] : -1;
  if (k < 0 || (m.grays[k] && m.autoG[k])) return;
  m.grays[k] = reverse ? cycleGrayLabelReverse(m.grays[k]) : cycleGrayLabel(m.grays[k]);
  m.autoG[k] = 0;
  reconcileAuto(P, m);
  refresh();
}

function cycleEdge(x) {
  const P = state.P, m = state.marks;
  if (x < 0 || P.edgeA[x] < 0 || isAutoX(m, x) || isGivenEdge(P, x)) return;
  m.edges[x] = cycleEdgeMark(m.edges[x]);
  m.autoE[x] = 0;
  reconcileAuto(P, m);
  refresh();
}

function toggleEdge(x) {
  const P = state.P, m = state.marks;
  if (x < 0 || P.edgeA[x] < 0 || isAutoX(m, x) || isGivenEdge(P, x)) return;
  m.edges[x] = toggleEdgeCross(m.edges[x]);
  m.autoE[x] = 0;
  reconcileAuto(P, m);
  refresh();
}

function cycleFace(f, reverse = false) {
  const P = state.P, m = state.marks;
  if (f < 0 || f >= m.faces.length || (P.hasVoids && P.faceExterior[f]) || (m.faces[f] && m.autoF[f])) {
    state.facePaintVal = null;
    return;
  }
  const next = reverse ? cycleFaceMarkReverse(m.faces[f]) : cycleFaceMark(m.faces[f]);
  setFaceGroup(P, m, f, next, 0);
  state.facePaintVal = next;
  reconcileAuto(P, m);
  refresh();
}

function paintFaceStep(f) {
  const P = state.P, m = state.marks;
  const val = state.facePaintVal;
  if (val === null || val === undefined || f < 0 || f >= m.faces.length) return;
  if (P.hasVoids && P.faceExterior[f]) return;
  if (m.faces[f] && m.autoF[f]) return;
  if (m.faces[f] === val) return;
  setFaceGroup(P, m, f, val, 0);
  reconcileAuto(P, m);
  refresh();
}

function dragStep(a, b, first) {
  const P = state.P, m = state.marks;
  state.dragStack.push(snapshot());
  const x = edgeBetween(P, a, b);
  if (x < 0 || isGivenEdge(P, x)) {
    if (first && isGivenEdge(P, x)) state.drawMode = m.edges[x] === 1 ? 1 : 0;
    return;
  }
  if (first) state.drawMode = m.edges[x] === 1 ? 0 : 1;
  if (state.drawMode === 1) {
    // Don't draw across crossed-out edges
    if (m.edges[x] === 2) return;
    m.edges[x] = 1;
    m.autoE[x] = 0;
  } else if (m.edges[x] === 1) {
    m.edges[x] = 0;
    m.autoE[x] = 0;
  } else {
    return;
  }
  reconcileAuto(P, m);
  refresh();
}

function crossStep(a, b, first) {
  const P = state.P, m = state.marks;
  state.dragStack.push(snapshot());
  const x = edgeBetween(P, a, b);
  if (x < 0 || isAutoX(m, x) || isGivenEdge(P, x)) {
    if (first) state.drawMode = null;
    return;
  }
  if (first) state.drawMode = m.edges[x] === 2 ? 0 : 2;
  if (state.drawMode === null) return;
  if (state.drawMode === 2) {
    // Don't overwrite drawn loop segments during a right-drag cross swipe
    if (m.edges[x] === 1) return;
    m.edges[x] = 2;
    m.autoE[x] = 0;
  } else if (m.edges[x] === 2) {
    m.edges[x] = 0;
    m.autoE[x] = 0;
  } else {
    return;
  }
  reconcileAuto(P, m);
  refresh();
}

function undoDragStep() {
  if (!state.dragStack.length) return;
  state.marks = state.dragStack.pop();
  refresh();
}

function endGesture(cancelled) {
  const before = state.pending;
  state.pending = null;
  state.dragStack = [];
  state.facePaintVal = null;
  if (!before) return;
  if (cancelled) { state.marks = before; refresh(); return; }
  if (!sameMarks(before, state.marks)) {
    state.undo.push(before);
    state.redo = [];
    save();
  }
  if (state.solved) markSolved();
  updateButtons();
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  state.marks = state.undo.pop();
  save(); refresh();
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  state.marks = state.redo.pop();
  save(); refresh();
}

function reset() {
  if (isPristine(state.marks)) return;
  state.undo.push(snapshot());
  state.redo = [];
  state.marks = freshMarks(state.P);
  save(); refresh();
}

// ------------------------------------------------------------ board refresh & fit

function analyse() {
  return {
    clueState: state.solved ? state.P.clues.map(() => '') : clueStates(state.P, state.marks),
    badFaces: state.solved ? new Set() : shadeConflicts(state.P, state.marks, settings.autoShade),
    earlyLoops: earlyLoopEdges(state.P, state.marks),
    trappedCells: state.solved ? new Set() : trappedFullCells(state.P, state.marks),
  };
}

function viewportSpace() {
  const availW = Math.min(window.innerWidth - 24, 1500);
  const wrap = $('board').parentElement;
  const top = wrap ? wrap.getBoundingClientRect().top + window.scrollY : 180;
  const availH = Math.max(0, window.innerHeight - top - 20);
  return { availW, availH };
}

function applyBoardSize(px) {
  const width = Math.round((board.size().W * px) / CELL_SIZE);
  $('board').style.width = `${width}px`;
  $('game-container').style.maxWidth = `${Math.max(640, width + 24)}px`;
}

function fitBoard() {
  const baseP = state.baseP;
  if (!baseP) return;
  const { availW, availH } = viewportSpace();
  const layout = chooseLayout(baseP.rows, baseP.cols, availW, availH, state.rotOverride);
  if (layout.rotated !== state.rotated) {
    if (board.gesture) board.cancel();
    const xf = layout.rotated
      ? (m) => rotateMarksCW(baseP, state.rotP, m)
      : (m) => unrotateMarksCW(baseP, state.rotP, m);
    state.marks = xf(state.marks);
    state.undo = state.undo.map(xf);
    state.redo = state.redo.map(xf);
    state.rotated = layout.rotated;
    state.P = state.rotated ? state.rotP : baseP;
    state.hint = null;
    hideToast();
    board.setPuzzle(state.P);
    showInfo();
    board.render(state.marks, analyse());
  }
  applyBoardSize(layout.px);
}
window.addEventListener('resize', fitBoard);

function toggleTurn() {
  const baseP = state.baseP;
  if (!baseP || baseP.rows === baseP.cols) return;
  state.rotOverride = !state.rotated;
  fitBoard();
}

function paintSolvedFaces(P, m) {
  const exactFaces = facesFromSolvedLoop(P, m.edges);
  for (let f = 0; f < exactFaces.length; f++) {
    if (m.faces[f] !== exactFaces[f] || m.autoF[f]) {
      m.faces[f] = exactFaces[f];
      m.autoF[f] = 1;
    }
  }
}

function refresh() {
  state.hint = null;
  hideToast();
  const solved = isSolved(state.P, state.marks.edges);
  if (solved) {
    // Only auto-paint on win/reopen when Auto-Shade is ON (so manual/inverted color schemes are never touched)
    if (settings.autoShade) paintSolvedFaces(state.P, state.marks);
    if (!state.solved && !board.gesture) markSolved();
  }
  state.solved = solved;
  board.render(state.marks, analyse());
  $('board').classList.toggle('solved', solved);
  $('status').textContent = solved ? 'Solved!' : '';
  $('status').classList.toggle('solved', solved);
  updateButtons();
}

function updateButtons() {
  $('undo-btn').disabled = !state.undo.length;
  $('redo-btn').disabled = !state.redo.length;
  $('reset-btn').disabled = isPristine(state.marks);
}

// ------------------------------------------------------------ persistence

const saveKey = (P) => `ms_save_${puzzleHash(P)}`;
const hasSave = (P) => store.get(saveKey(P)) !== null;

function save() {
  const baseP = state.baseP, m = state.marks;
  if (isPristine(m)) { store.del(saveKey(baseP)); return; }
  const canon = state.rotated ? unrotateMarksCW(baseP, state.rotP, m) : m;
  const payload = {
    e: Array.from(canon.edges).join(''),
    ae: Array.from(canon.autoE).join(''),
    f: Array.from(canon.faces).join(''),
    af: Array.from(canon.autoF).join(''),
  };
  if (canon.grays && canon.grays.length) {
    payload.g = Array.from(canon.grays).join('');
    payload.ag = Array.from(canon.autoG).join('');
  }
  store.set(saveKey(baseP), JSON.stringify(payload));
}

function load(P) {
  try {
    const s = JSON.parse(store.get(saveKey(P)) || 'null');
    if (s && s.e && s.e.length === P.numEdges) {
      const m = emptyMarks(P);
      for (let x = 0; x < P.numEdges; x++) m.edges[x] = P.edgeA[x] >= 0 ? +s.e[x] : 0;
      if (s.ae && s.ae.length === P.numEdges) {
        for (let x = 0; x < P.numEdges; x++) m.autoE[x] = P.edgeA[x] >= 0 ? +s.ae[x] : 0;
      }
      const F = m.faces.length;
      if (s.f && s.f.length === F) {
        for (let f = 0; f < F; f++) m.faces[f] = +s.f[f];
      }
      if (s.af && s.af.length === F) {
        for (let f = 0; f < F; f++) m.autoF[f] = +s.af[f];
      }
      const G = m.grays.length;
      if (G && s.g && s.g.length === G) {
        for (let k = 0; k < G; k++) m.grays[k] = +s.g[k];
      }
      if (G && s.ag && s.ag.length === G) {
        for (let k = 0; k < G; k++) m.autoG[k] = +s.ag[k];
      }
      if (P.hasGivens) {
        for (const gv of P.givens) { m.edges[gv.edge] = gv.v ? 1 : 2; m.autoE[gv.edge] = 0; }
      }
      reconcileAutoGray(P, m);
      applyAutoX(P, m, settings.autoX, { useShade: settings.autoShade });
      applyAutoShade(P, m, settings.autoShade);
      if (settings.autoShade && isSolved(P, m.edges)) paintSolvedFaces(P, m);
      return m;
    }
  } catch { /* corrupt save */ }
  return freshMarks(P);
}

const solvedSet = () => { try { return new Set(JSON.parse(store.get('ms_solved') || '[]')); } catch { return new Set(); } };
const bookSolvedMap = () => {
  try {
    const o = JSON.parse(store.get('ms_book_solved') || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
};

function recordBookSolved(book) {
  if (!book) return;
  const solved = solvedSet();
  const n = book.puzzles.filter((p) => solved.has(puzzleHash(p))).length;
  const map = bookSolvedMap();
  map[book.id] = n;
  store.set('ms_book_solved', JSON.stringify(map));
}

function markSolved() {
  const set = solvedSet();
  set.add(puzzleHash(state.P));
  store.set('ms_solved', JSON.stringify([...set]));
  recordBookSolved(state.book);
}

// ------------------------------------------------------------ toasts, check, hint

let toastTimer = 0;
function retireToast(el) {
  // Keep space reserved for an in-page hint toast so dismissing it doesn't shift the board under the pointer
  if (el.classList.contains('below') && !el.hidden) el.classList.add('ghost');
  else el.hidden = true;
}
function hideToast() {
  clearTimeout(toastTimer);
  const el = $('toast');
  if (el.classList.contains('hint')) retireToast(el);
  else { el.hidden = true; el.classList.remove('ghost'); }
}
function dropToast() {
  clearTimeout(toastTimer);
  const el = $('toast');
  el.hidden = true;
  el.className = 'toast';
  el.innerHTML = '';
}
function dismissToast() {
  const el = $('toast');
  if (el.hidden || el.classList.contains('ghost')) return;
  clearTimeout(toastTimer);
  retireToast(el);
  if (state.hint && state.hint.visible) {
    state.hint.visible = false;
    board.render(state.marks, analyse());
  }
}

function toast(msg, ms = 3200) {
  clearTimeout(toastTimer);
  const el = $('toast');
  el.className = 'toast';
  el.textContent = msg;
  el.hidden = false;
  toastTimer = setTimeout(dismissToast, ms);
}

// Clicking anywhere on the page dismisses an open toast (Hint button is exempt so clicking Hint again advances/cycles)
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#hint-btn')) dismissToast();
}, true);
$('toast').addEventListener('click', dismissToast);

function checkSoFar() {
  if (!state.P) return;
  dismissToast();
  if (state.solved) { toast('Solved!'); return; }
  if (!state.P.solution) { toast('No stored solution to check against.'); return; }
  const { total } = checkMarksAgainstSolution(state.P, state.marks);
  if (total === 0) toast('So far so good!');
  else toast(`${total} mark${total === 1 ? ' is' : 's are'} incorrect.`);
}

const ROLE_COLORS = {
  clue: 'var(--hint-clue)',
  area: 'var(--hint-range)',
  focus: 'var(--hint-focus)',
  problem: 'var(--hint-problem)',
  exit: 'var(--color-solved)',
  path: 'var(--hint-path)',
  faceIn: 'var(--face-in)',
  faceOut: 'var(--face-out)',
};

function showHintToast(meta, text, extraLine, usedRoles, faceLabels = null) {
  clearTimeout(toastTimer);
  const el = $('toast');
  el.className = 'toast hint below';
  el.innerHTML = '';

  const m = document.createElement('div');
  m.className = 'hint-meta';
  m.textContent = meta;
  el.append(m);

  const body = document.createElement('div');
  body.textContent = text;
  el.append(body);

  if (extraLine) {
    const more = document.createElement('div');
    more.className = 'hint-more';
    more.textContent = extraLine;
    el.append(more);
  }

  const legendItems = (usedRoles || []).map((r) => [ROLE_COLORS[r] || 'var(--hint-focus)', ROLES[r] || r]);
  if (faceLabels) {
    if (faceLabels.hasIn) legendItems.push([ROLE_COLORS.faceIn, faceLabels.inLabel]);
    if (faceLabels.hasOut) legendItems.push([ROLE_COLORS.faceOut, faceLabels.outLabel]);
  }
  if (legendItems.length) {
    const leg = document.createElement('div');
    leg.className = 'hint-legend';
    for (const [bg, lbl] of legendItems) {
      const item = document.createElement('span');
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.background = bg;
      item.append(chip, lbl);
      leg.append(item);
    }
    el.append(leg);
  }

  el.hidden = false;
}

function hint(opts = {}) {
  if (!state.P) return;
  if (state.solved) { toast('Already solved!'); return; }

  state.hint = advanceHint(state.hint, () => computeHint(state.P, state.marks), { full: !settings.incrementalHints, ...opts });
  const h = state.hint;

  if (h.kind === 'wrong') {
    board.render(state.marks, analyse(), { wrongEdges: h.wrongEdges, wrongClues: h.wrongClues });
    const msg = h.fromShade
      ? 'Auto-X crossed out a required segment because of a conflicting Inside/Outside shade (highlighted in red). Fix or undo your shaded squares first.'
      : h.contradiction
        ? 'The current marks lead to a contradiction. Fix or undo a recent move first.'
        : `${h.total} mark${h.total === 1 ? '' : 's'} (highlighted in red) disagree${h.total === 1 ? 's' : ''} with the solution. Fix or undo ${h.total === 1 ? 'it' : 'them'} first.`;
    showHintToast('Mistake found', msg, null, []);
    return;
  }

  if (h.kind === 'stuck') {
    board.render(state.marks, analyse(), { undecided: h.undecided });
    showHintToast(
      'Solver stuck',
      'None of the hint rules can find a next step here (tinted cells still have undecided edges).',
      null,
      [],
    );
    return;
  }

  renderCurrentHint();
}

function renderCurrentHint() {
  const h = state.hint;
  const item = h.hints[h.index];
  const full = h.stage >= 2;
  const roles = full ? item.roles : item.nudgeRoles;
  board.render(state.marks, analyse(), full
    ? { roles, targets: item.targets, chain: item.chain, faces: item.faces }
    : { roles });
  const usedRoles = Object.keys(roles).filter((k) => roles[k].length > 0);
  const faceLabels = full && item.faces && (item.faces.in.length || item.faces.out.length)
    ? {
        hasIn: item.faces.in.length > 0,
        hasOut: item.faces.out.length > 0,
        inLabel: item.faces.anchored ? 'Inside' : 'Side A',
        outLabel: item.faces.anchored ? 'Outside' : 'Side B',
      }
    : null;
  const count = h.hints.length > 1 ? ` · ${h.index + 1}/${h.hints.length}` : '';
  if (!full) {
    const meta = `${h.tier} · ${h.rule}${count} · where to look`;
    showHintToast(meta, item.nudge, 'Press Hint again for the full deduction.', usedRoles, null);
    return;
  }
  const meta = `${h.tier} · ${h.rule} (cost ${h.weight})${count}`;
  const move = describeMarks(state.P, item.targets);
  const more = h.hints.length > 1
    ? `Move: ${move}. Press Hint again for another firing of ${h.rule}.`
    : `Move: ${move}.`;
  showHintToast(meta, item.text, more, usedRoles, faceLabels);
}

// ------------------------------------------------------------ books & navigation

async function fetchBook(entry) {
  if (entry.puzzles) return entry.puzzles;
  if (state.loaded.has(entry.id)) return state.loaded.get(entry.id);
  const res = await fetch(entry.file);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const raw = parseCsv(text);
  if (!raw.length) throw new Error('empty book');
  state.loaded.set(entry.id, raw);
  return raw;
}

function updateUrl() {
  if (!state.book) return;
  const url = new URL(location.href);
  url.searchParams.set('book', state.book.id);
  url.searchParams.set('puzzle', String(state.idx + 1));
  history.replaceState(null, '', url.pathname + url.search);
}

function showInfo() {
  const P = state.P;
  const full = P.fullBoard ? ' · Full board' : '';
  const tier = P.tier ? ` · ${P.tier}` : '';
  const extra = beyondHints(P) ? ' (beyond hints)' : '';
  const info = $('puz-info');
  info.textContent = `${P.name} · ${P.cols}×${P.rows}${full}${tier}${extra}`;
  info.title = P.tier && TIER_INFO[P.tier] ? `${P.tier}: ${TIER_INFO[P.tier].blurb}` : '';
}

function openPuzzle(idx) {
  const book = state.book;
  if (!book || !book.puzzles.length) return;
  if (board.gesture) board.cancel();
  idx = Math.max(0, Math.min(Math.trunc(idx) || 0, book.puzzles.length - 1));
  state.idx = idx;
  const raw = book.puzzles[idx];
  const baseP = raw.N ? raw : compile(raw);
  book.puzzles[idx] = baseP;
  state.baseP = baseP;
  state.rotP = baseP.rows !== baseP.cols ? rotatePuzzleCW(baseP) : null;

  $('turn-btn').hidden = baseP.rows === baseP.cols;
  $('puz-num').value = idx + 1;
  $('puz-num').max = book.puzzles.length;
  $('puz-total').textContent = book.puzzles.length;
  $('prev-puz').disabled = idx === 0;
  $('next-puz').disabled = idx === book.puzzles.length - 1;

  dropToast();
  const { availW, availH } = viewportSpace();
  const layout = chooseLayout(baseP.rows, baseP.cols, availW, availH, state.rotOverride);
  state.rotated = layout.rotated;
  state.P = state.rotated ? state.rotP : baseP;
  const canonMarks = load(baseP);
  state.marks = state.rotated ? rotateMarksCW(baseP, state.rotP, canonMarks) : canonMarks;
  state.undo = [];
  state.redo = [];
  state.hint = null;
  state.solved = isSolved(state.P, state.marks.edges);

  board.setPuzzle(state.P);
  applyBoardSize(layout.px);
  showInfo();
  refresh();
  store.set('ms_last', JSON.stringify({ book: book.id, idx }));
  updateUrl();
}

let openBookSeq = 0;
async function openBook(bookId, idx = 0) {
  const entry = state.books.find((b) => b.id === bookId);
  if (!entry) return;
  const seq = ++openBookSeq;
  let raw;
  try {
    raw = await fetchBook(entry);
  } catch {
    if (seq === openBookSeq) {
      toast(navigator.onLine === false
        ? `You're offline — "${entry.name}" isn't saved for offline play.`
        : `Could not load "${entry.name}".`);
    }
    return;
  }
  if (seq !== openBookSeq) return;
  state.book = { id: entry.id, name: entry.name, puzzles: raw };
  state.rotOverride = null;
  recordBookSolved(state.book);
  syncBookButton();
  openPuzzle(idx);
}

function rememberFileBook(name, text) { store.set('ms_file_book', JSON.stringify({ name, text })); }
function restoreFileBook() {
  try {
    const f = JSON.parse(store.get('ms_file_book') || 'null');
    const puzzles = f && parseCsv(f.text);
    if (puzzles && puzzles.length) state.books.push({ id: `file:${f.name}`, name: f.name, puzzles, count: puzzles.length });
  } catch { /* ignore */ }
}

async function init() {
  let manifest = { books: [], groups: [] };
  try { manifest = await (await fetch('data/manifest.json')).json(); } catch { /* ignore */ }
  state.books = manifest.books || [];
  state.groups = manifest.groups || [];
  restoreFileBook();
  syncBookButton();
  syncOfflineUI();
  if (!state.books.length) { $('puz-info').textContent = 'No puzzle books found.'; return; }

  const params = new URLSearchParams(location.search);
  let last = null;
  try { last = JSON.parse(store.get('ms_last') || 'null'); } catch { /* ignore */ }
  let bookId = params.get('book') || (last && last.book) || manifest.default || state.books[0].id;
  const known = state.books.some((b) => b.id === bookId);
  if (!known) bookId = manifest.default || state.books[0].id;
  const idx = !known ? 0 : params.has('puzzle') ? +params.get('puzzle') - 1 : (last && last.book === bookId ? last.idx : 0);
  await openBook(bookId, Number.isFinite(idx) ? idx : 0);
  queueBackgroundSync();
}

// ------------------------------------------------------------ UI wiring & modals

const step = (d) => { if (!state.book) return; const j = state.idx + d; if (j >= 0 && j < state.book.puzzles.length) openPuzzle(j); };
$('prev-puz').addEventListener('click', () => step(-1));
$('next-puz').addEventListener('click', () => step(1));
$('puz-num').addEventListener('change', (e) => { if (state.book) openPuzzle((+e.target.value || 1) - 1); });
$('undo-btn').addEventListener('click', undo);
$('redo-btn').addEventListener('click', redo);
$('reset-btn').addEventListener('click', reset);
$('turn-btn').addEventListener('click', toggleTurn);
$('check-btn').addEventListener('click', checkSoFar);
$('hint-btn').addEventListener('click', () => hint());

const modals = [];
const modalOpen = () => modals.some(({ modal }) => !modal.classList.contains('modal-hidden'));
const syncModalInert = () => {
  const open = modalOpen();
  for (const child of $('game-container').children) {
    if (child.id !== 'toast') child.inert = open;
  }
};
function setupModal(modalId, openBtnId, onOpen, returnFocusId = openBtnId) {
  const modal = $(modalId), openBtn = $(openBtnId);
  modal.inert = true;
  modal.setAttribute('aria-hidden', 'true');
  const close = () => {
    modal.classList.add('modal-hidden');
    modal.inert = true;
    modal.setAttribute('aria-hidden', 'true');
    syncModalInert();
    $(returnFocusId).focus();
  };
  const open = () => {
    onOpen?.();
    modal.inert = false;
    modal.removeAttribute('aria-hidden');
    modal.classList.remove('modal-hidden');
    syncModalInert();
    modal.querySelector('[data-close]').focus();
  };
  openBtn.addEventListener('click', open);
  modal.querySelector('[data-close]').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modals.push({ modal, close });
  return { open, close };
}

// ---- Browse grid
function renderBrowse() {
  const book = state.book;
  if (!book) return;
  const solved = solvedSet();
  const isDone = (P) => solved.has(puzzleHash(P));
  const grid = $('browse-grid');
  grid.textContent = '';
  const doneCount = book.puzzles.filter(isDone).length;
  $('browse-summary').textContent = `${book.name}: ${doneCount} of ${book.puzzles.length} solved`;

  const TIER_ORDER = ['Beginner', 'Medium', 'Hard', 'Expert', 'Expert+ (beyond hints)'];
  const tierLabel = (P) => (beyondHints(P) ? 'Expert+ (beyond hints)' : P.tier);
  const inOrder = (vals) => new Set(vals).size > 1 && vals.every((v, i) => i === 0 || v >= vals[i - 1]);
  const mainArea = book.puzzles.length ? book.puzzles[0].rows * book.puzzles[0].cols : 0;
  const mainPuzzles = book.puzzles.filter((P) => P.rows * P.cols === mainArea);
  const tailPuzzles = book.puzzles.slice(mainPuzzles.length);
  const hasOversizedTail = mainPuzzles.length > 0 && tailPuzzles.length > 0
    && mainPuzzles.every((P, idx) => book.puzzles[idx] === P)
    && tailPuzzles.every((P) => P.rows * P.cols > mainArea)
    && mainPuzzles.every((P) => P.tier)
    && inOrder(mainPuzzles.map((P) => TIER_ORDER.indexOf(tierLabel(P))));
  const byTier = !hasOversizedTail && book.puzzles.every((P) => P.tier) && inOrder(book.puzzles.map((P) => TIER_ORDER.indexOf(tierLabel(P))));
  const bySize = !hasOversizedTail && !byTier && inOrder(book.puzzles.map((P) => P.rows * P.cols));
  const section = (P) => (
    hasOversizedTail ? (P.rows * P.cols > mainArea ? `Bonus · ${P.cols}×${P.rows}` : tierLabel(P))
      : byTier ? tierLabel(P)
      : bySize ? `${P.cols}×${P.rows}`
      : null
  );

  let current = null;
  const sectionNodes = [];
  const tileNodes = [];
  book.puzzles.forEach((P, i) => {
    const sec = section(P);
    if (sec && sec !== current) {
      current = sec;
      const head = document.createElement('div');
      head.className = 'browse-section-header';
      head.innerHTML = '<span class="browse-section-name"></span>';
      head.firstChild.textContent = sec;
      grid.append(head);
      sectionNodes.push({ label: sec, el: head });
    }
    const done = isDone(P), started = !done && hasSave(P);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'browse-tile' + (done ? ' bt-solved' : started ? ' bt-in-progress' : '') + (i === state.idx ? ' bt-current' : '');
    b.textContent = i + 1;
    const what = `${P.name} · ${P.cols}×${P.rows}${P.tier ? ' · ' + P.tier : ''}`;
    b.title = what;
    b.setAttribute('aria-label', `Puzzle ${i + 1}, ${what}${done ? ' (solved)' : started ? ' (in progress)' : ''}`);
    b.addEventListener('click', () => { browseModal.close(); openPuzzle(i); });
    grid.append(b);
    tileNodes.push(b);
  });

  const jumps = $('browse-jumps');
  jumps.textContent = '';
  const jumpTargets = [];
  if (sectionNodes.length > 1 && book.puzzles.length > 60) {
    for (const s of sectionNodes) jumpTargets.push({ label: s.label.replace(' (beyond hints)', ''), el: s.el });
  } else if (book.puzzles.length > 100) {
    const step = book.puzzles.length > 600 ? 200 : 100;
    for (let k = 0; k < book.puzzles.length; k += step) {
      jumpTargets.push({ label: `${k + 1}–${Math.min(book.puzzles.length, k + step)}`, el: tileNodes[k] });
    }
  }
  jumps.hidden = jumpTargets.length < 2;
  for (const jt of jumpTargets) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'browse-jump-pill';
    pill.textContent = jt.label;
    pill.addEventListener('click', () => jt.el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    jumps.append(pill);
  }
  requestAnimationFrame(() => grid.querySelector('.bt-current')?.scrollIntoView({ block: 'nearest' }));
}

const browseModal = setupModal('browse-modal', 'browse-btn', renderBrowse);
$('browse-jump-btn').addEventListener('click', () => {
  const solved = solvedSet();
  const next = state.book && state.book.puzzles.findIndex((P) => !solved.has(puzzleHash(P)));
  browseModal.close();
  if (next >= 0) openPuzzle(next); else toast('You have solved every puzzle in this book!');
});

// ---- Book picker (never loads unopened books; uses manifest counts + saved solved counts)
function syncBookButton() {
  const btn = $('book-btn');
  btn.textContent = '';
  const name = document.createElement('span');
  name.className = 'book-btn-name';
  const entry = state.books.find((b) => state.book && b.id === state.book.id);
  name.textContent = entry ? entry.name : 'Choose a book';
  btn.setAttribute('aria-label', entry ? `Book: ${entry.name}. Choose a book` : 'Choose a book');
  btn.append(name);
}

function renderBookPicker(view = {}) {
  const body = $('bp-body');
  body.textContent = '';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const groups = [...state.groups];
  const listed = state.books.filter((b) => !b.hidden);
  for (const b of listed) {
    const g = b.group || 'Your files';
    if (!groups.some((x) => x.name === g)) groups.push({ name: g, icon: '📂' });
  }
  const booksOf = (g) => listed.filter((b) => (b.group || 'Your files') === g.name);
  const isCurrent = (b) => !!state.book && b.id === state.book.id;
  const solvedCounts = bookSolvedMap();
  const countText = (b) => {
    const total = b.count ?? (b.puzzles ? b.puzzles.length : null);
    const done = solvedCounts[b.id] || 0;
    return { text: total === null ? '' : done ? `${done} / ${total} solved` : `${total} puzzles`, done: total !== null && done > 0 && done === total };
  };
  const pick = (b) => { bookModal.close(); if (!isCurrent(b)) openBook(b.id, 0); };
  const show = (v) => renderBookPicker(v);

  const card = (icon, name, blurb, meta, current, onClick) => {
    const node = el('button', 'bp-card' + (current ? ' bp-current' : ''));
    node.type = 'button';
    if (current) node.setAttribute('aria-current', 'true');
    node.append(el('span', 'bp-card-icon', icon || '📖'), el('span', 'bp-card-name', name));
    if (blurb) node.append(el('span', 'bp-card-blurb', blurb));
    if (meta) node.append(el('span', 'bp-card-meta', meta));
    node.addEventListener('click', onClick);
    return node;
  };
  const header = (title, blurb, backLabel, onBack) => {
    if (onBack) { const back = el('button', 'bp-back', backLabel); back.type = 'button'; back.addEventListener('click', onBack); body.append(back); }
    body.append(el('h3', 'bp-title', title));
    if (blurb) body.append(el('p', 'bp-blurb', blurb));
  };
  const bookList = (books) => {
    const list = el('div', 'bp-list');
    for (const b of books) {
      const node = el('button', 'bp-book' + (isCurrent(b) ? ' bp-current' : ''));
      node.type = 'button';
      if (isCurrent(b)) node.setAttribute('aria-current', 'true');
      const text = el('span', 'bp-book-text');
      text.append(el('span', 'bp-book-title', b.label || b.name));
      if (b.blurb) text.append(el('span', 'bp-book-blurb', b.blurb));
      const c = countText(b), count = el('span', 'bp-count', c.text);
      count.classList.toggle('bp-count-done', c.done);
      node.append(text, count);
      node.addEventListener('click', () => pick(b));
      list.append(node);
    }
    body.append(list);
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const group = view.group && groups.find((g) => g.name === view.group);
  if (!group) {
    const grid = el('div', 'bp-cards');
    for (const g of groups) {
      const books = booksOf(g);
      if (!books.length) continue;
      const only = books.length === 1 ? books[0] : null;
      grid.append(card(g.icon, g.name, g.blurb || (only && only.blurb), only ? countText(only).text : plural(books.length, 'book'),
        books.some(isCurrent), () => (only ? pick(only) : show({ group: g.name }))));
    }
    body.append(grid);
    return;
  }
  const books = booksOf(group);
  const subs = [...new Set(books.map((b) => b.sub).filter(Boolean))];
  const directBooks = books.filter((b) => !b.sub);
  if (!subs.length || (subs.length === 1 && !directBooks.length)) {
    header(group.name, group.blurb, '← All books', () => show({}));
    bookList(books);
    return;
  }
  if (view.sub && subs.includes(view.sub)) {
    header(`${group.name} · ${view.sub}`, group.subs?.[view.sub]?.blurb, `← ${group.name}`, () => show({ group: group.name }));
    bookList(books.filter((b) => b.sub === view.sub));
    return;
  }
  header(group.name, group.blurb, '← All books', () => show({}));
  const grid = el('div', 'bp-cards');
  for (const s of subs) {
    const inSub = books.filter((b) => b.sub === s);
    const info = group.subs?.[s] || {};
    const only = inSub.length === 1 ? inSub[0] : null;
    grid.append(card(info.icon || group.icon, s, info.blurb || (only && only.blurb),
      only ? countText(only).text : plural(inSub.length, 'book'),
      inSub.some(isCurrent), () => (only ? pick(only) : show({ group: group.name, sub: s }))));
  }
  body.append(grid);
  if (directBooks.length) bookList(directBooks);
}
const bookModal = setupModal('book-modal', 'book-btn', () => renderBookPicker({}));

// ---- Settings, palettes, help, print
const clearBtn = $('clear-saves-btn');
const disarmClear = () => { clearBtn.classList.remove('danger-btn--confirm'); clearBtn.textContent = 'Clear saves'; };
const settingsModal = setupModal('settings-modal', 'settings-btn', () => {
  $('setting-dark-mode').checked = document.documentElement.dataset.theme === 'dark';
  disarmClear();
  syncOfflineUI();
});
function renderHelpModal() {
  const P = state.P;
  const hasClues = !P || (P.clues && P.clues.length > 0);
  const hasGray = Boolean(P && P.grays && P.grays.length > 0);
  const isFull = Boolean(P && P.fullBoard);
  const hasGivens = Boolean(P && P.hasGivens);
  const hasWalls = Boolean(P && P.hasGivens && P.givens.some((g) => g.v === 0));
  const hasGivenLines = Boolean(P && P.hasGivens && P.givens.some((g) => g.v === 1));
  const hasVoids = Boolean(P && P.hasVoids);

  const intro = $('help-intro');
  if (intro) {
    if (isFull && !hasClues) {
      intro.innerHTML = 'Draw <b>one single closed loop</b> along the grid lines visiting <b>every intersection</b>, respecting all pre-filled segments and walls, with no crossings or branches.';
    } else if (isFull) {
      intro.innerHTML = 'Draw <b>one single closed loop</b> along the grid lines visiting <b>every intersection</b> and every circle, with no crossings or branches.';
    } else if (hasVoids) {
      intro.innerHTML = 'Draw <b>one single closed loop</b> along the grid lines visiting every circle while avoiding the cutout holes, with no crossings or branches. Empty intersections are optional.';
    } else if (hasWalls) {
      intro.innerHTML = 'Draw <b>one single closed loop</b> along the grid lines visiting every circle without crossing any solid walls, with no crossings or branches. Empty intersections are optional.';
    } else {
      intro.innerHTML = 'Draw <b>one single closed loop</b> along the grid lines visiting every circle, with no crossings or branches. Empty intersections are optional.';
    }
  }

  $('help-card-white').hidden = !hasClues;
  $('help-card-black').hidden = !hasClues;
  $('help-card-gray').hidden = !hasGray;
  $('help-card-full').hidden = !isFull;
  $('help-card-voids').hidden = !hasVoids;
  $('help-card-walls').hidden = !hasWalls || isFull;

  if (isFull) {
    $('help-full-title').textContent = hasGivens ? 'Full board & givens (special rule)' : 'Full board (special rule)';
    const givenNote = hasGivenLines && hasWalls
      ? 'Dark pre-filled segments and solid walls are permanent givens.'
      : hasGivenLines
        ? 'Dark pre-filled segments are permanent givens.'
        : 'Solid walls permanently block the loop from crossing between adjacent intersections.';
    $('help-full-desc').innerHTML = hasGivens
      ? `The loop must visit <b>every</b> intersection dot — none may be left empty. ${givenNote}`
      : 'The loop must visit <b>every</b> intersection dot — none may be left empty.';
    $('help-full-ok').textContent = hasGivens ? '✓ Every dot + givens' : '✓ Visits every dot';
    const fullSvg = $('help-card-full').querySelector('svg');
    if (fullSvg) {
      fullSvg.querySelector('.hr-given')?.toggleAttribute('hidden', !hasGivenLines);
      fullSvg.querySelector('.hr-wall')?.toggleAttribute('hidden', !hasWalls);
    }
  }

  $('help-ctrl-gray').hidden = !hasGray;
  $('help-ctrl-voids').hidden = !hasVoids;

  const link = $('help-guide-link');
  if (link) {
    const hash = hasGray ? '#variant-gray' : isFull ? '#variant-full' : hasVoids ? '#variant-swiss' : hasWalls ? '#variant-mazes' : '';
    link.setAttribute('href', `docs/how_to_solve.html${hash}`);
  }
}
const helpModal = setupModal('help-modal', 'help-btn', renderHelpModal);
// Don't auto-open help if deep-linking directly to a puzzle (e.g. from docs/how_to_solve.md or armory)
if (!store.get('ms_seenHelp') && !new URLSearchParams(location.search).has('book')) {
  store.set('ms_seenHelp', '1');
  helpModal.open();
}

$('setting-dark-mode').addEventListener('change', (e) => {
  document.documentElement.setAttribute('data-theme', e.target.checked ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', e.target.checked ? '#1a1a1a' : '#1976d2');
  store.set('ms_dark', e.target.checked ? '1' : '0');
  board.setOptions(paletteOptions());
  renderPaletteUI();
});

$('setting-color-lines').checked = settings.colorLines;
$('setting-color-lines').addEventListener('change', (e) => {
  settings.colorLines = e.target.checked;
  store.set('ms_colorLines', settings.colorLines ? '1' : '0');
  board.setOptions({ colorLines: settings.colorLines });
  renderPaletteUI();
});

$('setting-auto-x').checked = settings.autoX;
$('setting-auto-x').addEventListener('change', (e) => {
  settings.autoX = e.target.checked;
  store.set('ms_autoX', settings.autoX ? '1' : '0');
  if (state.P) {
    const syncOne = (m) => {
      applyAutoX(state.P, m, settings.autoX, { useShade: settings.autoShade });
      if (settings.autoShade) {
        reconcileAutoShade(state.P, m, true);
        if (isSolved(state.P, m.edges)) paintSolvedFaces(state.P, m);
      }
    };
    const before = snapshot();
    syncOne(state.marks);
    for (const m of [...state.undo, ...state.redo]) syncOne(m);
    if (!sameMarks(before, state.marks)) { save(); refresh(); }
  }
});

$('setting-auto-shade').checked = settings.autoShade;
$('setting-auto-shade').addEventListener('change', (e) => {
  settings.autoShade = e.target.checked;
  store.set('ms_autoShade', settings.autoShade ? '1' : '0');
  if (state.P) {
    const syncOne = (m) => {
      if (settings.autoX) {
        applyAutoX(state.P, m, true, { useShade: settings.autoShade });
      }
      applyAutoShade(state.P, m, settings.autoShade);
      if (settings.autoShade && isSolved(state.P, m.edges)) paintSolvedFaces(state.P, m);
    };
    const before = snapshot();
    syncOne(state.marks);
    for (const m of [...state.undo, ...state.redo]) syncOne(m);
    if (!sameMarks(before, state.marks)) { save(); refresh(); }
    else board.render(state.marks, analyse());
  }
});

$('setting-incremental-hints').checked = settings.incrementalHints;
$('setting-incremental-hints').addEventListener('change', (e) => {
  settings.incrementalHints = e.target.checked;
  store.set('ms_incrementalHints', settings.incrementalHints ? '1' : '0');
});

function renderPaletteUI() {
  const custom = settings.palette === CUSTOM;
  $('palette-group').hidden = !settings.colorLines;
  $('setting-palette').value = settings.palette;
  $('palette-desc').textContent = custom ? 'Colors you pick yourself' : PRESETS.find((p) => p.id === settings.palette).desc;
  $('palette-custom').hidden = !custom;
  const strip = $('palette-strip');
  strip.replaceChildren();
  (custom ? settings.custom : pathColors()).forEach((color, i, all) => {
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = color;
    sw.title = `Color ${i + 1}`;
    if (custom) {
      const input = document.createElement('input');
      input.type = 'color'; input.value = color; input.setAttribute('aria-label', `Color ${i + 1}`);
      input.addEventListener('input', () => { settings.custom[i] = input.value; sw.style.background = input.value; changeCustom(false); });
      sw.append(input);
      if (all.length > MIN_CUSTOM) {
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'swatch-x'; x.textContent = '×'; x.setAttribute('aria-label', `Remove color ${i + 1}`);
        x.addEventListener('click', () => { settings.custom.splice(i, 1); changeCustom(true); });
        sw.append(x);
      }
    }
    strip.append(sw);
  });
  $('palette-add').disabled = custom && settings.custom.length >= MAX_CUSTOM;
}
function changeCustom(redraw) {
  store.set('ms_pathCustom', JSON.stringify(settings.custom));
  board.setOptions(paletteOptions());
  if (redraw) renderPaletteUI();
}
for (const p of [...PRESETS, { id: CUSTOM, name: 'Custom…' }]) $('setting-palette').add(new Option(p.name, p.id));
$('setting-palette').addEventListener('change', (e) => {
  if (e.target.value === CUSTOM && !settings.custom) settings.custom = lightColors(settings.palette, null).slice(0, 8);
  settings.palette = e.target.value;
  store.set('ms_pathPalette', settings.palette);
  changeCustom(true);
});
$('palette-add').addEventListener('click', () => {
  settings.custom.push(PRESETS[0].light.find((c) => !settings.custom.includes(c)) || '#808080');
  changeCustom(true);
});
$('palette-reset').addEventListener('click', () => { settings.custom = PRESETS[0].light.slice(0, 8); changeCustom(true); });
renderPaletteUI();

clearBtn.addEventListener('click', () => {
  if (!clearBtn.classList.contains('danger-btn--confirm')) {
    clearBtn.classList.add('danger-btn--confirm');
    clearBtn.textContent = 'Are you sure?';
    return;
  }
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('ms_save_') || k === 'ms_solved' || k === 'ms_book_solved')
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
  disarmClear();
  if (state.P) openPuzzle(state.idx);
  toast('Saved progress cleared.');
});

$('csv-btn').addEventListener('click', () => $('csv-file').click());

// ---- Offline play (opt-in service worker)
const offlineToggle = $('setting-offline');
const offlineDesc = $('offline-desc');
const offlineActions = $('offline-actions');
const offlineRefreshBtn = $('offline-refresh-btn');
let offlineAbort = null;
let offlineQueue = Promise.resolve();
let offlineBusy = false;
let offlineSeq = 0;
let offlineUiSeq = 0;

function renderOfflineStatus(status) {
  const count = status.total ? `all ${status.total} puzzle books` : 'all puzzle books';
  if (!status.supported) {
    offlineToggle.checked = false;
    offlineToggle.disabled = true;
    offlineActions.hidden = true;
    offlineDesc.textContent = 'Unavailable in this browser or private window';
    return;
  }
  offlineToggle.disabled = false;
  offlineToggle.checked = status.enabled;
  offlineActions.hidden = !status.enabled;
  offlineRefreshBtn.disabled = offlineBusy || navigator.onLine === false;
  if (!status.enabled) {
    offlineDesc.textContent = `Save the app and ${count} (~7 MB) to play without internet`;
  } else if (status.total === 0) {
    offlineDesc.textContent = 'Ready offline';
  } else if (status.cached >= status.total) {
    offlineDesc.textContent = `Ready offline — all ${status.total} books saved`;
  } else {
    offlineDesc.textContent = `${status.cached} of ${status.total} books saved — connect to finish downloading`;
  }
}

async function syncOfflineUI() {
  if (offlineBusy) return;
  const opSeq = offlineSeq;
  const uiSeq = ++offlineUiSeq;
  const status = await getOfflineStatus(state.books);
  if (offlineBusy || opSeq !== offlineSeq || uiSeq !== offlineUiSeq) return;
  renderOfflineStatus(status);
}

function queueOfflineOp(fn) {
  const seq = ++offlineSeq;
  if (offlineAbort) offlineAbort.abort();
  const ctrl = new AbortController();
  offlineAbort = ctrl;
  const run = offlineQueue.catch(() => {}).then(() => {
    if (seq !== offlineSeq || ctrl.signal.aborted) return null;
    return fn(ctrl.signal, seq);
  });
  offlineQueue = run.catch(() => {});
  return run;
}

async function refreshManifestBooks(signal) {
  try {
    const res = await fetch(new Request('data/manifest.json', { cache: 'reload' }), { signal });
    if (!res.ok) return;
    const manifest = await res.json();
    if (!Array.isArray(manifest.books) || !manifest.books.length) return;
    const customBooks = state.books.filter((b) => !b.file);
    state.books = [...manifest.books, ...customBooks];
    if (Array.isArray(manifest.groups)) state.groups = manifest.groups;
  } catch { /* keep current manifest */ }
}

function runOfflineSync(force) {
  if (!isOfflineSupported()) return;
  queueOfflineOp(async (signal, seq) => {
    offlineBusy = true;
    offlineToggle.checked = true;
    offlineActions.hidden = false;
    offlineRefreshBtn.disabled = true;
    const verb = force ? 'Updating offline copy' : 'Downloading books';
    offlineDesc.textContent = force ? 'Updating offline copy…' : 'Setting up offline play…';

    let res = null;
    let failed = false;
    try {
      if (force || !state.books.some((b) => b.file)) await refreshManifestBooks(signal);
      if (signal.aborted) return;
      res = await enableOffline(state.books, {
        force,
        signal,
        onProgress: (done, total) => {
          if (signal.aborted) return;
          offlineDesc.textContent = total ? `${verb}… ${done} / ${total}` : `${verb}…`;
        },
      });
    } catch {
      failed = true;
    } finally {
      if (seq === offlineSeq) offlineBusy = false;
    }

    if (signal.aborted || seq !== offlineSeq) return;
    await syncOfflineUI();
    if (failed) {
      toast(force ? 'Could not update offline copy.' : 'Could not enable offline play.');
    } else if (force) {
      toast(res?.ok ? 'Offline copy updated.' : 'Some files could not be updated.');
    }
  });
}

function queueBackgroundSync() {
  if (offlineBusy || !state.books.length || !isOfflineSupported() || navigator.onLine === false) return;
  queueOfflineOp(async (signal, seq) => {
    const res = await syncMissingBooks(state.books, { signal });
    if (res && !signal.aborted && seq === offlineSeq) await syncOfflineUI();
  });
}

offlineToggle.addEventListener('change', () => {
  if (offlineToggle.checked) {
    runOfflineSync(false);
    return;
  }
  queueOfflineOp(async (signal, seq) => {
    offlineBusy = true;
    offlineRefreshBtn.disabled = true;
    offlineActions.hidden = true;
    offlineDesc.textContent = 'Removing offline copy…';
    try {
      await disableOffline();
    } finally {
      if (seq === offlineSeq) offlineBusy = false;
    }
    if (!signal.aborted && seq === offlineSeq) await syncOfflineUI();
  });
});

offlineRefreshBtn.addEventListener('click', () => {
  if (navigator.onLine === false) {
    toast('Connect to the internet to update your offline copy.');
    return;
  }
  runOfflineSync(true);
});

window.addEventListener('online', () => { syncOfflineUI(); queueBackgroundSync(); });
window.addEventListener('offline', () => { syncOfflineUI(); });
$('csv-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let text, puzzles;
  try {
    text = await f.text();
    puzzles = parseCsv(text);
    for (const p of puzzles) compile(p);
  } catch {
    toast('Could not read that CSV file.');
    return;
  }
  if (!puzzles.length) { toast('No puzzles found in that file.'); return; }
  rememberFileBook(f.name, text);
  const id = `file:${f.name}`;
  state.books = state.books.filter((b) => b.id !== id);
  state.books.push({ id, name: f.name, puzzles, count: puzzles.length });
  settingsModal.close();
  openBook(id, 0);
});

// ---- Print booklet modal
const endBookletPrint = () => document.body.classList.remove('printing-booklet');
window.addEventListener('afterprint', endBookletPrint);
matchMedia('print').addEventListener?.('change', (e) => { if (!e.matches) endBookletPrint(); });
const printSolution = (P) => {
  if (!P.solution) return null;
  const C = P.N ? P : compile(P);
  return decodeSolution(C, C.solution);
};

function setupPrint() {
  const sel = $('print-selection'), sizeSel = $('print-size'), keyBox = $('print-answer-key');
  const err = $('print-error'), summary = $('print-summary'), go = $('print-go-btn');
  const savedSize = store.get('ms_printSize');
  if ([...sizeSel.options].some((o) => o.value === savedSize)) sizeSel.value = savedSize;
  keyBox.checked = store.get('ms_printKey') !== '0';

  const update = () => {
    const puzzles = state.book ? state.book.puzzles : [];
    const { ids, error } = parseSelection(sel.value, puzzles.length);
    err.hidden = !error;
    err.textContent = error ?? '';
    go.disabled = Boolean(error);
    if (error) { summary.textContent = ''; return null; }
    const size = sizeSel.value;
    const keyIds = keyBox.checked ? ids.filter((id) => puzzles[id - 1].solution) : [];
    const plan = planPrint({ puzzles, ids, keyIds, size });
    const pages = (n) => `${n} page${n === 1 ? '' : 's'}`;
    summary.textContent = `${ids.length} puzzle${ids.length === 1 ? '' : 's'}, ${plan.perPage} per page: ${pages(plan.puzzlePages)}`
      + (plan.keyPages ? ` + ${pages(plan.keyPages)} of answers (${plan.keyPerPage} per page).` : '.');
    return { ids, puzzles, size };
  };

  setupModal('print-modal', 'print-btn', () => {
    settingsModal.close();
    const total = state.book ? state.book.puzzles.length : 0;
    $('print-book-name').textContent = state.book ? state.book.name : '';
    $('print-book-total').textContent = total;
    const from = state.idx + 1, to = Math.min(total, state.idx + 10);
    sel.value = total <= 1 ? '1' : (from === to ? String(from) : `${from}-${to}`);
    update();
    if (matchMedia('(pointer: fine)').matches) setTimeout(() => { sel.focus(); sel.select(); }, 0);
  }, 'settings-btn');

  sel.addEventListener('input', update);
  sizeSel.addEventListener('change', () => { store.set('ms_printSize', sizeSel.value); update(); });
  keyBox.addEventListener('change', () => { store.set('ms_printKey', keyBox.checked ? '1' : '0'); update(); });
  go.addEventListener('click', () => {
    const r = update();
    if (!r) return;
    for (const id of r.ids) {
      const p = r.puzzles[id - 1];
      if (p && !p.N) r.puzzles[id - 1] = compile(p);
    }
    buildPrintRoot({
      book: { title: state.book.name },
      puzzles: r.puzzles,
      ids: r.ids,
      size: r.size,
      includeKey: keyBox.checked,
      solutionOf: printSolution,
    });
    document.body.classList.add('printing-booklet');
    window.print();
  });
}
setupPrint();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (board.gesture) { board.cancel(); return; }
    const openModal = modals.find(({ modal }) => !modal.classList.contains('modal-hidden'));
    if (openModal) { openModal.close(); return; }
    const toastEl = $('toast');
    if ((state.hint && state.hint.visible) || (!toastEl.hidden && !toastEl.classList.contains('ghost'))) {
      dismissToast();
    }
    return;
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (modalOpen() || board.gesture) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (!mod && !e.altKey && e.key === 'ArrowLeft') step(-1);
  else if (!mod && !e.altKey && e.key === 'ArrowRight') step(1);
});

// Expose a small test/screenshot hook on localhost (used by tools/capture_how_to_images.py)
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.__masyu = {
    get state() { return state; },
    applyHint() {
      if (!state.hint || state.hint.kind !== 'step') return false;
      const item = state.hint.hints[state.hint.index];
      for (const x of item.targets.segOn) { state.marks.edges[x] = 1; state.marks.autoE[x] = 0; }
      for (const x of item.targets.segOff) { state.marks.edges[x] = 2; state.marks.autoE[x] = 0; }
      for (const cell of item.targets.grayWhite || []) {
        const k = state.P.grayAt[cell];
        if (k >= 0) { state.marks.grays[k] = WHITE; state.marks.autoG[k] = 0; }
      }
      for (const cell of item.targets.grayBlack || []) {
        const k = state.P.grayAt[cell];
        if (k >= 0) { state.marks.grays[k] = BLACK; state.marks.autoG[k] = 0; }
      }
      reconcileAuto(state.P, state.marks);
      refresh();
      return true;
    },
    showHint: (opts) => hint(opts),
  };
}

init();
