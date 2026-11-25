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

/**
 * Short grace period before Auto-X / Auto-Shade fire after a single tap into an intermediate
 * cycle state (e.g. empty -> line when double-tapping to place X), preventing flicker between taps.
 */
export function makeAutoGrace({
  delayMs = 320,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let key = null;
  let timer = null;
  let pendingFn = null;
  return {
    isPending(targetKey = null) {
      return key !== null && (targetKey === null || key === targetKey);
    },
    schedule(targetKey, onFire) {
      if (timer !== null) clearTimer(timer);
      key = targetKey;
      pendingFn = onFire;
      timer = setTimer(() => {
        const fn = pendingFn;
        key = null;
        timer = null;
        pendingFn = null;
        if (fn) fn();
      }, delayMs);
    },
    flush(exceptKey = null) {
      if (key === null || (exceptKey !== null && key === exceptKey)) return false;
      const fn = pendingFn;
      if (timer !== null) clearTimer(timer);
      key = null;
      timer = null;
      pendingFn = null;
      if (fn) fn();
      return true;
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      key = null;
      timer = null;
      pendingFn = null;
    },
  };
}
