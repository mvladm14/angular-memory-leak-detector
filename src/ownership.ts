// Resolves the owner of a resource being started: the component, directive
// or service whose code is running. Sources, most specific first:
//
// 1. Constructors (all builds). `assertInInjectionContext` tells whether an
//    injection context is active; if so, `inject(Injector)` returns the
//    node's NodeInjector. The slot being constructed is the one whose
//    NodeInjectorFactory has `resolving` set. Its instance is read once the
//    constructor returns (`settle`). A non-node injection context (e.g. a
//    root service created from a constructor) has no owner.
// 2. Angular's profiler (development builds, `ng.ɵsetProfiler`): reports
//    which instance's template, lifecycle hook or event handler is running.
//    Angular 20+ accepts several profilers; 16 to 19 accept one, which we
//    share with any profiler set later (e.g. Angular DevTools).
// 3. Subscription callbacks (all builds): a callback of an owner's
//    subscription runs as that owner (`runFor`), nested in the frame stack.
// 4. Loops (all builds): a timer or frame callback that schedules the same
//    function (or one with the same source) again keeps the owner. Nothing
//    else a timer callback starts is attributed: it may run change
//    detection for the whole app.
//
// Anything else has no owner and is never reported as a cause.
//
// Cost: `assertInInjectionContext` throws outside an injection context. So
// it is only called where a constructor can run: with Angular 19.2+ in development,
// inside a template-creation or dynamic-component frame; without the
// profiler (production) or before 19.2, always. Consequence: on 19.2+, a
// service created lazily from a hook or handler is attributed to that
// hook's instance.
//
// Owners never reference their instance: they are looked up in a WeakMap
// keyed by it. A view under construction is referenced only until the end
// of the current job.

import { assertInInjectionContext, inject, Injector, VERSION } from "@angular/core";
import { placeFromInjector, type Place } from "./discovery.js";
import type { Owner, ResourceKind } from "./types.js";
import { outsideAngular } from "./zone.js";

/** The owner of a resource being started, and `LeakCause.startedIn`. */
export type Context = { owner: Owner; startedIn: string | null; loop: boolean };

/** The timer or frame callback currently running, for loop detection. */
export type Running = { owner: Owner; startedIn: string | null; kind: ResourceKind; fn: Function };

/** `LeakCause.startedIn` values set here. */
export const CONSTRUCTOR = "constructor";
export const SUBSCRIPTION_CALLBACK = "subscription callback";
const TEMPLATE = "template";
const EVENT_HANDLER = "event handler";
const LIFECYCLE_HOOK = "lifecycle hook";

let owners = new WeakMap<object, Owner>();

export function newOwner(): Owner {
  return { resources: new Set(), pruned: 0 };
}

/** The owner of `instance`, created if needed. */
function ownerFor(instance: object): Owner {
  settle();
  let owner = owners.get(instance);
  if (!owner) owners.set(instance, (owner = newOwner()));
  return owner;
}

/** The owner of `instance`, if it started anything. */
export function ownerOf(instance: object): Owner | undefined {
  settle();
  return owners.get(instance);
}

// ---------------------------------------------------------------------------
// 1. Construction.

/** Angular's NodeInjectorFactory, held by a slot until its instance is created. */
type NodeInjectorFactory = { factory: unknown; resolving: unknown };

function isFactory(value: unknown): value is NodeInjectorFactory {
  return (
    typeof value === "object" &&
    value !== null &&
    "resolving" in value &&
    typeof (value as NodeInjectorFactory).factory === "function"
  );
}

/** Mask for the first provider index in `tNode.providerIndexes` (as in discovery.ts). */
const PROVIDERS_START_MASK = 0xfffff;

/**
 * The node's slot whose factory is `resolving`, or -1. If a directive's
 * constructor injects a service of the same node, both are resolving and the
 * service is the one running, so provider slots take precedence.
 */
