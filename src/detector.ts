// Installs the detector: `window.__ngLeakDetector`, the sweep loop, and
// discovery of components, directives and component-level services.
// `startMemoryLeakDetector` runs in development only, and is a no-op in
// production builds; `startProductionMemoryLeakDetector` runs in production
// builds too. Both are no-ops during server-side rendering and in browsers
// without WeakRef.

import { isDevMode } from "@angular/core";
import { _config, configure, onSweepIntervalChange } from "./config.js";
import {
  type NgDebugApi,
  rescan,
  runsWithoutDebugApi,
  startDiscovery,
  useWithoutDebugApi,
} from "./discovery.js";
import { classNamesMinified } from "./names.js";
import { productionApi } from "./production.js";
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
  return install(options, null);
}

/**
 * Start the detector in any build, production included: where Angular
 * publishes no debugging API, discovery makes the same lookups without it
 * (production.ts), and in a minified build classes are named by their
 * selectors (names.ts). In development it is `startMemoryLeakDetector`.
 * Safe to call more than once, and after `startMemoryLeakDetector`: later
 * calls only apply `options`. Returns `null` (and does nothing) on the
 * server, and in browsers without WeakRef / FinalizationRegistry.
 */
export function startProductionMemoryLeakDetector(
  options: Partial<LeakDetectorOptions> = {},
): LeakDetectorApi | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return install(options, productionApi());
}

/** `withoutDebugApi`: the lookups to make where Angular publishes no debugging API, if allowed. */
function install(
  options: Partial<LeakDetectorOptions>,
  withoutDebugApi: NgDebugApi | null,
): LeakDetectorApi | null {
  if (
    typeof WeakRef !== "function" ||
    typeof FinalizationRegistry !== "function" ||
    typeof MutationObserver !== "function"
  )
    return null;

  if (withoutDebugApi) useWithoutDebugApi(withoutDebugApi);
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
      `[ng-leak] Memory leak detector running${buildNote()} (${found.component} components, ${found.directive} directives, ${found.service} services found). Run window.__ngLeakDetector.report() for a live table.`,
    );
    if (found.component === 0) warnIfBlind();
  }
  return api;
}

/**
 * Say so if Angular has rendered the app, yet the detector found none of its
 * components. It reads how Angular lays out its views, which Angular doesn't
 * promise to keep: a version that changes it leaves the detector blind, not
 * broken, and it had better not look like an app without leaks.
 */
function warnIfBlind(): void {
  // Angular marks the host of the app's root component, in every build.
  const root = document.querySelector("[ng-version]");
  if (!root) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[ng-leak] Found none of this app's components, although Angular ${root.getAttribute("ng-version")} has rendered <${root.localName}>: this version of Angular may keep them in a way this version of the detector doesn't know (it supports Angular 16 to 22). It will report no leaks.`,
  );
}

/** Say so when running without Angular's debugging API, or on minified class names. */
function buildNote(): string {
  const withoutDebugApi = runsWithoutDebugApi();
  const minified = classNamesMinified();
  if (!withoutDebugApi && !minified) return "";
  const notes = [
    withoutDebugApi ? "without Angular's debugging API" : "",
    minified ? "classes named by selector (minified build)" : "",
  ].filter(Boolean);
  return ` in a production build, ${notes.join(", ")}`;
}
