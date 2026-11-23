// App controller: books, deep links, marks, undo/redo, persistence, Correct-so-far, Hint, Browse, Settings, Print.
import {
  compile, parseCsv, puzzleHash, isSolved, decodeSolution,
} from './logic.js';
import { TIER_INFO, beyondHints } from './rating.js';
import { computeHint, checkMarksAgainstSolution } from './hintstep.js';
import { ROLES, describeMarks } from './explain.js';
import {
  cycleEdgeMark, toggleEdgeCross, cycleFaceMark, cycleFaceMarkReverse, numFacesOf,
  reconcileAutoX, applyAutoX, reconcileAutoShade, applyAutoShade, shadeConflicts,
  facesFromSolvedLoop,
} from './marks.js';
import { clueStates, earlyLoopEdges } from './clues.js';
import { Board } from './board.js';
import {
  PRESETS, CUSTOM, MIN_CUSTOM, MAX_CUSTOM, sanitizeCustom, validId,
  lightColors, resolvePalette, eyesOf, alikeMatrix,
} from './palettes.js';
import { parseSelection, planPrint, buildPrintRoot } from './print.js';

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
  markCircles: store.get('ms_markCircles') !== '0',
  autoX: store.get('ms_autoX') === '1',
  autoShade: store.get('ms_autoShade') === '1',
};

