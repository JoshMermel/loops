# Masyu

A browser game and puzzle toolkit for **Masyu**, built in the same puzzle-toolkit pattern as `yajilin`, `polyomino-panel`, and `multiverse-star-battle`: an exact uniqueness solver cross-checked against a brute-force reference, a human-style rule scorer, self-explaining hints, a solution-first generator, verified books, and a zero-build static HTML/CSS/ES-modules GUI.

**Rules:** draw **one single closed loop** through cell centres orthogonally, passing through every circle (white and black) with no crossings or branches.

- **White circle (○):** the loop goes **straight through** it, and must **turn 90°** in at least one of the two immediately adjacent cells along the loop.
- **Black circle (●):** the loop **turns 90°** at it, and must go **straight through** both immediately adjacent cells along the loop (at least two segments straight in each direction).
- Empty cells may or may not be on the loop.

## Status

| Part | State |
| --- | --- |
| Exact solver / uniqueness counter (`js/logic.js`) | done, cross-checked against a brute-force reference (`tests/reference_solver.mjs`) |
| Human-style scorer (`js/rating.js`, `js/faceparity.js`, `js/imagine.js`) | done: 30 rules across Beginner, Medium, Hard (stuck = Expert), including dual-face Inside/Outside parity; soundness fuzz-tested against exact solutions |
| Hint button (`js/explain.js`, `js/hintstep.js`) | done: replays the scorer's next step, explains imagined chains step by step, draws ghost marks and dashed chains, cycles firings; tested end-to-end on Beginner/Medium puzzles |
| Generator (`js/generator.js`, `tools/generate.mjs`, `tools/fill_pools.mjs`, `tools/overnight.mjs`) | done: dual-face `tightLoop` (all-4-border full-coverage + two-pass clue stripping) + guided `W↔B` lattice hill-climber, verified by complete search; supports `--size`, `--seed`, `--budget`, `--style` (`balanced`, `white`, `black`, `sparse`), `--layout` (`interior`, `frame`, `stripes`, `rot180`, `mirror`, `transpose`, `rot90`, `yinyang`, `lattice`), `--min-fill`, `--tier`, `--max-tier`, `--keep` |
| Corpus and books (`tools/library/`, `tools/build_book.mjs`, `tools/audit_books.mjs`) | 30 visible books (**1,569 audited puzzles**): Gentle intro (60); Default `6×6` (120), `8×8` (120), `10×10` (90), `12×12` (75), `14×14` (45), `16×16` (36), `18×18` (24), `12×20` (24); Bonus All white, All black, Sparse, Skyscraper & Tall Skyscraper (`6×24–6×30`), Exact symmetry (balanced mirror / diagonal-mirror / 180° per tier), Yin-Yang (180° opposite-color), No edge clues, Lattice (full even-row/even-col dot grid: all 22 unique 9×9 + 9×11 & 13×13), and Full board (100% fill), plus hidden `armory` (19) |
| Browser GUI (`index.html`, `style.css`, `js/board.js`, `js/main.js`) | playable: intersection-grid edge controls (tap segment to cycle empty/line/✕, drag to draw/erase loop, right-click/drag for ✕, tap/right-click square center to shade Inside/Outside), undo/redo, localStorage saves by puzzle hash, "Correct so far?", Hint, Book picker modal, Browse grid, dark mode, line-color palettes, Auto-X and Auto-Shade modes, `?book=<id>&puzzle=N` deep links |
| Printing (`js/print.js`, Settings → Print puzzles) | done: fixed black-and-white SVG booklet for any range (`1-10, 15`), optional answer key, laid out by cell size for A4 and Letter, every page header linking to the site |
| Docs (`docs/how_to_solve.md`) | generated from `js/rating.js` with illustrations from the hidden `armory` book |

See [TODO.md](TODO.md).

## Run

Plain static HTML/CSS/ES modules, no build step:

```bash
python3 -m http.server 8766
```

Then open <http://localhost:8766> (deep-link example: `http://localhost:8766/index.html?book=8x8&puzzle=1`).

Run the full test suite:

```bash
node --test tests/*.test.mjs
```

### Toolkit commands

