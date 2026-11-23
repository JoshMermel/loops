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

- [ ] **Private calibration:** collect a private set of real published Masyu puzzles (in git-ignored `tools/calibration/`) to check rule coverage and calibrate tier boundaries and step costs with Josh.
- [x] **Inside / Outside dual-face coloring inference (`faceParity`):** added dual-face parity union-find (lines, crosses, outer border, white-circle diagonals, black-circle 3-to-1 + forced 2-step legs) into `js/faceparity.js`, `js/rating.js`, `js/explain.js` (with tinted square Hint overlays), and rescored all books.
- [ ] **New human rules from play:** play generated Medium/Hard puzzles and note any recurring Masyu patterns currently handled by `imagine` that deserve their own cheaper named rule (for example:
  - diagonally adjacent black and white circles near a wall,
  - two white circles diagonally adjacent forcing a corridor,
  - black circle forcing a white circle two cells away to turn at its far end,
  - paired open ends with 4 or 6 ends (`pairedEnds`),
  - uniqueness-assuming shortcuts (`uniqueRoute`) if desired for Hint only).
- [ ] **Rescore after cost tweaks:** run `node tools/rescore.mjs`, `node tools/audit_books.mjs --rate`, and regenerate `docs/how_to_solve.md`.

## Books & scaling

- [x] **Larger board sizes & grown starter books:** expanded `intro`–`12×12` (60–120 puzzles each), added `14×14`, `16×16`, `18×18`, and `12×20` to Default, added `10×10` All white / All black / Sparse, and added Tall Skyscraper (`6×24`, `8×24`, `6×30`) — **1,569 audited puzzles across 30 visible books**.
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