function resolvingSlot({ tNode, lView }: Place): number {
  const start = tNode.providerIndexes & PROVIDERS_START_MASK;
  let directive = -1;
  for (let i = Math.max(start, 0); i < tNode.directiveEnd; i++) {
    const value = lView[i];
    if (!isFactory(value) || value.resolving !== true) continue;
    if (i < tNode.directiveStart) return i;
    if (directive < 0) directive = i;
  }
  return directive;
}

/**
 * Owners of instances under construction, by view and slot, until `settle`
 * re-keys them by instance. Settled no later than the next microtask.
 */
type Pending = { view: unknown[]; index: number; owner: Owner };
let pending: Pending[] = [];
let settling = false;

function pendingOwner(lView: unknown[], index: number): Owner {
  for (const p of pending) {
    if (p.index === index && p.view === lView) return p.owner;
  }
  const owner = newOwner();
  pending.push({ view: lView, index, owner });
  if (!settling) {
    settling = true;
    outsideAngular(() => queueMicrotask(settleLater));
  }
  return owner;
}

function settleLater(): void {
  settling = false;
  settle();
  // Constructors are synchronous: nothing is still under construction here.
  pending.length = 0;
}

/** Re-keys the owners of finished constructions by their instance. */
export function settle(): void {
  if (pending.length === 0) return;
  let kept = 0;
  for (const p of pending) {
    const value = p.view[p.index];
    // Still resolving: keep. Not resolving but not created: the constructor threw.
    if (isFactory(value)) {
      if (value.resolving === true) pending[kept++] = p;
      continue;
    }
    if (typeof value === "object" && value !== null) adopt(value, p.owner);
  }
  pending.length = kept;
}

function adopt(instance: object, owner: Owner): void {
  const existing = owners.get(instance);
  if (!existing) {
    owners.set(instance, owner);
    return;
  }
  owner.resources.forEach((resource) => {
    resource.owner = existing;
    existing.resources.add(resource);
  });
  owner.resources.clear();
}

const probe = function ngLeakDetector() {};
type ErrorWithLimit = { stackTraceLimit?: number };

/** The current injection context's injector, or `undefined` if there is none. */
function injectionContext(): unknown {
  // Throws outside an injection context. A stack trace limit of 0 makes that
  // cheaper.
  const errors = Error as ErrorWithLimit;
  const limit = errors.stackTraceLimit;
  try {
    errors.stackTraceLimit = 0;
  } catch {
    // Not writable: the throw just costs more.
  }
  try {
    assertInInjectionContext(probe);
    return inject(Injector);
  } catch {
    return undefined;
  } finally {
    try {
      errors.stackTraceLimit = limit;
    } catch {
      // See above.
    }
  }
}

/**
 * The owner of the instance under construction. `undefined`: none found, try
 * other sources. `null`: a non-node injection context, so no owner.
 */
function constructing(): Owner | null | undefined {
  const injector = injectionContext();
  if (injector === undefined || injector === null) return undefined;
  const place = placeFromInjector(injector as { get(token: unknown): unknown });
  // Not a NodeInjector: an environment injector, e.g. creating a root service.
  if (!place) return "_lView" in (injector as object) ? undefined : null;
  const index = resolvingSlot(place);
  return index < 0 ? undefined : pendingOwner(place.lView, index);
}

// ---------------------------------------------------------------------------
// 2. Angular's profiler.

/** Angular's ProfilerEvent values (stable from 16 to 22); each `…End` is `…Start` + 1. */
const TEMPLATE_CREATE_START = 0;
const TEMPLATE_UPDATE_START = 2;
const LIFECYCLE_HOOK_START = 4;
const OUTPUT_START = 6;
const OUTPUT_END = 7;
/**
 * `createComponent` outside a template (root component, router pages,
 * dialogs), Angular 19.2+. The start event has no instance; the end may.
 */
const DYNAMIC_COMPONENT_START = 22;
const DYNAMIC_COMPONENT_END = 23;

/**
 * The frame stack, innermost last. Profiler frames store the instance;
 * subscription-callback frames (`runFor`) store the owner.
 */