```bash
# Generate puzzles into a pool in tools/library/ (COLSxROWS)
node tools/generate.mjs --size 8x8 --count 10 --seed 1 --budget 60 --style balanced --tier any

# Fill default & bonus pools, assemble data/*.csv + data/manifest.json, and audit everything
sh tools/make_default.sh
sh tools/make_bonus.sh
node tools/build_all_books.mjs
node tools/audit_books.mjs --rate

# Long unattended generation runs (resumable chunks)
node tools/overnight.mjs --sizes 6x6,8x8,10x10,12x12 --minutes 60 --chunk 10

# Refresh stored ratings after editing costs or tiers in js/rating.js
node tools/rescore.mjs

# Refresh the hidden armory book, hint illustrations, and docs/how_to_solve.md
node tools/how_to_examples.mjs
node tools/render_how_to_images.mjs
node tools/build_how_to_solve.mjs
```

`tools/generate.mjs` and `tools/audit_books.mjs` re-verify every puzzle independently: the stored solution must pass `isSolved()`, and uniqueness must be proven by sound rules or a complete exhaustive search (`exceeded` never counts as proof).

## Puzzle CSV format

```text
name,rows,cols,clues,solution,rules,tier,score
```

- `clues`: `row:col:W|B` items joined by `;` (0-based row and column, `W` = white circle, `B` = black circle).
- `solution`: one char per cell, row-major: a hex digit of the loop cell's exits (`U=1, R=2, D=4, L=8`, so `3`=UR, `5`=UD, `6`=RD, `9`=UL, `a`=RL, `c`=DL), or `#` for a cell not on the loop.
- `rules`, `tier`, `score`: hardest rule needed, difficulty tier (`Beginner`, `Medium`, `Hard`, `Expert`), and integer step-cost sum from `js/rating.js`.

Progress is saved in `localStorage` keyed by `ms_save_<puzzleHash>` (a stable hash of size and clues), so saves survive book renumbering.

## Layout

| Path | Purpose |
| --- | --- |
| `js/logic.js` | Pure logic (no DOM): compile, propagation + exact uniqueness solver (`solve`), `isSolved`, CSV, `symmetryKey`, `puzzleHash` |
| `js/rating.js` | Rule table (`RULES`), `closure`, `nextSteps`, `rate`, `solvedByRules` |
| `js/faceparity.js` | Dual-face Inside/Outside parity union-find & proof paths (lines, crosses, white diagonals, black 3-to-1 + 2-step legs) |
| `js/imagine.js` | Unified "imagine a segment on/off" lookahead with ablation chain pruning and dynamic pricing |
| `js/explain.js`, `js/hintstep.js` | Turns solver steps into sentences, highlight roles, ghost marks, and dashed imagined chains for Hint |
| `js/generator.js` | Solution-first generator: dual-face `tightLoop` + two-pass clue stripping + independent verification |
| `js/board.js`, `js/main.js` | SVG board, edge/cell pointer gestures, app controller, modals, persistence, deep links |
| `js/marks.js`, `js/clues.js`, `js/grace.js`, `js/lineends.js` | Pure UI logic: tap cycles, live circle coloring, red grace period, open-end rings |
| `js/palettes.js`, `js/palette_presets.js`, `js/colormath.js`, `js/pathcolors.js` | Lab-optimized color-blind-friendly palettes and stable per-path colors |
| `js/print.js` | Fixed black-and-white SVG booklet layout and generator (A4 and Letter) |
| `tools/generate.mjs`, `tools/overnight.mjs` | Pool generators writing to `tools/library/` (git-ignored) |
| `tools/build_book.mjs`, `tools/build_all_books.mjs`, `tools/make_*.sh` | Assemble pools into `data/<id>.csv` and `data/manifest.json` |
| `tools/audit_books.mjs`, `tools/rescore.mjs`, `tools/rate_puzzles.mjs` | Independent verification, parallel rescoring, and step inspection |
| `tools/how_to_examples.mjs`, `tools/render_how_to_images.mjs`, `tools/capture_how_to_images.py`, `tools/build_how_to_solve.mjs` | Build the hidden `armory` book, rule illustrations, and `docs/how_to_solve.md` |
| `tests/` | `node --test tests/*.test.mjs`, including `tests/reference_solver.mjs` brute-force cross-check |
| `data/manifest.json`, `data/*.csv` | Shipped puzzle books and metadata |
| `docs/how_to_solve.md`, `docs/images/` | Generated solving guide with an example for each rule |

