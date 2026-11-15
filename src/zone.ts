/**
 * Run `fn` outside Angular's zone when zone.js is loaded, so the detector's
 * timer, MutationObserver and microtasks never trigger change detection.
 */
export function outsideAngular<T>(fn: () => T): T {
  const root = (globalThis as { Zone?: { root?: { run<R>(f: () => R): R } } }).Zone?.root;
  return root ? root.run(fn) : fn();
}
