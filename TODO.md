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
- [ ] **Revisit `24×30` Giant board size:** decide whether `24×30` is too large for comfortable play and whether to replace it with a slightly more playable huge size (e.g. `20×20` or `16×24`).
- [ ] **Upgrade Bonus-book tail puzzles:** replace the current lukewarm `+10` oversized tail puzzles at the end of each Bonus book with genuinely memorable finales — either (a) very hard themed puzzles (high Expert / Expert+), (b) dramatically larger themed boards (e.g. `14×14` or `16×16` instead of `12×12`), or both.
- [x] **Pattern-based dot position layouts (Lattice family):** generalized fixed interior dot masks in `js/generator.js` (`concentric-sq`, `twin-sq`, `blocks2x2`, `quilt2x2`, `honeycomb`, `galaxy`, `circle-ring`, `diag-stripes`), folded `Lattice` into the mixed **💠 Patterns** Bonus book (`bonus-patterns`), ordered by Tier with per-group normalized quantile interleaving (`--max-run 2`) across mixed sizes (`9×9`–`13×13`).
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

- [ ] **Board rotation** (`js/rotate.js`) for tall rectangular boards (auto-landscape + Turn button).
- [ ] **Two-press step-by-step hints** (like `polyomino-panel`: first press shows where to look, second press shows the full deduction and ghost marks).
- [ ] **Offline play** (`sw.js` service worker opt-in in Settings, as in `polyomino-panel`).
- [ ] **Playwright PNG screenshots** (`tools/capture_how_to_images.py`) once Playwright is installed, to compare against the pure-Node SVG illustrations.
- [ ] **Phone / touch testing** of edge-tap vs cell-drag hit margins (`EDGE_MARGIN` in `js/board.js`).
- [ ] **Variants (separate branches, reusing topology + rule table + book machinery):**
  - **Gray / Any-color circles** (must be visited, either white or black behavior — or Balanced Loop / Masyu with voids).
  - **Hexagonal or triangular Masyu** (generalized topology in `js/logic.js`).
  - **Shaped / cutout boards** (void cells the loop cannot enter).
