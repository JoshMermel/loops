# TODO

Follows the puzzle-toolkit build order (see [README.md](README.md)).

## Done in initial build

- [x] Exact solver / uniqueness counter (`js/logic.js`), cross-checked against brute-force `tests/reference_solver.mjs`
- [x] Human-style scorer (`js/rating.js`, `js/imagine.js`) with 29 sound rules across Beginner, Medium, Hard
- [x] Hint explanations (`js/explain.js`, `js/hintstep.js`) with chain-of-consequences explanations and end-to-end Beginner/Medium hint-following test
- [x] Solution-first generator (`js/generator.js`, `tools/generate.mjs`, `tools/overnight.mjs`) scaling smoothly through 12×12
- [x] Starter corpus & books (`data/*.csv`, `data/manifest.json`, `tools/build_book.mjs`, `tools/rescore.mjs`, `tools/audit_books.mjs`): 10 visible books (351 audited puzzles) + hidden `armory`
- [x] Static browser GUI (`index.html`, `style.css`, `js/board.js`, `js/main.js`, `js/print.js`, palettes, dark mode, Browse, Book picker, deep links)
- [x] Generated `docs/how_to_solve.md` with hint illustrations from the hidden `armory` book

## Next: calibration & rule refinement

- [x] **External difficulty calibration & 4-tier split:** checked 176 published Masyu puzzles from multiple external sources, moved `threeWhites` / `twoWhitesStraight` into Beginner, fixed 0-step `imagine` area preemption, priced 3+ step `imagine` into Hard, and promoted full multi-rule trial-and-error (`tryEdge`) to **Expert** (keeping Hard strictly pure logic).
- [x] **Inside / Outside dual-face coloring inference (`faceParity`):** added dual-face parity union-find (lines, crosses, outer border, white-circle diagonals, black-circle 3-to-1 + forced 2-step legs) into `js/faceparity.js`, `js/rating.js`, `js/explain.js` (with tinted square Hint overlays), and rescored all books.
- [x] **5-tier rule recalibration & splits:** split `faceParity` into `faceShade` (Medium, matching Auto-Shade) and `faceCircle` (Hard, white diagonals + black 3-to-1 + relative chains); split `imagine` by cognitive load into `imagineLocal` (Medium), single-thread `imagineTrace` (Hard), and multi-front/long/area `imagineChain` (Expert); moved `whiteBothStraight`, `closingCell`, `samePathExits`, `twoWhitesStraight` to Medium and `chokepoint`/`parityPocket`/`twoEndsJoin` to Hard; kept `threeWhites` in Beginner; dropped Beginners from Giant books; topped up pools and rebuilt all 20 visible books + `armory` + solving guide.
- [x] **Expert max-score cap:** capped `Expert` upper scores across all books (`8×8 ≤ 900`, `12×12 ≤ 1700`, `16×16 ≤ 2900`, `12×20 ≤ 2700`, Bonus `≤ 950–1300`) so 10–22 trial slogs stay out of Expert books while `Expert+` remains strictly `unsolved`.
- [x] **Auto-X + Auto-Shade integration:** when both Auto-X and Auto-Shade are enabled, `autoXReasons(..., { useShade: true })` automatically places `✕` between adjacent squares shaded the same color AND on outer-border edges touching an Outside-shaded square (cascading cleanly with dead-end Auto-X and unwinding cleanly on erase or toggle).
- [x] **Auto-X white-circle eagerness:** in `js/marks.js` Rule 2 (`autoXReasons`), now requires BOTH straight segments through the white circle (`e1` and `e2`) to be drawn before auto-placing `✕` on `oppExt`.
- [x] **Flatten `Giants` subcategory inside `Default`:** removed the `Giants` sub-picker inside `Default` and updated `renderBookPicker` in `js/main.js` to list ungrouped books (`16×16`, `12×20 Giant`, `24×30 Full Page`) directly under the `8×8` / `12×12` cards.
- [x] **Revisit `24×30` Giant size + auto-rotation on landscape screens:** added pure logical 90° CW rotation ([js/rotate.js](js/rotate.js), [tests/rotate.test.mjs](tests/rotate.test.mjs)) with canonical `localStorage` saves, height-aware `fitBoard()`, vertical-overflow-first auto-rotation, and a manual `↻ Turn` button on non-square boards; replaced `24×30` with `16×24 Full Page` (100 puzzles, fits comfortably on normal laptop screens rotated to `24×16`).
- [x] **Giant quadrant-usage quality check:** added per-quadrant loop-fill penalties & annealing guidance in `tightLoop()` and per-quadrant minimum fill/clue checks in `generatePuzzle()` (`js/generator.js`), preventing lopsided boards like `24x30-01` (which had 14% top-right fill and bubbled to #1 when sorted by score).
- [x] **Revisit `💠 Patterns` choices:** retired the 5 Lattice lookalikes (`concentric-sq`, `twin-sq`, `diag-stripes`, `galaxy`, asymmetric `honeycomb-9x9`), made the entire `bonus-patterns` book **all-square** (`9×9`, `10×10`, `13×13`), and expanded it to **19 distinct bold shapes & symmetric wallpapers** (Lattice, Bullseye, 2×2 Blocks/Quilt, fixed symmetric 10×10 Honeycomb, Three Pillars, Hourglass, Viewfinder Brackets, Giant X, Solid Spiral, Staircase, Four Small 5-Pearl X's, Running-Bond Brickwork, Dominoes, L-Tiles, Mirrored L-Tiles, Herringbone, Diagonal Slashes, and Zigzag Columns).
- [x] **All white mega finale → `12×20`:** replaced the `14×14` mega finale puzzles at the end of `bonus-white` with 10 `12×20` All white boards.
- [x] **Black & White Cookie mega finale → `12×20` (with rectangular diagonal split):** generalized `cookie-diag` in `js/generator.js` to support rectangular boards (`r*(cols-1) + c*(rows-1) < (rows-1)*(cols-1)`), and replaced the `16×16` mega finale puzzles in `bonus-cookie` with 10 `12×20` boards across all three splits.
- [x] **Remove Yin-Yang book (`bonus-yinyang`):** retired the Yin-Yang Bonus book from `tools/build_all_books.mjs`, `tools/fill_pools.mjs`, `data/manifest.json`, and `data/bonus-yinyang.csv`.
- [x] **Evaluate generator language (JS vs. faster language):** profiled the 4,047-LOC shared core and decided to stay in zero-build JS/Node (single source of truth shared with browser hints; 62% of the core is the evolving human rater). Landed two rounds of pure-JS optimizations in `js/logic.js` (worklist-driven incremental `propagate()`, CSR edge-clue table, direct `LOOP`-cell path tracing replacing Step 5 union-find, in-place second branch in `solve()`), `js/rating.js` (single-pass `chokepointCheck`, Tarjan bridge pre-filtering in `findParity`, per-step cache in `nextSteps`, free-rule draining + `maxSteps` cutoff in `closure()`), and `js/imagine.js` (seeded `propagate()`, zero-deduction area-check skip, precomputed `onc` in `easyContradiction`, insertion-sorted scope) — achieving **7.7× faster `solve()`**, **2.8× faster `rate()`**, and **2.5–4.5× faster generation** with 100% identical outputs.
- [x] **Upgrade Bonus-book finales:** upgraded all 7 fixed-size Bonus books to 520 puzzles each (`500` core + `10 Expert+` beyond hints + `10 Mega` themed finales: `14×14` White / Exact symmetry / Yin-Yang tail, `12×20` All black & Full board via spanning-tree Hamiltonian seeding, `16×16` Cookie, `6×40` Mega Skyscraper).
- [x] **Pattern-based dot position layouts (Lattice family):** generalized fixed interior dot masks in `js/generator.js` (`concentric-sq`, `twin-sq`, `blocks2x2`, `quilt2x2`, `honeycomb`, `galaxy`, `circle-ring`, `diag-stripes`), folded `Lattice` into the mixed **💠 Patterns** Bonus book (`bonus-patterns`), ordered by Tier with per-group normalized quantile interleaving (`--max-run 2`) across mixed sizes (`9×9`–`13×13`).
- [x] **Code review:** full pass over `js/`, `tools/`, `tests/`, `index.html`, and `style.css`; fixed all High & Medium findings across the core engine (`rate()` final bookkeeping, Pass 2 clue sorting, `faceparity` shortcut shading, `threeWhites`/`twoWhitesStraight` edge deduplication, `tightLoop` topology reuse, `imagine`/`logic`/`explain` edge cases), UI/interaction (multi-touch guard, drag backtrack deadzone, hover/gesture reset on switch/rotate/keys, `load()` Auto-X sync, modal `inert`/`visibility` + focus, dark-mode hint tokens, `marks.js` stateless `autoXForced`), CLI tools (`audit_books`, `rescore`, `build_book`, `fill_pools`, `generate`, `capture_how_to_images`), and added unit tests (`imagine.test.mjs`, `armory` soundness sweep, incremental `propagate()`, backtrack/white-clue regressions).
- [ ] **Grow `16×16`, `12×20`, and `16×24` corpora for per-difficulty books:** expand these larger-board pools so each size can ship one book per viable difficulty tier (fine if Beginner — or even Medium — isn't viable on the largest sizes).
- [x] **Re-evaluate dismissing Auto-X marks:** locked Auto-X edges to match Auto-Shade (tapping, right-clicking, or dragging over an Auto-X edge is now a no-op; clearing a manual `✕` reveals any underlying Auto-X, which unwinds automatically when its cause is erased or Auto-X is toggled off) and simplified `reconcileAutoX` / `reconcileAutoShade` in `js/marks.js` into stateless recomputes.
- [ ] **New human rules from play:** play generated Medium/Hard puzzles and note any recurring Masyu patterns currently handled by `imagine` that deserve their own cheaper named rule (for example:
  - diagonally adjacent black and white circles near a wall,
  - two white circles diagonally adjacent forcing a corridor,
  - black circle forcing a white circle two cells away to turn at its far end,
  - paired open ends with 4 or 6 ends (`pairedEnds`),
  - uniqueness-assuming shortcuts (`uniqueRoute`) if desired for Hint only).
- [x] **Rescore & regenerate books after tier/cost updates:** rescored all pools, topped up Hard/Expert pools, rebuilt all 31 visible books + `armory`, regenerated `docs/how_to_solve.md`, and audited with `audit_books.mjs --rate --all`.

## Books & scaling

- [x] **Larger board sizes & per-difficulty Default + Bonus books:** `Gentle intro` (100), 4 separate score-banded 500-puzzle difficulty books (+ 10 `Expert+` beyond hints in Expert) for `8×8` and `12×12`, score-banded Giants (`16×16` 200, `12×20` 100, `24×30 Full Page` 60), 7 fixed-size 500+10 Bonus books (10/40/40/10 split + 10 oversized bonus puzzles at the end, including Black & White Cookie), and the 60-puzzle Lattice showcase — **8,110 audited puzzles across 20 visible books**.
- [x] **New themed Bonus corpuses:** Exact symmetry (`rot180`, `mirror`, `transpose`, balanced per tier), Yin-Yang (180° opposite-color symmetry), No edge clues (`interior`), Lattice (full even-row/even-col dot grid), and Full board (`100%` loop fill).
- [ ] **Grow further with `tools/fill_pools.mjs` / `tools/overnight.mjs`:** scale Default books toward 250–1000 puzzles each, or try `20×20` / `20×36` mega boards.
- [ ] **More themed Bonus ideas to explore:**
  - **Symmetric layout (asymmetric colors):** 180° symmetric clue *positions* with free circle colors and asymmetric loops.
  - **Diagonal stripes / X-pattern / Border-only frame on larger boards.**

## GUI polish & variants (as branches)

- [x] **Board rotation** (`js/rotate.js`) for tall rectangular boards (auto-landscape + Turn button).
- [ ] **Two-press step-by-step hints** (like `polyomino-panel`: first press shows where to look, second press shows the full deduction and ghost marks).
- [ ] **Offline play** (`sw.js` service worker opt-in in Settings, as in `polyomino-panel`).
- [ ] **Playwright PNG screenshots** (`tools/capture_how_to_images.py`) once Playwright is installed, to compare against the pure-Node SVG illustrations.
- [ ] **Phone / touch testing** of edge-tap vs cell-drag hit margins (`EDGE_MARGIN` in `js/board.js`).
- [ ] **Variants (separate branches, reusing topology + rule table + book machinery):**
  - **Gray / Any-color circles** (must be visited, either white or black behavior — or Balanced Loop / Masyu with voids).
  - **Hexagonal or triangular Masyu** (generalized topology in `js/logic.js`).
  - **Shaped / cutout boards** (void cells the loop cannot enter).
