#!/usr/bin/env node
// Build all shipped books in data/ from pools in tools/library/ and write data/manifest.json.
// Guarantees zero duplicates across books (--exclude).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const buildScript = new URL('./build_book.mjs', import.meta.url).pathname;
const manifestPath = path.join(root, 'data', 'manifest.json');

fs.mkdirSync(path.join(root, 'data'), { recursive: true });

// Preserve any hidden books (like armory) if manifest already exists
let existingHidden = [];
if (fs.existsSync(manifestPath)) {
  const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  existingHidden = (prev.books || []).filter((b) => b.hidden);
}

const manifest = {
  default: 'intro',
  groups: [
    {
      name: 'Start here',
      icon: '🌱',
      blurb: 'Small 5×5 and 6×6 puzzles to learn the rules.',
    },
    {
      name: 'Default',
      icon: '📚',
      blurb: 'Standard Masyu boards by size, from 8×8 up to full-page 24×30.',
      subs: {
        '8×8': {
          icon: '8️⃣',
          blurb: 'Compact boards across all four difficulties.',
        },
        '12×12': {
          icon: '🔷',
          blurb: 'Classic boards across all four difficulties.',
        },
        'Giants': {
          icon: '🗻',
          blurb: 'Big and printable full-page boards for long solves.',
        },
      },
    },
    {
      name: 'Bonus',
      icon: '🎁',
      blurb: 'Themed variations with the same Masyu rules.',
    },
  ],
  books: existingHidden,
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const recipes = [
  // ---- Start here
  {
    id: 'intro', name: 'Gentle intro', label: 'Gentle intro', group: 'Start here',
    glob: 'intro_5x5,intro_6x6', limit: 100, onlyTier: 'Beginner', balanceGroups: true,
    blurb: 'Small 5×5 and 6×6 Beginner warm-ups, easiest first.',
  },

  // ---- Default: 8×8 (4 separate books × 500, + 10 Expert+ in Expert)
  {
    id: '8x8-beginner', name: '8×8 Beginner', label: 'Beginner', group: 'Default', sub: '8×8',
    glob: 'balanced_8x8', limit: 500, onlyTier: 'Beginner', maxScore: 235,
    blurb: 'Warm-up puzzles using the core circle rules.',
  },
  {
    id: '8x8-medium', name: '8×8 Medium', label: 'Medium', group: 'Default', sub: '8×8',
    glob: 'balanced_8x8', limit: 500, onlyTier: 'Medium', minScore: 235, maxScore: 310,
    blurb: 'Inside/outside parity, small pockets, and short lookahead.',
  },
  {
    id: '8x8-hard', name: '8×8 Hard', label: 'Hard', group: 'Default', sub: '8×8',
    glob: 'balanced_8x8', limit: 500, onlyTier: 'Hard', minScore: 310, maxScore: 520,
    blurb: 'Deep pure-logic solves — no trial and error.',
  },
  {
    id: '8x8-expert', name: '8×8 Expert', label: 'Expert', group: 'Default', sub: '8×8',
    glob: 'balanced_8x8', limit: 500, onlyTier: 'Expert', minScore: 520, expertPlus: 10,
    blurb: 'Trial-and-error challenges, plus 10 Expert+ puzzles beyond hints.',
  },

  // ---- Default: 12×12 (4 separate books × 500, + 10 Expert+ in Expert)
  {
    id: '12x12-beginner', name: '12×12 Beginner', label: 'Beginner', group: 'Default', sub: '12×12',
    glob: 'balanced_12x12', limit: 500, onlyTier: 'Beginner', maxScore: 535,
    blurb: 'Warm-up puzzles using the core circle rules.',
  },
  {
    id: '12x12-medium', name: '12×12 Medium', label: 'Medium', group: 'Default', sub: '12×12',
    glob: 'balanced_12x12', limit: 500, onlyTier: 'Medium', minScore: 535, maxScore: 660,
    blurb: 'Inside/outside parity, small pockets, and short lookahead.',
  },
  {
    id: '12x12-hard', name: '12×12 Hard', label: 'Hard', group: 'Default', sub: '12×12',
    glob: 'balanced_12x12', limit: 500, onlyTier: 'Hard', minScore: 660, maxScore: 1050,
    blurb: 'Deep pure-logic solves — no trial and error.',
  },
  {
    id: '12x12-expert', name: '12×12 Expert', label: 'Expert', group: 'Default', sub: '12×12',
    glob: 'balanced_12x12', limit: 500, onlyTier: 'Expert', minScore: 1050, expertPlus: 10,
    blurb: 'Trial-and-error challenges, plus 10 Expert+ puzzles beyond hints.',
  },

  // ---- Default: Giants (curated smaller counts with per-tier score bands)
  {
    id: '16x16', name: '16×16', label: '16×16', group: 'Default', sub: 'Giants',
    glob: 'balanced_16x16', tiers: '50,50,50,50', tierBands: '0:940,940:1100,1100:1650,1650:',
    blurb: 'Big square boards, easiest first.',
  },
  {
    id: '12x20', name: '12×20 Giant', label: '12×20 Giant', group: 'Default', sub: 'Giants',
    glob: 'balanced_12x20', tiers: '25,25,25,25', tierBands: '0:900,900:1050,1050:1650,1650:',
    blurb: 'Tall magazine-page boards, easiest first.',
  },
  {
    id: '24x30', name: '24×30 Full Page', label: '24×30 Full Page', group: 'Default', sub: 'Giants',
    glob: 'balanced_24x30', tiers: '15,15,15,15', tierBands: '0:2580,2520:2750,2750:3300,3300:',
    blurb: 'Huge boards sized for one full printer page.',
  },

  // ---- Bonus: one fixed-size book per gimmick (500 puzzles at 10/40/40/10 + 10 oversized bonus) + Lattice showcase
  {
    id: 'bonus-white', name: 'All white', label: '⚪ All white (8×8)', group: 'Bonus',
    glob: 'white_8x8', tiers: '50,200,200,50', tierBands: '0:275,265:345,345:650,650:',
    bonusGlob: 'white_12x12', bonusCount: 10,
    blurb: 'Every circle is white — straight lines and forced turns.',
  },
  {
    id: 'bonus-black', name: 'All black', label: '⚫ All black (10×10)', group: 'Bonus',
    glob: 'black_10x10', tiers: '50,200,200,50', tierBands: '0:350,335:405,390:680,680:',
    bonusGlob: 'black_12x12', bonusCount: 10,
    blurb: 'Every circle is black — sharp corners and long legs.',
  },
  {
    id: 'bonus-cookie', name: 'Black & White Cookie', label: '🍪 Black & White Cookie (10×10)', group: 'Bonus',
    glob: 'cookie_vert_10x10,cookie_horiz_10x10,cookie_diag_10x10',
    tiers: '50,200,200,50', tierBands: '0:375,355:470,470:800,780:', balanceGroups: true, interleaveGroups: true, maxRun: 3,
    bonusGlob: 'cookie_vert_12x12,cookie_horiz_12x12,cookie_diag_12x12', bonusCount: 10,
    blurb: 'Half white circles, half black circles.',
  },
  {
    id: 'bonus-skyscraper', name: 'Skyscraper', label: '🏙️ Skyscraper (6×20)', group: 'Bonus',
    glob: 'sky_6x20', tiers: '50,200,200,50', tierBands: '0:480,430:550,550:900,880:',
    bonusGlob: 'tallsky_6x30', bonusCount: 10,
    blurb: 'Tall, narrow towers where the loop snakes up and down.',
  },
  {
    id: 'bonus-symmetry', name: 'Exact symmetry', label: '🪞 Exact symmetry (10×10)', group: 'Bonus',
    glob: 'sym_rot180_10x10,sym_mirror_10x10,sym_transpose_10x10',
    tiers: '50,200,200,50', tierBands: '0:360,340:440,440:760,760:', balanceGroups: true, interleaveGroups: true, maxRun: 3,
    bonusGlob: 'sym_rot180_12x12,sym_mirror_12x12,sym_transpose_12x12', bonusCount: 10,
    blurb: 'Mirror, diagonal, and 180° symmetric clues and loops.',
  },
  {
    id: 'bonus-yinyang', name: 'Yin-Yang', label: '☯️ Yin-Yang (10×10)', group: 'Bonus',
    glob: 'yinyang_10x10,yinyang_mirror_10x10,yinyang_transpose_10x10',
    tiers: '50,200,200,50', tierBands: '0:355,340:460,460:780,780:', balanceGroups: true, interleaveGroups: true, maxRun: 3,
    bonusGlob: 'yinyang_12x12,yinyang_mirror_12x12,yinyang_transpose_12x12', bonusCount: 10,
    blurb: 'Opposite-color symmetry — every white pairs with a black.',
  },
  {
    id: 'bonus-full', name: 'Full board', label: '🧱 Full board (10×10)', group: 'Bonus',
    glob: 'full_10x10', tiers: '50,200,200,50', tierBands: '0:425,400:485,480:850,820:',
    bonusGlob: 'full_10x12', bonusCount: 10,
    blurb: 'The loop visits every single intersection.',
  },
  {
    id: 'bonus-lattice', name: 'Lattice', label: '💠 Lattice (9×9 – 13×13)', group: 'Bonus',
    glob: 'lattice_9x9,lattice_9x11,lattice_13x13', limit: 60,
    blurb: 'Every even row and column holds a circle.',
  },
];

const builtFiles = [];
for (const r of recipes) {
  const args = [
    buildScript,
    '--id', r.id,
    '--name', r.name,
    '--label', r.label,
    '--group', r.group,
    '--glob', r.glob,
    '--blurb', r.blurb,
  ];
  if (r.sub) args.push('--sub', r.sub);
  if (r.limit) args.push('--limit', String(r.limit));
  if (r.tiers) args.push('--tiers', r.tiers);
  if (r.onlyTier) args.push('--only-tier', r.onlyTier);
  if (r.minScore !== undefined) args.push('--min-score', String(r.minScore));
  if (r.maxScore !== undefined) args.push('--max-score', String(r.maxScore));
  if (r.tierBands) args.push('--tier-bands', r.tierBands);
  if (r.expertPlus) args.push('--expert-plus', String(r.expertPlus));
  if (r.bonusGlob) args.push('--bonus-glob', r.bonusGlob);
  if (r.bonusCount) args.push('--bonus-count', String(r.bonusCount));
  if (r.balanceGroups) args.push('--balance-groups');
  if (r.interleaveGroups) args.push('--interleave-groups');
  if (r.maxRun) args.push('--max-run', String(r.maxRun));
  if (builtFiles.length) args.push('--exclude', builtFiles.join(','));
  execFileSync(process.execPath, args, { stdio: 'inherit' });
  builtFiles.push(`data/${r.id}.csv`);
}

// Re-order manifest.books so non-hidden books appear in recipe order, hidden at the end
const finalManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const byId = new Map(finalManifest.books.map((b) => [b.id, b]));
finalManifest.books = [
  ...recipes.map((r) => byId.get(r.id)).filter(Boolean),
  ...finalManifest.books.filter((b) => b.hidden),
];
fs.writeFileSync(manifestPath, JSON.stringify(finalManifest, null, 2) + '\n', 'utf8');
console.log('\nUpdated data/manifest.json with', finalManifest.books.length, 'books.');
