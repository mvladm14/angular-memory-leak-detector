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

/** Kind of a recorded resource (causes.ts). */
export type ResourceKind = LeakCauseKind;

/**
 * The resources a component, directive or service started (ownership.ts).
 * Looked up by instance; never references it.
 */
export type Owner = {
  /** Resources not known to have ended. */
  resources: Set<Resource>;
  /** Size of `resources` after the last prune. */
  pruned: number;
};

type ResourceBase = {
  /** Who started it. Reassigned only when two owners of one instance are merged. */
  owner: Owner;
  /** `LeakCause.startedIn`. */
  startedIn: string | null;
};

/** A timer, animation frame or idle callback. Removed when it fires (except intervals) or is cleared. */
export type TimerResource = ResourceBase & {
  kind: "interval" | "timeout" | "animationFrame" | "idleCallback";
  /** Delay in ms (0 for animation frames and idle callbacks). */
  delay: number;
  /** Re-scheduled by its own callback (see loops in ownership.ts). */
  loop: boolean;
};

/** An event listener. References neither the target (weakly only) nor the listener. */
export type ListenerResource = ResourceBase & {
  kind: "eventListener";
  target: WeakRef<EventTarget>;
  type: string;
  capture: boolean;
  signal: WeakRef<AbortSignal> | null;
  /** For `{ once: true }` listeners: the companion listener that detects firing (instrument.ts). */
  companion: EventListener | null;
  /** A `once` listener that has fired. */
  fired: boolean;
};

/** A ResizeObserver, MutationObserver or IntersectionObserver. References it and its targets weakly. */
export type ObserverResource = ResourceBase & {
  kind: "observer";
  /** The class name, for the description. */
  observerType: string;
  observer: WeakRef<object>;
  /** Observed targets, minus those passed to `unobserve`. */
  targets: Array<WeakRef<object>>;
  disconnected: boolean;
};

/** An RxJS subscription. Referenced weakly. */
export type SubscriptionResource = ResourceBase & {
  kind: "subscription";
  subscription: WeakRef<{ closed?: unknown }>;
  /** Class name of the source observable (through operators), or `""`. */
  source: string;
};

export type Resource = TimerResource | ListenerResource | ObserverResource | SubscriptionResource;

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
  /**
   * Resources the leaked instances (or the directives and services that
   * leaked with them) started and that are still active: the likely causes
   * of the leak. Own causes first, then by likelihood. Empty if none is
   * known, e.g. the instance is held by a cache or a closure, or by
   * something whose starter couldn't be determined. Always empty with
   * `trackCauses` off.
   */
  causes: LeakCause[];
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

/**
 * Kind of resource holding a leaked instance:
 * - `interval`: a `setInterval` not cleared;
 * - `timeout`: a pending `setTimeout`, or a loop of them;
 * - `animationFrame`: a pending `requestAnimationFrame`, usually a loop;
 * - `idleCallback`: a pending `requestIdleCallback`, or a loop of them;
 * - `eventListener`: a listener not removed (or a `once` listener not yet
 *   fired) on a target that outlives the instance (`window`, `document`, an
 *   attached element, a `MediaQueryList`, …);
 * - `observer`: a `ResizeObserver`, `MutationObserver` or
 *   `IntersectionObserver` not disconnected, observing an attached node;
 * - `subscription`: an RxJS subscription not closed.
 */
export type LeakCauseKind =
  | "interval"
  | "timeout"
  | "animationFrame"
  | "idleCallback"
  | "eventListener"
  | "observer"
  | "subscription";

/**
 * A resource started by a leaked instance (or by a directive or service that
 * leaked with it, see `by`) and still active after the instance was
 * destroyed. See the README, "Finding the cause".
 */
export type LeakCause = {
  kind: LeakCauseKind;
  /**
   * E.g. `setInterval every 1000 ms`, `setTimeout loop (every 500 ms)`,
   * `"resize" listener on window`, `"load" listener (once) on window`,
   * `ResizeObserver observing <body>`, `subscription to BehaviorSubject`.
   */
  description: string;
  /**
   * Where in `by`'s code it was started: `"constructor"` (including field
   * initializers), a lifecycle hook name (`"ngOnInit"`, …), `"event handler"`
   * (template or `@HostListener` binding), `"template"` (during rendering,
   * e.g. a pipe or input setter), or `"subscription callback"`. Hooks,
   * handlers and templates are only detected in development builds. `null`
   * if unknown.
   */
  startedIn: string | null;
  /**
   * `name` of the class that started it: the leaked class, or a directive or
   * service that leaked with it (see `retained`).
   */
  by: string;
  /** Whether `by` is a component, a directive or a service. */
  byKind: InstanceKind;
  /** Number of identical active resources. */
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
  /**
   * Report likely causes of leaks (`causes` in events, "Likely cause" in
   * warnings). Wraps `setTimeout`, `setInterval`, `requestAnimationFrame`,
   * `requestIdleCallback`, `addEventListener`, the `ResizeObserver`,
   * `MutationObserver` and `IntersectionObserver` classes, their
   * clear/remove/disconnect counterparts, and RxJS's `subscribe`, and
   * records what tracked instances start. Default `true`. When `false`, the
   * wrappers only call through and no causes are reported.
   */
  trackCauses: boolean;
};
