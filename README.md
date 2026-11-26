# Masyu

**Play online:** <https://joshmermelstein.com/masyu/> · **[How to solve (illustrated guide)](https://joshmermelstein.com/masyu/docs/how_to_solve.html)**

A browser game and puzzle toolkit for **Masyu**, built in the same puzzle-toolkit pattern as `yajilin`, `polyomino-panel`, and `multiverse-star-battle`: an exact uniqueness solver cross-checked against a brute-force reference, a human-style rule scorer, self-explaining hints, a solution-first generator, verified books, and a zero-build static HTML/CSS/ES-modules GUI.

**Rules:** draw **one single closed loop** along the grid lines orthogonally, passing through every circle (white and black) with no crossings or branches.

- **White circle (○):** the loop goes **straight through** it, and must **turn 90°** at least once at the immediately adjacent intersections along the loop.
- **Black circle (●):** the loop **turns 90°** at it, and must go **straight through** both immediately adjacent intersections along the loop (at least two segments straight in each direction).
- **Gray circle:** secretly either white or black — the loop must visit it and satisfy either rule. Tap a gray circle in the app to label it white or black as a note (optional).
- **Hamilton cycle:** the loop must visit **every** intersection dot on the grid (guided by permanent given lines, given walls, or both — or combined with Masyu / Slitherlink in Hybrids).
- **Swiss cheese:** cutout holes (`X`) cannot be entered; each enclosed interior hole acts as one Inside/Outside region (tap anywhere in a hole to shade it).
- **Slitherlink & Hybrids:** each numbered square (`0–3`) tells how many of its four sides belong to the single closed loop. In **Hybrids** books, two loop rule sets share one loop (`Masyu + Hamilton cycle`, `Slitherlink + Masyu`, `Slitherlink + Hamilton cycle`, `Mid-loop + Masyu`, `Mid-loop + Slitherlink`, `Mid-loop + Hamilton cycle`), and every puzzle is verified to require both.
- **Mid-loop:** the loop must pass straight through every teal dot at the exact midpoint of its straight segment (dots on intersections sit on even-length runs; dots on segment midpoints sit on odd-length runs).
- Empty intersections may or may not be on the loop (except in **Hamilton cycle** books and hybrids).

## Status

