// Grace period before newly violated circles turn red, so mid-gesture edits don't flash red.
export function makeGrace() {
  let shown = new Set(), waiting = new Set(), waitKey = '';
  return {
    update(wanted, immediate = false) {
      shown = new Set([...shown].filter((k) => wanted.has(k)));
      waiting = new Set();
      for (const k of wanted) if (!shown.has(k)) (immediate ? shown : waiting).add(k);
      const key = [...waiting].sort().join(',');
      const fresh = key !== waitKey;
      waitKey = key;
      return { show: shown, waiting, fresh };
    },
    commit() { for (const k of waiting) shown.add(k); waiting = new Set(); waitKey = ''; },
    reset() { shown = new Set(); waiting = new Set(); waitKey = ''; },
  };
}
