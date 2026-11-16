// Sweep, report, and forced-GC entry points.
//
// `tally` looks at the destroyed instances still in memory (store.ts's
// `destroyed`), drops the collected ones, and counts stale / awaiting-GC /
// held-by-router / with-owner instances per class name (of a component,
// directive or component-level service). Instances Angular hasn't destroyed
// can't have a verdict, and their number per class is kept up to date as they
// come and go (`stats`), so neither a sweep nor a report walks them: both cost
// nothing while nothing destroyed is still in memory, however big the app is.
// `sweep` fires warnings and listener events, `report` returns a snapshot.
//
// An instance destroyed for `leakAgeMs` is only *stale* (a leak) once a major
// garbage collection has run since and left it in memory. Until then it is
// `awaitingGc`: it may simply not have been collected yet. See witness.ts.
// A page the Angular router itself still holds (Angular 16 and 20) is
// `heldByRouter` and gets no verdict until the router lets go. See router.ts.
//
// A destroyed component still in memory often keeps its whole view, and with
// it every directive and service in there. Those are part of its leak: a
// stale directive or service whose owner (LiveEntry) is destroyed and still
// in memory too counts as `withOwner`, is listed in the owner's warning and
// event, and gets none of its own. While the owner isn't judged yet (too
// recent, awaiting a collection, held by the router) they wait for its
// verdict; if the owner is excluded, they are kept on purpose with it. A
// stale one whose owner was collected, or is alive, leaked on its own, and is
// reported on its own.

import { _config, isExcluded, isTrackedKind } from "./config.js";
import { destroyed, forget, getStats, stats } from "./store.js";
import { emitLeak, hasListeners } from "./subscribers.js";
import type { ComponentStats, LiveEntry, ReportRow, RetainedInstances } from "./types.js";
import { isOverAge, survivedGc, syncWitness } from "./witness.js";

type Bucket = {
  stale: number;
  awaitingGc: number;
  heldByRouter: number;
  withOwner: number;
};

/** Where a destroyed instance is, on its way to a verdict. */
type State = "recent" | "held" | "awaitingGc" | "stale";

function stateOf(entry: LiveEntry, now: number): State {
  if (entry.heldByRouter) return "held";
  if (!isOverAge(entry, now)) return "recent";
  // The caller has just dereferenced the instance (see survivedGc).
  return survivedGc(entry) ? "stale" : "awaitingGc";
}

type Tally = {
  /** Only the classes with destroyed instances still in memory. */
  perName: Map<string, Bucket>;
  /** Per owner class name: what leaked with its leaked instances, by `kind:name`. */
  retainedBy: Map<string, Map<string, RetainedInstances>>;
};

const isShown = (name: string, s: ComponentStats) => !isExcluded(name) && isTrackedKind(s.kind);

function tally(): Tally {
  const now = Date.now();
  const perName = new Map<string, Bucket>();
  const retainedBy = new Map<string, Map<string, RetainedInstances>>();

  // 1. Every destroyed instance still in memory, and its state. An owner can
  // come after what it owns: the verdicts need them all first.
  const states = new Map<LiveEntry, State>();
  destroyed.forEach((entry) => {
    // Destroyed too recently to be judged, and with no witness to drop (see
    // syncWitness): nothing to look at yet. After a page with thousands of
    // instances goes, sweeps skip them until `leakAgeMs` has passed. A
    // collected one is forgotten by the registry meanwhile.
    if (!entry.heldByRouter && entry.witness === null && now - entry.destroyedAt! < _config.leakAgeMs) {
      return;
    }
    if (!entry.ref.deref()) {
      forget(entry);
      return;
    }
    // Hidden ones only matter as owners: whether they are destroyed.
    if (isShown(entry.componentName, getStats(entry.componentName))) syncWitness(entry, now);
    states.set(entry, stateOf(entry, now));
  });

  // 2. The counts.
  states.forEach((state, entry) => {
    const name = entry.componentName;
    if (!isShown(name, getStats(name))) return;
    let bucket = perName.get(name);
    if (!bucket) {
      bucket = { stale: 0, awaitingGc: 0, heldByRouter: 0, withOwner: 0 };
      perName.set(name, bucket);
    }
    if (entry.heldByRouter) bucket.heldByRouter += 1;
    if (state === "awaitingGc") bucket.awaitingGc += 1;
    if (state !== "stale") return;

    const ownerState = entry.owner ? ownerStateOf(entry.owner, states) : undefined;
    if (ownerState === undefined) {
      bucket.stale += 1;
      return;
    }
    bucket.withOwner += 1;
    if (ownerState !== "stale") return;
    const ownerName = entry.owner!.componentName;
    let retained = retainedBy.get(ownerName);
    if (!retained) retainedBy.set(ownerName, (retained = new Map()));
    const key = `${entry.kind}:${name}`;
    const row = retained.get(key);
    if (row) row.count += 1;
    else retained.set(key, { name, kind: entry.kind, count: 1 });
  });

  return { perName, retainedBy };
}

