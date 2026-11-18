// Wraps the APIs that start and end resources, and records (causes.ts) those
// started by a known owner (ownership.ts):
// - setTimeout/setInterval/clearTimeout/clearInterval,
//   requestAnimationFrame/cancelAnimationFrame,
//   requestIdleCallback/cancelIdleCallback (global object);
// - addEventListener/removeEventListener (EventTarget.prototype);
// - ResizeObserver, MutationObserver, IntersectionObserver: the classes, and
//   observe/unobserve/disconnect;
// - subscribe on RxJS's Observable.prototype, reached through Angular's
//   EventEmitter so that no RxJS import is needed.
//
// Wrappers call the original (zone.js's patched version, if present) with the
// same arguments and return its result. Timer and subscription callbacks are
// wrapped (to track firing, loops, and callback ownership). Listeners are not
// wrapped, so `removeEventListener` keeps matching; `once` listeners get a
// companion listener instead (see `addListenerWrapper`).
//
// Installed by the provider (before the first component is created, so
// constructors are covered) or when the detector starts; never at module load,
// so production builds that don't use the detector can drop this module.
// With `trackCauses` off, wrappers only call through.

import { EventEmitter } from "@angular/core";
import {
  begin,
  beginListener,
  beginObserving,
  disconnected,
  end,
  endListener,
  endObserving,
  fired,
  frames,
  sameObserver,
  idles,
  isListening,
  resetCauses,
  sourceName,
  timers,
} from "./causes.js";
import { _config } from "./config.js";
import { attribute, type Context, resetOwnership, runAs, runFor, startProfiler, stopProfiler } from "./ownership.js";
import type { ListenerResource, Owner, ResourceKind, SubscriptionResource, TimerResource } from "./types.js";
import { outsideAngular } from "./zone.js";

type Patch = { on: object; key: string; original: Function; wrapper: Function };
let patches: Patch[] = [];

/** Replaces `on[key]` with `make(original)`, if it is a function. */
function patch(on: object | undefined | null, key: string, make: (original: Function) => Function): void {
  if (!on) return;
  const original: unknown = (on as Record<string, unknown>)[key];
  if (typeof original !== "function") return;
  const wrapper = make(original);
  try {
    (on as Record<string, unknown>)[key] = wrapper;
  } catch {
    return;
  }
  if ((on as Record<string, unknown>)[key] === wrapper) patches.push({ on, key, original, wrapper });
}

const enabled = () => _config.trackCauses;

// ---------------------------------------------------------------------------
// Timers and animation frames.

function timerWrapper(kind: ResourceKind & TimerResource["kind"], ids: Map<unknown, TimerResource>) {
  return (original: Function) =>
    function (this: unknown, handler: unknown, delay?: unknown, ...rest: unknown[]): unknown {
      // A string handler is code to eval, with no owner.
      if (!enabled() || typeof handler !== "function") return original.apply(this, arguments);
      const context = attribute(kind, handler);
      if (!context) return original.apply(this, arguments);
      const resource: TimerResource = {
        kind,
        owner: context.owner,
        startedIn: context.startedIn,
        // For idle callbacks the second argument is an options object.
        delay: kind === "interval" || kind === "timeout" ? Math.max(0, Number(delay) || 0) : 0,
        loop: context.loop,
      };
      const running = { owner: context.owner, startedIn: context.startedIn, kind, fn: handler };
      let id: unknown;
      const callback = function (this: unknown, ...args: unknown[]): unknown {
        if (kind !== "interval") {
          ids.delete(id);
          end(resource);
        }
        running.owner = resource.owner;
        return runAs(running, () => handler.apply(this, args));
      };
      id = kind === "animationFrame" ? original.call(this, callback) : original.call(this, callback, delay, ...rest);
      ids.set(id, resource);
      begin(resource);
      return id;
    };
}

function clearWrapper(ids: Map<unknown, TimerResource>) {
  return (original: Function) =>
    function (this: unknown, id: unknown): unknown {
      const resource = ids.get(id);
      if (resource) {
        ids.delete(id);
        end(resource);
      }
      return original.apply(this, arguments);
    };
}

