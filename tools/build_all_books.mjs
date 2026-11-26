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

const manifest = {
  default: 'intro',
  groups: [
    {
      name: 'Start here',
      icon: '🌱',
      blurb: 'Small Beginner warm-ups to learn Masyu, Slitherlink, Mid-loop, and Hamilton cycle.',
    },
    {
      name: 'Masyu',
      icon: '⚪',
      blurb: 'Classic Masyu by size, plus Gray dots, Swiss cheese, and Bonus themes.',
      subs: {
        Classic: {
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
        'Gray dots': {
          icon: '🔘',
          blurb: 'Gray circles are secretly either white or black — figuring out which is part of the puzzle (tap any gray circle to label it).',
        },
        'Swiss cheese': {
          icon: '🧀',
          blurb: 'Boards punched with random interior holes across four sizes — each hole is entirely Inside or Outside the loop.',
        },
        Bonus: {
          icon: '🎁',
          blurb: 'Themed variations with the same Masyu rules.',
        },
      },
    },
    {
      name: 'Slitherlink',
      icon: '🔢',
      blurb: 'Classic Slitherlink by size & difficulty, plus Swiss cheese, Skyscraper, Symmetry, and All 3s.',
      subs: {
        Classic: {
          icon: '📚',
          blurb: 'Standard Slitherlink boards by size (counted in numbered squares), from 7×7 up to tall 10×16.',
          subs: {
            '7×7': {
              icon: '7️⃣',
              blurb: 'Compact 7×7-square boards across all four difficulties.',
            },
            '10×10': {
              icon: '🔟',
              blurb: 'Classic 10×10-square boards across all four difficulties.',
            },
            '12×12': {
              icon: '🔷',
              blurb: 'Big 12×12-square boards across all four difficulties.',
            },
            '10×16': {
              icon: '📏',
              blurb: 'Tall magazine-page 10×16-square boards across all four difficulties.',
            },
          },
        },
        Bonus: {
          icon: '🎁',
          blurb: 'Themed variations with the same Slitherlink rules.',
        },
      },
    },
    {
      name: 'Mid-loop',
      icon: '🎯',
      blurb: 'Pass straight through every teal dot at the exact midpoint of its straight loop segment.',
    },
    {
      name: 'Hamilton cycle',
      icon: '🔁',
      blurb: 'Visit every single dot on the grid — guided by given lines, given walls, or both.',
    },
    {
      name: 'Hybrids',
      icon: '🔀',
      blurb: 'Two loop puzzle rules combined on one board — every puzzle genuinely needs both.',
      subs: {
        'Masyu + Hamilton cycle': {
          icon: '⚪🔁',
          blurb: 'Masyu circles on a loop that must visit every dot on the grid.',
        },
        'Slitherlink + Masyu': {
          icon: '🔢⚪',
          blurb: 'Numbered squares and Masyu circles sharing one single closed loop.',
        },
        'Slitherlink + Hamilton cycle': {
          icon: '🔢🔁',
          blurb: 'Slitherlink numbers on a Hamilton cycle that visits every single dot.',
        },
        'Mid-loop + Masyu': {
          icon: '🎯⚪',
          blurb: 'Teal midpoint dots and Masyu circles sharing one single closed loop.',
        },
        'Mid-loop + Slitherlink': {
          icon: '🎯🔢',
          blurb: 'Teal midpoint dots and numbered Slitherlink squares sharing one single closed loop.',
        },
        'Mid-loop + Hamilton cycle': {
          icon: '🎯🔁',
          blurb: 'Teal midpoint dots on a Hamilton cycle that visits every single dot.',
        },
      },
    },
  ],
};

const recipes = [
  // ---- Start here
  {
    id: 'intro', name: 'Masyu intro', label: '⚪ Masyu', group: 'Start here',
    glob: 'intro_5x5,intro_6x6', limit: 100, onlyTier: 'Beginner', balanceGroups: true,
    blurb: 'Small 5×5 and 6×6 Beginner Masyu warm-ups, easiest first.',
  },
  {
    id: 'intro-slither', name: 'Slitherlink intro', label: '🔢 Slitherlink', group: 'Start here',
    glob: 'intro_slither_5x5,intro_slither_6x6', limit: 100, onlyTier: 'Beginner', balanceGroups: true,
    blurb: 'Small Beginner Slitherlink warm-ups, easiest first.',
  },
  {
    id: 'intro-midloop', name: 'Mid-loop intro', label: '🎯 Mid-loop', group: 'Start here',
    glob: 'intro_midloop_6x6,intro_midloop_7x7', limit: 100, onlyTier: 'Beginner', balanceGroups: true,
    blurb: 'Small Beginner Mid-loop warm-ups, easiest first.',
  },
  {
    id: 'intro-hamilton', name: 'Hamilton cycle intro', label: '🔁 Hamilton cycle', group: 'Start here',
    glob: 'intro_ham_lines_4x6,intro_ham_walls_4x6,intro_ham_mixed_4x6,intro_ham_lines_6x6,intro_ham_walls_6x6,intro_ham_mixed_6x6',
    limit: 42, onlyTier: 'Beginner', balanceGroups: true,
    blurb: 'Small Beginner Hamilton cycle warm-ups with given lines & walls, easiest first.',
  },

  // ---- Default: 8×8 (4 separate books × 500, + 10 Expert+ in Expert)
  {
    id: '8x8-beginner', name: '8×8 Beginner', label: 'Beginner', group: 'Masyu', sub: 'Classic', sub2: '8×8',
    glob: 'balanced_8x8', limit: 500, onlyTier: 'Beginner', maxScore: 235,
    blurb: 'Warm-up puzzles using the core circle rules.',
  },
  {
    id: '8x8-medium', name: '8×8 Medium', label: 'Medium', group: 'Masyu', sub: 'Classic', sub2: '8×8',
    glob: 'balanced_8x8', limit: 500, onlyTier: 'Medium', minScore: 215, maxScore: 270,
    blurb: 'Local patterns, basic shading, and 1-step lookahead.',
  },
  {
    id: '8x8-hard', name: '8×8 Hard', label: 'Hard', group: 'Masyu', sub: 'Classic', sub2: '8×8',
    glob: 'balanced_8x8', limit: 500, onlyTier: 'Hard', minScore: 265, maxScore: 420,
    blurb: 'Circle shading, topology, and short single-thread lookahead.',
  },
  {
    id: '8x8-expert', name: '8×8 Expert', label: 'Expert', group: 'Masyu', sub: 'Classic', sub2: '8×8',
    glob: 'balanced_8x8', limit: 500, onlyTier: 'Expert', minScore: 420, maxScore: 900, expertPlus: 10,
    blurb: 'Complex lookahead chains, plus 10 Expert+ puzzles beyond hints.',
  },

  // ---- Default: 12×12 (4 separate books × 500, + 10 Expert+ in Expert)
  {
    id: '12x12-beginner', name: '12×12 Beginner', label: 'Beginner', group: 'Masyu', sub: 'Classic', sub2: '12×12',
    glob: 'balanced_12x12', limit: 500, onlyTier: 'Beginner', maxScore: 535,
    blurb: 'Warm-up puzzles using the core circle rules.',
  },
  {
    id: '12x12-medium', name: '12×12 Medium', label: 'Medium', group: 'Masyu', sub: 'Classic', sub2: '12×12',
    glob: 'balanced_12x12', limit: 500, onlyTier: 'Medium', minScore: 495, maxScore: 585,
    blurb: 'Local patterns, basic shading, and 1-step lookahead.',
  },
  {
    id: '12x12-hard', name: '12×12 Hard', label: 'Hard', group: 'Masyu', sub: 'Classic', sub2: '12×12',
    glob: 'balanced_12x12', limit: 500, onlyTier: 'Hard', minScore: 575, maxScore: 820,
    blurb: 'Circle shading, topology, and short single-thread lookahead.',
  },
  {
    id: '12x12-expert', name: '12×12 Expert', label: 'Expert', group: 'Masyu', sub: 'Classic', sub2: '12×12',
    glob: 'balanced_12x12', limit: 500, onlyTier: 'Expert', minScore: 820, maxScore: 1700, expertPlus: 10,
    blurb: 'Complex lookahead chains, plus 10 Expert+ puzzles beyond hints.',
  },

  // ---- Default: 16×16 (4 separate books × 500, + 10 Expert+ in Expert)
  {
    id: '16x16-beginner', name: '16×16 Beginner', label: 'Beginner', group: 'Masyu', sub: 'Classic', sub2: '16×16',
    glob: 'balanced_16x16', limit: 500, onlyTier: 'Beginner', maxScore: 950,
    blurb: 'Warm-up puzzles using the core circle rules.',
  },
  {
    id: '16x16-medium', name: '16×16 Medium', label: 'Medium', group: 'Masyu', sub: 'Classic', sub2: '16×16',
    glob: 'balanced_16x16', limit: 500, onlyTier: 'Medium', minScore: 870, maxScore: 1050,
    blurb: 'Local patterns, basic shading, and 1-step lookahead.',
  },
  {
    id: '16x16-hard', name: '16×16 Hard', label: 'Hard', group: 'Masyu', sub: 'Classic', sub2: '16×16',
    glob: 'balanced_16x16', limit: 500, onlyTier: 'Hard', minScore: 990, maxScore: 1450,
    blurb: 'Circle shading, topology, and short single-thread lookahead.',
  },
  {
    id: '16x16-expert', name: '16×16 Expert', label: 'Expert', group: 'Masyu', sub: 'Classic', sub2: '16×16',
    glob: 'balanced_16x16', limit: 500, onlyTier: 'Expert', minScore: 1350, maxScore: 3000, expertPlus: 10,
    blurb: 'Complex lookahead chains, plus 10 Expert+ puzzles beyond hints.',
  },

  // ---- Default: 12×20 (4 separate books × 500, + 10 Expert+ in Expert)
  {
    id: '12x20-beginner', name: '12×20 Beginner', label: 'Beginner', group: 'Masyu', sub: 'Classic', sub2: '12×20',
    glob: 'balanced_12x20', limit: 500, onlyTier: 'Beginner', maxScore: 890,
    blurb: 'Warm-up puzzles using the core circle rules.',
  },
  {
    id: '12x20-medium', name: '12×20 Medium', label: 'Medium', group: 'Masyu', sub: 'Classic', sub2: '12×20',
    glob: 'balanced_12x20', limit: 500, onlyTier: 'Medium', minScore: 815, maxScore: 980,
    blurb: 'Local patterns, basic shading, and 1-step lookahead.',
  },
  {
    id: '12x20-hard', name: '12×20 Hard', label: 'Hard', group: 'Masyu', sub: 'Classic', sub2: '12×20',
    glob: 'balanced_12x20', limit: 500, onlyTier: 'Hard', minScore: 940, maxScore: 1350,
    blurb: 'Circle shading, topology, and short single-thread lookahead.',
  },
  {
    id: '12x20-expert', name: '12×20 Expert', label: 'Expert', group: 'Masyu', sub: 'Classic', sub2: '12×20',
    glob: 'balanced_12x20', limit: 500, onlyTier: 'Expert', minScore: 1240, maxScore: 2800, expertPlus: 10,
    blurb: 'Complex lookahead chains, plus 10 Expert+ puzzles beyond hints.',
  },

  // ---- Default: 16×24 (4 separate books × 500, + 10 Expert+ in Expert)
  {
    id: '16x24-beginner', name: '16×24 Beginner', label: 'Beginner', group: 'Masyu', sub: 'Classic', sub2: '16×24',
    glob: 'balanced_16x24', limit: 500, onlyTier: 'Beginner', maxScore: 1420,
    blurb: 'Warm-up puzzles using the core circle rules.',
  },
  {
    id: '16x24-medium', name: '16×24 Medium', label: 'Medium', group: 'Masyu', sub: 'Classic', sub2: '16×24',
    glob: 'balanced_16x24', limit: 500, onlyTier: 'Medium', minScore: 1310, maxScore: 1550,
    blurb: 'Local patterns, basic shading, and 1-step lookahead.',
  },
  {
    id: '16x24-hard', name: '16×24 Hard', label: 'Hard', group: 'Masyu', sub: 'Classic', sub2: '16×24',
    glob: 'balanced_16x24', limit: 500, onlyTier: 'Hard', minScore: 1480, maxScore: 2150,
    blurb: 'Circle shading, topology, and short single-thread lookahead.',
  },
  {
    id: '16x24-expert', name: '16×24 Expert', label: 'Expert', group: 'Masyu', sub: 'Classic', sub2: '16×24',
    glob: 'balanced_16x24', limit: 500, onlyTier: 'Expert', minScore: 2050, maxScore: 3900, expertPlus: 10,
    blurb: 'Complex lookahead chains, plus 10 Expert+ puzzles beyond hints.',
  },

  // ---- Gray circles (top-level section)
  {
    id: 'bonus-gray', name: 'Gray circles', label: '🔘 Gray circles (8×8)', group: 'Masyu', sub: 'Gray dots',
    glob: 'gray_8x8', tiers: '50,200,200,50', tierBands: '0:265,235:315,300:540,520:1500',
    expertPlus: 10, bonusGlob: 'gray_12x20', bonusCount: 10,
    blurb: 'Gray circles mixed with white and black — deduce which color each gray circle is (tap to label).',
  },
  {
    id: 'bonus-allgray', name: 'All gray', label: '🌫️ All gray (8×8)', group: 'Masyu', sub: 'Gray dots',
    glob: 'allgray_8x8', tiers: '50,200,200,50', tierBands: '0:270,245:325,310:520,500:1600',
    expertPlus: 10, bonusGlob: 'allgray_10x12', bonusCount: 10,
    blurb: 'Every circle is gray — figure out white vs. black for every dot from scratch (tap to label).',
  },

  // ---- Hamilton cycle (first-tier puzzle: visit every dot on the grid)
  {
    id: 'full-lines-8x8', name: 'Given lines (8×8)', label: '➖ Given lines (8×8)', group: 'Hamilton cycle',
    glob: 'full_lines_8x8', tiers: '50,200,200,50', tierBands: '0:245,215:295,255:480,430:1200',
    blurb: 'Visit every dot using only permanent pre-filled loop segments.',
  },
  {
    id: 'full-walls-8x8', name: 'Given walls (8×8)', label: '✕ Given walls (8×8)', group: 'Hamilton cycle',
    glob: 'full_walls_8x8', tiers: '50,200,200,50', tierBands: '0:255,220:300,265:480,430:1200',
    blurb: 'Visit every dot using only permanent blocked walls (✕).',
  },
  {
    id: 'full-mixed-8x8', name: 'Lines & walls (8×8)', label: '🚧 Lines & walls (8×8)', group: 'Hamilton cycle',
    glob: 'full_mixed_8x8', tiers: '50,200,200,50', tierBands: '0:255,220:300,265:500,450:1200',
    blurb: 'Visit every dot guided by a mix of permanent segments and walls.',
  },
  {
    id: 'full-swiss-10x10', name: 'Swiss cheese (10×10)', label: '🧀 Swiss cheese (10×10)', group: 'Hamilton cycle',
    glob: 'full_swiss_10x10', tiers: '50,200,200,50',
    blurb: 'Visit every remaining dot on a 10×10 grid punched with balanced interior holes.',
  },
  {
    id: 'full-sym-8x8', name: 'Symmetry (8×8)', label: '🪞 Symmetry (8×8)', group: 'Hamilton cycle',
    glob: 'full_sym_rot180_8x8,full_sym_mirror_8x8', tiers: '50,200,200,50', balanceGroups: true, interleaveGroups: true, maxRun: 2,
    blurb: 'Mirror and 180° symmetric given lines and walls on a full-board loop.',
  },

  // ---- Swiss cheese (top-level section: 10x10, 12x12, 16x16, 12x20 — 500 core + Expert+ tail)
  {
    id: 'swiss-10x10', name: 'Swiss cheese (10×10)', label: '🧀 10×10', group: 'Masyu', sub: 'Swiss cheese',
    glob: 'shaped_swiss_10x10', tiers: '50,200,200,50', tierBands: '0:350,300:410,355:620,520:1300',
    expertPlus: 10,
    blurb: 'Compact 10×10 boards with 3–5 interior cutout holes across all four difficulties, plus Expert+.',
  },
  {
    id: 'swiss-12x12', name: 'Swiss cheese (12×12)', label: '🧀 12×12', group: 'Masyu', sub: 'Swiss cheese',
    glob: 'swiss_12x12', tiers: '50,200,200,50', tierBands: '0:485,440:560,490:820,600:1700',
    expertPlus: 10,
    blurb: 'Classic 12×12 boards with 5–8 interior cutout holes across all four difficulties, plus Expert+.',
  },
  {
    id: 'swiss-16x16', name: 'Swiss cheese (16×16)', label: '🧀 16×16', group: 'Masyu', sub: 'Swiss cheese',
    glob: 'swiss_16x16', tiers: '50,200,200,50', tierBands: '0:870,780:960,890:1350,1100:2900',
    expertPlus: 10,
    blurb: 'Big 16×16 boards with 8–13 scattered cutout holes across all four difficulties, plus Expert+.',
  },
  {
    id: 'swiss-12x20', name: 'Swiss cheese (12×20)', label: '🧀 12×20', group: 'Masyu', sub: 'Swiss cheese',
    glob: 'swiss_12x20', tiers: '50,200,200,50', tierBands: '0:810,725:900,800:1250,1020:2700',
    expertPlus: 10,
    blurb: 'Tall 12×20 boards with 8–13 scattered cutout holes across all four difficulties, plus Expert+.',
  },

  // ---- Bonus: one fixed-size book per gimmick (500 puzzles at 10/40/40/10 + 10 Expert+ + 10 Mega finale) + Patterns
  {
    id: 'bonus-white', name: 'All white', label: '⚪ All white (8×8)', group: 'Masyu', sub: 'Bonus',
    glob: 'white_8x8', tiers: '50,200,200,50', tierBands: '0:265,240:305,300:485,470:950',
    expertPlus: 10, bonusGlob: 'white_12x20', bonusCount: 10,
    blurb: 'Every circle is white — straight lines and forced turns.',
  },
  {
    id: 'bonus-black', name: 'All black', label: '⚫ All black (10×10)', group: 'Masyu', sub: 'Bonus',
    glob: 'black_10x10', tiers: '50,200,200,50', tierBands: '0:345,315:380,365:510,500:1100',
    expertPlus: 10, bonusGlob: 'black_12x20', bonusCount: 10,
    blurb: 'Every circle is black — sharp corners and long legs.',
  },
  {
    id: 'bonus-cookie', name: 'Black & White Cookie', label: '🍪 Black & White Cookie (10×10)', group: 'Masyu', sub: 'Bonus',
    glob: 'cookie_angle_10x10',
    tiers: '50,200,200,50', tierBands: '0:375,345:430,415:625,600:1200',
    expertPlus: 10, bonusGlob: 'cookie_angle_12x20', bonusCount: 10,
    blurb: 'The board is split in half with black dots on one side and white dots on the other.',
  },
  {
    id: 'bonus-skyscraper', name: 'Skyscraper', label: '🏙️ Skyscraper (6×20)', group: 'Masyu', sub: 'Bonus',
    glob: 'sky_6x20', tiers: '50,200,200,50', tierBands: '0:455,415:505,480:730,700:1300',
    expertPlus: 10, bonusGlob: 'tallsky_6x40', bonusCount: 10,
    blurb: 'Tall, narrow towers where the loop snakes up and down.',
  },
  {
    id: 'bonus-symmetry', name: 'Symmetry', label: '🪞 Symmetry (10×10)', group: 'Masyu', sub: 'Bonus',
    glob: 'sym_rot180_10x10,sym_mirror_10x10,sym_transpose_10x10',
    tiers: '50,200,200,50', tierBands: '0:365,315:420,375:600,570:1200', balanceGroups: true, interleaveGroups: true, maxRun: 3,
    expertPlus: 10, bonusGlob: 'sym_rot180_14x14,sym_mirror_14x14,sym_transpose_14x14', bonusCount: 10,
    blurb: 'Mirror, diagonal, and 180° symmetric clues and loops.',
  },
  {
    id: 'bonus-patterns', name: 'Patterns', label: '💠 Patterns (9×9 – 13×13)', group: 'Masyu', sub: 'Bonus',
    glob: 'lattice_9x9,lattice_13x13,pat_blocks2x2_9x9,pat_quilt2x2_10x10,pat_circle_10x10,pat_honeycomb_10x10,pat_pillars_9x9,pat_hourglass_10x10,pat_brackets_10x10,pat_xbracket_9x9,pat_spiral_10x10,pat_stairs_9x9,pat_smallx_9x9,pat_bricks_10x10,pat_dominoes_10x10,pat_ltiles_10x10,pat_mirrorltiles_10x10,pat_herringbone_10x10,pat_slashes_10x10,pat_zigzags_10x10',
    tierBands: '0:,0:,0:,0:1300', interleaveGroups: true, maxRun: 2,
    blurb: 'Bold shapes & repeating wallpapers — lattice, pillars, hourglass, spiral, brickwork, herringbone, and more.',
  },

  // ---- Slitherlink Classic (per-size/per-difficulty 500-puzzle books, like Masyu) + Bonus
  ...([
    ['7x7', '7×7', 'slither_8x8'],
    ['10x10', '10×10', 'slither_11x11'],
    ['12x12', '12×12', 'slither_13x13'],
    ['10x16', '10×16', 'slither_11x17'],
  ].flatMap(([slug, dimLabel, glob]) => [
    {
      id: `slither-${slug}-beginner`, name: `Slitherlink ${dimLabel} Beginner`, label: 'Beginner',
      group: 'Slitherlink', sub: 'Classic', sub2: dimLabel, glob, limit: 500, onlyTier: 'Beginner',
      blurb: 'Warm-up Slitherlink boards using core number and corner rules.',
    },
    {
      id: `slither-${slug}-medium`, name: `Slitherlink ${dimLabel} Medium`, label: 'Medium',
      group: 'Slitherlink', sub: 'Classic', sub2: dimLabel, glob, limit: 500, onlyTier: 'Medium',
      blurb: 'Corner-2 couplings, 1-line-in patterns, basic shading, and 1-step lookahead.',
    },
    {
      id: `slither-${slug}-hard`, name: `Slitherlink ${dimLabel} Hard`, label: 'Hard',
      group: 'Slitherlink', sub: 'Classic', sub2: dimLabel, glob, limit: 500, onlyTier: 'Hard',
      blurb: 'Slitherlink shading, loop topology, and short single-thread lookahead.',
    },
    {
      id: `slither-${slug}-expert`, name: `Slitherlink ${dimLabel} Expert`, label: 'Expert',
      group: 'Slitherlink', sub: 'Classic', sub2: dimLabel, glob, limit: 500, onlyTier: 'Expert',
      blurb: 'Deep lookahead chains on pure Slitherlink grids.',
    },
  ])),
  {
    id: 'slither-swiss-10x10', name: 'Slitherlink — Swiss cheese', label: '🧀 Swiss cheese (10×10)', group: 'Slitherlink', sub: 'Bonus',
    glob: 'slither_swiss_10x10', tiers: '50,200,200,50',
    blurb: 'Slitherlink on boards punched with random interior holes — each hole is entirely Inside or Outside.',
  },
  {
    id: 'slither-sky-6x18', name: 'Slitherlink — Skyscraper', label: '🏙️ Skyscraper (6×18)', group: 'Slitherlink', sub: 'Bonus',
    glob: 'slither_sky_6x18', tiers: '50,200,200,50',
    blurb: 'Tall, narrow Slitherlink towers where the loop weaves up and down.',
  },
  {
    id: 'slither-sym-9x9', name: 'Slitherlink — Symmetry', label: '🪞 Symmetry (9×9)', group: 'Slitherlink', sub: 'Bonus',
    glob: 'slither_sym_rot180_9x9,slither_sym_mirror_9x9,slither_sym_transpose_9x9',
    tiers: '50,200,200,50', balanceGroups: true, interleaveGroups: true, maxRun: 2,
    blurb: 'Mirror, diagonal, and 180° symmetric Slitherlink clues and loops.',
  },
  {
    id: 'slither-all3-8x8', name: 'Slitherlink — All 3s', label: '3️⃣ All 3s (8×8)', group: 'Slitherlink', sub: 'Bonus',
    glob: 'slither_all3_8x8', tiers: '50,200,200,50',
    blurb: 'Pure Slitherlink where every single numbered square is a 3.',
  },

  // ---- Mid-loop (full-size 500-puzzle books at 10/40/40/10)
  {
    id: 'midloop-small', name: 'Mid-loop — Small', label: 'Small (7×7)', group: 'Mid-loop',
    glob: 'midloop_7x7', tiers: '50,200,200,50',
    blurb: 'Compact 7×7 Mid-loop boards across all four difficulties.',
  },
  {
    id: 'midloop-classic', name: 'Mid-loop — Classic', label: 'Classic (10×10)', group: 'Mid-loop',
    glob: 'midloop_10x10', tiers: '50,200,200,50',
    blurb: 'Classic 10×10 Mid-loop boards across all four difficulties.',
  },
  {
    id: 'midloop-large', name: 'Mid-loop — Large', label: 'Large (12×12)', group: 'Mid-loop',
    glob: 'midloop_12x12', tiers: '50,200,200,50',
    blurb: 'Big 12×12 Mid-loop boards across all four difficulties.',
  },

  // ---- Hybrids (two loop rule sets combined — every puzzle requires both)
  {
    id: 'full-masyu-8x8', name: 'Masyu + Hamilton cycle', label: '⚪🔁 Classic (8×8)', group: 'Hybrids', sub: 'Masyu + Hamilton cycle',
    glob: 'full_masyu_8x8', tiers: '50,200,200,50', tierBands: '0:245,210:295,265:520,470:1300',
    blurb: 'Sparse Masyu circles where visiting every dot is required to find the unique loop.',
  },
  {
    id: 'hybrid-slither-masyu', name: 'Slitherlink + Masyu', label: '🔢⚪ Classic (8×8)', group: 'Hybrids', sub: 'Slitherlink + Masyu',
    glob: 'hybrid_slither_masyu_8x8', tiers: '50,200,200,50',
    blurb: 'Numbered squares and Masyu circles share one single loop — every puzzle genuinely requires both.',
  },
  {
    id: 'hybrid-slither-full', name: 'Slitherlink + Hamilton cycle', label: '🔢🔁 Classic (8×8)', group: 'Hybrids', sub: 'Slitherlink + Hamilton cycle',
    glob: 'hybrid_slither_full_8x8', tiers: '50,200,200,50',
    blurb: 'Slitherlink numbers on a Hamilton cycle that visits every single dot.',
  },
  {
    id: 'hybrid-slither2-full', name: 'All 2s + Hamilton cycle', label: '2️⃣🔁 All 2s (6×7)', group: 'Hybrids', sub: 'Slitherlink + Hamilton cycle',
    glob: 'hybrid_slither2_full_6x7', tiers: '50,200,200,50',
    blurb: 'Every clue is a 2 on a Hamilton cycle that visits every single dot.',
  },
  {
    id: 'hybrid-midloop-masyu', name: 'Mid-loop + Masyu', label: '🎯⚪ Classic (8×8)', group: 'Hybrids', sub: 'Mid-loop + Masyu',
    glob: 'hybrid_midloop_masyu_8x8', tiers: '50,200,200,50',
    blurb: 'Teal midpoint dots and Masyu circles share one single loop — every puzzle genuinely requires both.',
  },
  {
    id: 'hybrid-midloop-slither', name: 'Mid-loop + Slitherlink', label: '🎯🔢 Classic (8×8)', group: 'Hybrids', sub: 'Mid-loop + Slitherlink',
    glob: 'hybrid_midloop_slither_8x8', tiers: '50,200,200,50',
    blurb: 'Teal midpoint dots and Slitherlink numbers share one single loop — every puzzle genuinely requires both.',
  },
  {
    id: 'hybrid-midloop-full', name: 'Mid-loop + Hamilton cycle', label: '🎯🔁 Classic (8×8)', group: 'Hybrids', sub: 'Mid-loop + Hamilton cycle',
    glob: 'hybrid_midloop_full_8x8', tiers: '50,200,200,50',
    blurb: 'Teal midpoint dots on a Hamilton cycle that visits every single dot.',
  },
];

const onlyArg = process.argv.find((a, i) => process.argv[i - 1] === '--only')
  || (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const onlySet = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;

const builtFiles = [];
if (onlySet) {
  for (const r of recipes) {
    if (!onlySet.has(r.id) && fs.existsSync(path.join(root, 'data', `${r.id}.csv`))) {
      builtFiles.push(`data/${r.id}.csv`);
    }
  }
}

for (const r of recipes) {
  if (onlySet && !onlySet.has(r.id)) continue;
  const args = [
    buildScript,
    '--id', r.id,
    '--name', r.name,
    '--label', r.label,
    '--group', r.group,
    '--glob', r.glob,
    '--blurb', r.blurb,
    '--sub', r.sub || '',
    '--sub2', r.sub2 || '',
  ];
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
  if (r.sortByGroup) args.push('--sort-by-group');
  if (r.maxRun) args.push('--max-run', String(r.maxRun));
  if (builtFiles.length) args.push('--exclude', builtFiles.join(','));
  execFileSync(process.execPath, args, { stdio: 'inherit' });
  builtFiles.push(`data/${r.id}.csv`);
}

// Re-order manifest.books so non-hidden books appear in recipe order, hidden at the end,
// and sync recipe metadata (name/label/group/sub/sub2/blurb) even for skipped untouched books.
const finalManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const byId = new Map(finalManifest.books.map((b) => [b.id, b]));
for (const r of recipes) {
  const entry = byId.get(r.id);
  if (!entry) continue;
  entry.name = r.name;
  entry.label = r.label;
  entry.group = r.group;
  entry.blurb = r.blurb;
  if (r.sub) entry.sub = r.sub;
  else delete entry.sub;
  if (r.sub2) entry.sub2 = r.sub2;
  else delete entry.sub2;
}
finalManifest.default = manifest.default;
finalManifest.groups = manifest.groups;
finalManifest.books = [
  ...recipes.map((r) => byId.get(r.id)).filter(Boolean),
  ...finalManifest.books.filter((b) => b.hidden),
];
fs.writeFileSync(manifestPath, JSON.stringify(finalManifest, null, 2) + '\n', 'utf8');
console.log('\nUpdated data/manifest.json with', finalManifest.books.length, 'books.');