| Part | State |
| --- | --- |
| Exact solver / uniqueness counter (`js/logic.js`, `js/variants/`) | done: modular single-loop engine with worklist-driven incremental `propagate()` and CSR edge-clue wakeups, direct cycle tracing, mystery gray-circle resolution (`W`/`B`/`G`), full-board mode (`full`), permanent given lines/walls (`H1`/`H0`/`V1`/`V0`), cutout voids (`X`), Slitherlink face counts (`S0`–`S3`), and Mid-loop midpoint dots (`MC`/`MH`/`MV`), cross-checked against a brute-force reference (`tests/reference_solver.mjs`) |
| Human-style scorer (`js/rating.js`, `js/faceparity.js`, `js/imagine.js`, `js/variants/`) | done: 63 rules (6 bookkeeping + 57 solving rules, including 9 local Slitherlink rules + unified `faceSlither`, 6 Mid-loop midpoint-symmetry rules, gray-circle deductions, full-board checkerboard parity `checkerPocket`/`checkerParity`, dual-face parity across interior holes & exterior cutouts, and uniqueness-based `symmetry` inference) across Beginner, Medium, Hard, and Expert; soundness-tested against exact solutions and `data/armory.csv` |
| Hint button (`js/explain.js`, `js/hintstep.js`) | done: two-press progressive hints with Settings toggle for immediate full hints (first press highlights where to look without spoiling the move; second press replays the scorer's next step, explains imagined chains step by step, and draws ghost edge/gray-label marks, face highlights, and dashed chains; further presses cycle alternate firings); tested end-to-end on Masyu, gray, full-board, Swiss cheese, Slitherlink, Mid-loop, hybrids, and `data/armory.csv` |
| Generator (`js/generator.js`, `tools/generate.mjs`, `tools/fill_pools.mjs`, `tools/overnight.mjs`) | done: dual-face `tightLoop` + guided `W↔B` mask hill-climber + Hamiltonian full-board generator (including Swiss cheese & symmetry) + Swiss cheese dual-face hole generator + Slitherlink, Mid-loop & necessity-verified hybrid generators (`slither*`, `midloop*`), verified by complete search; supports `--size`, `--seed`, `--budget`, `--style`, `--layout`, `--min-fill`, `--tier`, `--max-tier`, `--keep` |
| Corpus and books (`tools/library/`, `tools/build_book.mjs`, `tools/build_all_books.mjs`, `tools/audit_books.mjs`) | 56 visible books (**23,850 audited puzzles**) across 6 top-level sections: **Start here** (Beginner intros for `Masyu` 100, `Slitherlink` 40, `Mid-loop` 24, `Hamilton cycle` 42); **Masyu** (`Classic` across 5 sizes `8×8`–`16×24`, 2,010 per size; `Gray dots`, 2×520; `Swiss cheese`, 4×510; `Bonus`, 5×520 + `Patterns` 294); **Slitherlink** (6 books × 500: `Small`, `Classic`, `Swiss cheese`, `Skyscraper`, `Symmetry`, `All 3s`); **Mid-loop** (`Small` 7×7 and `Classic` 10×10, 24 each); **Hamilton cycle** (5 books × 500: `Given lines`, `Given walls`, `Lines & walls`, `Swiss cheese`, `Symmetry`); **Hybrids** grouped by combo (`Masyu + Hamilton cycle` 500, `Slitherlink + Masyu` 500, `Slitherlink + Hamilton cycle` 2×500, plus 24-puzzle token books for `Mid-loop + Masyu`, `Mid-loop + Slitherlink`, and `Mid-loop + Hamilton cycle` — all necessity-verified); and hidden `armory` (50) |
| Browser GUI (`index.html`, `style.css`, `js/board.js`, `js/main.js`, `js/rotate.js`, `js/offline.js`, `sw.js`) | playable: intersection-grid edge controls (tap segment to cycle empty/line/✕, drag to draw/erase loop, right-click/drag for ✕, tap/right-click square center or anywhere inside a cutout hole to shade Inside/Outside, tap/right-click gray circles for 0° checkerboard white/black labels with auto-labeling, locked permanent given lines & walls + full-board trapped-dot highlights, exact rounded board silhouettes for shaped boards), auto-rotation + manual `↻ Turn` for tall boards, undo/redo, localStorage saves by canonical puzzle hash, "Correct so far?", Hint (with Two-step hints toggle), Book picker modal, Browse grid, dark mode, line-color palettes, locked Auto-X and Auto-Shade modes, opt-in **Offline play** service worker (`sw.js` + `manifest.webmanifest`), `?book=<id>&puzzle=N` deep links |
| Printing (`js/print.js`, Settings → Print puzzles) | done: fixed black-and-white SVG booklet for any range (`1-10, 15`), optional answer key, laid out by cell size for A4 and Letter, every page header linking to the site |
| Docs (`docs/how_to_solve.md`, `docs/how_to_solve.html`) | generated from `js/rating.js` with illustrations from the hidden `armory` book |

See [TODO.md](TODO.md).

## Run

Plain static HTML/CSS/ES modules, no build step:

```bash
python3 -m http.server 8766
```

Then open <http://localhost:8766> (deep-link example: `http://localhost:8766/index.html?book=8x8-beginner&puzzle=1`).

Run the full test suite:

```bash
node --test tests/*.test.mjs
```

### Toolkit commands

```bash
# Generate puzzles into a pool in tools/library/ (COLSxROWS)
node tools/generate.mjs --size 8x8 --count 10 --seed 1 --budget 60 --style balanced --tier any

# Fill pools in parallel (groups: core | giants | bonus | bonus-cookie | bonus-gray | full-board | swiss | slither | midloop | variants-token | intro-extra | bonus-patterns | bonus-finales | all)
node tools/fill_pools.mjs --only core
node tools/fill_pools.mjs --only giants
node tools/build_all_books.mjs
node tools/audit_books.mjs --all

# Long unattended generation runs (resumable chunks)
node tools/overnight.mjs --sizes 8x8,12x12,16x16 --minutes 60 --chunk 10

# Refresh stored ratings after editing costs or tiers in js/rating.js
node tools/rescore.mjs

# Refresh the hidden armory book, hint illustrations, and docs/how_to_solve.{md,html}
node tools/how_to_examples.mjs
node tools/render_how_to_images.mjs
node tools/build_how_to_solve.mjs
```

`tools/generate.mjs`, `tools/fill_pools.mjs`, and `tools/audit_books.mjs` re-verify every puzzle independently: the stored solution must pass `isSolved()`, and uniqueness must be proven by sound rules or a complete exhaustive search (`exceeded` never counts as proof).

## Puzzle CSV format

```text
name,rows,cols,clues,solution,rules,tier,score
```

- `clues`: semicolon-separated tokens: optional `full` (full-board rule), circle clues `row:col:W|B|G` (0-based row/col, `W` = white, `B` = black, `G` = mystery gray), Slitherlink face numbers `row:col:S0|S1|S2|S3` (0-based dual-square row/col), Mid-loop midpoint dots `row:col:MC|MH|MV` (`C` = vertex, `H`/`V` = right/bottom segment midpoint), cutout voids `row:col:X`, and optional permanent given edges `row:col:H1|H0|V1|V0` (`H`/`V` = right/bottom track, `1` = given segment, `0` = given wall).
- `solution`: one char per cell, row-major: a hex digit of the loop cell's exits (`U=1, R=2, D=4, L=8`, so `3`=UR, `5`=UD, `6`=RD, `9`=UL, `a`=RL, `c`=DL), or `#` for a cell not on the loop.
- `rules`, `tier`, `score`: hardest rule needed, difficulty tier (`Beginner`, `Medium`, `Hard`, `Expert`), and integer step-cost sum from `js/rating.js`.

Progress is saved in `localStorage` keyed by `ms_save_<puzzleHash>` (a stable hash of size and clues), so saves survive book renumbering and board rotation.

## Layout

| Path | Purpose |
| --- | --- |
| `js/logic.js` | Pure logic (no DOM): compile, incremental `propagate()` + exact uniqueness solver (`solve`), `isSolved`, CSV, `symmetryKey`, `puzzleHash` |
| `js/variants/` | Modular single-loop variant registry (`index.js`) and puzzle-specific rule modules (starting with `slitherlink.js`: exact propagator, Auto-X, parity, human rules, hints) |
| `js/rating.js` | Rule table (`RULES`), `closure`, `nextSteps`, `rate`, `solvedByRules` |
| `js/faceparity.js` | Dual-face Inside/Outside parity union-find & proof paths (lines, crosses, white diagonals, black 3-to-1 + 2-step legs) |
| `js/imagine.js` | Unified "imagine a segment on/off" lookahead with ablation chain pruning and dynamic pricing |
| `js/explain.js`, `js/hintstep.js` | Turns solver steps into sentences, highlight roles, ghost marks, and dashed imagined chains for Hint |
| `js/generator.js` | Solution-first generator: dual-face `tightLoop` + two-pass clue stripping + fixed-mask pattern hill-climber + independent verification |
| `js/board.js`, `js/main.js`, `js/rotate.js` | SVG board, edge/face pointer gestures, pure 90° CW board rotation, app controller, modals, persistence, deep links |
| `sw.js`, `js/offline.js`, `manifest.webmanifest` | Opt-in offline service worker (network-first app shell, stale-while-revalidate book CSVs, Settings toggle + update/cleanup) and PWA manifest |
| `js/marks.js`, `js/clues.js`, `js/grace.js`, `js/lineends.js` | Pure UI logic: tap cycles, Auto-X & Auto-Shade, live circle error checks, red grace period, open-end rings |
| `js/palettes.js`, `js/palette_presets.js`, `js/colormath.js`, `js/pathcolors.js` | Lab-optimized color-blind-friendly palettes and stable per-path colors |
| `js/print.js` | Fixed black-and-white SVG booklet layout and generator (A4 and Letter) |
| `tools/_cli.mjs`, `tools/generate.mjs`, `tools/fill_pools.mjs`, `tools/overnight.mjs` | Shared CLI helpers and pool generators writing to `tools/library/` (git-ignored) |
| `tools/build_book.mjs`, `tools/build_all_books.mjs` | Assemble pools into `data/<id>.csv` and `data/manifest.json` |
| `tools/audit_books.mjs`, `tools/rescore.mjs`, `tools/rate_puzzles.mjs` | Independent verification, parallel rescoring, and step inspection |
| `tools/how_to_examples.mjs`, `tools/render_how_to_images.mjs`, `tools/capture_how_to_images.py`, `tools/build_how_to_solve.mjs` | Build the hidden `armory` book, rule illustrations, and `docs/how_to_solve.{md,html}` |
| `tests/` | `node --test tests/*.test.mjs`, including `tests/reference_solver.mjs` brute-force cross-check |
| `data/manifest.json`, `data/*.csv` | Shipped puzzle books and metadata |
| `docs/how_to_solve.md`, `docs/how_to_solve.html`, `docs/images/` | Generated solving guide with an example for each rule |

## Difficulty: rules, tiers, and score

The human-style solver (`js/rating.js`) always applies the cheapest applicable rule and never looks at the stored solution. A puzzle's **tier** is the tier of the hardest rule it needed; its **score** is the sum of step costs (+100 per undecided cell if the rules get stuck, making it **Expert**, "beyond the hints"). Re-binning a rule or changing a cost is a one-line edit in `RULES`; run `node tools/rescore.mjs` afterward to refresh book scores.

| # | Rule | What it does | Tier | Cost |
| --- | --- | --- | --- | --- |
| 1 | `edgesOffCellOff` | bookkeeping: a segment touching an off-loop cell is off | Beginner | 1 |
| 2 | `edgeEnds` | bookkeeping: a segment puts both of its cells on the loop | Beginner | 1 |
| 3 | `fullCell` | bookkeeping: a cell with two segments takes no more | Beginner | 1 |
| 4 | `isolatedCellOff` | bookkeeping: a cell with all its edges off is not on the loop | Beginner | 1 |
| 5 | `closedLoopRestOff` | bookkeeping: once the single loop is closed, all remaining cells are off the loop | Beginner | 1 |
| 6 | `grayFromShape` | bookkeeping: a gray circle with two drawn segments resolves to white (straight) or black (turn) | Beginner | 1 |
| 7 | `whiteStraight` | a white circle blocked on one axis goes straight along the other | Beginner | 2 |
| 8 | `blackExtend` | a black circle continues straight two cells from an existing segment and turns away from the opposite side | Beginner | 2 |
| 9 | `blackWall` | a black circle blocked within two cells of a wall or cross must extend two cells the opposite way | Beginner | 2 |
| 10 | `grayMustBeBlack` | a gray circle that cannot go straight through must be black | Beginner | 2 |
| 11 | `blackAdjacent` | two touching black circles cannot connect, so each extends two cells away from the other | Beginner | 3 |
| 12 | `whiteMustTurn` | a white circle that goes straight at one end must turn at the other | Beginner | 3 |
| 13 | `grayMustBeWhite` | a gray circle without a two-cell leg on one axis must be white | Beginner | 3 |
| 14 | `deadEnd` | an empty cell with fewer than two exits left cannot be on the loop | Beginner | 4 |
| 15 | `forcedExits` | a loop cell with only two exits left must use both | Beginner | 4 |
| 16 | `blackPerp` | a black circle cannot enter a neighbor that already has a perpendicular segment | Beginner | 5 |
| 17 | `noEarlyClose` | a segment joining the two ends of one path would close the loop early | Beginner | 6 |
| 18 | `threeWhites` | three white circles in a row must all cross perpendicular to the row | Beginner | 8 |
| 19 | `whiteBothStraight` | a white circle cannot use an axis where both neighbors already continue straight | Medium | 10 |
| 20 | `closingCell` | an empty cell whose only two exits meet one path cannot be on the loop | Medium | 11 |
| 21 | `samePathExits` | a loop cell with three exits where two meet one path must use the third | Medium | 11 |
| 22 | `twoWhitesStraight` | two touching white circles with a straight segment entering one cannot connect, so both cross perpendicular | Medium | 12 |
| 23 | `grayWhiteNoTurn` | a gray circle that cannot turn on either side of its only open axis must be black | Medium | 12 |
| 24 | `whiteNoTurnAxis` | a white circle cannot use an axis whose two neighbors are both unable to turn | Medium | 14 |
| 25 | `blackNoEarlyClose` | a black circle cannot extend two cells into the other end of its own path and close the loop early | Medium | 14 |
| 26 | `blackBlockedTarget` | a black circle cannot extend toward a circle two cells away that cannot accept a straight segment | Medium | 15 |
| 27 | `blackTwoDiagWhites` | a black circle flanked by two diagonally adjacent white circles cannot extend between them | Medium | 15 |
| 28 | `blackWhiteNoTurn` | a black circle cannot extend into a white circle two cells away whose far side cannot turn | Medium | 16 |
| 29 | `whiteCornerPinch` | a two-exit corner diagonally next to a white circle cannot pinch both of its already-active neighbors | Medium | 17 |
| 30 | `whiteDeadEndPinch` | a segment completing two sides of a 2×2 square beside a white circle cannot pinch both of its axes | Medium | 17 |
| 31 | `faceShade` | basic inside/outside shading (crossing lines and X marks from the border) puts known colors on both sides of an edge | Medium | 18 |
| 32 | `checkerPocket` | checkerboard light/dark dot counts in a small full-board pocket force its exit segments | Medium | 18 |
| 33 | `boxStrand` | closing two active corners of a 2×2 square cannot seal off both escapes of an open end on the opposite side | Medium | 20 |
| 34 | `corridorNoEarlyClose` | a forced multi-cell corridor joining the two ends of one path would close the loop early | Hard | 30 |
| 35 | `checkerParity` | checkerboard light/dark dot counts in a full-board region force its exit segments | Hard | 36 |
| 36 | `faceCircle` | advanced inside/outside shading (white-circle diagonals, black 3-to-1 corners, or relative coloring) forces an edge | Hard | 38 |
| 37 | `twoEndsJoin` | a sealed area with just two open ends must connect them, so their far ends cannot join early | Hard | 44 |
| 38 | `chokepoint` | blocking this segment would cut off a small area or leave a single chokepoint cell | Hard | 48 |
| 39 | `parityPocket` | the other choice would seal off a small pocket with an odd number of open ends | Hard | 52 |
| 40 | `crossingParity` | the loop crosses the border of any rectangle or band an even number of times | Hard | 58 |
| 41 | `chokepointArea` | blocking this segment would cut off a large area or leave a single chokepoint cell | Hard | 64 |
| 42 | `parityForces` | the other choice would seal off an area with an odd number of open ends | Hard | 68 |
| 43 | `tryEdge` | trying a segment or gray circle one way leads to a contradiction | Expert | 120 |
| 44 | `imagineLocal` | imagine a segment or gray circle one way: one local step immediately breaks a rule | Medium | 22–28 |
| 45 | `imagineTrace` | imagine a segment or gray circle one way and trace one single thread 2–3 steps ahead until something breaks | Hard | 36–75 |
| 46 | `imagineChain` | imagine a segment or gray circle one way and follow a long, multi-front, or area-parity chain until something breaks | Expert | ≥80 |

## License

MIT — see [LICENSE](LICENSE).
