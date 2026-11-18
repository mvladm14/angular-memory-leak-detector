// Leak causes: the resources (timers, animation frames, idle callbacks, event
// listeners, observers, RxJS subscriptions) an instance started and that are
// still active after it was destroyed. instrument.ts records them, for the
// owner ownership.ts resolves; sweep.ts asks `collect` for a leaked
// instance's.
//
// A resource is active:
// - interval: until cleared;
// - timeout, animation frame, idle callback: until it fires or is cancelled;
// - event listener: until removed, its signal aborted, or (`once`) fired.
//   Counted only if its target is not a node detached from the document;
// - observer: until disconnected. Counted only while it observes a node in
//   the document;
// - subscription: until closed.
//
// Causes of directives and services that leaked with a component are
// reported with the component, attributed to them (`by`).

import { classNamesMinified } from "./names.js";
import { ownerOf } from "./ownership.js";
import type {
  InstanceKind,
  LeakCause,
  LeakCauseKind,
  ListenerResource,
  ObserverResource,
  Owner,
  Resource,
  TimerResource,
} from "./types.js";

/** Active timers (intervals and timeouts share ids), animation frames and idle callbacks, by id. */
export const timers = new Map<unknown, TimerResource>();
export const frames = new Map<unknown, TimerResource>();
export const idles = new Map<unknown, TimerResource>();
/** Observer records, by observer. */
let observers = new WeakMap<object, ObserverResource>();
/**
 * Maps an alternate object for an observer to the one the app created. With
 * zone.js, the app's observer wraps a native one, which is what the callback
 * receives.
 */
let aliases = new WeakMap<object, object>();

const canonical = (observer: object) => aliases.get(observer) ?? observer;

/** Records `alias` as another object for `observer`. */
export function sameObserver(alias: object, observer: object): void {
  if (alias !== observer) aliases.set(alias, canonical(observer));
}
/** Listener records, by listener, to match `removeEventListener` calls. */
let listeners = new WeakMap<object, ListenerResource[]>();

/** Minimum number of resources an owner must have before they are pruned. */
const PRUNE_MIN = 32;

/** Records a started resource on its owner. */
export function begin(resource: Resource): void {
  const { owner } = resource;
  owner.resources.add(resource);
  // Subscriptions and some listeners end without notifying us: prune them
  // as the set grows, so a long-lived owner doesn't accumulate records.
  if (owner.resources.size >= Math.max(PRUNE_MIN, owner.pruned * 2)) prune(owner);
}

/** Removes an ended resource from its owner. */
export function end(resource: Resource): void {
  resource.owner.resources.delete(resource);
}

function prune(owner: Owner): void {
  owner.resources.forEach((resource) => {
    if (hasEnded(resource)) end(resource);
  });
  owner.pruned = owner.resources.size;
}

/** The listener's records, without those that ended unnoticed (signal aborted, target collected). */
function addedWith(listener: object): ListenerResource[] | undefined {
  const added = listeners.get(listener)?.filter((r) => !hasEnded(r));
  if (added?.length) listeners.set(listener, added);
  else listeners.delete(listener);
  return added?.length ? added : undefined;
}

/** Records a listener, unless an identical one is recorded (a duplicate `addEventListener` is a no-op). */
export function beginListener(listener: object, resource: ListenerResource, target: EventTarget): void {
  const added = addedWith(listener);
  if (added?.some((r) => sameListener(r, target, resource.type, resource.capture))) return;
  if (added) added.push(resource);
  else listeners.set(listener, [resource]);
  begin(resource);
}

/** Whether an identical listener is already recorded. */
export function isListening(listener: object, target: EventTarget, type: string, capture: boolean): boolean {
  return addedWith(listener)?.some((r) => sameListener(r, target, type, capture)) ?? false;
}

/** Ends the record matching a `removeEventListener` call, and returns it. */
export function endListener(
  listener: object,
  target: EventTarget,
  type: string,
  capture: boolean,
): ListenerResource | null {
  const added = addedWith(listener);
  const at = added?.findIndex((r) => sameListener(r, target, type, capture)) ?? -1;
  if (at < 0) return null;
  const resource = added![at]!;
  end(resource);
  added!.splice(at, 1);
  if (added!.length === 0) listeners.delete(listener);
  return resource;
}

/** A `once` listener fired, so the browser removed it. */
export function fired(resource: ListenerResource): void {
  resource.fired = true;
  end(resource);
}

/** `observe(target)`: adds the target, creating the record with `start` if there is none. */
export function beginObserving(seen: object, target: object, start: () => ObserverResource | null): void {
  const observer = canonical(seen);
  let resource = observers.get(observer);
  if (!resource || hasEnded(resource)) {
    const started = start();
    if (!started) return;
    observers.set(observer, (resource = started));
    begin(resource);
  }
  if (!resource.targets.some((t) => t.deref() === target)) resource.targets.push(new WeakRef(target));
}

