#!/usr/bin/env node
// Generate docs/how_to_solve.md from the rule table in js/rating.js, docs/examples/examples.json,
// and images in docs/images/ (prefers .png if captured via Playwright, else crisp .svg from render_how_to_images.mjs).
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

const VARIANT_GROUPS = [
  {
    id: 'variant-gray',
    title: 'Gray circles',
    intro: 'Each gray circle is secretly either a **white** or a **black** circle — figuring out which is part of the puzzle. Tap a gray circle in the app to label it as an optional note.',
    htmlIntro: 'Each gray circle is secretly either a <b>white</b> or a <b>black</b> circle — figuring out which is part of the puzzle. Tap a gray circle in the app to label it as an optional note.',
    ruleIds: ['grayFromShape', 'grayMustBeBlack', 'grayMustBeWhite', 'grayWhiteNoTurn'],
  },
  {
    id: 'variant-full',
    title: 'Hamilton cycle',
    intro: 'The loop must visit **every** intersection dot on the grid (none may be left empty). Dark pre-filled segments and bold **✕** walls are permanent givens. Also combines with Masyu or Slitherlink in **Hybrids** books.',
    htmlIntro: 'The loop must visit <b>every</b> intersection dot on the grid (none may be left empty). Dark pre-filled segments and bold <b>✕</b> walls are permanent givens. Also combines with Masyu or Slitherlink in <b>Hybrids</b> books.',
    ruleIds: ['checkerPocket', 'checkerParity'],
  },
  {
    id: 'variant-swiss',
    title: 'Swiss cheese',
    intro: 'Cutout holes cannot be entered. Every enclosed hole lies entirely **Inside** or entirely **Outside** the loop (tap anywhere in a hole to shade it). All core Masyu techniques — especially border rules, `chokepoint`, `faceShade`, and `faceCircle` — work naturally around and across interior holes.',
    htmlIntro: 'Cutout holes cannot be entered. Every enclosed hole lies entirely <b>Inside</b> or entirely <b>Outside</b> the loop (tap anywhere in a hole to shade it). All core Masyu techniques — especially border rules, <code>chokepoint</code>, <code>faceShade</code>, and <code>faceCircle</code> — work naturally around and across interior holes.',
    ruleIds: [],
  },
  {
    id: 'variant-slitherlink',
    title: 'Slitherlink & Hybrids',
    intro: 'Each number **0–3** sits inside a grid square and tells how many of that square’s four sides belong to the single closed loop (blank squares can have any number of sides). In **Hybrids** books, numbered squares share the same single loop with Masyu circles or a Hamilton cycle.',
    htmlIntro: 'Each number <b>0–3</b> sits inside a grid square and tells how many of that square’s four sides belong to the single closed loop (blank squares can have any number of sides). In <b>Hybrids</b> books, numbered squares share the same single loop with Masyu circles or a Hamilton cycle.',
    ruleIds: ['slitherZero', 'slitherCount', 'slitherCorner', 'slitherAdjacent3', 'slitherDiag3', 'slither3LineIn', 'slither1LineIn', 'slitherDiag32', 'faceSlither'],
  },
];
const VARIANT_RULE_IDS = new Set(VARIANT_GROUPS.flatMap((g) => g.ruleIds));
const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

const orderedForTier = (tier) => {
  const base = HUMAN_ORDER.filter((r) => r.tier === tier && !VARIANT_RULE_IDS.has(r.id));
  const virtuals = RULES.filter((r) => r.virtual && r.tier === tier && !VARIANT_RULE_IDS.has(r.id));
  return [...base, ...virtuals].sort((a, b) => a.cost - b.cost);
};
const coreFreeRules = RULES.filter((x) => x.free && !VARIANT_RULE_IDS.has(x.id));

const out = [];
const say = (...lines) => out.push(...lines);

