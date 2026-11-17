// Tracking of instances: `track` when discovery finds one (a component, a
// directive or a component-level service), `markDestroyed` when Angular
// destroys the view it lives in: its own view for a component, the view its
// element is in for a directive or a service.

import { addEntry, getStats, noteDestroyed } from "./store.js";
import type { InstanceKind, LiveEntry } from "./types.js";
import { syncWitness } from "./witness.js";

/**
 * `className` is the class's name at runtime, minified or not (names.ts): the
 * one a heap snapshot shows. By default `componentName`, as in a build that
 * keeps class names.
 */
export function track(
  instance: object,
  componentName: string,
  host: string,
  kind: InstanceKind = "component",
  className: string = componentName,
): LiveEntry {
  const entry: LiveEntry = {
    ref: new WeakRef(instance),
    componentName,
    kind,
    host,
    destroyedAt: null,
    witness: null,
    heldByRouter: false,
    companions: null,
    owner: null,
  };
  addEntry(instance, entry);
  const s = getStats(componentName);
  s.lastCreatedAt = Date.now();
  if (!s.seen) {
    s.seen = true;
    s.kind = kind;
    s.className = className;
  }
  return entry;
}

export function markDestroyed(entry: LiveEntry): void {
  if (entry.destroyedAt !== null) return;
  const now = Date.now();
  entry.destroyedAt = now;
  noteDestroyed(entry);
  // With `leakAgeMs: 0` the instance is stale at once: give it its witness
  // now, so a collection before the next sweep counts.
  syncWitness(entry, now);
}
