// Shared types for the leak detector.

export type LiveEntry = {
  /** The component instance. Held weakly: the detector must never keep it alive. */
  ref: WeakRef<object>;
  componentName: string;
  /** Tag name of the host element, e.g. `app-user-card` (or `button` for attribute selectors). */
  host: string;
  createdAt: number;
  /** When Angular destroyed the component's view, or `null` while it is alive. */
  destroyedAt: number | null;
  /**
   * Set while the instance is stale (see witness.ts). Its object being gone
   * means a major collection has run since the instance went stale.
   */
  witness: Witness | null;
  /**
   * A destroyed page the Angular router itself still holds (Angular 16 and 20,
   * see router.ts). It gets no verdict until the router lets go of it.
   */
  heldByRouter: boolean;
};

/** A released old-generation object, shared by the instances that went stale in one job. */
export type Witness = { ref: WeakRef<object> };

export type ComponentStats = {
  host: string;
  lastCreatedAt: number;
  lastWarnedAt: number;
};

export type LeakEvent = {
  /** Component class name, e.g. `UserCardComponent` — the name to filter by in a heap snapshot. */
  component: string;
  /** Host element tag name, e.g. `app-user-card`. */
  host: string;
  /**
   * Number of instances destroyed ≥ leakAgeMs ago that are still reachable
   * after a garbage collection that ran once they had been destroyed that long.
   */
  stale: number;
  /** Total reachable instances: alive + recently destroyed + leaked. */
  live: number;
  /** Threshold (ms) used to classify a destroyed instance as stale. */
  leakAgeMs: number;
  /** Timestamp (ms since epoch) at which the event was fired. */
  at: number;
};

export type LeakListener = (event: LeakEvent) => void;

export type ReportRow = {
  component: string;
  host: string;
  /** Reachable instances, alive or destroyed. */
  live: number;
  /** Destroyed ≥ leakAgeMs ago and still in memory after a garbage collection: leaked. */
  stale: number;
  /**
   * Destroyed ≥ leakAgeMs ago but no major garbage collection has run since:
   * they may just not have been collected yet, so they aren't reported.
   */
  awaitingGc: number;
  /**
   * Destroyed pages the Angular router itself still holds after navigating
   * away from them (Angular 16 and 20 only). They aren't judged until later
   * navigations make the router let go of them.
   */
  heldByRouter: number;
  lastCreatedSecsAgo: number;
};

export type LeakDetectorOptions = {
  /** Console output (warnings, the install banner, `report()`'s table). Default `true`. */
  logging: boolean;
  /** How long a destroyed component may stay in memory before it is suspect. Default 10 000 ms. */
  leakAgeMs: number;
  /** Stale instances of one component needed before it is reported. Default 1. */
  suspectThreshold: number;
  /** How often leaks are checked. Default 2 000 ms. */
  sweepIntervalMs: number;
  /** Minimum time between two reports of the same component. Default 30 000 ms. */
  warnCooldownMs: number;
  /**
   * Components never reported, by class name (`"UserCardComponent"`) or
   * pattern. Use it for components something keeps on purpose, e.g. a cache.
   */
  exclude: ReadonlyArray<string | RegExp>;
};
