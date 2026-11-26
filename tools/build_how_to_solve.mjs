#!/usr/bin/env node
// Generate docs/how_to_solve.md and docs/how_to_solve.html from the rule table in js/rating.js,
// docs/examples/examples.json, and images in docs/images/.
// Organized around shared single-loop fundamentals plus dedicated first-class sections for every puzzle family.
import fs from 'node:fs';
import path from 'node:path';
import { RULES, TIERS, TIER_INFO, HUMAN_ORDER } from '../js/rating.js';
import { MEDIUM_MAX, HARD_MAX } from '../js/imagine.js';
import { repoRoot } from './_cli.mjs';

const imagineCostLabel = (r) => (
  r.id === 'imagineLocal' ? `cost 22–${MEDIUM_MAX} (dynamic)`
    : r.id === 'imagineTrace' ? `cost 36–${HARD_MAX} (dynamic)`
      : r.id === 'imagineChain' ? `cost ≥ 80 (dynamic)`
        : `cost ${r.cost}`
);

const root = repoRoot(import.meta.url);
const examples = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'examples', 'examples.json'), 'utf8'));
const byRule = new Map(examples.map((e) => [e.rule, e]));

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const imgFor = (ruleId) => {
  const png = path.join(root, 'docs', 'images', `${ruleId}.png`);
  if (fs.existsSync(png)) return `images/${ruleId}.png`;
  return `images/${ruleId}.svg`;
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Partition rules into universal loop fundamentals vs. puzzle-family-specific rules
const isGrayRule = (r) => Boolean(r.grayOnly || r.id === 'grayFromShape');
const isPuzzleSpecific = (r) => Boolean(r.circleOnly || isGrayRule(r) || r.slitherOnly || r.midloopOnly || r.fullBoardOnly);
const sortByLadder = (list) => list.slice().sort((a, b) => (
  TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.cost - b.cost
));

const UNIVERSAL_TIER_BLURBS = {
  Beginner: 'direct local deductions — basic clue rules, dead ends, forced exits, and not closing the loop early',
  Medium: 'multi-step local patterns, basic border-anchored Inside/Outside shading, and 1-step local lookahead',
  Hard: 'clue-powered Inside/Outside shading, global loop topology (corridors, chokepoints, parity), symmetry, and short single-thread lookahead',
  Expert: 'longer multi-front or area-parity lookahead chains and trial-and-contradiction deductions',
};

const universalFreeRules = RULES.filter((r) => r.free && !isPuzzleSpecific(r));
const universalForTier = (tier) => {
  const base = HUMAN_ORDER.filter((r) => r.tier === tier && !isPuzzleSpecific(r));
  const virtuals = RULES.filter((r) => r.virtual && r.tier === tier && !isPuzzleSpecific(r));
  return [...base, ...virtuals].sort((a, b) => a.cost - b.cost);
};

const PUZZLE_SECTIONS = [
  {
    id: 'puzzle-masyu',
    title: 'Masyu',
    icon: '⚪',
    summaryMd: '**White circles (○):** pass straight through and turn 90° at least once at an adjacent intersection. **Black circles (●):** turn 90° at the circle and go straight for at least two segments in both exit directions.',
    summaryHtml: '<b>White circles (○):</b> pass straight through and turn 90° at least once at an adjacent intersection. <b>Black circles (●):</b> turn 90° at the circle and go straight for at least two segments in both exit directions.',
    rules: sortByLadder(RULES.filter((r) => r.circleOnly && !r.free)),
    subgroups: [
      {
        id: 'variant-gray',
        title: 'Gray circles',
        introMd: 'Each gray circle is secretly either a **white** or a **black** circle — figuring out which is part of the puzzle. Tap a gray circle in the app to label it as an optional note.',
        introHtml: 'Each gray circle is secretly either a <b>white</b> or a <b>black</b> circle — figuring out which is part of the puzzle. Tap a gray circle in the app to label it as an optional note.',
        freeRules: RULES.filter((r) => isGrayRule(r) && r.free),
        rules: sortByLadder(RULES.filter((r) => isGrayRule(r) && !r.free)),
      },
    ],
  },
  {
    id: 'variant-slitherlink',
    title: 'Slitherlink',
    icon: '🔢',
    summaryMd: 'Each number **0–3** sits inside a grid square and tells how many of that square’s four sides belong to the single closed loop (blank squares can have any number of sides).',
    summaryHtml: 'Each number <b>0–3</b> sits inside a grid square and tells how many of that square’s four sides belong to the single closed loop (blank squares can have any number of sides).',
    rules: sortByLadder(RULES.filter((r) => r.slitherOnly && !r.free)),
    subgroups: [],
  },
  {
    id: 'variant-midloop',
    title: 'Mid-loop',
    icon: '🎯',
    summaryMd: 'Every teal dot sits either on an intersection (even straight run: 2, 4, …) or on a segment midpoint (odd straight run: 1, 3, …). The single closed loop must pass **straight through** every teal dot with **equal straight lengths** on both sides up to the 90° turns at each end. Because intersection dots always go straight through, diagonal Inside/Outside shading (`faceCircle`) also applies to them.',
    summaryHtml: 'Every teal dot sits either on an intersection (even straight run: 2, 4, …) or on a segment midpoint (odd straight run: 1, 3, …). The single closed loop must pass <b>straight through</b> every teal dot with <b>equal straight lengths</b> on both sides up to the 90° turns at each end. Because intersection dots always go straight through, diagonal Inside/Outside shading (<a href="#faceCircle"><code>faceCircle</code></a>) also applies to them.',
    rules: sortByLadder(RULES.filter((r) => r.midloopOnly && !r.free)),
    subgroups: [],
  },
  {
    id: 'variant-full',
    title: 'Hamilton cycle',
    icon: '🔁',
    summaryMd: 'The loop must visit **every** active intersection dot on the grid (none may be left empty). Dark pre-filled segments and bold **✕** walls are permanent givens.',
    summaryHtml: 'The loop must visit <b>every</b> active intersection dot on the grid (none may be left empty). Dark pre-filled segments and bold <b>✕</b> walls are permanent givens.',
    rules: sortByLadder(RULES.filter((r) => r.fullBoardOnly && !r.free)),
    subgroups: [],
  },
];

// Sanity check: every rule in RULES must appear exactly once
const covered = new Set([
  ...universalFreeRules.map((r) => r.id),
  ...TIERS.flatMap((t) => universalForTier(t).map((r) => r.id)),
  ...PUZZLE_SECTIONS.flatMap((s) => [
    ...s.rules.map((r) => r.id),
    ...s.subgroups.flatMap((sg) => [...sg.freeRules.map((r) => r.id), ...sg.rules.map((r) => r.id)]),
  ]),
]);
const missingRules = RULES.filter((r) => !covered.has(r.id)).map((r) => r.id);
if (missingRules.length) {
  throw new Error(`Rules missing from how_to_solve layout: ${missingRules.join(', ')}`);
}

// ------------------------------------------------------------ Markdown generation

const out = [];
const say = (...lines) => out.push(...lines);

const emitRuleMd = (r, heading = '###') => {
  const costLabel = imagineCostLabel(r);
  say(`${heading} ${r.id}`, '', `*${r.tier}, ${costLabel}*`, '');
  say(`${cap(r.label)}.`, '');
  const e = byRule.get(r.id);
  if (e) {
    const link = `../index.html?book=armory&puzzle=${e.puzzle}`;
    const presses = e.hints === 0 ? 'the empty board' : `after ${e.hints} earlier hint${e.hints === 1 ? '' : 's'}`;
    say(
      `<a href="${link}"><img src="${imgFor(r.id)}" width="480" alt="${r.id} hint example"></a>`,
      '',
      `*${e.name} (${e.cols}×${e.rows}, ${presses}). Click the picture to open this puzzle in the app.*`,
      '',
      `> Hint says: "${e.text}"`,
      '',
    );
  } else {
    say('*No puzzle in the current corpus needed this rule as its cheapest next hint yet (cheaper rules resolved those positions first).*', '');
  }
  say('---', '');
};

say(
  '# How to solve — Loop Puzzles',
  '',
  '<!-- Generated by tools/build_how_to_solve.mjs from js/rating.js, docs/examples/examples.json, and docs/images/. -->',
  '',
  'Every solving technique the Hint button knows across **Masyu**, **Slitherlink**, **Mid-loop**, **Hamilton cycle**, and **Hybrids** — grouped into shared loop fundamentals plus each puzzle’s own rules.',
  'The same rule table powers both difficulty grading and live hints (see [README.md](../README.md)).',
  '',
  '## Rules at a glance',
  '',
  'Every puzzle in the collection shares one core objective: draw **one single closed loop** along the grid lines orthogonally, with no crossings or branches. Each puzzle family adds its own clue rules (and **Hybrids** books combine any two on the same board):',
  '',
  '- **[Masyu](#masyu):** Visit every circle — go straight through white circles (○) and turn at an adjacent intersection; turn 90° at black circles (●) and go straight two segments in each direction.',
  '- **[Slitherlink](#slitherlink):** Each number `0–3` inside a square tells how many of its four sides belong to the loop.',
  '- **[Mid-loop](#mid-loop):** Pass straight through every teal dot (on intersections for even runs, or segment midpoints for odd runs) with equal straight length on both sides.',
  '- **[Hamilton cycle](#hamilton-cycle):** Visit every active intersection dot on the grid, respecting any given lines and walls.',
  '- **[Modifiers & Hybrids](#board-modifiers--hybrids):** Gray circles (mystery white/black), Swiss cheese cutout holes (each hole is entirely Inside or Outside), and two-ruleset hybrids where every puzzle genuinely needs both.',
  '',
  '## How the examples work',
  '',
  'Each illustration shows a position reached by following **Hint** from an empty board, together with the Hint button’s own highlights, ghost marks, and explanation.',
  'The example puzzles live in a hidden book (`data/armory.csv`, `"hidden": true` in `data/manifest.json`); click any picture to open that exact puzzle in the app (`index.html?book=armory&puzzle=N`).',
  '',
  '## Loop fundamentals',
  '',
  'These shared techniques apply to **every** puzzle family — Masyu, Slitherlink, Mid-loop, Hamilton cycle, and all Hybrids. A puzzle’s overall difficulty (**Beginner**, **Medium**, **Hard**, or **Expert**) is set by the highest tier among all required steps (both loop fundamentals and puzzle-specific rules).',
  '',
  '### Bookkeeping',
  '',
  `${universalFreeRules.length} core bookkeeping rules cost 1 each and run automatically before each hint step so the board stays tidy:`,
  '',
);

for (const r of universalFreeRules) {
  say(`- \`${r.id}\` (cost ${r.cost}): ${cap(r.label)}.`);
}
say('');

const activeUniversalTiers = TIERS.filter((t) => universalForTier(t).length > 0);
for (const tier of activeUniversalTiers) {
  const blurb = UNIVERSAL_TIER_BLURBS[tier] || TIER_INFO[tier]?.blurb;
  say(`### ${tier}`, '');
  if (blurb) say(`A puzzle is rated **${tier}** when its hardest required step is in this tier: ${blurb}.`, '');
  for (const r of universalForTier(tier)) emitRuleMd(r, '####');
}

for (const sec of PUZZLE_SECTIONS) {
  say(`## ${sec.title}`, '', sec.summaryMd, '');
  for (const r of sec.rules) emitRuleMd(r, '###');
  for (const sg of sec.subgroups) {
    say(`### ${sg.title}`, '', sg.introMd, '');
    if (sg.freeRules.length) {
      for (const r of sg.freeRules) say(`- Bookkeeping: \`${r.id}\` (cost ${r.cost}): ${cap(r.label)}.`);
      say('');
    }
    for (const r of sg.rules) emitRuleMd(r, '####');
  }
}

say(
  '## Board modifiers & Hybrids',
  '',
  '### Swiss cheese',
  '',
  'Cutout holes cannot be entered. Every enclosed hole lies entirely **Inside** or entirely **Outside** the loop (tap anywhere in a hole to shade it). All loop techniques — especially border rules, `chokepoint`, `faceShade`, `faceCircle`, and `faceSlither` — work naturally around and across interior holes.',
  '',
  '### Hybrids',
  '',
  'In **Hybrids** books, two clue families (such as Masyu + Hamilton cycle, Slitherlink + Masyu, Slitherlink + Hamilton cycle, Mid-loop + Masyu, Mid-loop + Slitherlink, or Mid-loop + Hamilton cycle) share one single closed loop, and every puzzle is verified to genuinely require both rule sets. Inside/Outside shading and Mid-loop ray constraints automatically combine across clue families.',
  '',
);

fs.writeFileSync(path.join(root, 'docs', 'how_to_solve.md'), out.join('\n').replace(/\n---\n$/, '\n'), 'utf8');

// ------------------------------------------------------------ Standalone HTML generation

const renderRuleCardHtml = (r) => {
  const costLabel = imagineCostLabel(r);
  const e = byRule.get(r.id);
  let body;
  if (e) {
    const link = `../index.html?book=armory&puzzle=${e.puzzle}`;
    const presses = e.hints === 0 ? 'the empty board' : `after ${e.hints} earlier hint${e.hints === 1 ? '' : 's'}`;
    body = `
      <a class="rule-img" href="${esc(link)}"><img src="${esc(imgFor(r.id))}" alt="${esc(r.id)} hint example" loading="lazy"></a>
      <p class="caption">${esc(e.name)} (${e.cols}×${e.rows}, ${presses}). Click the picture to open this puzzle in the app.</p>
      <blockquote>Hint says: "${esc(e.text)}"</blockquote>`;
  } else {
    body = `
      <p class="none">No puzzle in the current corpus needed this rule as its cheapest next hint yet (cheaper rules resolved those positions first).</p>`;
  }
  return `
    <section class="rule-card" id="${esc(r.id)}">
      <h3><code>${esc(r.id)}</code></h3>
      <div class="rule-meta">${esc(r.tier)}, ${esc(costLabel)}</div>
      <p>${esc(cap(r.label))}.</p>${body}
    </section>`;
};

const htmlParts = [];
htmlParts.push(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>How to Solve — Loop Puzzles</title>
  <meta name="description" content="Every solving technique the Hint button knows across Masyu, Slitherlink, Mid-loop, Hamilton cycle, and Hybrids, with interactive examples.">
  <link rel="icon" href="../favicon.svg" type="image/svg+xml">
  <script>
    (function () {
      var dark = false;
      try { dark = localStorage.getItem('ms_dark') === '1'; } catch (e) {}
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    })();
  </script>
  <style>
    :root {
      --bg: #f6f8fa; --card: #ffffff; --text: #1c2128; --muted: #57606a;
      --border: #d8dee4; --accent: #1976d2; --code-bg: #eef2f6; --quote-bg: #f0f6fc;
    }
    :root[data-theme="dark"] {
      --bg: #0f1318; --card: #161b22; --text: #e6edf3; --muted: #9aa4b2;
      --border: #2c3440; --accent: #6cb4ff; --code-bg: #1f2630; --quote-bg: #1a2433;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.55;
    }
    main { max-width: 760px; margin: 0 auto; }
    .back { display: inline-block; margin-bottom: 12px; color: var(--accent); text-decoration: none; font-weight: 600; }
    .back:hover { text-decoration: underline; }
    h1 { margin: 0 0 8px; font-size: 1.9rem; }
    h2 { margin: 36px 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--border); font-size: 1.38rem; }
    h3 { margin: 0 0 4px; font-size: 1.1rem; }
    .sub-heading { margin: 26px 0 8px; font-size: 1.18rem; }
    p { margin: 0 0 12px; }
    ul { margin: 0 0 14px; padding-left: 22px; }
    li { margin: 4px 0; }
    code { background: var(--code-bg); padding: 1px 6px; border-radius: 4px; font-size: 0.9em; }
    .lead { color: var(--muted); font-size: 1.02rem; }
    .toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 22px; }
    .toc a {
      padding: 5px 12px; border-radius: 999px; border: 1px solid var(--border);
      background: var(--card); color: var(--accent); text-decoration: none; font-size: 0.88rem; font-weight: 600;
    }
    .toc a:hover { border-color: var(--accent); }
    .family-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px; margin: 12px 0 18px;
    }
    .family-card {
      background: var(--card); border: 1px solid var(--border); border-radius: 10px;
      padding: 12px 14px; text-decoration: none; color: inherit; display: block;
    }
    .family-card:hover { border-color: var(--accent); }
    .family-card b { display: block; margin-bottom: 4px; color: var(--accent); }
    .family-card span { font-size: 0.88rem; color: var(--muted); }
    .rule-card {
      background: var(--card); border: 1px solid var(--border); border-radius: 10px;
      padding: 16px 18px; margin: 14px 0;
    }
    .rule-meta { color: var(--muted); font-size: 0.86rem; font-style: italic; margin-bottom: 8px; }
    .rule-img { display: block; margin: 12px 0 8px; }
    .rule-img img { max-width: 100%; width: 460px; height: auto; border-radius: 8px; border: 1px solid var(--border); background: #fff; }
    .caption { color: var(--muted); font-size: 0.85rem; margin-bottom: 10px; }
    blockquote {
      margin: 8px 0 0; padding: 10px 14px; border-left: 3px solid var(--accent);
      background: var(--quote-bg); border-radius: 0 6px 6px 0; font-size: 0.95rem;
    }
    .none { color: var(--muted); font-style: italic; margin: 8px 0 0; }
  </style>
</head>
<body>
  <main>
    <a class="back" href="../index.html">← Back to Puzzles</a>
    <h1>How to Solve — Loop Puzzles</h1>
    <p class="lead">Every solving technique the Hint button knows across <b>Masyu</b>, <b>Slitherlink</b>, <b>Mid-loop</b>, <b>Hamilton cycle</b>, and <b>Hybrids</b>. Click any diagram to open that exact puzzle in the app.</p>
    <nav class="toc" aria-label="Jump to section">
      <a href="#rules">Rules at a glance</a>
      <a href="#loop-fundamentals">Loop fundamentals</a>
      ${PUZZLE_SECTIONS.map((s) => `<a href="#${esc(s.id)}">${esc(s.icon)} ${esc(s.title)}</a>`).join('\n      ')}
      <a href="#variant-swiss">🧀 Modifiers &amp; Hybrids</a>
    </nav>

    <h2 id="rules">Rules at a glance</h2>
    <p>Every puzzle shares one core goal: draw <b>one single closed loop</b> along the grid lines with no crossings or branches. Jump directly to any puzzle family:</p>
    <div class="family-grid">
      <a class="family-card" href="#puzzle-masyu"><b>⚪ Masyu</b><span>Go straight through white circles (turning beside them); turn 90° at black circles (going straight two steps out).</span></a>
      <a class="family-card" href="#variant-slitherlink"><b>🔢 Slitherlink</b><span>Each number 0–3 inside a square tells how many of its four sides belong to the single closed loop.</span></a>
      <a class="family-card" href="#variant-midloop"><b>🎯 Mid-loop</b><span>Pass straight through every teal dot at the exact midpoint of its straight segment (equal length on both sides).</span></a>
      <a class="family-card" href="#variant-full"><b>🔁 Hamilton cycle</b><span>Visit every active intersection dot on the grid, guided by permanent given lines and ✕ walls.</span></a>
      <a class="family-card" href="#variant-gray"><b>🔘 Gray circles</b><span>Masyu circles whose color (white or black) is hidden — deduce which each one is as you solve.</span></a>
      <a class="family-card" href="#variant-swiss"><b>🧀 Swiss cheese &amp; Hybrids</b><span>Cutout holes (each entirely Inside or Outside) and two-ruleset hybrids that genuinely require both.</span></a>
    </div>

    <h2 id="loop-fundamentals">Loop fundamentals</h2>
    <p>These universal techniques work identically on <b>every</b> puzzle family. A puzzle’s difficulty tier (Beginner, Medium, Hard, or Expert) comes from the hardest required rule across both loop fundamentals and puzzle-specific techniques.</p>
    <nav class="toc" aria-label="Jump to fundamental tier">
      <a href="#bookkeeping">Bookkeeping</a>
      ${activeUniversalTiers.map((t) => `<a href="#${t.toLowerCase()}">${esc(t)}</a>`).join('\n      ')}
    </nav>

    <h3 class="sub-heading" id="bookkeeping">Bookkeeping</h3>
    <p>${universalFreeRules.length} core bookkeeping rules cost 1 each and run automatically before each hint step so the board stays tidy:</p>
    <ul>
      ${universalFreeRules.map((r) => `<li><code>${esc(r.id)}</code> (cost ${r.cost}): ${esc(cap(r.label))}.</li>`).join('\n      ')}
    </ul>`);

for (const tier of activeUniversalTiers) {
  const blurb = UNIVERSAL_TIER_BLURBS[tier] || TIER_INFO[tier]?.blurb;
  htmlParts.push(`
    <h3 class="sub-heading" id="${tier.toLowerCase()}">${esc(tier)}</h3>
    ${blurb ? `<p>A puzzle is rated <b>${esc(tier)}</b> when its hardest required step is in this tier: ${esc(blurb)}.</p>` : ''}`);
  for (const r of universalForTier(tier)) htmlParts.push(renderRuleCardHtml(r));
}

for (const sec of PUZZLE_SECTIONS) {
  htmlParts.push(`
    <h2 id="${esc(sec.id)}">${esc(sec.icon)} ${esc(sec.title)}</h2>
    <p>${sec.summaryHtml}</p>`);
  for (const r of sec.rules) htmlParts.push(renderRuleCardHtml(r));
  for (const sg of sec.subgroups) {
    htmlParts.push(`
    <h3 class="sub-heading" id="${esc(sg.id)}">${esc(sg.title)}</h3>
    <p>${sg.introHtml}</p>`);
    if (sg.freeRules.length) {
      htmlParts.push(`
    <ul>
      ${sg.freeRules.map((r) => `<li><b>Bookkeeping:</b> <code>${esc(r.id)}</code> (cost ${r.cost}): ${esc(cap(r.label))}.</li>`).join('\n      ')}
    </ul>`);
    }
    for (const r of sg.rules) htmlParts.push(renderRuleCardHtml(r));
  }
}

htmlParts.push(`
    <h2 id="variant-rules">Board modifiers &amp; Hybrids</h2>
    <h3 class="sub-heading" id="variant-swiss">🧀 Swiss cheese</h3>
    <p>Cutout holes cannot be entered. Every enclosed hole lies entirely <b>Inside</b> or entirely <b>Outside</b> the loop (tap anywhere in a hole to shade it). All loop techniques — especially border rules, <a href="#chokepoint"><code>chokepoint</code></a>, <a href="#faceShade"><code>faceShade</code></a>, <a href="#faceCircle"><code>faceCircle</code></a>, and <a href="#faceSlither"><code>faceSlither</code></a> — work naturally around and across interior holes.</p>
    <h3 class="sub-heading" id="hybrids">🔀 Hybrids</h3>
    <p>In <b>Hybrids</b> books, two clue families (Masyu + Hamilton cycle, Slitherlink + Masyu, Slitherlink + Hamilton cycle, Mid-loop + Masyu, Mid-loop + Slitherlink, or Mid-loop + Hamilton cycle) share one single closed loop, and every puzzle is verified to genuinely require both rule sets. Inside/Outside shading and Mid-loop ray constraints automatically combine across clue families.</p>
  </main>
</body>
</html>
`);

fs.writeFileSync(path.join(root, 'docs', 'how_to_solve.html'), htmlParts.join('\n'), 'utf8');
console.log(`Generated docs/how_to_solve.md and docs/how_to_solve.html (${examples.length} illustrated rules across ${RULES.length} total rules).`);
