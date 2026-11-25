"""
capture_how_to_images.py

Optional Playwright screenshot capture for docs/how_to_solve.md: opens the live app on the hidden
`armory` book for every example in docs/examples/examples.json, restores the exact board marks,
presses Hint, and saves docs/images/<rule>.png.

Needs Playwright (pip install playwright; playwright install chromium) and the repo served over HTTP:
    python3 -m http.server 8766
    python3 tools/capture_how_to_images.py http://localhost:8766
"""
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent


def capture(page, base, ex, out_path):
    page.goto(f"{base}/index.html?book=armory&puzzle={ex['puzzle']}")
    page.wait_for_load_state("networkidle")
    key = page.evaluate(
        """async (n) => {
            const { parseCsv, compile, puzzleHash } = await import('./js/logic.js');
            const text = await (await fetch('data/armory.csv')).text();
            return 'ms_save_' + puzzleHash(compile(parseCsv(text)[n - 1]));
        }""",
        ex["puzzle"],
    )
    save = {"e": ex["edges"], "ae": "0" * len(ex["edges"])}
    page.evaluate(
        """([key, save]) => {
            localStorage.setItem(key, JSON.stringify(save));
            localStorage.setItem('ms_dark', '0');
            localStorage.setItem('ms_seenHelp', '1');
            localStorage.setItem('ms_autoX', '0');
            localStorage.setItem('ms_autoShade', '0');
        }""",
        [key, save],
    )
    page.reload()
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(150)
    page.click("#hint-btn")
    page.wait_for_timeout(150)
    box = page.evaluate(
        """() => {
            const b = document.getElementById('board').getBoundingClientRect();
            const t = document.getElementById('toast').getBoundingClientRect();
            return {
                x: Math.min(b.left, t.left) - 8,
                y: b.top - 8,
                w: Math.max(b.right, t.right) - Math.min(b.left, t.left) + 16,
                h: t.bottom - b.top + 16,
            };
        }"""
    )
    page.screenshot(
        path=str(out_path),
        clip={"x": max(box["x"], 0), "y": max(box["y"], 0), "width": box["w"], "height": box["h"]},
    )


def main():
    args = sys.argv[1:]
    base = args[0] if args and args[0].startswith("http") else "http://localhost:8766"
    only = [a for a in args if not a.startswith("http")]
    examples = json.loads((ROOT / "docs/examples/examples.json").read_text())
    out_dir = ROOT / "docs/images"
    out_dir.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 640, "height": 1200}, device_scale_factor=2)
        for ex in examples:
            if only and ex["rule"] not in only:
                continue
            capture(page, base, ex, out_dir / f"{ex['rule']}.png")
            print(f"Captured {ex['rule']}.png", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
