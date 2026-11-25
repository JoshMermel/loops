#!/usr/bin/env node
// Build all shipped books in data/ from pools in tools/library/ and write data/manifest.json.
// Guarantees zero duplicates across books (--exclude).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { repoRoot } from './_cli.mjs';

const root = repoRoot(import.meta.url);
const buildScript = fileURLToPath(new URL('./build_book.mjs', import.meta.url));
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
      blurb: 'Standard Masyu boards by size, from 8×8 up to full-page 16×24.',
      subs: {
        '8×8': {
          icon: '8️⃣',
          blurb: 'Compact boards across all four difficulties.',
        },
        '12×12': {
          icon: '🔷',
          blurb: 'Classic boards across all four difficulties.',
        },
        '16×16': {
          icon: '🟦',
          blurb: 'Big square boards across all four difficulties.',
        },
        '12×20': {
          icon: '📏',
          blurb: 'Tall magazine-page boards across all four difficulties.',
        },
        '16×24': {
          icon: '📄',
          blurb: 'Full-page 2:3 boards across all four difficulties.',
        },
      },
    },
    {
      name: 'Bonus',
      icon: '🎁',
      blurb: 'Themed variations and mystery gray circles.',
    },
  ],
  books: existingHidden,
};

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
    glob: 'balanced_8x8', limit: 500, onlyTier: 'Medium', minScore: 215, maxScore: 270,
    blurb: 'Local patterns, basic shading, and 1-step lookahead.',
  },
  {
    id: '8x8-hard', name: '8×8 Hard', label: 'Hard', group: 'Default', sub: '8×8',
    glob: 'balanced_8x8', limit: 500, onlyTier: 'Hard', minScore: 265, maxScore: 420,
    blurb: 'Circle shading, topology, and short single-thread lookahead.',
  },
  {
    id: '8x8-expert', name: '8×8 Expert', label: 'Expert', group: 'Default', sub: '8×8',
    glob: 'balanced_8x8', limit: 500, onlyTier: 'Expert', minScore: 420, maxScore: 900, expertPlus: 10,
    blurb: 'Complex lookahead chains, plus 10 Expert+ puzzles beyond hints.',
  },

  // ---- Default: 12×12 (4 separate books × 500, + 10 Expert+ in Expert)
  {
    id: '12x12-beginner', name: '12×12 Beginner', label: 'Beginner', group: 'Default', sub: '12×12',
    glob: 'balanced_12x12', limit: 500, onlyTier: 'Beginner', maxScore: 535,
    blurb: 'Warm-up puzzles using the core circle rules.',
  },
  {
    id: '12x12-medium', name: '12×12 Medium', label: 'Medium', group: 'Default', sub: '12×12',
    glob: 'balanced_12x12', limit: 500, onlyTier: 'Medium', minScore: 495, maxScore: 585,
    blurb: 'Local patterns, basic shading, and 1-step lookahead.',
  },
  {
    id: '12x12-hard', name: '12×12 Hard', label: 'Hard', group: 'Default', sub: '12×12',
    glob: 'balanced_12x12', limit: 500, onlyTier: 'Hard', minScore: 575, maxScore: 820,
    blurb: 'Circle shading, topology, and short single-thread lookahead.',
  },
  {
    id: '12x12-expert', name: '12×12 Expert', label: 'Expert', group: 'Default', sub: '12×12',
    glob: 'balanced_12x12', limit: 500, onlyTier: 'Expert', minScore: 820, maxScore: 1700, expertPlus: 10,
    blurb: 'Complex lookahead chains, plus 10 Expert+ puzzles beyond hints.',
  },

  // ---- Default: 16×16 (4 separate books × 500, + 10 Expert+ in Expert)
  {
    id: '16x16-beginner', name: '16×16 Beginner', label: 'Beginner', group: 'Default', sub: '16×16',
    glob: 'balanced_16x16', limit: 500, onlyTier: 'Beginner', maxScore: 950,
    blurb: 'Warm-up puzzles using the core circle rules.',
  },
  {
    id: '16x16-medium', name: '16×16 Medium', label: 'Medium', group: 'Default', sub: '16×16',
    glob: 'balanced_16x16', limit: 500, onlyTier: 'Medium', minScore: 870, maxScore: 1050,
    blurb: 'Local patterns, basic shading, and 1-step lookahead.',
  },
  {
    id: '16x16-hard', name: '16×16 Hard', label: 'Hard', group: 'Default', sub: '16×16',
    glob: 'balanced_16x16', limit: 500, onlyTier: 'Hard', minScore: 990, maxScore: 1450,
    blurb: 'Circle shading, topology, and short single-thread lookahead.',
  },
  {
    id: '16x16-expert', name: '16×16 Expert', label: 'Expert', group: 'Default', sub: '16×16',
    glob: 'balanced_16x16', limit: 500, onlyTier: 'Expert', minScore: 1350, maxScore: 3000, expertPlus: 10,
    blurb: 'Complex lookahead chains, plus 10 Expert+ puzzles beyond hints.',
  },

  // ---- Default: 12×20 (4 separate books × 500, + 10 Expert+ in Expert)
  {
    id: '12x20-beginner', name: '12×20 Beginner', label: 'Beginner', group: 'Default', sub: '12×20',
    glob: 'balanced_12x20', limit: 500, onlyTier: 'Beginner', maxScore: 890,
    blurb: 'Warm-up puzzles using the core circle rules.',
  },
  {
    id: '12x20-medium', name: '12×20 Medium', label: 'Medium', group: 'Default', sub: '12×20',
    glob: 'balanced_12x20', limit: 500, onlyTier: 'Medium', minScore: 815, maxScore: 980,
    blurb: 'Local patterns, basic shading, and 1-step lookahead.',
  },
  {
    id: '12x20-hard', name: '12×20 Hard', label: 'Hard', group: 'Default', sub: '12×20',
    glob: 'balanced_12x20', limit: 500, onlyTier: 'Hard', minScore: 940, maxScore: 1350,
    blurb: 'Circle shading, topology, and short single-thread lookahead.',
  },
  {
    id: '12x20-expert', name: '12×20 Expert', label: 'Expert', group: 'Default', sub: '12×20',
    glob: 'balanced_12x20', limit: 500, onlyTier: 'Expert', minScore: 1240, maxScore: 2800, expertPlus: 10,
    blurb: 'Complex lookahead chains, plus 10 Expert+ puzzles beyond hints.',
  },

  // ---- Default: 16×24 (4 separate books × 500, + 10 Expert+ in Expert)
  {
    id: '16x24-beginner', name: '16×24 Beginner', label: 'Beginner', group: 'Default', sub: '16×24',
    glob: 'balanced_16x24', limit: 500, onlyTier: 'Beginner', maxScore: 1420,
    blurb: 'Warm-up puzzles using the core circle rules.',
  },
  {
    id: '16x24-medium', name: '16×24 Medium', label: 'Medium', group: 'Default', sub: '16×24',
    glob: 'balanced_16x24', limit: 500, onlyTier: 'Medium', minScore: 1310, maxScore: 1550,
    blurb: 'Local patterns, basic shading, and 1-step lookahead.',
  },
  {
    id: '16x24-hard', name: '16×24 Hard', label: 'Hard', group: 'Default', sub: '16×24',
    glob: 'balanced_16x24', limit: 500, onlyTier: 'Hard', minScore: 1480, maxScore: 2150,
    blurb: 'Circle shading, topology, and short single-thread lookahead.',
  },
  {
    id: '16x24-expert', name: '16×24 Expert', label: 'Expert', group: 'Default', sub: '16×24',
    glob: 'balanced_16x24', limit: 500, onlyTier: 'Expert', minScore: 2050, maxScore: 3900, expertPlus: 10,
    blurb: 'Complex lookahead chains, plus 10 Expert+ puzzles beyond hints.',
  },

  // ---- Bonus: one fixed-size book per gimmick (500 puzzles at 10/40/40/10 + 10 Expert+ + 10 Mega finale) + Patterns
  {
    id: 'bonus-white', name: 'All white', label: '⚪ All white (8×8)', group: 'Bonus',
    glob: 'white_8x8', tiers: '50,200,200,50', tierBands: '0:265,240:305,300:485,470:950',
    expertPlus: 10, bonusGlob: 'white_12x20', bonusCount: 10,
    blurb: 'Every circle is white — straight lines and forced turns.',
  },
  {
    id: 'bonus-black', name: 'All black', label: '⚫ All black (10×10)', group: 'Bonus',
    glob: 'black_10x10', tiers: '50,200,200,50', tierBands: '0:345,315:380,365:510,500:1100',
    expertPlus: 10, bonusGlob: 'black_12x20', bonusCount: 10,
    blurb: 'Every circle is black — sharp corners and long legs.',
  },
  {
    id: 'bonus-gray', name: 'Gray circles', label: '🔘 Gray circles (8×8)', group: 'Bonus',
    glob: 'gray_8x8', tiers: '50,200,200,50', tierBands: '0:265,235:315,300:540,520:1500',
    expertPlus: 10, bonusGlob: 'gray_12x20', bonusCount: 10,
    blurb: 'Mystery gray circles mixed with white and black — deduce which each one is (tap to label).',
  },
  {
    id: 'bonus-allgray', name: 'All gray', label: '🌫️ All gray (8×8)', group: 'Bonus',
    glob: 'allgray_8x8', tiers: '50,200,200,50', tierBands: '0:270,245:325,310:520,500:1600',
    expertPlus: 10, bonusGlob: 'allgray_10x12', bonusCount: 10,
    blurb: 'Every circle is a mystery gray circle — figure out white vs. black from scratch.',
  },
  {
    id: 'bonus-cookie', name: 'Black & White Cookie', label: '🍪 Black & White Cookie (10×10)', group: 'Bonus',
    glob: 'cookie_vert_10x10,cookie_horiz_10x10,cookie_diag_10x10',
    tiers: '50,200,200,50', tierBands: '0:375,345:430,415:625,600:1200', balanceGroups: true, interleaveGroups: true, maxRun: 3,
    expertPlus: 10, bonusGlob: 'cookie_vert_12x20,cookie_horiz_12x20,cookie_diag_12x20', bonusCount: 10,
    blurb: 'Half white circles, half black circles.',
  },
  {
    id: 'bonus-skyscraper', name: 'Skyscraper', label: '🏙️ Skyscraper (6×20)', group: 'Bonus',
    glob: 'sky_6x20', tiers: '50,200,200,50', tierBands: '0:455,415:505,480:730,700:1300',
    expertPlus: 10, bonusGlob: 'tallsky_6x40', bonusCount: 10,
    blurb: 'Tall, narrow towers where the loop snakes up and down.',
  },
  {
    id: 'bonus-symmetry', name: 'Exact symmetry', label: '🪞 Exact symmetry (10×10)', group: 'Bonus',
    glob: 'sym_rot180_10x10,sym_mirror_10x10,sym_transpose_10x10',
    tiers: '50,200,200,50', tierBands: '0:365,315:420,375:600,570:1200', balanceGroups: true, interleaveGroups: true, maxRun: 3,
    expertPlus: 10, bonusGlob: 'sym_rot180_14x14,sym_mirror_14x14,sym_transpose_14x14', bonusCount: 10,
    blurb: 'Mirror, diagonal, and 180° symmetric clues and loops.',
  },
  {
    id: 'bonus-full', name: 'Full board', label: '🧱 Full board (10×10)', group: 'Bonus',
    glob: 'full_10x10', tiers: '50,200,200,50', tierBands: '0:420,390:465,450:640,610:1250',
    expertPlus: 10, bonusGlob: 'full_12x20', bonusCount: 10,
    blurb: 'The loop visits every single intersection.',
  },
  {
    id: 'bonus-patterns', name: 'Patterns', label: '💠 Patterns (9×9 – 13×13)', group: 'Bonus',
    glob: 'lattice_9x9,lattice_13x13,pat_blocks2x2_9x9,pat_quilt2x2_10x10,pat_circle_10x10,pat_honeycomb_10x10,pat_pillars_9x9,pat_hourglass_10x10,pat_brackets_10x10,pat_xbracket_9x9,pat_spiral_10x10,pat_stairs_9x9,pat_smallx_9x9,pat_bricks_10x10,pat_dominoes_10x10,pat_ltiles_10x10,pat_mirrorltiles_10x10,pat_herringbone_10x10,pat_slashes_10x10,pat_zigzags_10x10',
    tierBands: '0:,0:,0:,0:1300', interleaveGroups: true, maxRun: 2,
    blurb: 'Bold shapes & repeating wallpapers — lattice, pillars, hourglass, spiral, brickwork, herringbone, and more.',
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
finalManifest.default = manifest.default;
finalManifest.groups = manifest.groups;
finalManifest.books = [
  ...recipes.map((r) => byId.get(r.id)).filter(Boolean),
  ...finalManifest.books.filter((b) => b.hidden),
];
fs.writeFileSync(manifestPath, JSON.stringify(finalManifest, null, 2) + '\n', 'utf8');
console.log('\nUpdated data/manifest.json with', finalManifest.books.length, 'books.');
