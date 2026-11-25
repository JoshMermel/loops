// Printable Masyu booklets: fixed black-and-white SVG laid out by cell size to fit both A4 and Letter.
// Every page header links back to the site. Everything except buildPrintRoot is pure (tested in tests/print.test.mjs).
import { E_ON } from './logic.js';

const INK = '#111', GRID = '#8c8c8c';
export const MAX_PRINT = 500;
export const SITE_URL = 'https://joshmermelstein.com/masyu/';
export const SITE_TEXT = SITE_URL.replace(/^https:\/\//, '').replace(/\/$/, '');

/** "1-10, 15, 20-22" -> { ids: [1..10, 15, 20, 21, 22] } or { error }. */
export function parseSelection(text, total) {
  const parts = String(text || '').replace(/\s*[-–]\s*/g, '-').split(/[,\s]+/).filter(Boolean);
  if (!parts.length) return { error: 'Enter the puzzles to print, for example 1-10 or 3, 7, 12.' };
  const ids = new Set();
  for (const part of parts) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return { error: `"${part}" isn't a puzzle number or range.` };
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < 1 || a > total || b > total) return { error: `This book has puzzles 1 to ${total}.` };
    if (b < a) return { error: `"${part}" is backwards.` };
    for (let i = a; i <= b; i++) ids.add(i);
  }
  if (ids.size > MAX_PRINT) return { error: `Please print at most ${MAX_PRINT} puzzles at a time.` };
  return { ids: [...ids].sort((x, y) => x - y) };
}

export const SIZES = {
  comfortable: { label: 'Comfortable', puzzle: 7, answer: 4 },
  compact: { label: 'Compact', puzzle: 5.5, answer: 3.2 },
};
export const PAGE = { w: 186, h: 255, head: 14, caption: 8.5, colGap: 5, rowGap: 6 };
const BOARD_PAD = 0.12;
const CAPTION_CHAR_MM = 2.0;

export const boardUnits = (P) => [P.cols + BOARD_PAD, P.rows + BOARD_PAD];

export function captionMm(P, answer = false) {
  const chars = 1 + 3 + (!answer && P.tier ? 3 + P.tier.length : 0);
  return chars * CAPTION_CHAR_MM;
}

export function layoutFor(puzzles, cellMm, answer = false) {
  let w = 0, h = 0;
  for (const p of puzzles) {
    const [pw, ph] = boardUnits(p);
    w = Math.max(w, pw);
    h = Math.max(h, ph);
  }
  if (!w) return { cellMm, cols: 1, rows: 1, perPage: 1 };
  const cell = Math.min(cellMm, PAGE.w / w, (PAGE.h - PAGE.head - PAGE.caption) / h);
  const boardH = h * cell;
  let itemW = 0;
  for (const p of puzzles) itemW = Math.max(itemW, boardUnits(p)[0] * cell, captionMm(p, answer));
  const cols = Math.max(1, Math.floor((PAGE.w + PAGE.colGap) / (itemW + PAGE.colGap)));
  const rows = Math.max(1, Math.floor((PAGE.h - PAGE.head + PAGE.rowGap) / (boardH + PAGE.caption + PAGE.rowGap)));
  return { cellMm: cell, cols, rows, perPage: cols * rows };
}

export function planPrint({ puzzles, ids, keyIds = [], size = 'comfortable' }) {
  const { puzzle: puzzleMm, answer: answerMm } = SIZES[size] ?? SIZES.comfortable;
  const puzzleLayout = layoutFor(ids.map((id) => puzzles[id - 1]), puzzleMm);
  const keyLayout = keyIds.length ? layoutFor(keyIds.map((id) => puzzles[id - 1]), answerMm, true) : null;
  return {
    puzzleLayout,
    keyLayout,
    perPage: puzzleLayout.perPage,
    keyPerPage: keyLayout?.perPage ?? 0,
    puzzlePages: Math.ceil(ids.length / puzzleLayout.perPage),
    keyPages: keyLayout ? Math.ceil(keyIds.length / keyLayout.perPage) : 0,
  };
}

