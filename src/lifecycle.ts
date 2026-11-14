// Tracking of component instances: `track` when discovery finds one,
// `markDestroyed` when Angular destroys its view.

import { getStats, live, registry } from "./store.js";
import type { LiveEntry } from "./types.js";
import { syncWitness } from "./witness.js";

/**
 * The component's class name. Dev builds made with esbuild (the Angular CLI's
 * default builder since v17) emit `class _UserCardComponent`, so a leading
 * underscore before a capital letter is dropped.
 */
export function componentNameOf(instance: object): string {
  const ctor = (instance as { constructor?: unknown }).constructor;
  const raw = typeof ctor === "function" ? ctor.name : "";
  if (!raw) return "Unknown";
  return raw.replace(/^_+(?=[A-Z])/, "");
}

export function track(instance: object, componentName: string, host: string): LiveEntry {
  const now = Date.now();
  const entry: LiveEntry = {
    ref: new WeakRef(instance),
    componentName,
    host,
    createdAt: now,
    destroyedAt: null,
    witness: null,
  };
  live.add(entry);
  registry.register(instance, entry);

  const s = getStats(componentName);
  s.lastCreatedAt = now;
  if (!s.host) s.host = host;
  return entry;
}

export function markDestroyed(entry: LiveEntry): void {
  if (entry.destroyedAt !== null) return;
  const now = Date.now();
  entry.destroyedAt = now;
  // With `leakAgeMs: 0` the instance is stale at once: give it its witness
  // now, so a collection before the next sweep counts.
  syncWitness(entry, now);
}