// ---------------------------------------------------------------------------
// Event listeners.

/** Name of Angular's template/host listener function (16 to 22), in unminified builds. */
const ANGULAR_LISTENER = "wrapListenerIn_markDirtyAndPreventDefault";
/**
 * String literal in the source of the function Angular's DOM renderer wraps
 * template listeners in (16 to 22). Survives minification; Angular's
 * `DebugNode` detects renderer listeners the same way.
 */
const ANGULAR_RENDERER_LISTENER = "__ngUnwrap__";

/**
 * Whether Angular added this listener for a template event or `@HostListener`.
 * Angular removes these itself, and there is one per event binding, so they
 * are skipped.
 */
function isAngularListener(listener: unknown): boolean {
  if (typeof listener !== "function") return false;
  if (listener.name === ANGULAR_LISTENER) return true;
  try {
    return Function.prototype.toString.call(listener).includes(ANGULAR_RENDERER_LISTENER);
  } catch {
    return false;
  }
}

type ListenerOptions = { capture?: unknown; once?: unknown; signal?: unknown } | boolean | undefined | null;

const isSignal = (value: unknown): value is AbortSignal =>
  typeof AbortSignal === "function" && value instanceof AbortSignal;

const captureOf = (options: ListenerOptions) =>
  typeof options === "object" && options !== null ? Boolean(options.capture) : Boolean(options);

/**
 * Re-entrancy guard: a wrapped method called from another wrapper (e.g. a
 * global object's own `addEventListener` calling EventTarget's) records nothing.
 */
let inListenerCall = false;

function callThrough(original: Function, self: unknown, args: ArrayLike<unknown>): unknown {
  if (inListenerCall) return original.apply(self, args);
  inListenerCall = true;
  try {
    return original.apply(self, args);
  } finally {
    inListenerCall = false;
  }
}

const isListener = (value: unknown): value is object =>
  typeof value === "function" || (typeof value === "object" && value !== null);

function addListenerWrapper(original: Function) {
  return function (this: EventTarget, type: unknown, listener: unknown, options?: ListenerOptions): unknown {
    if (inListenerCall) return original.apply(this, arguments);
    const args = arguments;
    const add = () => callThrough(original, this, args);
    if (!enabled() || !isListener(listener)) return add();
    // Angular removes these with the view.
    if (isAngularListener(listener)) return add();
    const opts = typeof options === "object" && options !== null ? options : null;
    const signal = isSignal(opts?.signal) ? opts.signal : null;
    if (signal?.aborted) return add();
    const target = this ?? globalThis;
    const eventType = String(type);
    const capture = captureOf(options);
    const record = (context: Context): ListenerResource => ({
      kind: "eventListener",
      owner: context.owner,
      startedIn: context.startedIn,
      target: new WeakRef(target),
      type: eventType,
      capture,
      signal: signal ? new WeakRef(signal) : null,
      companion: null,
      fired: false,
    });
    if (!opts?.once) {
      const result = add();
      const context = attribute("eventListener", null);
      if (context) beginListener(listener, record(context), target);
      return result;
    }
    // `once` listeners are removed by the browser when they fire. To detect
    // that without wrapping the app's listener, add a companion `once`
    // listener just before it (same target, type and phase, so it fires just
    // before it). It is passive, registered outside Angular's zone, and
    // shares the app's signal.
    const context = attribute("eventListener", null);
    if (!context || isListening(listener, target, eventType, capture)) return add();
    const resource = record(context);
    const companion = (resource.companion = () => fired(resource));
    const companionOptions = { capture, once: true, passive: true, ...(signal ? { signal } : {}) };
    outsideAngular(() => callThrough(original, target, [eventType, companion, companionOptions]));
    const result = add();
    beginListener(listener, resource, target);
    return result;
  };
}

