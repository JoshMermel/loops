# Loops — Project Working Preferences & Architecture

## Working Preferences & Guardrails

- **Git:** Never run `git push` without explicit user approval.
- **Local planning:** Keep `TODO.md` untracked and gitignored (local planning only). Check `TODO.md` for current priorities and playtest books.
- **Tasting books before full books:** For any new gimmick or variant, build a **24-puzzle tasting book** (`4 / 8 / 8 / 4` across Beginner / Medium / Hard / Expert) first for playtesting and track it in `TODO.md` before growing to 500. Standard 500-puzzle books use `50 / 200 / 200 / 50` (Beginner / Medium / Hard / Expert), plus a few harder-than-Expert (`Expert+`) bonus puzzles where applicable.
- **Mandatory verification:** Always verify changes with:
  - `node --test tests/*.test.mjs`
  - `node tools/audit_books.mjs --book <changed> --rate` (always include `--rate` so stored `rules` / `tier` / `score` match live `rate()` with zero drift).

## Architecture & Hard-Won Lessons

- **Zero-build static app:** Plain HTML/CSS/ES modules with no bundler (`js/logic.js`, `js/variants/*`, `js/rating.js`, `js/faceparity.js`, `js/imagine.js`, `js/generator.js`, `js/board.js`, `js/main.js`, `js/print.js`, `sw.js`).
- **Quality bar for any new variant or rule:**
  - Exact solver brute-force cross-checked in `tests/reference_solver.mjs` (both pure and hybrid boards).
  - 100% sound human rules in `js/rating.js` / `js/variants/*`.
  - Zero-false-positive live error highlights (`js/clues.js` / variant state helpers).
  - Mutual-necessity checks for hybrids in `js/generator.js`.
- **Book hierarchy:** All four main Classic families (Masyu, Slitherlink, Mid-loop, Castle Wall) follow the 3-level `Family → Classic → Size → Difficulty` hierarchy; single-child subcategories auto-unwrap in the book picker.
- **Resumable pools:** `tools/library/` stores gitignored puzzle pools; `tools/fill_pools.mjs` is resumable and idempotent.
- **Castle Wall specifics:**
  - `tools/audit_books.mjs` forbids exterior White/Gray tiles, unnumbered exterior Black tiles, and zero-length arrow rays.
  - Pure unnumbered Castle Wall (zero arrows) was already probed and does not scale past 8×8 Beginner.
- **PNG artwork from SVG:** Render `og-image.png`, `apple-touch-icon.png`, and similar PNG assets via **headless Chrome** rather than ImageMagick (`magick`'s MSVG renderer drops strokes).
