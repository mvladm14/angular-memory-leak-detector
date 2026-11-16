// Shared types for the leak detector.

/**
 * What a tracked instance is:
 *
 * - `component`: a component, destroyed with its own view;
 * - `directive`: a directive (attribute or structural), destroyed with the
 *   view its element is in;
 * - `service`: a service provided by a component or directive (its
 *   `providers` or `viewProviders`), which Angular creates for that element
 *   and destroys with the view the element is in.
 */
export type InstanceKind = "component" | "directive" | "service";

export type LiveEntry = {
  /** The instance. Held weakly: the detector must never keep it alive. */
  ref: WeakRef<object>;
  /** The instance's class name (for any kind: the name is historical). */
  componentName: string;
  kind: InstanceKind;
  /**
   * Tag name of the element: the component's host (`app-user-card`), the
   * directive's element (`button`, or `ng-template` / `ng-container` for a
   * directive on one), or the element whose injector provides the service.
   */
  host: string;
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
  /**
   * On a component: the directives on its host element and the services that
   * element provides. They share its fate with the router (router.ts): the
   * component can reference them, so they are held while it is. `null` until
   * it has one: most components have none.
   */
  companions: LiveEntry[] | null;
  /**
   * On a directive or service: the component it belongs to. That is the
   * component on the same element (whose `providers`, `viewProviders` and
   * host directives these are), or else the one whose template the element
   * is in. A destroyed component still in memory often keeps its whole view,
   * and with it everything in there: those are reported in its warning, not
   * one by one (sweep.ts). `null` for what isn't in a component's view.
   */
  owner: LiveEntry | null;
};

/** A released old-generation object, shared by the instances that went stale in one job. */
export type Witness = { ref: WeakRef<object> };

export type ComponentStats = {
  kind: InstanceKind;
  host: string;
  /** Instances of the class still in memory: its entries in `live`. */
  live: number;
  lastCreatedAt: number;
  lastWarnedAt: number;
};

export type LeakEvent = {
  /**
   * Class name of the leaked instance: of a component (`UserCardComponent`),
   * a directive (`TooltipDirective`) or a service (`CartStore`), see `kind`.
   * The name to filter by in a heap snapshot.
   */
  name: string;
  /** Whether it is a component, a directive or a component-level service. */
  kind: InstanceKind;
  /**
   * Tag name of its element, e.g. `app-user-card`: the component's host, the
   * directive's element, or the element that provides the service.
   */
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
  /**
   * The directives and services of the leaked components that are still in
   * memory with them (their owner, see LiveEntry), most first. They get no
   * event of their own. Empty for a directive or service, and for a
   * component whose own directives and services were freed.
   */
  retained: RetainedInstances[];
  /** Timestamp (ms since epoch) at which the event was fired. */
  at: number;
};

export type LeakListener = (event: LeakEvent) => void;

/** Instances of one class that leaked together with a component, as part of its leak. */
export type RetainedInstances = {
  /** Class name of the directive or service. */
  name: string;
  kind: InstanceKind;
  /** How many of them. */
  count: number;
};

export type ReportRow = {
  /** Class name: of a component, a directive or a service (see `kind`). */
  name: string;
  kind: InstanceKind;
  host: string;
  /** Reachable instances, alive or destroyed. */
  live: number;
  /**
   * Destroyed ≥ leakAgeMs ago and still in memory after a garbage collection:
   * leaked, and reported.
   */
  stale: number;
  /**
   * Directives and services destroyed ≥ leakAgeMs ago and still in memory
   * after a garbage collection, together with the destroyed component they
   * belong to, which is still in memory too: they are part of that
   * component's leak, reported in its warning (or, while it isn't judged yet,
   * waiting for its verdict), not on their own.
   */
  withOwner: number;
  /**
   * Destroyed ≥ leakAgeMs ago but no major garbage collection has run since:
   * they may just not have been collected yet, so they aren't reported.
   */
  awaitingGc: number;
  /**
   * Destroyed pages the Angular router itself still holds after navigating
   * away from them (Angular 16 and 20 only), with the directives on their host
   * element and the services it provides. They aren't judged until later
   * navigations make the router let go of them.
   */
  heldByRouter: number;
  lastCreatedSecsAgo: number;
};

export type LeakDetectorOptions = {
  /** Console output (warnings, the install banner, `report()`'s table). Default `true`. */
  logging: boolean;
  /** How long a destroyed instance may stay in memory before it is suspect. Default 10 000 ms. */
  leakAgeMs: number;
  /** Stale instances of one class needed before it is reported. Default 1. */
  suspectThreshold: number;
  /** How often leaks are checked. Default 2 000 ms. */
  sweepIntervalMs: number;
  /** Minimum time between two reports of the same class. Default 30 000 ms. */
  warnCooldownMs: number;
  /**
   * Classes never reported (components, directives or services), by class
   * name (`"UserCardComponent"`) or pattern. Use it for instances something
   * keeps on purpose, e.g. a cache.
   */
  exclude: ReadonlyArray<string | RegExp>;
  /**
   * Track directives too, Angular's own included (`RouterLink`, `NgIf`, …).
   * Default `true`. Turning it off also hides the ones already tracked.
   */
  trackDirectives: boolean;
  /**
   * Track services provided by components and directives (their `providers`
   * and `viewProviders`). Default `true`. Turning it off also hides the ones
   * already tracked.
   */
  trackServices: boolean;
};
