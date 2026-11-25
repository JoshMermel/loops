# Masyu

**Play online:** <https://joshmermelstein.com/masyu/> · **[How to solve (illustrated guide)](https://joshmermelstein.com/masyu/docs/how_to_solve.html)**

A browser game and puzzle toolkit for **Masyu**, built in the same puzzle-toolkit pattern as `yajilin`, `polyomino-panel`, and `multiverse-star-battle`: an exact uniqueness solver cross-checked against a brute-force reference, a human-style rule scorer, self-explaining hints, a solution-first generator, verified books, and a zero-build static HTML/CSS/ES-modules GUI.

**Rules:** draw **one single closed loop** along the grid lines orthogonally, passing through every circle (white and black) with no crossings or branches.

- **White circle (○):** the loop goes **straight through** it, and must **turn 90°** at least once at the immediately adjacent intersections along the loop.
- **Black circle (●):** the loop **turns 90°** at it, and must go **straight through** both immediately adjacent intersections along the loop (at least two segments straight in each direction).
- Empty intersections may or may not be on the loop.

## Status

| Part | State |
| --- | --- |
| Exact solver / uniqueness counter (`js/logic.js`) | done: worklist-driven incremental `propagate()` with CSR edge-clue wakeups and direct cycle tracing, cross-checked against a brute-force reference (`tests/reference_solver.mjs`) |
| Human-style scorer (`js/rating.js`, `js/faceparity.js`, `js/imagine.js`) | done: 33 rules (5 bookkeeping + 28 solving rules) across Beginner, Medium, Hard, and Expert (including dual-face Inside/Outside parity and dynamically priced lookahead); soundness-tested against exact solutions and `data/armory.csv` |
| Hint button (`js/explain.js`, `js/hintstep.js`) | done: replays the scorer's next step, explains imagined chains step by step, draws ghost marks and dashed chains, cycles firings; tested end-to-end on Beginner/Medium puzzles |
| Generator (`js/generator.js`, `tools/generate.mjs`, `tools/fill_pools.mjs`, `tools/overnight.mjs`) | done: dual-face `tightLoop` (all-4-border + four-quadrant coverage and two-pass clue stripping) + guided `W↔B` mask hill-climber, verified by complete search; supports `--size`, `--seed`, `--budget`, `--style` (`balanced`, `white`, `black`, `sparse`), `--layout` (symmetry/region filters: `checkerboard`, `interior`, `frame`, `stripes`, `rot180`, `mirror`, `transpose`, `rot90`, `yinyang`, `yinyang-mirror`, `yinyang-transpose`, `cookie`, `cookie-horiz`, `cookie-diag`; fixed geometric/wallpaper masks: `lattice`, `blocks2x2`, `quilt2x2`, `circle-ring`, `honeycomb`, `pillars`, `hourglass`, `brackets`, `x-bracket`, `spiral`, `stairs`, `small-x`, `bricks`, `dominoes`, `ltiles`, `mirror-ltiles`, `herringbone`, `slashes`, `zigzags`), `--min-fill`, `--tier`, `--max-tier`, `--keep` |
| Corpus and books (`tools/library/`, `tools/build_book.mjs`, `tools/build_all_books.mjs`, `tools/audit_books.mjs`) | 28 visible books (**13,566 audited puzzles**): Gentle intro (100: 50 `5×5` + 50 `6×6`); Default across 5 sizes (`8×8`, `12×12`, `16×16`, `12×20`, `16×24`), each with 4 score-banded 500-puzzle difficulty books (+ 10 `Expert+` beyond hints in Expert = 2,010 per size); Bonus (6 fixed-size 520-puzzle books split 10% B / 40% M / 40% H / 10% E + 10 `Expert+` + 10 Mega finale puzzles each: All white `8×8`+`12×20`, All black `10×10`+`12×20`, Black & White Cookie `10×10`+`12×20` balanced across vertical/horizontal/diagonal splits, Skyscraper `6×20`+`6×40`, Exact symmetry `10×10`+`14×14` balanced across mirror/diagonal/180°, Full board `10×10`+`12×20`; plus **Patterns** with 296 all-square `9×9`–`13×13` puzzles across 19 shapes & wallpapers) and hidden `armory` (23) |
| Browser GUI (`index.html`, `style.css`, `js/board.js`, `js/main.js`, `js/rotate.js`) | playable: intersection-grid edge controls (tap segment to cycle empty/line/✕, drag to draw/erase loop, right-click/drag for ✕, tap/right-click square center to shade Inside/Outside), auto-rotation + manual `↻ Turn` for tall boards, undo/redo, localStorage saves by canonical puzzle hash, "Correct so far?", Hint, Book picker modal, Browse grid, dark mode, line-color palettes, locked Auto-X and Auto-Shade modes, `?book=<id>&puzzle=N` deep links |
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

# Fill pools in parallel (groups: core | giants | bonus | bonus-cookie | bonus-patterns | bonus-finales | all)
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

