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
  /**
   * The name of the instance's class (for any kind: the field's name is
   * historical): its class name, or in a minified build its selector
   * (names.ts).
   */
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
  /**
   * Per tag, how many of the class's instances in memory (its entries in
   * `live`) are on an element of that tag. Kept as they come and go, so that
   * a report needn't walk them.
   */
  hosts: Map<string, number>;
  /** Whether an instance has been seen: `kind` and `className` are its class's. */
  seen: boolean;
  /** The class's name at runtime, minified in a minified build (names.ts). */
  className: string;
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
   *
   * In a minified production build, where class names are mangled: the
   * selector of a component (`app-user-card`) or directive
   * (`[appTooltip]`), a component without one by its component id
   * (`ng-component (c2736387395)`), and a service by where it is provided
   * (`app-cart providers[0]`). It depends only on what leaked, never on what
   * the detector saw before: the same leak has the same name in every
   * session, so events from many can be grouped by it. Classes that share a
   * selector share the name.
   */
  name: string;
  /** Whether it is a component, a directive or a component-level service. */
  kind: InstanceKind;
  /**
   * Tag name of its element, e.g. `app-user-card`: the component's host, the
   * directive's element, or the element that provides the service. Of the
   * leaked instances' elements, the first tag in alphabetical order: the
   * same whatever order the detector saw them in. `hosts` lists them all.
   */
  host: string;
  /**
   * The tags of the leaked instances' elements, in alphabetical order, each
   * with how many of them are on one: a directive that leaked on two
   * `<button>`s and an `<a>` has `[{ host: "a", count: 1 }, { host:
   * "button", count: 2 }]`. `host` is the first.
   */
  hosts: HostCount[];
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

/** Instances of a class on elements of one tag. */
export type HostCount = {
  /** The tag, e.g. `button`, or `ng-template` / `ng-container`. */
  host: string;
  /** How many instances. */
  count: number;
};

/** Instances of one class that leaked together with a component, as part of its leak. */
export type RetainedInstances = {
  /** Class name of the directive or service. */
  name: string;
  kind: InstanceKind;
  /** How many of them. */
  count: number;
};

export type ReportRow = {
  /**
   * Class name: of a component, a directive or a service (see `kind`). In a
   * minified build, a selector or minified name, as in LeakEvent.
   */
  name: string;
  kind: InstanceKind;
  /**
   * Of the elements its instances in memory are on, the first tag in
   * alphabetical order, as in LeakEvent. `hosts` lists them all.
   */
  host: string;
  /** The tags of its instances' elements, with how many on each, as in LeakEvent. */
  hosts: HostCount[];
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

/** A class: a component, directive or service. */
export type ClassRef = abstract new (...args: never[]) => unknown;

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
   * name (`"UserCardComponent"`), pattern, or the class itself
   * (`UserCardComponent`). Use it for instances something keeps on purpose,
   * e.g. a cache. A name or pattern is matched against `name`, which in a
   * minified build is a selector or a minified name: the class itself works
   * in every build.
   */
  exclude: ReadonlyArray<string | RegExp | ClassRef>;
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
  /**
   * In a minified build, give each class the detector names by its selector
   * or provider (`app-user-card`) that name as its `name` too, which is what
   * a heap snapshot shows, so that the warning and the heap snapshot agree.
   * Only classes whose name is minified are renamed, when first seen; a
   * service class provided in several places takes the name of the first
   * (the warning gives it). Not needed once `ng-leak-names` has restored the
   * build's class names. Default `false`: a class is renamed when the
   * detector first sees one of its instances, so stack traces of errors
   * thrown before then name it differently than those after, which error
   * trackers may group apart.
   */
  renameMinifiedClasses: boolean;
};