## Difficulty: rules, tiers, and score

The human-style solver (`js/rating.js`) always applies the cheapest applicable rule and never looks at the stored solution. A puzzle's **tier** is the tier of the hardest rule it needed; its **score** is the sum of step costs (+100 per undecided cell if the rules get stuck, making it **Expert**, "beyond the hints"). Re-binning a rule or changing a cost is a one-line edit in `RULES`; run `node tools/rescore.mjs` afterward to refresh book scores.

| # | Rule | What it does | Tier | Cost |
| --- | --- | --- | --- | --- |
| 1 | `edgesOffCellOff` | bookkeeping: edges touching an off-loop cell are off | Beginner | 1 |
| 2 | `edgeEnds` | bookkeeping: a loop segment puts both its cells on the loop | Beginner | 1 |
| 3 | `fullCell` | bookkeeping: a cell with two segments takes no more | Beginner | 1 |
| 4 | `closedLoopRestOff` | bookkeeping: once the single loop is closed, remaining cells/edges are off | Beginner | 1 |
| 5 | `whiteStraight` | a white circle blocked on one axis goes straight along the other | Beginner | 2 |
| 6 | `blackExtend` | a black circle with a segment goes straight two cells and turns away from the opposite side | Beginner | 2 |
| 7 | `blackWall` | a black circle blocked within two cells of a wall or cross goes two cells the opposite way | Beginner | 2 |
| 8 | `blackAdjacent` | two touching black circles cannot join, so each goes two cells away from the other | Beginner | 3 |
| 9 | `whiteMustTurn` | a white circle going straight at one end must turn at the other | Beginner | 3 |
| 10 | `deadEnd` | an empty cell with fewer than two exits left cannot be on the loop | Beginner | 4 |
| 11 | `forcedExits` | a loop cell with only two exits left must use both | Beginner | 4 |
| 12 | `blackPerp` | a black circle cannot enter a neighbor that already has a perpendicular segment | Beginner | 5 |
| 13 | `whiteBothStraight` | a white circle cannot use an axis where both neighbors already continue straight | Beginner | 5 |
| 14 | `noEarlyClose` | a segment joining the two ends of one path would close the loop early | Beginner | 6 |
| 15 | `samePathExits` | a loop cell with three exits where two meet one path must use the third | Beginner | 7 |
| 16 | `closingCell` | an empty cell whose only two exits meet one path cannot be on the loop | Beginner | 7 |
| 17 | `threeWhites` | three white circles in a row must all cross perpendicular to the row | Medium | 10 |
| 18 | `twoWhitesStraight` | two touching white circles with a straight segment entering one cannot connect | Medium | 11 |
| 19 | `whiteNoTurnAxis` | a white circle cannot use an axis whose two neighbors are both unable to turn | Medium | 12 |
| 20 | `blackBlockedTarget` | a black circle cannot extend toward a circle two cells away that cannot accept a straight segment | Medium | 13 |
| 21 | `faceParity` | inside/outside square coloring (lines, crosses, white diagonals, black 3-to-1 corners & 2-step legs) forces an edge | Medium | 16+ |
| 22 | `twoEndsJoin` | a sealed area with just two open ends must connect them, so their far ends cannot join early | Medium | 20 |
| 23 | `chokepoint` | blocking a segment would disconnect loop cells or leave a single chokepoint cell (≤ 12 cells) | Medium | 22 |
| 24 | `parityPocket` | the other choice would seal off a small pocket (≤ 3 open ends, ≤ 9 cells) with an odd number of open ends | Medium | 26 |
| 25 | `imagine` | imagine a segment on or off and follow the easy rules: short pruned chain to a contradiction (dynamic cost ≤ 30) | Medium | ≤30 |
| 26 | `crossingParity` | the loop crosses the border of any rectangle or band an even number of times | Hard | 55 |
| 27 | `chokepointArea` | `chokepoint` for a cut-off area larger than 12 cells | Hard | 60 |
| 28 | `imagineLong` | `imagine` when the pruned chain costs above 30 (dynamic cost) | Hard | >30 |
| 29 | `parityForces` | `parityPocket` for a larger area (+2 per open end past 3) | Hard | 65 |
| 30 | `tryEdge` | trial and error: assume a segment on/off and follow all rules above to a contradiction (+2 per step) | Hard | 120 |
