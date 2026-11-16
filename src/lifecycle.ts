// Tracking of instances: `track` when discovery finds one (a component, a
// directive or a component-level service), `markDestroyed` when Angular
// destroys the view it lives in: its own view for a component, the view its
// element is in for a directive or a service.

import { addEntry, getStats, noteDestroyed } from "./store.js";
import type { InstanceKind, LiveEntry } from "./types.js";
import { syncWitness } from "./witness.js";

/** Per class, its name: one string shared by all its instances' entries. */
let names = new WeakMap<Function, string>();

/**
 * The instance's class name. Dev builds made with esbuild (the Angular CLI's
 * default builder since v17) emit `class _UserCardComponent`, so a leading
 * underscore before a capital letter is dropped.
 */
export function componentNameOf(instance: object): string {
  const ctor = (instance as { constructor?: unknown }).constructor;
  if (typeof ctor !== "function") return "Unknown";
  let name = names.get(ctor);
  if (name === undefined) {
    name = ctor.name.replace(/^_+(?=[A-Z])/, "") || "Unknown";
    names.set(ctor, name);
  }
  return name;
}

export function track(
  instance: object,
  componentName: string,
  host: string,
  kind: InstanceKind = "component",
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
  if (!s.host) {
    s.host = host;
    s.kind = kind;
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
