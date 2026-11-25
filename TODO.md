# TODO

Open follow-ups and future ideas for Masyu (see [README.md](README.md) for architecture and shipped features).

## Variants & future twists

- [ ] **New circle types:**
  - **Strict / double-turn whites & numbered blacks:** e.g. marked white circles that must turn on *both* sides, and/or numbered black circles whose straight legs have a required length.
  - **Anti-Masyu (inverted pearls):** inverted rules (white turns and immediately turns on ≥1 side; black goes straight and stays straight on both sides), standalone or mixed with standard circles.
- [ ] **Cylinder / Torus / Möbius strip / Klein bottle:** wrap-around edge topologies (including twisted/non-orientable identifications where Inside/Outside shading generalizes or disables). Inspired by Jason Davies's [Planarity](https://www.jasondavies.com/planarity/) — inspect closely during implementation and credit the author for inspiration.
- [ ] **Hexagonal or triangular Masyu (maybe):** generalized non-square lattice topology (`K = 3` / `K = 6` in `js/logic.js`) with a dedicated renderer and drag handler.

## Rules, books & generator

- [ ] **Consider promoting other Bonus books to top-level sections:** review whether any remaining Bonus themes (e.g., All white / All black, Black & White Cookie, Skyscraper, Symmetry, Patterns) merit their own top-level section with multiple sizes or variations.
- [ ] **New human rules from play:** play generated Medium/Hard puzzles and note any recurring Masyu patterns currently handled by `imagine` that deserve their own cheaper named rule (remaining ideas:
  - diagonally adjacent black and white circles near a wall,
  - two white circles diagonally adjacent forcing a corridor,
  - paired open ends with 4 or 6 ends (`pairedEnds`),
  - uniqueness-assuming shortcuts (`uniqueRoute`) if desired for Hint only).
- [ ] **Explore even larger boards or custom packs:** e.g. `20×20` / `20×36` mega boards using `tools/fill_pools.mjs` / `tools/overnight.mjs`.
- [ ] **More themed Bonus ideas to explore:**
  - **Symmetric layout (asymmetric colors):** 180° symmetric clue *positions* with free circle colors and asymmetric loops.
  - **Diagonal stripes / X-pattern / Border-only frame on larger boards.**

## UI, polish & housekeeping

- [ ] **Cross-machine completion sync / login (maybe):** optionally allow signing in to share puzzle completion status across devices (see Star Battle for reference).
- [ ] **Phone / touch testing** of edge-tap vs cell-drag hit margins (`EDGE_MARGIN` in `js/board.js`).
- [ ] **Playwright PNG screenshots** (`tools/capture_how_to_images.py`) once Playwright is installed, to compare against the pure-Node SVG illustrations.