const emitRuleMd = (r) => {
  const costLabel = imagineCostLabel(r);
  say(`#### ${r.id}`, '', `*${r.tier}, ${costLabel}*`, '');
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
  '# How to solve Masyu',
  '',
  '<!-- Generated by tools/build_how_to_solve.mjs from js/rating.js, docs/examples/examples.json, and docs/images/. -->',
  '',
  'Every solving technique the Hint button knows, ordered from easiest to hardest, with an example of the hint at work.',
  'The same rule table powers both difficulty grading and live hints (see [README.md](../README.md)).',
  '',
  '## Rules of Masyu',
  '',
  '- Draw **one single closed loop** along the grid lines orthogonally, with no crossings or branches.',
  '- The loop must visit **every circle** (white and black). Empty intersections may or may not be visited.',
  '- **White circle (○):** the loop goes **straight through** it, and must **turn 90°** at least once at the immediately adjacent intersections along the loop.',
  '- **Black circle (●):** the loop **turns 90°** at it, and must go **straight through** both immediately adjacent intersections along the loop (at least two segments straight in each exit direction).',
  '- Some books feature other loop puzzles or hybrids — see **[Variant rules](#variant-rules)** below (Slitherlink, Hamilton cycle, Gray circles, and Swiss cheese).',
  '',
  '## How the examples work',
  '',
  'Each illustration shows a position reached by following **Hint** from an empty board, together with the Hint button\'s own highlights, ghost marks, and explanation.',
  'The example puzzles live in a hidden book (`data/armory.csv`, `"hidden": true` in `data/manifest.json`); click any picture to open that exact puzzle in the app (`index.html?book=armory&puzzle=N`).',
  '',
  '## Bookkeeping',
  '',
  `${coreFreeRules.length} core bookkeeping rules cost 1 each and run automatically before each hint step so the board stays tidy:`,
  '',
);

for (const r of coreFreeRules) {
  say(`- \`${r.id}\` (cost ${r.cost}): ${cap(r.label)}.`);
}
say('');

for (const tier of TIERS.filter((t) => orderedForTier(t).length > 0)) {
  const info = TIER_INFO[tier];
  say(`## ${tier}`, '');
  if (info && info.blurb) say(`A puzzle is rated **${tier}** when its hardest required step is in this tier: ${info.blurb}.`, '');

  for (const r of orderedForTier(tier)) {
    const costLabel = imagineCostLabel(r);
    say(`### ${r.id}`, '', `*${tier}, ${costLabel}*`, '');
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
  }
}

say('## Variant rules', '', 'Extra techniques used only in books with special rules:', '');
for (const vg of VARIANT_GROUPS) {
  say(`### ${vg.title}`, '', vg.intro, '');
  const freeV = vg.ruleIds.map((id) => RULE_BY_ID.get(id)).filter((r) => r && r.free);
  const solveV = vg.ruleIds.map((id) => RULE_BY_ID.get(id)).filter((r) => r && !r.free);
  if (freeV.length) {
    for (const r of freeV) say(`- Bookkeeping: \`${r.id}\` (cost ${r.cost}): ${cap(r.label)}.`);
    say('');
  }
  for (const r of solveV) emitRuleMd(r);
}

fs.writeFileSync(path.join(root, 'docs', 'how_to_solve.md'), out.join('\n').replace(/\n---\n$/, '\n'), 'utf8');

// Also generate a clean, standalone docs/how_to_solve.html for GitHub Pages (since .nojekyll serves raw .md).
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const activeTiers = TIERS.filter((t) => orderedForTier(t).length > 0);