/** Fixed black-and-white Masyu board SVG (intersection-grid, 1 unit per step). Optional `sol` draws the loop. */
export function boardSvg(P, sol = null) {
  const { rows, cols } = P;
  const pad = 0.55;
  const w = cols - 1, h = rows - 1;
  let g = `<rect x="${-pad}" y="${-pad}" width="${w + 2 * pad}" height="${h + 2 * pad}" fill="#fff"/>`;
  for (let c = 0; c < cols; c++) g += `<line x1="${c}" y1="0" x2="${c}" y2="${h}" stroke="${GRID}" stroke-width="0.03"/>`;
  for (let r = 0; r < rows; r++) g += `<line x1="0" y1="${r}" x2="${w}" y2="${r}" stroke="${GRID}" stroke-width="0.03"/>`;

  if (sol) {
    for (let x = 0; x < P.numEdges; x++) {
      if (sol.e[x] !== E_ON) continue;
      const a = x >> 1, b = (x & 1) ? a + cols : a + 1;
      g += `<line class="loop" x1="${a % cols}" y1="${(a / cols) | 0}" x2="${b % cols}" y2="${(b / cols) | 0}" stroke="${INK}" stroke-width="0.14" stroke-linecap="round"/>`;
    }
  }
  // Circles on intersections (drawn above loop line so white/gray circles stay unobstructed)
  for (const cl of P.clues) {
    if (cl.t === 'W') {
      g += `<circle class="white-fill" cx="${cl.c}" cy="${cl.r}" r="0.21" fill="#fff"/>`;
      g += `<circle class="white-circle" cx="${cl.c}" cy="${cl.r}" r="0.21" fill="none" stroke="${INK}" stroke-width="0.065"/>`;
    } else if (cl.t === 'G') {
      g += `<circle class="gray-fill" cx="${cl.c}" cy="${cl.r}" r="0.215" fill="#b4b4b4"/>`;
      g += `<circle class="gray-circle" cx="${cl.c}" cy="${cl.r}" r="0.215" fill="none" stroke="#444" stroke-width="0.06"/>`;
    } else {
      g += `<circle class="black-circle" cx="${cl.c}" cy="${cl.r}" r="0.225" fill="${INK}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" class="print-board" viewBox="${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}">${g}</svg>`;
}

const div = (cls, parent, text) => {
  const el = document.createElement('div');
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  parent?.appendChild(el);
  return el;
};

export function buildPrintRoot({ book, puzzles, ids, size = 'comfortable', includeKey, solutionOf }) {
  let root = document.getElementById('print-root');
  if (!root) { root = document.createElement('div'); root.id = 'print-root'; document.body.appendChild(root); }
  root.textContent = '';

  const link = (text, cls) => { const a = document.createElement('a'); a.href = SITE_URL; a.textContent = text; a.className = cls; return a; };
  const addPages = (list, layout, withSolution, heading) => {
    const k = layout.perPage;
    for (let i = 0; i < list.length; i += k) {
      const page = div('print-page', root);
      const head = div('print-head', page);
      div('print-brand', head).append(link('Masyu', 'print-name'));
      head.append(link(SITE_TEXT, 'print-url'));
      div('print-book', head, `${book.title}${heading ? ` · ${heading}` : ''}`);
      const grid = div('print-grid', page);
      grid.style.setProperty('--cols', layout.cols);
      for (const id of list.slice(i, i + k)) {
        const P = puzzles[id - 1];
        const fig = div('print-item', grid);
        div('print-caption', fig, `#${id}${!withSolution && P.tier ? ` · ${P.tier}` : ''}`);
        fig.insertAdjacentHTML('beforeend', boardSvg(P, withSolution ? solutions.get(id) : null));
        fig.lastElementChild.style.width = `${boardUnits(P)[0] * layout.cellMm}mm`;
      }
    }
  };

  const solutions = new Map();
  const keyIds = [];
  if (includeKey) {
    for (const id of ids) {
      const sol = solutionOf(puzzles[id - 1]);
      if (sol) { solutions.set(id, sol); keyIds.push(id); }
    }
  }
  const plan = planPrint({ puzzles, ids, keyIds, size });
  addPages(ids, plan.puzzleLayout, false, null);
  if (keyIds.length) addPages(keyIds, plan.keyLayout, true, 'Answers');
  return root;
}
