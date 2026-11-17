// Module-level state.
//
// - `live`     : every tracked entry whose instance (component, directive or
//                service) is still reachable.
// - `destroyed`: the entries of `live` whose instance Angular has destroyed.
//                The only ones a sweep has to look at: in an app that frees
//                what it destroys, it stays small however big the app is.
// - `stats`    : per-class-name info (kind, runtime class name, instances in
//                `live` and per tag of their elements, last-created time,
//                last-warn time).
// - `registry` : when an instance is collected, forget its entry.
// - `entries`  : each tracked instance's entry, for callers handed an instance.

import type { ComponentStats, LiveEntry } from "./types.js";

export const live = new Set<LiveEntry>();
export const destroyed = new Set<LiveEntry>();
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
  const s = getStats(entry.componentName);
  s.live += 1;
  s.hosts.set(entry.host, (s.hosts.get(entry.host) ?? 0) + 1);
  registry ??= new FinalizationRegistry<LiveEntry>(forget);
  registry.register(instance, entry);
}

/** Angular destroyed the entry's instance: sweeps look at it from now on. */
export function noteDestroyed(entry: LiveEntry): void {
  if (live.has(entry)) destroyed.add(entry);
}

/** The entry's instance was collected. Safe to call more than once. */
export function forget(entry: LiveEntry): void {
  if (!live.delete(entry)) return;
  destroyed.delete(entry);
  const s = stats.get(entry.componentName);
  if (!s) return;
  s.live -= 1;
  const onTag = (s.hosts.get(entry.host) ?? 0) - 1;
  if (onTag > 0) s.hosts.set(entry.host, onTag);
  else s.hosts.delete(entry.host);
}

export function getStats(name: string): ComponentStats {
  let s = stats.get(name);
  if (!s) {
    s = {
      kind: "component",
      hosts: new Map(),
      seen: false,
      className: name,
      live: 0,
      lastCreatedAt: 0,
      lastWarnedAt: 0,
    };
    stats.set(name, s);
  }
  return s;
}