const board = new Board($('board'), {
  onStart: () => { state.pending = snapshot(); state.dragStack = []; },
  onBeginDrag: () => { if (state.pending) state.marks = cloneMarks(state.pending); state.dragStack = []; },
  onEdgeTap: (edge) => cycleEdge(edge),
  onEdgeRight: (edge) => toggleEdge(edge),
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
board.setOptions({ colorLines: settings.colorLines, markCircles: settings.markCircles, ...paletteOptions() });

// ------------------------------------------------------------ marks & undo

const emptyMarks = (P) => ({
  edges: new Uint8Array(P.numEdges),
  autoE: new Uint8Array(P.numEdges),
  faces: new Uint8Array(numFacesOf(P)),
  autoF: new Uint8Array(numFacesOf(P)),
});
const freshMarks = (P) => {
  const m = emptyMarks(P);
  if (settings.autoShade) reconcileAutoShade(P, null, m, true);
  return m;
};
const cloneMarks = (m) => ({
  edges: m.edges.slice(),
  autoE: m.autoE.slice(),
  faces: m.faces.slice(),
  autoF: m.autoF.slice(),
});
const snapshot = () => cloneMarks(state.marks);
const sameMarks = (a, b) => (
  a.edges.every((v, i) => v === b.edges[i])
  && a.autoE.every((v, i) => v === b.autoE[i])
  && a.faces.every((v, i) => v === b.faces[i])
  && a.autoF.every((v, i) => v === b.autoF[i])
);
const isPristine = (m) => (
  m.edges.every((v, x) => v === 0 || (v === 2 && m.autoE[x]))
  && m.faces.every((v, f) => v === 0 || m.autoF[f])
);

function edgeBetween(P, a, b) {
  for (let d = 0; d < 4; d++) if (P.nb[a * 4 + d] === b) return P.ed[a * 4 + d];
  return -1;
}

function cycleEdge(x) {
  const P = state.P, m = state.marks;
  if (x < 0 || P.edgeA[x] < 0) return;
  const prev = snapshot();
  m.edges[x] = cycleEdgeMark(m.edges[x]);
  m.autoE[x] = 0;
  reconcileAutoX(P, prev, m, settings.autoX);
  reconcileAutoShade(P, prev, m, settings.autoShade);
  refresh();
}

function toggleEdge(x) {
  const P = state.P, m = state.marks;
  if (x < 0 || P.edgeA[x] < 0) return;
  const prev = snapshot();
  m.edges[x] = toggleEdgeCross(m.edges[x]);
  m.autoE[x] = 0;
  reconcileAutoX(P, prev, m, settings.autoX);
  reconcileAutoShade(P, prev, m, settings.autoShade);
  refresh();
}

function cycleFace(f, reverse = false) {
  const P = state.P, m = state.marks;
  if (f < 0 || f >= m.faces.length) return;
  const prev = snapshot();
  const next = reverse ? cycleFaceMarkReverse(m.faces[f]) : cycleFaceMark(m.faces[f]);
  m.faces[f] = next;
  m.autoF[f] = 0;
  state.facePaintVal = next;
  reconcileAutoShade(P, prev, m, settings.autoShade);
  refresh();
}

function paintFaceStep(f) {
  const P = state.P, m = state.marks;
  if (f < 0 || f >= m.faces.length) return;
  const val = state.facePaintVal;
  if (m.faces[f] === val && !m.autoF[f]) return;
  const prev = snapshot();
  m.faces[f] = val;
  m.autoF[f] = 0;
  reconcileAutoShade(P, prev, m, settings.autoShade);
  refresh();
}

function dragStep(a, b, first) {
  const P = state.P, m = state.marks;
  const prev = snapshot();
  state.dragStack.push(prev);
  const x = edgeBetween(P, a, b);
  if (x < 0) return;
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
  reconcileAutoX(P, prev, m, settings.autoX);
  reconcileAutoShade(P, prev, m, settings.autoShade);
  refresh();
}

function crossStep(a, b, first) {
  const P = state.P, m = state.marks;
  const prev = snapshot();
  state.dragStack.push(prev);
  const x = edgeBetween(P, a, b);
  if (x < 0) return;
  if (first) state.drawMode = m.edges[x] === 2 ? 0 : 2;
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
  reconcileAutoX(P, prev, m, settings.autoX);
  reconcileAutoShade(P, prev, m, settings.autoShade);
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
  if (!before) return;
  if (cancelled) { state.marks = before; refresh(); return; }
  if (!sameMarks(before, state.marks)) {
    state.undo.push(before);
    state.redo = [];
    save();
  }
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
    clueState: clueStates(state.P, state.marks),
    badFaces: state.solved ? new Set() : shadeConflicts(state.P, state.marks, settings.autoShade),
    earlyLoops: earlyLoopEdges(state.P, state.marks),
  };
}

function fitBoard() {
  const P = state.P;
  if (!P) return;
  const avail = Math.min(window.innerWidth - 24, 1500);
  const px = Math.max(26, Math.min(48, Math.floor(avail / (P.cols + 0.5))));
  const width = Math.round((board.size().W * px) / 44);
  $('board').style.width = `${width}px`;
  $('game-container').style.maxWidth = `${Math.max(640, width + 24)}px`;
}
window.addEventListener('resize', fitBoard);

function refresh() {
  state.hint = null;
  hideToast();
  const solved = isSolved(state.P, state.marks.edges);
  if (solved && !state.solved) {
    // Only auto-paint on win when Auto-Shade is ON (so manual/inverted color schemes are never touched)
    if (settings.autoShade) {
      const exactFaces = facesFromSolvedLoop(state.P, state.marks.edges);
      for (let f = 0; f < exactFaces.length; f++) {
        if (state.marks.faces[f] !== exactFaces[f] || state.marks.autoF[f]) {
          state.marks.faces[f] = exactFaces[f];
          state.marks.autoF[f] = 1;
        }
      }
    }
    markSolved();
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
  const P = state.P, m = state.marks;
  if (isPristine(m)) { store.del(saveKey(P)); return; }
  store.set(saveKey(P), JSON.stringify({
    e: Array.from(m.edges).join(''),
    ae: Array.from(m.autoE).join(''),
    f: Array.from(m.faces).join(''),
    af: Array.from(m.autoF).join(''),
  }));
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
      if (!settings.autoX) applyAutoX(P, m, false);
      applyAutoShade(P, m, settings.autoShade);
      return m;
    }
  } catch { /* corrupt save */ }
  return freshMarks(P);
}

const solvedSet = () => { try { return new Set(JSON.parse(store.get('ms_solved') || '[]')); } catch { return new Set(); } };
const bookSolvedMap = () => { try { return JSON.parse(store.get('ms_book_solved') || '{}'); } catch { return {}; } };

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