- `clues`: `row:col:W|B` items joined by `;` (0-based row and column, `W` = white circle, `B` = black circle).
- `solution`: one char per cell, row-major: a hex digit of the loop cell's exits (`U=1, R=2, D=4, L=8`, so `3`=UR, `5`=UD, `6`=RD, `9`=UL, `a`=RL, `c`=DL), or `#` for a cell not on the loop.
- `rules`, `tier`, `score`: hardest rule needed, difficulty tier (`Beginner`, `Medium`, `Hard`, `Expert`), and integer step-cost sum from `js/rating.js`.

Progress is saved in `localStorage` keyed by `ms_save_<puzzleHash>` (a stable hash of size and clues), so saves survive book renumbering and board rotation.

## Layout

| Path | Purpose |
| --- | --- |
| `js/logic.js` | Pure logic (no DOM): compile, incremental `propagate()` + exact uniqueness solver (`solve`), `isSolved`, CSV, `symmetryKey`, `puzzleHash` |
| `js/rating.js` | Rule table (`RULES`), `closure`, `nextSteps`, `rate`, `solvedByRules` |
| `js/faceparity.js` | Dual-face Inside/Outside parity union-find & proof paths (lines, crosses, white diagonals, black 3-to-1 + 2-step legs) |
| `js/imagine.js` | Unified "imagine a segment on/off" lookahead with ablation chain pruning and dynamic pricing |
| `js/explain.js`, `js/hintstep.js` | Turns solver steps into sentences, highlight roles, ghost marks, and dashed imagined chains for Hint |
| `js/generator.js` | Solution-first generator: dual-face `tightLoop` + two-pass clue stripping + fixed-mask pattern hill-climber + independent verification |
| `js/board.js`, `js/main.js`, `js/rotate.js` | SVG board, edge/face pointer gestures, pure 90° CW board rotation, app controller, modals, persistence, deep links |
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
| 6 | `whiteStraight` | a white circle blocked on one axis goes straight along the other | Beginner | 2 |
| 7 | `blackExtend` | a black circle continues straight two cells from an existing segment and turns away from the opposite side | Beginner | 2 |
| 8 | `blackWall` | a black circle blocked within two cells of a wall or cross must extend two cells the opposite way | Beginner | 2 |
| 9 | `blackAdjacent` | two touching black circles cannot connect, so each extends two cells away from the other | Beginner | 3 |
| 10 | `whiteMustTurn` | a white circle that goes straight at one end must turn at the other | Beginner | 3 |
| 11 | `deadEnd` | an empty cell with fewer than two exits left cannot be on the loop | Beginner | 4 |
| 12 | `forcedExits` | a loop cell with only two exits left must use both | Beginner | 4 |
| 13 | `blackPerp` | a black circle cannot enter a neighbor that already has a perpendicular segment | Beginner | 5 |
| 14 | `noEarlyClose` | a segment joining the two ends of one path would close the loop early | Beginner | 6 |
| 15 | `threeWhites` | three white circles in a row must all cross perpendicular to the row | Beginner | 8 |
| 16 | `whiteBothStraight` | a white circle cannot use an axis where both neighbors already continue straight | Medium | 10 |
| 17 | `closingCell` | an empty cell whose only two exits meet one path cannot be on the loop | Medium | 11 |
| 18 | `samePathExits` | a loop cell with three exits where two meet one path must use the third | Medium | 11 |
| 19 | `twoWhitesStraight` | two touching white circles with a straight segment entering one cannot connect, so both cross perpendicular | Medium | 12 |
| 20 | `whiteNoTurnAxis` | a white circle cannot use an axis whose two neighbors are both unable to turn | Medium | 14 |
| 21 | `blackBlockedTarget` | a black circle cannot extend toward a circle two cells away that cannot accept a straight segment | Medium | 15 |
| 22 | `faceShade` | basic inside/outside shading (crossing lines and X marks from the border) puts known colors on both sides of an edge | Medium | 18 |
| 23 | `faceCircle` | advanced inside/outside shading (white-circle diagonals, black 3-to-1 corners, or relative coloring) forces an edge | Hard | 38 |
| 24 | `twoEndsJoin` | a sealed area with just two open ends must connect them, so their far ends cannot join early | Hard | 44 |
| 25 | `chokepoint` | blocking this segment would cut off a small area or leave a single chokepoint cell | Hard | 48 |
| 26 | `parityPocket` | the other choice would seal off a small pocket with an odd number of open ends | Hard | 52 |
| 27 | `crossingParity` | the loop crosses the border of any rectangle or band an even number of times | Hard | 58 |
| 28 | `chokepointArea` | blocking this segment would cut off a large area or leave a single chokepoint cell | Hard | 64 |
| 29 | `parityForces` | the other choice would seal off an area with an odd number of open ends | Hard | 68 |
| 30 | `tryEdge` | trying a segment one way leads to a contradiction | Expert | 120 |
| 31 | `imagineLocal` | imagine a segment on or off at a circle or open end: one local step immediately breaks a rule | Medium | 22–28 |
| 32 | `imagineTrace` | imagine a segment on or off and trace one single thread 2–3 steps ahead until something breaks | Hard | 36–75 |
| 33 | `imagineChain` | imagine a segment on or off and follow a long, multi-front, or area-parity chain until something breaks | Expert | ≥80 |

## License

MIT — see [LICENSE](LICENSE).