const frameEvents: number[] = [];
const frameInstances: unknown[] = [];
const frameOwners: Array<Owner | null> = [];
/** `startedIn` per frame; lifecycle hooks store the hook function, named lazily by `originAt`. */
const frameOrigins: Array<string | Function> = [];
let depth = 0;
/** Frame type for subscription callbacks (not a ProfilerEvent). */
const CALLBACK = -1;

/** The hook's name. Angular 16 to 19 wrap `ngOnChanges` in a differently named function. */
function hookName(hook: Function): string {
  const name = hook.name;
  if (/^ng[A-Z]\w*$/.test(name)) return name;
  return /OnChanges/.test(name) ? "ngOnChanges" : LIFECYCLE_HOOK;
}

// Hot path: called for every template execution and lifecycle hook.
export function onProfilerEvent(event: number, instance?: unknown, hookOrListener?: unknown): void {
  if (event === DYNAMIC_COMPONENT_START) return enter(event, undefined, TEMPLATE);
  if (event === DYNAMIC_COMPONENT_END) return leave(DYNAMIC_COMPONENT_START, undefined);
  if (event > OUTPUT_END) return;
  if (event % 2 === 1) return leave(event - 1, instance);
  const origin =
    event === LIFECYCLE_HOOK_START
      ? typeof hookOrListener === "function"
        ? hookOrListener
        : LIFECYCLE_HOOK
      : event === OUTPUT_START
        ? EVENT_HANDLER
        : TEMPLATE;
  enter(event, instance, origin);
}

/** `startedIn` for the frame at `i`. */
function originAt(i: number): string {
  const origin = frameOrigins[i]!;
  return typeof origin === "string" ? origin : hookName(origin);
}

function enter(event: number, instance: unknown, origin: string | Function, owner: Owner | null = null): void {
  frameEvents[depth] = event;
  frameInstances[depth] = instance;
  frameOwners[depth] = owner;
  frameOrigins[depth] = origin;
  depth += 1;
}

/** Pops the frames from index `at` up. */
function popTo(at: number): void {
  for (let j = at; j < depth; j++) {
    frameInstances[j] = undefined;
    frameOwners[j] = null;
    frameOrigins[j] = TEMPLATE;
  }
  depth = at;
}

/** Pops the frame matching an end event; ignores an end without a matching start. */
function leave(start: number, instance: unknown): void {
  for (let i = depth - 1; i >= 0; i--) {
    if (frameEvents[i] !== start || (start !== DYNAMIC_COMPONENT_START && frameInstances[i] !== instance)) continue;
    popTo(i);
    return;
  }
}

type ProfilerCallback = (event: number, instance?: unknown, hookOrListener?: unknown) => void;
type NgProfilerApi = { ɵsetProfiler?: (profiler: ProfilerCallback | null) => unknown };

let stopProfiling: (() => void) | null = null;

/**
 * False until the job in which the profiler was installed has ended: it may
 * have been installed inside a frame whose start event it missed.
 */
let framesKnown = false;

/**
 * Installs our profiler callback once `ng.ɵsetProfiler` exists (published
 * when Angular creates its first component, in development). Retried when
 * the detector starts and on each attribution until then.
 */
export function startProfiler(): void {
  if (stopProfiling) return;
  const ng = (globalThis as { ng?: NgProfilerApi }).ng;
  const set = ng?.ɵsetProfiler;
  if (!ng || typeof set !== "function") return;
  // Angular 16 to 19: a profiler set after ours, which we forward to.
  let other: ProfilerCallback | null = null;
  const shared: ProfilerCallback = (event, instance, hookOrListener) => {
    onProfilerEvent(event, instance, hookOrListener);
    other?.(event, instance, hookOrListener);
  };
  let removal: unknown;
  try {
    removal = set(shared);
  } catch {
    return;
  }
  framesKnown = false;
  outsideAngular(() => Promise.resolve().then(() => (framesKnown = stopProfiling !== null)));
  // Angular 20+: `setProfiler` returns a removal function.
  if (typeof removal === "function") {
    stopProfiling = removal as () => void;
    return;
  }
  // Angular 16 to 19: single profiler slot. Intercept later calls so ours stays installed.
  const share = (profiler: ProfilerCallback | null) => {
    other = typeof profiler === "function" ? profiler : null;
  };
  ng.ɵsetProfiler = share;
  stopProfiling = () => {
    if (ng.ɵsetProfiler === share) ng.ɵsetProfiler = set;
    set(other);
  };
}