// Clicking anywhere on the page dismisses an open toast (Hint button is exempt so clicking Hint again cycles firings)
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#hint-btn') && !e.target.closest('#check-btn')) dismissToast();
}, true);
$('toast').addEventListener('click', dismissToast);

function checkSoFar() {
  if (!state.P) return;
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

function hint() {
  if (!state.P) return;
  if (state.solved) { toast('Already solved!'); return; }

  // Cycle through firings if Hint is pressed again on the same board position
  if (state.hint && state.hint.kind === 'step') {
    if (state.hint.visible && state.hint.hints.length > 1) {
      state.hint.index = (state.hint.index + 1) % state.hint.hints.length;
    }
    state.hint.visible = true;
    renderCurrentHint();
    return;
  }

  const res = computeHint(state.P, state.marks);
  if (res.kind === 'wrong') {
    state.hint = { ...res, visible: true };
    board.render(state.marks, analyse(), { wrongEdges: res.wrongEdges });
    showHintToast(
      'Mistake found',
      `${res.total} mark${res.total === 1 ? '' : 's'} (highlighted in red) disagree${res.total === 1 ? 's' : ''} with the solution. Fix or undo ${res.total === 1 ? 'it' : 'them'} first.`,
      null,
      [],
    );
    return;
  }

  if (res.kind === 'stuck') {
    state.hint = { ...res, visible: true };
    board.render(state.marks, analyse(), { undecided: res.undecided });
    showHintToast(
      'Solver stuck',
      'None of the hint rules can find a next step here (tinted cells still have undecided edges).',
      null,
      [],
    );
    return;
  }

  state.hint = { ...res, index: 0, visible: true };
  renderCurrentHint();
}

function renderCurrentHint() {
  const h = state.hint;
  const item = h.hints[h.index];
  board.render(state.marks, analyse(), {
    roles: item.roles,
    targets: item.targets,
    chain: item.chain,
    faces: item.faces,
  });
  const usedRoles = Object.keys(item.roles).filter((k) => item.roles[k].length > 0);
  const faceLabels = item.faces && (item.faces.in.length || item.faces.out.length)
    ? {
        hasIn: item.faces.in.length > 0,
        hasOut: item.faces.out.length > 0,
        inLabel: item.faces.anchored ? 'Inside' : 'Side A',
        outLabel: item.faces.anchored ? 'Outside' : 'Side B',
      }
    : null;
  const meta = `${h.tier} · ${h.rule} (cost ${h.weight})${h.hints.length > 1 ? ` · ${h.index + 1}/${h.hints.length}` : ''}`;
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
  const text = await (await fetch(entry.file)).text();
  const raw = parseCsv(text);
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
  const tier = P.tier ? ` · ${P.tier}` : '';
  const extra = beyondHints(P) ? ' (beyond hints)' : '';
  const info = $('puz-info');
  info.textContent = `${P.name} · ${P.cols}×${P.rows}${tier}${extra}`;
  info.title = P.tier && TIER_INFO[P.tier] ? `${P.tier}: ${TIER_INFO[P.tier].blurb}` : '';
}

function openPuzzle(idx) {
  const book = state.book;
  if (!book || !book.puzzles.length) return;
  idx = Math.max(0, Math.min(idx, book.puzzles.length - 1));
  state.idx = idx;
  const raw = book.puzzles[idx];
  const P = raw.N ? raw : compile(raw);
  book.puzzles[idx] = P;
  state.P = P;
  state.marks = load(P);
  state.undo = [];
  state.redo = [];
  state.hint = null;
  state.solved = isSolved(P, state.marks.edges);

  $('puz-num').value = idx + 1;
  $('puz-num').max = book.puzzles.length;
  $('puz-total').textContent = book.puzzles.length;
  $('prev-puz').disabled = idx === 0;
  $('next-puz').disabled = idx === book.puzzles.length - 1;

  board.setPuzzle(P);
  dropToast();
  fitBoard();
  showInfo();
  refresh();
  store.set('ms_last', JSON.stringify({ book: book.id, idx }));
  updateUrl();
}

async function openBook(bookId, idx = 0) {
  const entry = state.books.find((b) => b.id === bookId);
  if (!entry) return;
  const raw = await fetchBook(entry);
  state.book = { id: entry.id, name: entry.name, puzzles: raw };
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
  if (!state.books.length) { $('puz-info').textContent = 'No puzzle books found.'; return; }

  const params = new URLSearchParams(location.search);
  let last = null;
  try { last = JSON.parse(store.get('ms_last') || 'null'); } catch { /* ignore */ }
  let bookId = params.get('book') || (last && last.book) || manifest.default || state.books[0].id;
  const known = state.books.some((b) => b.id === bookId);
  if (!known) bookId = manifest.default || state.books[0].id;
  const idx = !known ? 0 : params.has('puzzle') ? +params.get('puzzle') - 1 : (last && last.book === bookId ? last.idx : 0);
  await openBook(bookId, Number.isFinite(idx) ? idx : 0);
}

// ------------------------------------------------------------ UI wiring & modals

const step = (d) => { if (!state.book) return; const j = state.idx + d; if (j >= 0 && j < state.book.puzzles.length) openPuzzle(j); };
$('prev-puz').addEventListener('click', () => step(-1));
$('next-puz').addEventListener('click', () => step(1));
$('puz-num').addEventListener('change', (e) => { if (state.book) openPuzzle((+e.target.value || 1) - 1); });
$('undo-btn').addEventListener('click', undo);
$('redo-btn').addEventListener('click', redo);
$('reset-btn').addEventListener('click', reset);
$('check-btn').addEventListener('click', checkSoFar);
$('hint-btn').addEventListener('click', hint);

const modals = [];
function setupModal(modalId, openBtnId, onOpen) {
  const modal = $(modalId), openBtn = $(openBtnId);
  const close = () => { modal.classList.add('modal-hidden'); openBtn.focus(); };
  const open = () => { onOpen?.(); modal.classList.remove('modal-hidden'); modal.querySelector('[data-close]').focus(); };
  openBtn.addEventListener('click', open);
  modal.querySelector('[data-close]').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modals.push({ modal, close });
  return { open, close };
}
const modalOpen = () => modals.some(({ modal }) => !modal.classList.contains('modal-hidden'));

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
  const hasOther = subs.length > 0 && books.some((b) => !b.sub);
  if (subs.length < 2 && !(subs.length && hasOther)) {
    header(group.name, group.blurb, '← All books', () => show({}));
    bookList(books);
    return;
  }
  const subName = view.sub === null ? 'Other' : view.sub;
  if (view.sub !== undefined && (view.sub === null ? hasOther : subs.includes(view.sub))) {
    header(`${group.name} · ${subName}`, group.subs?.[view.sub]?.blurb, `← ${group.name}`, () => show({ group: group.name }));
    bookList(books.filter((b) => (view.sub === null ? !b.sub : b.sub === view.sub)));
    return;
  }
  header(group.name, group.blurb, '← All books', () => show({}));
  const grid = el('div', 'bp-cards');
  for (const s of hasOther ? [...subs, null] : subs) {
    const inSub = books.filter((b) => (s === null ? !b.sub : b.sub === s));
    const info = (s !== null && group.subs?.[s]) || {};
    const only = inSub.length === 1 ? inSub[0] : null;
    grid.append(card(info.icon || group.icon, s === null ? 'Other' : s, info.blurb || (only && only.blurb),
      only ? countText(only).text : plural(inSub.length, 'book'),
      inSub.some(isCurrent), () => (only ? pick(only) : show({ group: group.name, sub: s }))));
  }
  body.append(grid);
}
const bookModal = setupModal('book-modal', 'book-btn', () => renderBookPicker({}));

