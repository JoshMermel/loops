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
      blurb: 'Small Beginner puzzles (5×5 and 6×6) that introduce the core white and black circle rules.',
    },
    {
      name: 'Default',
      icon: '📚',
      blurb: 'Standard Masyu boards by size — from quick 6×6 warm-ups up to giant 18×18 and 12×20 grids, easiest first.',
    },
    {
      name: 'Bonus',
      icon: '🎁',
      blurb: 'Themed variations using the exact same rules with a distinct feel.',
      subs: {
        'All white': {
          icon: '⚪',
          blurb: 'Every circle is white: straight lines and forced turns everywhere.',
        },
        'All black': {
          icon: '⚫',
          blurb: 'Every circle is black: sharp corners and long two-step legs.',
        },
        'Sparse': {
          icon: '🔹',
          blurb: 'Stripped down to as few circles as uniqueness allows.',
        },
        'Skyscraper': {
          icon: '🏙️',
          blurb: 'Tall, narrow towers (up to 6×30) where the loop snakes up and down.',
        },
        'Exact symmetry': {
          icon: '🪞',
          blurb: 'Mirror, diagonal-mirror, 180°, and 90° rotational puzzles where both clues and solution loop are symmetric.',
        },
        'Yin-Yang': {
          icon: '☯️',
          blurb: '180° opposite-color symmetry: turn the board upside down and every white circle lands on a black circle.',
        },
        'No edge clues': {
          icon: '🎯',
          blurb: 'Zero circles on the outer border — no free wall openings, work outward from the interior.',
        },
        'Lattice': {
          icon: '💠',
          blurb: 'Every even row and even column holds a circle — all dots present, and none anywhere else.',
        },
        'Full board': {
          icon: '🧱',
          blurb: 'Every single intersection on the grid is visited by the loop (100% fill, standard Masyu rules).',
        },
      },
    },
  ],
  books: existingHidden,
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const recipes = [
  // ---- Start here
  {
    id: 'intro', name: 'Gentle intro', label: 'Gentle intro', group: 'Start here',
    glob: 'intro_', limit: 60, onlyTier: 'Beginner',
    blurb: '60 small Beginner puzzles (5×5 and 6×6), easiest first.',
  },

  // ---- Default sizes (6x6 through giant 18x18 & 12x20)
  {
    id: '6x6', name: '6×6', label: '6×6', group: 'Default',
    glob: 'balanced_6x6', tiers: '40,40,40',
    blurb: '120 puzzles on 6×6 boards — 40 each of Beginner, Medium, and Hard.',
  },
  {
    id: '8x8', name: '8×8', label: '8×8', group: 'Default',
    glob: 'balanced_8x8', tiers: '40,40,40',
    blurb: '120 puzzles on 8×8 boards — 40 each of Beginner, Medium, and Hard.',
  },
  {
    id: '10x10', name: '10×10', label: '10×10', group: 'Default',
    glob: 'balanced_10x10', tiers: '30,30,30',
    blurb: '90 puzzles on 10×10 boards — 30 each of Beginner, Medium, and Hard.',
  },
  {
    id: '12x12', name: '12×12', label: '12×12', group: 'Default',
    glob: 'balanced_12x12', tiers: '25,25,25',
    blurb: '75 puzzles on 12×12 boards — 25 each of Beginner, Medium, and Hard.',
  },
  {
    id: '14x14', name: '14×14', label: '14×14', group: 'Default',
    glob: 'balanced_14x14', tiers: '15,15,15',
    blurb: '45 large puzzles on 14×14 boards — 15 each of Beginner, Medium, and Hard.',
  },
  {
    id: '16x16', name: '16×16', label: '16×16', group: 'Default',
    glob: 'balanced_16x16', tiers: '12,12,12',
    blurb: '36 big puzzles on 16×16 boards — 12 each of Beginner, Medium, and Hard.',
  },
  {
    id: '18x18', name: '18×18', label: '18×18', group: 'Default',
    glob: 'balanced_18x18', limit: 24,
    blurb: '24 giant 18×18 square boards for long, deep solves.',
  },
  {
    id: '12x20', name: '12×20 Giant', label: '12×20 Giant', group: 'Default',
    glob: 'balanced_12x20', limit: 24,
    blurb: '24 tall giant 12×20 boards (classic magazine-page proportions).',
  },

  // ---- Bonus: All white
  {
    id: 'bonus-white-6x6', name: 'All white 6×6', label: '6×6', group: 'Bonus', sub: 'All white',
    glob: 'white_6x6', limit: 60,
    blurb: '60 all-white Masyu puzzles on 6×6 boards, easiest first.',
  },
  {
    id: 'bonus-white-8x8', name: 'All white 8×8', label: '8×8', group: 'Bonus', sub: 'All white',
    glob: 'white_8x8', limit: 60,
    blurb: '60 all-white Masyu puzzles on 8×8 boards, easiest first.',
  },
  {
    id: 'bonus-white-10x10', name: 'All white 10×10', label: '10×10', group: 'Bonus', sub: 'All white',
    glob: 'white_10x10', limit: 45,
    blurb: '45 all-white Masyu puzzles on 10×10 boards, easiest first.',
  },

  // ---- Bonus: All black
  {
    id: 'bonus-black-6x6', name: 'All black 6×6', label: '6×6', group: 'Bonus', sub: 'All black',
    glob: 'black_6x6', limit: 60,
    blurb: '60 all-black Masyu puzzles on 6×6 boards, easiest first.',
  },
  {
    id: 'bonus-black-8x8', name: 'All black 8×8', label: '8×8', group: 'Bonus', sub: 'All black',
    glob: 'black_8x8', limit: 60,
    blurb: '60 all-black Masyu puzzles on 8×8 boards, easiest first.',
  },
  {
    id: 'bonus-black-10x10', name: 'All black 10×10', label: '10×10', group: 'Bonus', sub: 'All black',
    glob: 'black_10x10', limit: 45,
    blurb: '45 all-black Masyu puzzles on 10×10 boards, easiest first.',
  },

  // ---- Bonus: Sparse
  {
    id: 'bonus-sparse-8x8', name: 'Sparse 8×8', label: '8×8', group: 'Bonus', sub: 'Sparse',
    glob: 'sparse_8x8', limit: 60,
    blurb: '60 minimal-clue 8×8 puzzles stripped as far as uniqueness allows.',
  },
  {
    id: 'bonus-sparse-10x10', name: 'Sparse 10×10', label: '10×10', group: 'Bonus', sub: 'Sparse',
    glob: 'sparse_10x10', limit: 45,
    blurb: '45 minimal-clue 10×10 puzzles stripped as far as uniqueness allows.',
  },

  // ---- Bonus: Skyscraper
  {
    id: 'bonus-skyscraper', name: 'Skyscraper', label: 'Standard (5×14 – 6×20)', group: 'Bonus', sub: 'Skyscraper',
    glob: 'sky_', limit: 60,
    blurb: '60 tall, narrow puzzles (5×14, 6×16, and 6×20), easiest first.',
  },
  {
    id: 'bonus-skyscraper-tall', name: 'Tall Skyscraper', label: 'Mega (6×24 – 6×30)', group: 'Bonus', sub: 'Skyscraper',
    glob: 'tallsky_', limit: 36,
    blurb: '36 extra-tall tower puzzles (6×24, 8×24, and 6×30), easiest first.',
  },

  // ---- Bonus: Exact symmetry
  {
    id: 'bonus-symmetry-8x8', name: 'Exact symmetry 8×8', label: '8×8', group: 'Bonus', sub: 'Exact symmetry',
    glob: 'sym_rot180_8x8,sym_mirror_8x8,sym_transpose_8x8,sym_rot90_8x8', limit: 60,
    blurb: '60 symmetric 8×8 puzzles mixing mirror, diagonal-mirror, 180°, and 90° rotational symmetry.',
  },
  {
    id: 'bonus-symmetry-10x10', name: 'Exact symmetry 10×10', label: '10×10', group: 'Bonus', sub: 'Exact symmetry',
    glob: 'sym_rot180_10x10,sym_mirror_10x10,sym_transpose_10x10,sym_rot90_10x10', limit: 48,
    blurb: '48 symmetric 10×10 puzzles mixing mirror, diagonal-mirror, 180°, and 90° rotational symmetry.',
  },

  // ---- Bonus: Yin-Yang
  {
    id: 'bonus-yinyang-8x8', name: 'Yin-Yang 8×8', label: '8×8', group: 'Bonus', sub: 'Yin-Yang',
    glob: 'yinyang_8x8', limit: 45,
    blurb: '45 opposite-color 180° symmetric puzzles on 8×8 boards.',
  },
  {
    id: 'bonus-yinyang-10x10', name: 'Yin-Yang 10×10', label: '10×10', group: 'Bonus', sub: 'Yin-Yang',
    glob: 'yinyang_10x10', limit: 30,
    blurb: '30 opposite-color 180° symmetric puzzles on 10×10 boards.',
  },

  // ---- Bonus: No edge clues (Interior only)
  {
    id: 'bonus-interior-8x8', name: 'No edge clues 8×8', label: '8×8', group: 'Bonus', sub: 'No edge clues',
    glob: 'interior_8x8', limit: 45,
    blurb: '45 puzzles on 8×8 boards with zero circles on the outer border.',
  },
  {
    id: 'bonus-interior-10x10', name: 'No edge clues 10×10', label: '10×10', group: 'Bonus', sub: 'No edge clues',
    glob: 'interior_10x10', limit: 45,
    blurb: '45 puzzles on 10×10 boards with zero circles on the outer border.',
  },

  // ---- Bonus: Lattice (all even-row, even-col dots present)
  {
    id: 'bonus-lattice-9x9', name: 'Lattice 9×9', label: '9×9 (all 22)', group: 'Bonus', sub: 'Lattice',
    glob: 'lattice_9x9', limit: 22,
    blurb: 'All 22 unique 9×9 full-lattice puzzles (up to symmetry) with every even-row, even-column circle present.',
  },
  {
    id: 'bonus-lattice-big', name: 'Lattice big', label: '9×11 & 13×13', group: 'Bonus', sub: 'Lattice',
    glob: 'lattice_9x11,lattice_13x13', limit: 32,
    blurb: '32 larger full-lattice puzzles on 9×11 (20 dots) and 13×13 (36 dots) boards.',
  },

  // ---- Bonus: Full board (100% loop fill)
  {
    id: 'bonus-full-6x6', name: 'Full board 6×6', label: '6×6', group: 'Bonus', sub: 'Full board',
    glob: 'full_6x6', limit: 45,
    blurb: '45 full-fill 6×6 puzzles where the loop visits every intersection.',
  },
  {
    id: 'bonus-full-8x8', name: 'Full board 8×8', label: '8×8', group: 'Bonus', sub: 'Full board',
    glob: 'full_8x8', limit: 45,
    blurb: '45 full-fill 8×8 puzzles where the loop visits every intersection.',
  },
  {
    id: 'bonus-full-10x10', name: 'Full board 10×10', label: '10×10', group: 'Bonus', sub: 'Full board',
    glob: 'full_10x10', limit: 30,
    blurb: '30 full-fill 10×10 puzzles where the loop visits every intersection.',
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