export function stopProfiler(): void {
  stopProfiling?.();
  stopProfiling = null;
  framesKnown = false;
}

/** Whether Angular emits `DynamicComponentStart` (19.2+). */
let reportsDynamicComponents: boolean | undefined;

/**
 * Whether a constructor may be running. On 19.2+, constructors only run
 * inside template-creation or dynamic-component frames. Without the
 * profiler, or before 19.2, we can't tell, so always true.
 */
function mayBeConstructing(): boolean {
  if (!stopProfiling || !framesKnown) return true;
  reportsDynamicComponents ??= (() => {
    const major = Number(VERSION.major);
    return major > 19 || (major === 19 && Number(VERSION.minor) >= 2);
  })();
  if (!reportsDynamicComponents) return true;
  if (depth === 0) return false;
  const event = frameEvents[depth - 1];
  return event === TEMPLATE_CREATE_START || event === DYNAMIC_COMPONENT_START;
}

// ---------------------------------------------------------------------------
// 3. Subscription callbacks.

/** Runs a subscription callback as `owner`. */
export function runFor<T>(owner: Owner, run: () => T): T {
  const at = depth;
  enter(CALLBACK, undefined, SUBSCRIPTION_CALLBACK, owner);
  try {
    return run();
  } finally {
    // Also drops frames left unbalanced by an exception.
    if (depth > at) popTo(at);
  }
}

// ---------------------------------------------------------------------------
// 4. Loops.

let running: Running | null = null;

/** Runs a timer or frame callback, recording it for loop detection. */
export function runAs<T>(callback: Running, run: () => T): T {
  const previous = running;
  running = callback;
  try {
    return run();
  } finally {
    running = previous;
  }
}

const sources = new WeakMap<Function, string>();

function sourceOf(fn: Function): string {
  let source = sources.get(fn);
  if (source === undefined) {
    try {
      source = Function.prototype.toString.call(fn);
    } catch {
      source = "";
    }
    sources.set(fn, source);
  }
  return source;
}

/** Same function, or same source text. Native and bound functions compare by identity only. */
function sameCode(a: Function, b: Function): boolean {
  if (a === b) return true;
  const source = sourceOf(a);
  return source !== "" && !source.includes("[native code]") && source === sourceOf(b);
}

// ---------------------------------------------------------------------------

/**
 * The owner of a resource of `kind` being started now (`fn`: the callback of
 * a timer or frame), or `null`. See the top of this file.
 */
export function attribute(kind: ResourceKind, fn: Function | null): Context | null {
  if (!stopProfiling) startProfiler();
  settle();
  const built = mayBeConstructing() ? constructing() : undefined;
  if (built === null) return null;
  if (built !== undefined) {
    // A callback of the same owner's subscription, run synchronously inside
    // its constructor (e.g. a BehaviorSubject's first value): report the callback.
    const callback = depth > 0 && frameOwners[depth - 1] === built;
    return { owner: built, startedIn: callback ? originAt(depth - 1) : CONSTRUCTOR, loop: false };
  }
  if (depth > 0) {
    const startedIn = originAt(depth - 1);
    const owner = frameOwners[depth - 1];
    if (owner) return { owner, startedIn, loop: false };
    const instance = frameInstances[depth - 1];
    if (typeof instance !== "object" || instance === null) return null;
    return { owner: ownerFor(instance), startedIn, loop: false };
  }
  if (running && fn && running.kind === kind && sameCode(running.fn, fn)) {
    return { owner: running.owner, startedIn: running.startedIn, loop: true };
  }
  return null;
}

/** Clears all state. */
export function resetOwnership(): void {
  owners = new WeakMap();
  pending = [];
  settling = false;
  popTo(0);
  running = null;
  reportsDynamicComponents = undefined;
}