const htmlParts = [];
htmlParts.push(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>How to solve Masyu</title>
  <meta name="description" content="Every solving technique the Masyu Hint button knows, ordered from Beginner to Expert, with interactive examples.">
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
    h2 { margin: 36px 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--border); font-size: 1.35rem; }
    h3 { margin: 0 0 4px; font-size: 1.1rem; }
    .variant-heading { margin: 26px 0 8px; font-size: 1.18rem; }
    p { margin: 0 0 12px; }
    ul { margin: 0 0 14px; padding-left: 22px; }
    li { margin: 4px 0; }
    code { background: var(--code-bg); padding: 1px 6px; border-radius: 4px; font-size: 0.9em; }
    .lead { color: var(--muted); font-size: 1.02rem; }
    .toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 24px; }
    .toc a {
      padding: 5px 12px; border-radius: 999px; border: 1px solid var(--border);
      background: var(--card); color: var(--accent); text-decoration: none; font-size: 0.88rem; font-weight: 600;
    }
    .toc a:hover { border-color: var(--accent); }
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
    <a class="back" href="../index.html">← Back to Masyu</a>
    <h1>How to solve Masyu</h1>
    <p class="lead">Every solving technique the Hint button knows, ordered from easiest to hardest. Click any diagram to open that exact puzzle in the app.</p>
    <nav class="toc" aria-label="Jump to section">
      <a href="#rules">Rules</a>
      <a href="#bookkeeping">Bookkeeping</a>
      ${activeTiers.map((t) => `<a href="#${t.toLowerCase()}">${esc(t)}</a>`).join('\n      ')}
      <a href="#variant-rules">Variant rules</a>
    </nav>

    <h2 id="rules">Rules of Masyu</h2>
    <ul>
      <li>Draw <b>one single closed loop</b> along the grid lines passing through every circle (white and black), with no crossings or branches.</li>
      <li>Empty intersections may or may not be visited by the loop.</li>
      <li><b>White circle (○):</b> the loop goes <b>straight through</b> it, and must <b>turn 90°</b> in at least one of the two adjacent cells along the loop.</li>
      <li><b>Black circle (●):</b> the loop <b>turns 90°</b> at it, and must go <b>straight through</b> both adjacent cells along the loop (at least two segments straight in each exit direction).</li>
      <li>Some books feature other loop puzzles or hybrids — see <a href="#variant-rules"><b>Variant rules</b></a> below (Slitherlink, Hamilton cycle, Gray circles, and Swiss cheese).</li>
    </ul>

    <h2 id="bookkeeping">Bookkeeping</h2>
    <p>${coreFreeRules.length} core bookkeeping rules cost 1 each and run automatically before each hint step so the board stays tidy:</p>
    <ul>
      ${coreFreeRules.map((r) => `<li><code>${esc(r.id)}</code> (cost ${r.cost}): ${esc(cap(r.label))}.</li>`).join('\n      ')}
    </ul>`);

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

for (const tier of activeTiers) {
  const info = TIER_INFO[tier];
  htmlParts.push(`
    <h2 id="${tier.toLowerCase()}">${esc(tier)}</h2>
    ${info && info.blurb ? `<p>A puzzle is rated <b>${esc(tier)}</b> when its hardest required step is in this tier: ${esc(info.blurb)}.</p>` : ''}`);
  for (const r of orderedForTier(tier)) {
    htmlParts.push(renderRuleCardHtml(r));
  }
}

htmlParts.push(`
    <h2 id="variant-rules">Variant rules</h2>
    <p>Extra rules and techniques used only in books with special rules:</p>
    <nav class="toc" aria-label="Jump to variant">
      ${VARIANT_GROUPS.map((vg) => `<a href="#${esc(vg.id)}">${esc(vg.title)}</a>`).join('\n      ')}
    </nav>`);

for (const vg of VARIANT_GROUPS) {
  const freeV = vg.ruleIds.map((id) => RULE_BY_ID.get(id)).filter((r) => r && r.free);
  const solveV = vg.ruleIds.map((id) => RULE_BY_ID.get(id)).filter((r) => r && !r.free);
  htmlParts.push(`
    <h3 class="variant-heading" id="${esc(vg.id)}">${esc(vg.title)}</h3>
    <p>${vg.htmlIntro}</p>`);
  if (freeV.length) {
    htmlParts.push(`
    <ul>
      ${freeV.map((r) => `<li><b>Bookkeeping:</b> <code>${esc(r.id)}</code> (cost ${r.cost}): ${esc(cap(r.label))}.</li>`).join('\n      ')}
    </ul>`);
  }
  for (const r of solveV) htmlParts.push(renderRuleCardHtml(r));
}

htmlParts.push(`
  </main>
</body>
</html>
`);

fs.writeFileSync(path.join(root, 'docs', 'how_to_solve.html'), htmlParts.join('\n'), 'utf8');
console.log(`Generated docs/how_to_solve.md and docs/how_to_solve.html (${examples.length} illustrated rules).`);
