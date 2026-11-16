// Installs the detector: `window.__ngLeakDetector`, the sweep loop, and
// discovery of components, directives and component-level services.
// Development only — a no-op in production builds, during server-side
// rendering, and in browsers without WeakRef.

import { isDevMode } from "@angular/core";
import { _config, configure, onSweepIntervalChange } from "./config.js";
import { rescan, startDiscovery } from "./discovery.js";
import { live } from "./store.js";
import { subscribe } from "./subscribers.js";
import { forceGc, report, sweep } from "./sweep.js";
import type { LeakDetectorOptions, LeakListener, ReportRow } from "./types.js";
import { startWitnesses } from "./witness.js";
import { outsideAngular } from "./zone.js";

export type LeakDetectorApi = {
  /** Print (and return) a table of tracked components, directives and services. */
  report(): ReportRow[];
  /** Check for leaks now instead of waiting for the next sweep. */
  sweep(): void;
  /** `window.gc()` (needs `--js-flags="--expose-gc"`), then sweep. */
  forceGc(): void;
  /** Change options while the app runs. */
  configure(options: Partial<LeakDetectorOptions>): void;
  /** Listen for leaks. Returns an unsubscribe function. */
  subscribe(listener: LeakListener): () => void;
  /**
   * Re-scan the document for what the observer could not see: components
   * rendered into a detached tree, services created after their element.
   */
  rescan(): void;
};

declare global {
  interface Window {
    __ngLeakDetector?: LeakDetectorApi;
  }
}

const api: LeakDetectorApi = {
  report,
  sweep,
  forceGc,
  configure: (options) => outsideAngular(() => configure(options)),
  subscribe,
  rescan: () => rescan(),
};

let intervalId: ReturnType<typeof setInterval> | null = null;

function startSweepLoop(): void {
  if (intervalId !== null) return;
  intervalId = setInterval(() => {
    if (document.visibilityState === "visible") sweep();
  }, _config.sweepIntervalMs);
}

function restartSweepLoop(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  startSweepLoop();
}

/**
 * Start the detector. Safe to call more than once: later calls only apply
 * `options`. Returns `null` (and does nothing) outside development mode, on
 * the server, and in browsers without WeakRef / FinalizationRegistry.
 */
export function startMemoryLeakDetector(
  options: Partial<LeakDetectorOptions> = {},
): LeakDetectorApi | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  if (!isDevMode()) return null;
  if (
    typeof WeakRef !== "function" ||
    typeof FinalizationRegistry !== "function" ||
    typeof MutationObserver !== "function"
  )
    return null;

  const existing = window.__ngLeakDetector;
  if (existing) {
    existing.configure(options);
    return existing;
  }

  window.__ngLeakDetector = api;
  outsideAngular(() => {
    configure(options);
    // `configure({ sweepIntervalMs })` restarts the loop with the new cadence.
    onSweepIntervalChange(restartSweepLoop);
    startWitnesses();
    startSweepLoop();
    startDiscovery();
  });

  if (_config.logging) {
    const found = { component: 0, directive: 0, service: 0 };
    live.forEach((entry) => (found[entry.kind] += 1));
    // eslint-disable-next-line no-console
    console.info(
      `[ng-leak] Memory leak detector running (${found.component} components, ${found.directive} directives, ${found.service} services found). Run window.__ngLeakDetector.report() for a live table.`,
    );
  }
  return api;
}