function removeListenerWrapper(original: Function) {
  return function (this: EventTarget, type: unknown, listener: unknown, options?: ListenerOptions): unknown {
    if (inListenerCall) return original.apply(this, arguments);
    if (isListener(listener)) {
      const target = this ?? globalThis;
      const capture = captureOf(options);
      const ended = endListener(listener, target, String(type), capture);
      // A `once` listener removed before firing: remove its companion too.
      if (ended?.companion) callThrough(original, target, [String(type), ended.companion, capture]);
    }
    return callThrough(original, this, arguments);
  };
}

// ---------------------------------------------------------------------------
// Observers.

/** Observer classes that are wrapped. */
const OBSERVERS = ["ResizeObserver", "MutationObserver", "IntersectionObserver"] as const;

/** Property on a wrapped observer callback that references its observer. */
const OBSERVER = Symbol("ngLeakDetectorObserver");

/**
 * Wraps an observer class so that each instance's callback references the
 * instance. Needed for zone.js, whose observer wraps a native one: the
 * browser keeps the native observer alive while it observes, but nothing
 * keeps zone.js's object, which our record references weakly. The callback
 * also receives the native object; we register it as an alias
 * (`sameObserver`) so `disconnect()` on it is seen. Prototype, name,
 * `instanceof` and subclassing are preserved.
 */
function observerConstructor(observerType: string) {
  return (original: Function) => {
    const Observer = function (this: unknown, callback: unknown): unknown {
      if (!new.target) return Reflect.apply(original, this, arguments);
      const args: unknown[] = Array.from(arguments);
      if (typeof callback !== "function") return Reflect.construct(original, args, new.target);
      let observer: object | undefined;
      const own = function (this: unknown, records: unknown, given: unknown): unknown {
        if (observer && typeof given === "object" && given !== null && given !== observer) {
          sameObserver(given, observer);
          patchObserverPrototype(Object.getPrototypeOf(given), observerType);
        }
        return callback.apply(this, arguments);
      };
      args[0] = own;
      observer = Reflect.construct(original, args, new.target) as object;
      Object.defineProperty(own, OBSERVER, { value: observer });
      return observer;
    };
    Observer.prototype = original.prototype;
    Object.defineProperty(Observer, "name", { value: original.name });
    Object.defineProperty(Observer, "length", { value: original.length });
    Object.setPrototypeOf(Observer, original);
    return Observer;
  };
}

/** Observer prototypes already wrapped. */
let patchedPrototypes = new WeakSet<object>();

function patchObserverPrototype(prototype: object | null | undefined, observerType: string): void {
  if (!prototype || patchedPrototypes.has(prototype)) return;
  patchedPrototypes.add(prototype);
  patch(prototype, "observe", observeWrapper(observerType));
  patch(prototype, "unobserve", unobserveWrapper);
  patch(prototype, "disconnect", disconnectWrapper);
}

/**
 * Re-entrancy guard: zone.js's observer methods forward to the native ones,
 * which are wrapped too and must not record again.
 */
let inObserverCall = false;

function observerCall(original: Function, self: unknown, args: IArguments, record: () => void): unknown {
  if (inObserverCall) return original.apply(self, args);
  inObserverCall = true;
  try {
    record();
    return original.apply(self, args);
  } finally {
    inObserverCall = false;
  }
}

/** `observe(target)`: attributed to the owner at the first `observe` call. */
function observeWrapper(observerType: string) {
  return (original: Function) =>
    function (this: object, target: unknown): unknown {
      if (inObserverCall) return original.apply(this, arguments);
      const result = observerCall(original, this, arguments, () => {});
      if (!enabled() || typeof target !== "object" || target === null) return result;
      beginObserving(this, target, () => {
        const context = attribute("observer", null);
        return (
          context && {
            kind: "observer",
            owner: context.owner,
            startedIn: context.startedIn,
            observerType,
            observer: new WeakRef(this),
            targets: [],
            disconnected: false,
          }
        );
      });
      return result;
    };
}

function unobserveWrapper(original: Function) {
  return function (this: object, target: unknown): unknown {
    return observerCall(original, this, arguments, () => {
      if (typeof target === "object" && target !== null) endObserving(this, target);
    });
  };
}