/**
 * The owner's state: `undefined` if it is alive (not destroyed) or was
 * collected; `recent` if it was skipped for that (destroyed, still tracked).
 */
function ownerStateOf(owner: LiveEntry, states: ReadonlyMap<LiveEntry, State>): State | undefined {
  return states.get(owner) ?? (destroyed.has(owner) ? "recent" : undefined);
}

/** `UserCardComponent <app-user-card>`, `directive TooltipDirective on <button>`, … */
function describe(name: string, s: ComponentStats): string {
  if (s.kind === "directive") return `directive ${name} on <${s.host}>`;
  if (s.kind === "service") return `service ${name} provided by <${s.host}>`;
  return `${name} <${s.host}>`;
}

/** Classes listed by name in a warning; the rest are counted. */
const LISTED = 6;

/** `, together with 3 directive(s) and 1 service(s) of its own: RouterLink ×2, …` */
function together(retained: readonly RetainedInstances[]): string {
  if (retained.length === 0) return "";
  const count = (kind: string) =>
    retained.filter((r) => r.kind === kind).reduce((n, r) => n + r.count, 0);
  const counts = [
    count("directive") > 0 ? `${count("directive")} directive(s)` : "",
    count("service") > 0 ? `${count("service")} service(s)` : "",
  ].filter(Boolean);
  const names = retained
    .slice(0, LISTED)
    .map((r) => (r.count > 1 ? `${r.name} ×${r.count}` : r.name));
  const more = retained.length > LISTED ? ` and ${retained.length - LISTED} more` : "";
  return `, together with ${counts.join(" and ")} of its own: ${names.join(", ")}${more}`;
}

/** Most first, then by name. */
function sorted(retained: Map<string, RetainedInstances> | undefined): RetainedInstances[] {
  return [...(retained?.values() ?? [])].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}

export function sweep(): void {
  const now = Date.now();
  const { perName, retainedBy } = tally();

  perName.forEach((bucket, name) => {
    const s = getStats(name);
    const cooldownPassed = now - s.lastWarnedAt > _config.warnCooldownMs;
    if (bucket.stale >= _config.suspectThreshold && cooldownPassed) {
      s.lastWarnedAt = now;
      const retained = sorted(retainedBy.get(name));
      if (_config.logging) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ng-leak] Suspected leak: ${describe(name, s)} — ${bucket.stale} instance(s) destroyed >${_config.leakAgeMs / 1000}s ago still retained after garbage collection (live ${s.live} total)${together(retained)}. Take a heap snapshot and filter for "${name}" to see what holds it.`,
        );
      }
      if (hasListeners()) {
        emitLeak({
          name,
          kind: s.kind,
          host: s.host,
          stale: bucket.stale,
          live: s.live,
          leakAgeMs: _config.leakAgeMs,
          at: now,
          retained,
        });
      }
    }
  });
}

export function report(): ReportRow[] {
  const now = Date.now();
  const { perName } = tally();
  const rows: ReportRow[] = [];
  const none: Bucket = { stale: 0, awaitingGc: 0, heldByRouter: 0, withOwner: 0 };

  stats.forEach((s, name) => {
    if (s.live <= 0 || !isShown(name, s)) return;
    const bucket = perName.get(name) ?? none;
    rows.push({
      name,
      kind: s.kind,
      host: s.host,
      live: s.live,
      stale: bucket.stale,
      withOwner: bucket.withOwner,
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
