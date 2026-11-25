# TODO

Open follow-ups and future ideas for Masyu (see [README.md](README.md) for architecture and shipped features).

## Variants & future twists

- [x] **Shaped / cutout boards:** void intersections (`X`), exact rounded board silhouettes, unified single-target interior holes with Inside/Outside propagation, **Swiss cheese (10×10)** (500 puzzles), and **Shape sampler** (120 puzzles across 12 shapes sorted by shape — curate keepers/cuts after playtesting).
- [ ] **Pre-walled / maze Masyu:** standard Masyu puzzles with permanent given walls (`H0`/`V0`, already supported by the engine & UI) forming rooms, corridors, and mazes.
- [ ] **New circle types:**
  - **Strict / double-turn whites & numbered blacks:** e.g. marked white circles that must turn on *both* sides, and/or numbered black circles whose straight legs have a required length.
  - **Anti-Masyu (inverted pearls):** inverted rules (white turns and immediately turns on ≥1 side; black goes straight and stays straight on both sides), standalone or mixed with standard circles.
- [ ] **Cylinder / Torus / Möbius strip / Klein bottle:** wrap-around edge topologies (including twisted/non-orientable identifications where Inside/Outside shading generalizes or disables). Inspired by Jason Davies's [Planarity](https://www.jasondavies.com/planarity/) — inspect closely during implementation and credit the author for inspiration.
- [ ] **Hexagonal or triangular Masyu (maybe):** generalized non-square lattice topology (`K = 3` / `K = 6` in `js/logic.js`) with a dedicated renderer and drag handler.

## Rules, books & generator

- [ ] **Audit full-board necessity across all Full-board books:** verify that every shipped `fullBoard` puzzle (`full-masyu-8x8`, `full-lines-8x8`, `full-walls-8x8`, `full-mixed-8x8`) is NOT uniquely solvable without the full-board condition (i.e., has >1 solution when `fullBoard` is dropped), and consider enforcing this check in `tools/audit_books.mjs`.
- [ ] **Black & White Cookie arbitrary-angle splits:** allow the dividing line between white and black halves to be placed at arbitrary angles (not just vertical, horizontal, and main diagonal).
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

- [ ] **Context-aware Help modal for special rules:** surface dedicated explanations (and diagrams) for active special rules — such as Gray circles, Full board, given lines/walls, and Shaped cutouts — when viewing a puzzle where those rules apply (instead of showing them all unconditionally or burying them in Controls).
- [ ] **Split special-rule deductions in the solving guide:** consider moving variant-specific rules (Gray circles, Full-board checkerboard parity, etc.) into dedicated sections or separate docs within `docs/how_to_solve.{md,html}` so the core Masyu guide stays focused.
- [ ] **Rename "Exact symmetry" to "Symmetry"** across the book picker, manifest, and docs.
- [ ] **Clarify Gray circles category description:** note that figuring out each gray circle's identity (white vs. black) is part of the puzzle.
- [ ] **Cross-machine completion sync / login (maybe):** optionally allow signing in to share puzzle completion status across devices (see Star Battle for reference).
- [ ] **Phone / touch testing** of edge-tap vs cell-drag hit margins (`EDGE_MARGIN` in `js/board.js`).
- [ ] **Playwright PNG screenshots** (`tools/capture_how_to_images.py`) once Playwright is installed, to compare against the pure-Node SVG illustrations.
