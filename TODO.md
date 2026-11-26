# TODO

Open follow-ups and future ideas for Masyu (see [README.md](README.md) for architecture and shipped features).

## Gimmick token books to playtest & evaluate

Try these 24-puzzle tasting books and decide for each one whether to **grow to 500**, **keep small**, or **delete**:

### Hybrids → Gray dots + each pure family
- [ ] `hybrid-gray-full` — **🔘🔁 Gray dots + Hamilton cycle (8×8)** (all-gray Masyu circles on a Hamilton cycle visiting every dot)
- [ ] `hybrid-midloop-gray` — **🎯🔘 Mid-loop + Gray dots (8×8)** (teal midpoint dots paired with all-gray Masyu circles)
- [ ] `hybrid-castle-gray` — **🏰🔘 Castle Wall + Gray dots (8×8)** (Castle Wall blocks & arrows paired with all-gray Masyu circles)

## Variants & future twists

- [ ] **Castle Wall Bonus gimmicks (Step 6):** add Castle Wall Bonus tasting books (e.g. Symmetry, All-gray walls, Unnumbered walls, Skyscraper, Swiss cheese).
- [ ] **Mid-loop Classic per-size × difficulty split (optional):** split pure `Mid-loop → Classic` (`7×7`, `10×10`, `12×12`) into separate Beginner/Medium/Hard/Expert books to match Masyu, Slitherlink, and Castle Wall.
- [ ] **New single-loop families in `js/variants/`:**
  - **Corral / Bag:** dual-square sightline numbers (strictly Inside the loop), standalone + hybrids with Masyu, Mid-loop, Castle Wall, Hamilton cycle (and visually distinct badges if paired with Slitherlink).
  - **Balance Loop / Yajilin / Simple Loop** (lower priority).
- [ ] **More pure Slitherlink gimmicks:**
  - Digit-restricted boards: No 3s (`0/1/2`), Even only (`0/2`), Odd only (`1/3`).
  - Geometric clue masks (Slitherlink `Patterns`), plus larger sizes (`13×13`, `15×15`).
- [ ] **More Hybrid gimmicks** (inside our remaining `Hybrids` subcategories):
  - *Masyu + Hamilton cycle:* All white, All black, Gray dots, Swiss cheese, Symmetry.
  - *Mid-loop + Masyu / Mid-loop + Hamilton cycle:* Gray dots, Swiss cheese, Symmetry, All even / All odd.
- [ ] **New circle types:**
  - **Strict / double-turn whites & numbered blacks:** e.g. marked white circles that must turn on *both* sides, and/or numbered black circles whose straight legs have a required length.
  - **Anti-Masyu (inverted pearls):** inverted rules (white turns and immediately turns on ≥1 side; black goes straight and stays straight on both sides), standalone or mixed with standard circles.
- [ ] **Cylinder / Torus / Möbius strip / Klein bottle:** wrap-around edge topologies (including twisted/non-orientable identifications where Inside/Outside shading generalizes or disables). Inspired by Jason Davies's [Planarity](https://www.jasondavies.com/planarity/) — inspect closely during implementation and credit the author for inspiration.
- [ ] **Hexagonal or triangular grids (maybe):** generalized non-square lattice topology (`K = 3` / `K = 6` in `js/logic.js`) with a dedicated renderer and drag handler.

## Rules, books & generator

- [ ] **Rescore older Masyu books (optional housekeeping):** ~0.5–2% of puzzles in pre-Mid-loop Masyu Hard/Expert/Swiss books have minor `rules`/`score` drift (`0` tier changes) from earlier engine updates; run `tools/rescore.mjs` if we want `--all --rate` 100% zero-diff across legacy books too.
- [ ] **Additional cross-family hybrid inferences (if new patterns emerge from play):** `slitherStraightCorner`, `slitherMustVisitCorner`, and `blackMustVisitReach` are now shipped and illustrated; revisit if playtesting surfaces more recurring Medium/Hard hybrid `imagine` patterns.
- [ ] **Consider promoting other Bonus books to top-level sections:** review whether any remaining Bonus themes (e.g., All white / All black, Black & White Cookie, Skyscraper, Symmetry, Patterns) merit their own top-level section with multiple sizes or variations.
- [ ] **New human rules from play:** play generated Medium/Hard puzzles and note any recurring patterns currently handled by `imagine` that deserve their own cheaper named rule (e.g., diagonally adjacent black & white circles near a wall, two diagonally adjacent white circles forcing a corridor, `pairedEnds` with 4/6 ends, or hint-only `uniqueRoute`).
- [ ] **Explore even larger boards or custom packs:** e.g. `20×20` / `20×36` mega boards using `tools/fill_pools.mjs` / `tools/overnight.mjs`.
- [ ] **More themed Masyu Bonus ideas:** 180° symmetric clue *positions* with free circle colors and asymmetric loops; diagonal stripes / X-pattern / border-only frame on larger boards.

## UI, polish & housekeeping

- [ ] **Daily / Random puzzle picker:** one-click "Daily" or "Surprise me" picker by puzzle family and difficulty.
- [ ] **Custom puzzle builder / shareable URL links:** draw or paste a custom board and share it via URL hash.
- [ ] **Cross-machine completion sync / login (maybe):** optionally allow signing in to share puzzle completion status across devices (see Star Battle for reference).
- [ ] **Phone / touch testing** of edge-tap vs cell-drag hit margins (`EDGE_MARGIN` in `js/board.js`).
- [ ] **Playwright PNG screenshots** (`tools/capture_how_to_images.py`) once Playwright is installed, to compare against the pure-Node SVG illustrations.