// ---- Settings, palettes, help, print
const clearBtn = $('clear-saves-btn');
const disarmClear = () => { clearBtn.classList.remove('danger-btn--confirm'); clearBtn.textContent = 'Clear saves'; };
const settingsModal = setupModal('settings-modal', 'settings-btn', () => {
  $('setting-dark-mode').checked = document.documentElement.dataset.theme === 'dark';
  disarmClear();
});
const helpModal = setupModal('help-modal', 'help-btn');
// Don't auto-open help if deep-linking directly to a puzzle (e.g. from docs/how_to_solve.md or armory)
if (!store.get('ms_seenHelp') && !new URLSearchParams(location.search).has('book')) {
  store.set('ms_seenHelp', '1');
  helpModal.open();
}

$('setting-dark-mode').addEventListener('change', (e) => {
  document.documentElement.setAttribute('data-theme', e.target.checked ? 'dark' : 'light');
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

$('setting-mark-circles').checked = settings.markCircles;
$('setting-mark-circles').addEventListener('change', (e) => {
  settings.markCircles = e.target.checked;
  store.set('ms_markCircles', settings.markCircles ? '1' : '0');
  board.setOptions({ markCircles: settings.markCircles });
});

$('setting-auto-x').checked = settings.autoX;
$('setting-auto-x').addEventListener('change', (e) => {
  settings.autoX = e.target.checked;
  store.set('ms_autoX', settings.autoX ? '1' : '0');
  if (state.P) {
    const before = snapshot();
    applyAutoX(state.P, state.marks, settings.autoX);
    if (settings.autoShade) reconcileAutoShade(state.P, before, state.marks, true);
    for (const m of [...state.undo, ...state.redo]) {
      const mPrev = {
        edges: m.edges.slice(), autoE: m.autoE.slice(),
        faces: m.faces.slice(), autoF: m.autoF.slice(),
      };
      applyAutoX(state.P, m, settings.autoX);
      if (settings.autoShade) reconcileAutoShade(state.P, mPrev, m, true);
    }
    if (!sameMarks(before, state.marks)) { save(); refresh(); }
  }
});

$('setting-auto-shade').checked = settings.autoShade;
$('setting-auto-shade').addEventListener('change', (e) => {
  settings.autoShade = e.target.checked;
  store.set('ms_autoShade', settings.autoShade ? '1' : '0');
  if (state.P) {
    const before = snapshot();
    applyAutoShade(state.P, state.marks, settings.autoShade);
    for (const m of [...state.undo, ...state.redo]) applyAutoShade(state.P, m, settings.autoShade);
    if (!sameMarks(before, state.marks)) { save(); refresh(); }
  }
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
$('csv-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const text = await f.text(), puzzles = parseCsv(text);
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
    sel.value = total <= 1 ? '1' : `${state.idx + 1}-${Math.min(total, state.idx + 10)}`;
    update();
    if (matchMedia('(pointer: fine)').matches) setTimeout(() => { sel.focus(); sel.select(); }, 0);
  });

  sel.addEventListener('input', update);
  sizeSel.addEventListener('change', () => { store.set('ms_printSize', sizeSel.value); update(); });
  keyBox.addEventListener('change', () => { store.set('ms_printKey', keyBox.checked ? '1' : '0'); update(); });
  go.addEventListener('click', () => {
    const r = update();
    if (!r) return;
    const compiled = r.puzzles.map((p) => (p.N ? p : compile(p)));
    buildPrintRoot({
      book: { title: state.book.name },
      puzzles: compiled,
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
    modals.find(({ modal }) => !modal.classList.contains('modal-hidden'))?.close();
    return;
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (modalOpen()) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
});

// Expose a small test/screenshot hook on localhost (used by tools/capture_how_to_images.py)
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.__masyu = {
    get state() { return state; },
    applyHint() {
      if (!state.hint || state.hint.kind !== 'step') return false;
      const item = state.hint.hints[state.hint.index];
      const prev = snapshot();
      for (const x of item.targets.segOn) { state.marks.edges[x] = 1; state.marks.autoE[x] = 0; }
      for (const x of item.targets.segOff) { state.marks.edges[x] = 2; state.marks.autoE[x] = 0; }
      reconcileAutoX(state.P, prev, state.marks, settings.autoX);
      reconcileAutoShade(state.P, prev, state.marks, settings.autoShade);
      refresh();
      return true;
    },
    showHint: hint,
  };
}

init();
