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
 * If `onFire({ force: false })` returns `false` (e.g. pointer is currently held down), the target
 * stays pending as a missed timer so `flush(exceptKey)` or `flushIfMissed()` runs it safely later.
 */
export function makeAutoGrace({
  delayMs = 180,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let key = null;
  let missedKey = null;
  let timer = null;
  let pendingFn = null;
  const activeKey = () => (key !== null ? key : missedKey);
  return {
    isPending(targetKey = null) {
      const k = activeKey();
      return k !== null && (targetKey === null || k === targetKey);
    },
    schedule(targetKey, onFire) {
      if (timer !== null) clearTimer(timer);
      key = targetKey;
      missedKey = null;
      pendingFn = onFire;
      timer = setTimer(() => {
        const k = key;
        const fn = pendingFn;
        key = null;
        timer = null;
        const ran = fn ? fn({ force: false }) : true;
        if (ran === false) {
          missedKey = k;
        } else {
          missedKey = null;
          pendingFn = null;
        }
      }, delayMs);
    },
    flush(exceptKey = null) {
      const k = activeKey();
      if (k === null || (exceptKey !== null && k === exceptKey)) return false;
      const fn = pendingFn;
      if (timer !== null) clearTimer(timer);
      key = null;
      missedKey = null;
      timer = null;
      pendingFn = null;
      if (fn) fn({ force: true });
      return true;
    },
    flushIfMissed() {
      if (missedKey === null) return false;
      const fn = pendingFn;
      missedKey = null;
      pendingFn = null;
      if (fn) fn({ force: true });
      return true;
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      key = null;
      missedKey = null;
      timer = null;
      pendingFn = null;
    },
  };
}
