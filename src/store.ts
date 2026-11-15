// Module-level state.
//
// - `live`    : every tracked entry whose component instance is still reachable.
// - `stats`   : per-component-name info (host tag, last-created time, last-warn time).
// - `registry`: when an instance is collected, drop its entry from `live`.
// - `entries` : each tracked instance's entry, for callers handed an instance.

import type { ComponentStats, LiveEntry } from "./types.js";

export const live = new Set<LiveEntry>();
export const stats = new Map<string, ComponentStats>();

/** Created on first use, so that nothing here runs at module load. */
let registry: FinalizationRegistry<LiveEntry> | null = null;

/** Keyed weakly, and an entry holds its instance weakly: no instance is kept alive. */
const entries = new WeakMap<object, LiveEntry>();

export function entryOf(instance: object): LiveEntry | undefined {
  return entries.get(instance);
}

export function addEntry(instance: object, entry: LiveEntry): void {
  live.add(entry);
  entries.set(instance, entry);
  registry ??= new FinalizationRegistry<LiveEntry>((collected) => {
    live.delete(collected);
  });
  registry.register(instance, entry);
}

export function getStats(name: string): ComponentStats {
  let s = stats.get(name);
  if (!s) {
    s = { host: "", lastCreatedAt: 0, lastWarnedAt: 0 };
    stats.set(name, s);
  }
  return s;
}
