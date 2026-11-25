#!/usr/bin/env node
// Render standalone light-theme SVG illustrations (intersection-grid layout) for every example in
// docs/examples/examples.json into docs/images/<rule>.svg, matching the live app's exact styling.
import fs from 'node:fs';
import path from 'node:path';
import { compile, parseCsv, colName, edgeCells } from '../js/logic.js';
import { describeMarks } from '../js/explain.js';
import { repoRoot } from './_cli.mjs';

const root = repoRoot(import.meta.url);
const examples = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'examples', 'examples.json'), 'utf8'));
const armory = parseCsv(fs.readFileSync(path.join(root, 'data', 'armory.csv'), 'utf8'));
const outDir = path.join(root, 'docs', 'images');
fs.mkdirSync(outDir, { recursive: true });

const S = 40;
const PAD = 22;
const LABEL = 18;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wrapText(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

for (const ex of examples) {
  const P = compile({ ...armory[ex.puzzle - 1] });
  const edges = Uint8Array.from(ex.edges, Number);
  const grays = ex.grays ? Uint8Array.from(ex.grays, Number) : null;
  const grayLabel = (cell) => {
    const k = P.grayAt ? P.grayAt[cell] : -1;
    return (grays && k >= 0) ? grays[k] : 0;
  };

  const innerW = (P.cols - 1) * S + 2 * PAD;
  const innerH = (P.rows - 1) * S + 2 * PAD;
  const boardW = innerW + LABEL;
  const boardH = innerH + LABEL;
  const cardW = Math.max(boardW + 24, 460);
  const bx = Math.round((cardW - boardW) / 2);
  const by = 12;

  const vx = (c) => PAD + c * S;
  const vy = (r) => PAD + r * S;
  const ix = (i) => PAD + (i % P.cols) * S;
  const iy = (i) => PAD + ((i / P.cols) | 0) * S;
  const segCoords = (x) => {
    const [a, b] = edgeCells(P, x);
    return [ix(a), iy(a), ix(b), iy(b)];
  };

  let g = `<rect x="1" y="1" width="${innerW - 2}" height="${innerH - 2}" rx="8" fill="#ffffff" stroke="#e0e0e0" stroke-width="1.5"/>`;

  // Dual-face Inside/Outside hint shading (for faceParity)
  if (ex.faces && P.rows > 1 && P.cols > 1) {
    const fc = P.cols - 1;
    for (const f of ex.faces.in || []) {
      const r = (f / fc) | 0, c = f % fc;
      g += `<rect x="${vx(c) + 2}" y="${vy(r) + 2}" width="${S - 4}" height="${S - 4}" rx="4" fill="rgba(38,166,154,0.28)" stroke="rgba(38,166,154,0.75)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    }
    for (const f of ex.faces.out || []) {
      const r = (f / fc) | 0, c = f % fc;
      g += `<rect x="${vx(c) + 2}" y="${vy(r) + 2}" width="${S - 4}" height="${S - 4}" rx="4" fill="rgba(245,166,85,0.28)" stroke="rgba(230,140,50,0.75)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    }
  }

  // Role tints
  const roles = ex.roles || {};
  const roleFill = {
    area: 'rgba(25,118,210,0.13)',
    clue: 'rgba(25,118,210,0.26)',
    path: 'rgba(122,81,149,0.28)',
    problem: 'url(#hatch)',
    focus: 'rgba(244,236,156,0.8)',
  };
  for (const i of roles.area || []) {
    g += `<rect x="${ix(i) - S / 2}" y="${iy(i) - S / 2}" width="${S}" height="${S}" fill="${roleFill.area}"/>`;
  }
  for (const role of ['clue', 'path', 'problem', 'focus']) {
    for (const i of roles[role] || []) {
      g += `<rect x="${ix(i) - S / 2 + 3}" y="${iy(i) - S / 2 + 3}" width="${S - 6}" height="${S - 6}" rx="8" fill="${roleFill[role]}"/>`;
    }
  }

  // Lattice lines
  for (let r = 0; r < P.rows; r++) g += `<line x1="${vx(0)}" y1="${vy(r)}" x2="${vx(P.cols - 1)}" y2="${vy(r)}" stroke="#cccccc" stroke-width="1.2"/>`;
  for (let c = 0; c < P.cols; c++) g += `<line x1="${vx(c)}" y1="${vy(0)}" x2="${vx(c)}" y2="${vy(P.rows - 1)}" stroke="#cccccc" stroke-width="1.2"/>`;

  // Existing segments (behind all pearls so circles read cleanly)
  for (let x = 0; x < P.numEdges; x++) {
    if (edges[x] !== 1) continue;
    const [x1, y1, x2, y2] = segCoords(x);
    g += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1976d2" stroke-width="${S * 0.14}" stroke-linecap="round"/>`;
  }

  // Circles (white, black, unlabeled gray, and 0° 2×2 checkerboard labeled gray) on top of segments
  const checkerQuads = (cx, cy, r) => (
    `M${cx} ${cy}V${cy - r}A${r} ${r} 0 0 1 ${cx + r} ${cy}ZM${cx} ${cy}V${cy + r}A${r} ${r} 0 0 1 ${cx - r} ${cy}Z`
  );
  for (const cl of P.clues) {
    const cx = vx(cl.c), cy = vy(cl.r);
    if (cl.t === 'W') {
      g += `<circle cx="${cx}" cy="${cy}" r="${S * 0.21}" fill="#ffffff"/>`;
      g += `<circle cx="${cx}" cy="${cy}" r="${S * 0.21}" fill="none" stroke="#111111" stroke-width="2.2"/>`;
    } else if (cl.t === 'G') {
      const lbl = grayLabel(cl.r * P.cols + cl.c);
      if (lbl === 0) {
        g += `<circle cx="${cx}" cy="${cy}" r="${S * 0.215}" fill="#b6bcc4"/>`;
        g += `<circle cx="${cx}" cy="${cy}" r="${S * 0.215}" fill="none" stroke="#5a626c" stroke-width="2.2"/>`;
      } else if (lbl === 1) {
        const r = S * 0.22;
        g += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff"/>`;
        g += `<path d="${checkerQuads(cx, cy, r)}" fill="#aeb5be"/>`;
        g += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#111111" stroke-width="2.2"/>`;
      } else {
        const r = S * 0.22;
        g += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#111111"/>`;
        g += `<path d="${checkerQuads(cx, cy, r)}" fill="#969ea8"/>`;
        g += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#111111" stroke-width="2.2"/>`;
      }
    } else {
      g += `<circle cx="${cx}" cy="${cy}" r="${S * 0.22}" fill="#111111"/>`;
    }
  }

  // Existing edge X marks
  for (let x = 0; x < P.numEdges; x++) {
    if (edges[x] !== 2) continue;
    const [x1, y1, x2, y2] = segCoords(x);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, d = S * 0.085;
    const p = `M${mx - d} ${my - d}L${mx + d} ${my + d}M${mx - d} ${my + d}L${mx + d} ${my - d}`;
    g += `<path d="${p}" stroke="#ffffff" stroke-width="3.6" stroke-linecap="round"/><path d="${p}" stroke="#757575" stroke-width="1.8" stroke-linecap="round"/>`;
  }

  // Hint overlays
  for (const i of roles.exit || []) g += `<circle cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.36}" fill="none" stroke="#2e7d32" stroke-width="2.2" stroke-dasharray="4 3"/>`;
  for (const i of roles.focus || []) g += `<circle cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.38}" fill="none" stroke="#8a6d00" stroke-width="2.8"/>`;

  for (const x of ex.chain || []) {
    const [x1, y1, x2, y2] = segCoords(x);
    g += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#d55e00" stroke-width="${S * 0.11}" stroke-linecap="round" stroke-dasharray="6 5" opacity="0.92"/>`;
  }
  const targets = ex.targets || {};
  for (const x of targets.segOn || []) {
    const [x1, y1, x2, y2] = segCoords(x);
    const len = Math.hypot(x2 - x1, y2 - y1), k = (S * 0.24) / len;
    g += `<line x1="${x1 + (x2 - x1) * k}" y1="${y1 + (y2 - y1) * k}" x2="${x2 - (x2 - x1) * k}" y2="${y2 - (y2 - y1) * k}" stroke="#8a6d00" stroke-width="${S * 0.14}" stroke-linecap="round" stroke-dasharray="5 4"/>`;
  }
  for (const x of targets.segOff || []) {
    const [x1, y1, x2, y2] = segCoords(x);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, d = S * 0.11;
    const p = `M${mx - d} ${my - d}L${mx + d} ${my + d}M${mx - d} ${my + d}L${mx + d} ${my - d}`;
    g += `<path d="${p}" stroke="#ffffff" stroke-width="5.2" stroke-linecap="round"/><path d="${p}" stroke="#c62828" stroke-width="2.6" stroke-linecap="round"/>`;
  }
  for (const i of targets.grayWhite || []) {
    g += `<circle cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.165}" fill="#ffffff" stroke="#8a6d00" stroke-width="2.2" stroke-dasharray="4 2.5"/>`;
  }
  for (const i of targets.grayBlack || []) {
    g += `<circle cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.165}" fill="#111111" stroke="#8a6d00" stroke-width="2.2" stroke-dasharray="4 2.5"/>`;
  }

  // Axis labels
  let labels = '';
  for (let c = 0; c < P.cols; c++) labels += `<text x="${LABEL + vx(c)}" y="${LABEL - 4}" fill="#777777" font-size="11" font-family="system-ui, sans-serif" text-anchor="middle">${colName(c)}</text>`;
  for (let r = 0; r < P.rows; r++) labels += `<text x="${LABEL - 4}" y="${LABEL + vy(r) + 4}" fill="#777777" font-size="11" font-family="system-ui, sans-serif" text-anchor="end">${r + 1}</text>`;

  // Hint toast box beneath board
  const meta = `${ex.tier} · ${ex.rule} (cost ${ex.weight})`;
  const move = `Move: ${describeMarks(P, targets)}.`;
  const textLines = wrapText(ex.text, 62);
  const moveLines = wrapText(move, 66);
  const boxX = 14, boxY = by + boardH + 10, boxW = cardW - 28;
  const boxH = 28 + textLines.length * 17 + moveLines.length * 15 + 14;
  const totalH = boxY + boxH + 12;

  let toastSvg = `<rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="8" fill="#181818"/>`;
  toastSvg += `<text x="${boxX + 12}" y="${boxY + 20}" fill="#bbbbbb" font-size="11" font-family="ui-monospace, Menlo, monospace">${esc(meta)}</text>`;
  let ty = boxY + 39;
  for (const line of textLines) {
    toastSvg += `<text x="${boxX + 12}" y="${ty}" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif">${esc(line)}</text>`;
    ty += 17;
  }
  ty += 3;
  for (const line of moveLines) {
    toastSvg += `<text x="${boxX + 12}" y="${ty}" fill="#cccccc" font-size="11.5" font-family="system-ui, sans-serif">${esc(line)}</text>`;
    ty += 15;
  }

  const defs = `<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#d55e00" stroke-width="3" opacity="0.55"/></pattern></defs>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cardW}" height="${totalH}" viewBox="0 0 ${cardW} ${totalH}">`
    + `<rect width="${cardW}" height="${totalH}" rx="10" fill="#fafafa" stroke="#e2e2e2"/>`
    + defs
    + `<g transform="translate(${bx} ${by})">${labels}<g transform="translate(${LABEL} ${LABEL})">${g}</g></g>`
    + toastSvg
    + `</svg>\n`;

  fs.writeFileSync(path.join(outDir, `${ex.rule}.svg`), svg, 'utf8');
}

const activeSvgs = new Set(examples.map((ex) => `${ex.rule}.svg`));
for (const file of fs.readdirSync(outDir)) {
  if (file.endsWith('.svg') && !activeSvgs.has(file)) {
    fs.unlinkSync(path.join(outDir, file));
  }
}

console.log(`Rendered ${examples.length} hint illustrations into docs/images/*.svg`);
