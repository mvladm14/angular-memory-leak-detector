// Runtime configuration. Mutable so that `configure()` can hot-update behavior
// (logging, thresholds, sweep cadence) while the app runs.

import { isNameOf } from "./names.js";
import type { InstanceKind, LeakDetectorOptions } from "./types.js";

export const _config: LeakDetectorOptions = {
  logging: true,
  leakAgeMs: 10_000,
  suspectThreshold: 1,
  sweepIntervalMs: 2_000,
  warnCooldownMs: 30_000,
  exclude: [],
  trackDirectives: true,
  trackServices: true,
  renameMinifiedClasses: false,
  trackCauses: true,
};

const intervalChangeListeners = new Set<() => void>();

/**
 * Register a callback that fires when `configure()` changes `sweepIntervalMs`.
 * Used by the sweep loop to restart itself with the new cadence.
 */
export function onSweepIntervalChange(cb: () => void): void {
  intervalChangeListeners.add(cb);
}

const configureListeners = new Set<() => void>();

/** Register a callback that fires after every `configure()`. */
export function onConfigure(cb: () => void): void {
  configureListeners.add(cb);
}

export function configure(options: Partial<LeakDetectorOptions> = {}): void {
  const oldInterval = _config.sweepIntervalMs;
  Object.assign(_config, options);
  if (options.sweepIntervalMs && options.sweepIntervalMs !== oldInterval) {
    intervalChangeListeners.forEach((cb) => cb());
  }
  configureListeners.forEach((cb) => cb());
}

/**
 * `name`: as names.ts gives it. A class in `exclude` matches the names its
 * instances were given: none before one is seen.
 */
export function isExcluded(name: string): boolean {
  return _config.exclude.some((rule) => {
    if (typeof rule === "string") return rule === name;
    if (typeof rule === "function") return isNameOf(rule, name);
    return rule.test(name);
  });
}

/** Components are always tracked; directives and services unless turned off. */
export function isTrackedKind(kind: InstanceKind): boolean {
  if (kind === "directive") return _config.trackDirectives;
  if (kind === "service") return _config.trackServices;
  return true;
}