/** `observer.unobserve(target)`. */
export function endObserving(observer: object, target: object): void {
  const resource = observers.get(canonical(observer));
  if (resource) resource.targets = resource.targets.filter((t) => t.deref() !== target && t.deref() !== undefined);
}

/** `disconnect()`: ends the record. A later `observe` creates a new one. */
export function disconnected(seen: object): void {
  const observer = canonical(seen);
  const resource = observers.get(observer);
  if (!resource) return;
  resource.disconnected = true;
  observers.delete(observer);
  end(resource);
}

function sameListener(r: ListenerResource, target: EventTarget, type: string, capture: boolean): boolean {
  return r.type === type && r.capture === capture && r.target.deref() === target;
}

/**
 * Whether `resource` ended without our wrappers seeing it. Timers, frames and
 * idle callbacks are removed when they end, so they never qualify.
 */
function hasEnded(resource: Resource): boolean {
  switch (resource.kind) {
    case "interval":
    case "timeout":
    case "animationFrame":
    case "idleCallback":
      return false;
    case "eventListener":
      return resource.fired || !resource.target.deref() || resource.signal?.deref()?.aborted === true;
    case "observer":
      return resource.disconnected || !resource.observer.deref();
    case "subscription":
      return resource.subscription.deref()?.closed !== false;
  }
}

/**
 * Whether an active resource currently retains its callback. Listeners and
 * observers on detached nodes don't (they are collected with the node), but
 * are kept, as the node may be attached again.
 */
function holds(resource: Resource): boolean {
  if (resource.kind === "eventListener") return isHeld(resource.target.deref());
  if (resource.kind === "observer") return heldTargets(resource).length > 0;
  return true;
}

/** A target still in memory, and not a node out of the document. */
function isHeld(target: object | undefined): target is object {
  return target !== undefined && !(typeof Node === "function" && target instanceof Node && !target.isConnected);
}

/** The observer's targets that are still alive and not detached nodes. */
function heldTargets(resource: ObserverResource): object[] {
  return resource.targets.map((t) => t.deref()).filter(isHeld);
}

// ---------------------------------------------------------------------------
// Descriptions.