function disconnectWrapper(original: Function) {
  return function (this: object): unknown {
    return observerCall(original, this, arguments, () => disconnected(this));
  };
}

// ---------------------------------------------------------------------------
// RxJS subscriptions.

/**
 * `Observable.prototype` of the RxJS copy Angular uses: the first prototype
 * above `EventEmitter.prototype` that has its own `pipe`.
 */
function observablePrototype(): object | null {
  let proto: object | null = EventEmitter.prototype;
  for (let i = 0; proto && i < 8; i++, proto = Object.getPrototypeOf(proto)) {
    if (Object.prototype.hasOwnProperty.call(proto, "pipe") && Object.prototype.hasOwnProperty.call(proto, "subscribe")) {
      return proto;
    }
  }
  return null;
}

/** Follows `source` links through operators to the originating observable. */
function rootSource(observable: object): object {
  let current = observable;
  for (let i = 0; i < 32; i++) {
    const source: unknown = (current as { source?: unknown }).source;
    if (typeof source !== "object" || source === null || typeof (source as { subscribe?: unknown }).subscribe !== "function") {
      break;
    }
    current = source;
  }
  return current;
}

/**
 * Whether `observer` is an RxJS Subscriber. RxJS passes Subscribers for its
 * internal subscriptions (operators, `share`, `takeUntil` notifiers); apps
 * pass functions or observer objects (a Subject has no `add`). Only the
 * app's subscription is recorded; internal ones end with it.
 */
function isSubscriber(observer: unknown): boolean {
  if (typeof observer !== "object" || observer === null) return false;
  const s = observer as { next?: unknown; add?: unknown; unsubscribe?: unknown };
  return typeof s.next === "function" && typeof s.add === "function" && typeof s.unsubscribe === "function";
}

/**
 * Wraps the observer's callbacks to run as `owner` (`runFor`). Observer
 * objects keep their `this`, and no callback is added that wasn't there
 * (a missing `error` handler changes RxJS's error reporting).
 */
function ownObserver(observer: unknown, owner: () => Owner): unknown {
  const wrap = (callback: Function, self: unknown) =>
    function (this: unknown, ...args: unknown[]): unknown {
      return runFor(owner(), () => callback.apply(self === undefined ? this : self, args));
    };
  if (typeof observer === "function") return wrap(observer, undefined);
  if (typeof observer !== "object" || observer === null) return observer;
  const callbacks = observer as Record<string, unknown>;
  const own: Record<string, unknown> = {};
  for (const key of ["next", "error", "complete"]) {
    const callback = callbacks[key];
    if (typeof callback === "function") own[key] = wrap(callback, observer);
  }
  return own;
}

/**
 * Set while Angular subscribes to an `EventEmitter` for an output binding or
 * an `async` pipe; Angular ends these itself, so they are skipped. Detected
 * in `EventEmitter.subscribe`, before it wraps the observer: by the
 * listener's name (development builds) or the `async` pipe's `next`.
 */
let angularOutput = false;

function outputSubscribeWrapper(original: Function) {
  return function (this: object, observer?: unknown): unknown {
    const angular =
      (typeof observer === "function" && observer.name === ANGULAR_LISTENER) || isAsyncPipeObserver(observer);
    if (angularOutput || !angular) return original.apply(this, arguments);
    angularOutput = true;
    try {
      return original.apply(this, arguments);
    } finally {
      angularOutput = false;
    }
  };
}

/**
 * Whether `observer` is the `async` pipe's: its `next` calls
 * `_updateLatestValue` (16 to 22; property names survive minification).
 * The pipe unsubscribes itself, so these are skipped.
 */
function isAsyncPipeObserver(observer: unknown): boolean {
  if (typeof observer !== "object" || observer === null) return false;
  const next = (observer as { next?: unknown }).next;
  if (typeof next !== "function") return false;
  try {
    return Function.prototype.toString.call(next).includes("_updateLatestValue");
  } catch {
    return false;
  }
}

