// Module-level state.
//
// - `live`    : every tracked entry whose component instance is still reachable.
// - `stats`   : per-component-name info (host tag, last-created time, last-warn time).
// - `registry`: when an instance is collected, drop its entry from `live`.

import type { ComponentStats, LiveEntry } from "./types.js";

export const live = new Set<LiveEntry>();
export const stats = new Map<string, ComponentStats>();

export const registry = new FinalizationRegistry<LiveEntry>((entry) => {
  live.delete(entry);
});

export function getStats(name: string): ComponentStats {
  let s = stats.get(name);
  if (!s) {
    s = { host: "", lastCreatedAt: 0, lastWarnedAt: 0 };
    stats.set(name, s);
  }
  return s;
}