/** `window`, `document`, `<button>`, `MediaQueryList`, … */
function targetName(target: object): string {
  if (typeof window !== "undefined" && target === window) return "window";
  if (typeof Document === "function" && target instanceof Document) return "document";
  if (typeof Element === "function" && target instanceof Element) return `<${target.localName}>`;
  const name = (target as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && name.length > 1 ? name : "an event target";
}

/**
 * RxJS and Angular observable classes with a numeric suffix, which bundlers
 * add on name clashes (e.g. `BehaviorSubject2` with Vite on Angular 17/18).
 */
const RENUMBERED = /^(Observable|Subject|BehaviorSubject|ReplaySubject|AsyncSubject|AnonymousSubject|ConnectableObservable|EventEmitter)\d+$/;

/**
 * The observable's class name for a description (`BehaviorSubject`,
 * `EventEmitter` for Angular's `EventEmitter_`), or `""` if minified.
 */
export function sourceName(className: unknown): string {
  if (typeof className !== "string" || className.length <= 1 || classNamesMinified()) return "";
  let name = sourceNames.get(className);
  if (name === undefined) {
    name = className
      .replace(/^_+(?=[A-Z])/, "")
      .replace(/_+$/, "")
      .replace(RENUMBERED, "$1");
    sourceNames.set(className, name);
  }
  return name;
}

/** Cache: few distinct classes, many subscriptions. */
const sourceNames = new Map<string, string>();

/** `LeakCause.description`: `setInterval every 1000 ms`, `"resize" listener on window`, … */
function describe(resource: Resource): string | null {
  switch (resource.kind) {
    case "interval":
      return `setInterval every ${resource.delay} ms`;
    case "timeout":
      return resource.loop ? `setTimeout loop (every ${resource.delay} ms)` : `setTimeout of ${resource.delay} ms`;
    case "animationFrame":
      return resource.loop ? "requestAnimationFrame loop" : "requestAnimationFrame";
    case "idleCallback":
      return resource.loop ? "requestIdleCallback loop" : "requestIdleCallback";
    case "eventListener": {
      const target = resource.target.deref();
      const once = resource.companion ? " (once)" : "";
      return target ? `"${resource.type}" listener${once} on ${targetName(target)}` : null;
    }
    case "observer": {
      const [first, ...more] = heldTargets(resource);
      if (!first) return null;
      return `${resource.observerType} observing ${targetName(first)}${more.length > 0 ? ` and ${more.length} more` : ""}`;
    }
    case "subscription":
      return resource.source ? `subscription to ${resource.source}` : "subscription";
  }
}

/** Verbs for the warning: `<started> … and <pending>`, e.g. `started … and never cleared`. */
type Verbs = readonly [started: string, pending: string];
const VERBS: Readonly<Record<LeakCauseKind, Verbs>> = {
  interval: ["started", "never cleared"],
  timeout: ["set", "still pending"],
  animationFrame: ["requested", "still pending"],
  idleCallback: ["requested", "still pending"],
  eventListener: ["added", "never removed"],
  observer: ["started", "never disconnected"],
  subscription: ["opened", "never unsubscribed"],
};
const LOOP_VERBS: Verbs = ["started", "never stopped"];
const ONCE_VERBS: Verbs = ["added", "never fired nor removed"];

/** Sort order of cause kinds: browser-held resources first, subscriptions last. */
const LIKELIHOOD: readonly LeakCauseKind[] = [
  "interval",
  "animationFrame",
  "idleCallback",
  "timeout",
  "observer",
  "eventListener",
  "subscription",
];

/** A cause, with the verbs for its wording (loop, `once` listener, or by kind). */
export type Found = { cause: LeakCause; verbs: Verbs };

/** Causes being aggregated by `collect`, by identity key. */
export type Causes = Map<string, Found>;

/** Adds the active resources of `instance` to `causes`, attributed to `by`. */
export function collect(causes: Causes, instance: object, by: string, byKind: InstanceKind): void {
  const owner = ownerOf(instance);
  if (!owner) return;
  owner.resources.forEach((resource) => {
    if (hasEnded(resource)) {
      end(resource);
      return;
    }
    if (!holds(resource)) return;
    const description = describe(resource);
    if (description === null) return;
    const loop = "loop" in resource && resource.loop;
    const once = resource.kind === "eventListener" && resource.companion !== null;
    const key = `${resource.kind}\n${description}\n${resource.startedIn}\n${byKind}\n${by}\n${loop}`;
    const found = causes.get(key);
    if (found) found.cause.count += 1;
    else {
      const { kind, startedIn } = resource;
      const verbs = loop ? LOOP_VERBS : once ? ONCE_VERBS : VERBS[kind];
      causes.set(key, { cause: { kind, description, startedIn, by, byKind, count: 1 }, verbs });
    }
  });
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Sorts causes: `name`'s own first, then by kind, count, `by`, description. */
export function sortedCauses(causes: Causes, name: string): Found[] {
  return [...causes.values()].sort(
    ({ cause: a }, { cause: b }) =>
      Number(a.by !== name) - Number(b.by !== name) ||
      LIKELIHOOD.indexOf(a.kind) - LIKELIHOOD.indexOf(b.kind) ||
      b.count - a.count ||
      byCodePoint(a.by, b.by) ||
      byCodePoint(a.description, b.description) ||
      byCodePoint(a.startedIn ?? "", b.startedIn ?? ""),
  );
}

/** `startedIn` as a phrase for the warning. */
function where(startedIn: string | null): string {
  switch (startedIn) {
    case null:
      return "";
    case "constructor":
      return " in its constructor";
    case "template":
      return " in its template";
    case "event handler":
      return " in an event handler";
    case "lifecycle hook":
      return " in a lifecycle hook";
    case "subscription callback":
      return " in a subscription's callback";
    default:
      return ` in ${startedIn}`;
  }
}

/**
 * One cause in the warning, e.g. `"scroll" listener on window ×2, added by
 * ScrollSpyDirective in ngOnInit and never removed`. `by` is omitted when it
 * is the leaked class `name`.
 */
function phrase({ cause, verbs }: Found, name: string): string {
  const [started, pending] = verbs;
  const count = cause.count > 1 ? ` ×${cause.count}` : "";
  const by = cause.by !== name ? ` by ${cause.by}` : "";
  const at = where(cause.startedIn);
  if (by === "" && at === "") return `${cause.description}${count}, ${pending}`;
  return `${cause.description}${count}, ${started}${by}${at} and ${pending}`;
}

/** Maximum number of causes listed in a warning; the rest are counted. */
const LISTED = 4;

/** The warning's ` Likely cause(s): …` sentence, or `""` if there are none. */
export function causesSentence(causes: readonly Found[], name: string): string {
  if (causes.length === 0) return "";
  const phrases = causes.slice(0, LISTED).map((cause) => phrase(cause, name));
  const more = causes.length > LISTED ? `; and ${causes.length - LISTED} more` : "";
  return ` Likely cause${causes.length > 1 ? "s" : ""}: ${phrases.join("; ")}${more}.`;
}

/** Clears all records. */
export function resetCauses(): void {
  timers.clear();
  frames.clear();
  idles.clear();
  listeners = new WeakMap();
  observers = new WeakMap();
  aliases = new WeakMap();
}
