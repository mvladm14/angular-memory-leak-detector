// Sweep, report, and forced-GC entry points.
//
// `bucketLiveEntries` walks the live set, drops collected entries, and tallies
// live / stale / awaiting-GC / held-by-router counts per component name. It's
// shared between `sweep` (which fires warnings + listener events) and `report`
// (which returns a snapshot).
//
// An instance destroyed for `leakAgeMs` is only *stale* (a leak) once a major
// garbage collection has run since and left it in memory. Until then it is
// `awaitingGc`: it may simply not have been collected yet. See witness.ts.
// A page the Angular router itself still holds (Angular 16 and 20) is
// `heldByRouter` and gets no verdict until the router lets go. See router.ts.

import { _config, isExcluded } from "./config.js";
import { getStats, live } from "./store.js";
import { emitLeak, hasListeners } from "./subscribers.js";
import type { ReportRow } from "./types.js";
import { isOverAge, survivedGc, syncWitness } from "./witness.js";

type Bucket = { live: number; stale: number; awaitingGc: number; heldByRouter: number };

function bucketLiveEntries(): Map<string, Bucket> {
  const now = Date.now();
  const perName = new Map<string, Bucket>();

  live.forEach((entry) => {
    if (!entry.ref.deref()) {
      live.delete(entry);
      return;
    }
    if (isExcluded(entry.componentName)) return;
    syncWitness(entry, now);
    let bucket = perName.get(entry.componentName);
    if (!bucket) {
      bucket = { live: 0, stale: 0, awaitingGc: 0, heldByRouter: 0 };
      perName.set(entry.componentName, bucket);
    }
    bucket.live += 1;
    if (entry.heldByRouter) bucket.heldByRouter += 1;
    if (!isOverAge(entry, now)) return;
    if (survivedGc(entry)) bucket.stale += 1;
    else bucket.awaitingGc += 1;
  });

  return perName;
}

export function sweep(): void {
  const now = Date.now();
  const perName = bucketLiveEntries();

  perName.forEach((bucket, name) => {
    const s = getStats(name);
    const cooldownPassed = now - s.lastWarnedAt > _config.warnCooldownMs;
    if (bucket.stale >= _config.suspectThreshold && cooldownPassed) {
      s.lastWarnedAt = now;
      if (_config.logging) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ng-leak] Suspected leak: ${name} <${s.host}> — ${bucket.stale} instance(s) destroyed >${_config.leakAgeMs / 1000}s ago still retained after garbage collection (live ${bucket.live} total). Take a heap snapshot and filter for "${name}" to see what holds it.`,
        );
      }
      if (hasListeners()) {
        emitLeak({
          component: name,
          host: s.host,
          stale: bucket.stale,
          live: bucket.live,
          leakAgeMs: _config.leakAgeMs,
          at: now,
        });
      }
    }
  });
}

export function report(): ReportRow[] {
  const now = Date.now();
  const perName = bucketLiveEntries();
  const rows: ReportRow[] = [];

  perName.forEach((bucket, name) => {
    const s = getStats(name);
    rows.push({
      component: name,
      host: s.host,
      live: bucket.live,
      stale: bucket.stale,
      awaitingGc: bucket.awaitingGc,
      heldByRouter: bucket.heldByRouter,
      lastCreatedSecsAgo: Number(((now - s.lastCreatedAt) / 1000).toFixed(1)),
    });
  });

  rows.sort((a, b) => b.stale - a.stale || b.live - a.live);

  if (_config.logging) {
    // eslint-disable-next-line no-console
    console.table(rows);
  }
  return rows;
}

export function forceGc(): void {
  const g = globalThis as typeof globalThis & { gc?: () => void };
  if (typeof g.gc === "function") {
    g.gc();
  } else if (_config.logging) {
    // eslint-disable-next-line no-console
    console.info(
      '[ng-leak] window.gc is not available. Start Chrome with --js-flags="--expose-gc" to enable it, or click "Collect garbage" in DevTools → Memory.',
    );
  }
  sweep();
}