function subscribeWrapper(original: Function) {
  return function (this: object, observer?: unknown): unknown {
    // Hot path: also called for every internal operator subscription.
    if (!enabled() || angularOutput || isSubscriber(observer) || isAsyncPipeObserver(observer)) {
      return arguments.length <= 1 ? original.call(this, observer) : original.apply(this, arguments);
    }
    const context = attribute("subscription", null);
    if (!context) return arguments.length <= 1 ? original.call(this, observer) : original.apply(this, arguments);
    let resource: SubscriptionResource | null = null;
    // Read from the record once created: `adopt` may reassign its owner.
    const owner = () => resource?.owner ?? context.owner;
    // `subscribe(observer)`, or the deprecated `subscribe(next, error, complete)`.
    const subscription: unknown =
      arguments.length <= 1
        ? original.call(this, ownObserver(observer, owner))
        : original.apply(
            this,
            Array.from(arguments, (arg) => (typeof arg === "function" || arg === observer ? ownObserver(arg, owner) : arg)),
          );
    // Already closed (e.g. `of(1)`): nothing to record.
    if (typeof subscription === "object" && subscription !== null && (subscription as { closed?: unknown }).closed === false) {
      resource = {
        kind: "subscription",
        owner: context.owner,
        startedIn: context.startedIn,
        subscription: new WeakRef(subscription),
        source: sourceName(rootSource(this).constructor?.name),
      };
      begin(resource);
    }
    return subscription;
  };
}

// ---------------------------------------------------------------------------

let started = false;

/** Installs the wrappers if `trackCauses`. Idempotent. Browser only. */
export function startCauses(trackCauses: boolean = _config.trackCauses): void {
  if (!trackCauses) return;
  if (typeof window === "undefined" || typeof document === "undefined" || typeof WeakRef !== "function") return;
  // Retried on each call: the profiler may not be published yet when the
  // provider calls this.
  startProfiler();
  if (started) return;
  started = true;
  const global = globalThis as unknown as Record<string, unknown>;
  patch(global, "setTimeout", timerWrapper("timeout", timers));
  patch(global, "setInterval", timerWrapper("interval", timers));
  // Intervals and timeouts share ids; either clear function clears either.
  patch(global, "clearTimeout", clearWrapper(timers));
  patch(global, "clearInterval", clearWrapper(timers));
  patch(global, "requestAnimationFrame", timerWrapper("animationFrame", frames));
  patch(global, "cancelAnimationFrame", clearWrapper(frames));
  patch(global, "requestIdleCallback", timerWrapper("idleCallback", idles));
  patch(global, "cancelIdleCallback", clearWrapper(idles));
  for (const observerType of OBSERVERS) {
    patch(global, observerType, observerConstructor(observerType));
    const observer = global[observerType];
    patchObserverPrototype(typeof observer === "function" ? (observer.prototype as object) : null, observerType);
  }
  if (typeof EventTarget === "function") {
    patch(EventTarget.prototype, "addEventListener", addListenerWrapper);
    patch(EventTarget.prototype, "removeEventListener", removeListenerWrapper);
  }
  // Some environments (e.g. jsdom under vitest) define these on the global
  // object itself rather than inheriting them from EventTarget.
  for (const [key, wrapper] of [
    ["addEventListener", addListenerWrapper],
    ["removeEventListener", removeListenerWrapper],
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(global, key)) patch(global, key, wrapper);
  }
  patch(observablePrototype(), "subscribe", subscribeWrapper);
  patch(EventEmitter.prototype, "subscribe", outputSubscribeWrapper);
}

/**
 * Restores the originals (where not re-wrapped since) and clears all state.
 * For tests; the detector itself never stops.
 */
export function stopCauses(): void {
  for (const { on, key, original, wrapper } of patches.reverse()) {
    const record = on as Record<string, unknown>;
    if (record[key] === wrapper) record[key] = original;
  }
  patches = [];
  started = false;
  inListenerCall = false;
  inObserverCall = false;
  angularOutput = false;
  patchedPrototypes = new WeakSet();
  stopProfiler();
  resetOwnership();
  resetCauses();
}
