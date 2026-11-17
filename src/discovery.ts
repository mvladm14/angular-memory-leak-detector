// Finds component, directive and component-level service instances, and
// learns when Angular destroys them, with no build step: everything goes
// through Angular's dev-mode debugging API (`window.ng`, published only when
// `ngDevMode` is on), or in a production build, where there is none, through
// the same lookups made from what Angular keeps there (production.ts).
//
// - A MutationObserver sees every node Angular inserts into the document:
//   elements, and the comments Angular anchors `<ng-template>` and
//   `<ng-container>` with (structural directives such as `*ngIf` live there).
// - Components: `ng.getComponent(el)` says whether an element hosts one, and
//   `ng.getInjector(el).get(ChangeDetectorRef)` on its host returns the
//   ViewRef of the component's own view. Its `onDestroy` callback fires when
//   Angular destroys the view: that is the "destroyed" signal.
// - Directives: `ng.getDirectives(node)` lists the node's directive instances
//   (never its component).
// - Component-level services: what a component's or directive's `providers`
//   and `viewProviders` create lives in the node's injector, which no public
//   API lists. They are read from it, and which of them the node owns from
//   how the app declared them (see `providedServices`).
// - A node's directives and services live in the view the node is in, and are
//   destroyed with it. `ng.getInjector(node).get(DestroyRef)` is that view's
//   DestroyRef: its `onDestroy` is their "destroyed" signal.
// - On Angular 16 and 20, the directives of each `<router-outlet>` include the
//   outlet, whose deactivated pages the router keeps (router.ts).
//
// Cost: every node gets one `ng.*` lookup, the one that turns its view id
// into a context; most hold nothing, which that context says (`isBare`), and
// get no other. The nodes of a view share one DestroyRef lookup and one
// destroy hook (`groupOf`).
//
// The detector must never retain what it watches. Two things matter:
//
// 1. `ng.getComponent` / `ng.getDirectives` / `ng.getInjector` cache a context
//    object on the node (Angular normally stores only a numeric view id
//    there), and that cache holds the component and directive instances
//    strongly. A destroyed component whose detached host element is still
//    referenced (by a DOM leak, or by the browser itself for a while) would
//    then look leaked because of us. So the node's original value is restored
//    after every lookup.
// 2. The onDestroy callbacks live in Angular's views. Each is created in a
//    function of its own so that its closure holds only entries (a WeakRef and
//    a name each), never an instance, node or view.

import { ChangeDetectorRef, DestroyRef } from "@angular/core";
import { _config } from "./config.js";
import { markDestroyed, track } from "./lifecycle.js";
import { namesOf, serviceNamesOf } from "./names.js";
import { heldNavigations, isRouterOutlet, OUTLET_TAG, watchOutlet } from "./router.js";
import { entryOf } from "./store.js";
import type { InstanceKind, LiveEntry } from "./types.js";

type NgInjector = { get(token: unknown, notFoundValue?: unknown): unknown };

/**
 * The parts of Angular's dev-mode global (`window.ng`) the detector uses. In
 * a production build, the same lookups made without it (production.ts).
 */
export type NgDebugApi = {
  getComponent(element: Element): object | null;
  getInjector(node: Node): NgInjector;
  /** Directives, and router outlets on Angular 16 and 20 (router.ts). */
  getDirectives?(node: Node): unknown[];
  /** The component whose template the node is in, through embedded views. */
  getOwningComponent?(node: Node): object | null;
  /** How a node's providers were declared (Angular 16.2 and later). */
  ɵgetInjectorProviders?(injector: NgInjector): unknown;
};

/** What `ng.ɵgetInjectorProviders` lists: one provider as the app declared it. */
type ProviderRecord = { token: unknown; provider: unknown; isViewProvider?: boolean };

/** What `ChangeDetectorRef` resolves to on a component host: its view's ViewRef. */
type ComponentViewRef = {
  readonly context: unknown;
  readonly destroyed: boolean;
  onDestroy(callback: () => void): unknown;
};

/**
 * What `DestroyRef` resolves to on a node: the DestroyRef of the view the node
 * is in. Its `onDestroy` throws once that view is destroyed.
 */
type ViewDestroyRef = { onDestroy(callback: () => void): unknown };

/** Where Angular stores a node's view context (a numeric view id by default). */
const CONTEXT_KEY = "__ngContext__";

/**
 * What to look nodes up with where Angular publishes no debugging API (a
 * production build), if the detector may run there: production.ts.
 */
let withoutDebugApi: NgDebugApi | null = null;

/** Let discovery run without Angular's debugging API, with `api` (or not: `null`). */
export function useWithoutDebugApi(api: NgDebugApi | null): void {
  withoutDebugApi = api;
}

/** Angular's debugging API, where it is published (development builds). */
function debugApi(): NgDebugApi | null {
  const ng = (globalThis as { ng?: Partial<NgDebugApi> }).ng;
  return ng && typeof ng.getComponent === "function" && typeof ng.getInjector === "function"
    ? (ng as NgDebugApi)
    : null;
}

/** Whether discovery runs on a stand-in for Angular's debugging API (a production build). */
export function runsWithoutDebugApi(): boolean {
  return debugApi() === null && withoutDebugApi !== null;
}

/** Angular's debugging API where it is published (development), else the stand-in, if any. */
export function ngApi(): NgDebugApi | null {
  return debugApi() ?? withoutDebugApi;
}

/**
 * Instances looked at and not tracked (a view of a shape this detector
 * doesn't know, or already destroyed): not looked at again. Tracked ones are
 * known by their entry (`entryOf`).
 */
let rejected = new WeakSet<object>();

const isKnown = (instance: object) => rejected.has(instance) || entryOf(instance) !== undefined;

let observedRoots = new WeakSet<Node>();
let observer: MutationObserver | null = null;

function onDestroyOf(entry: LiveEntry): () => void {
  return () => markDestroyed(entry);
}

/**
 * The entries of the directives and services of one view: the nodes in a view
 * share its destroy signal, so one hook serves them all. `done` once it fired.
 * `owner`: the component whose template the view belongs to, the same for
 * all its nodes, looked up once (`undefined` until then).
 */
type ViewGroup = { entries: LiveEntry[]; done: boolean; owner?: LiveEntry | null };

/** Per view (its LView), its group. Keyed weakly: no view is kept alive. */
let viewGroups = new WeakMap<object, ViewGroup>();

function onDestroyOfGroup(group: ViewGroup): () => void {
  return () => {
    group.done = true;
    group.entries.forEach(markDestroyed);
    group.entries = [];
  };
}

/**
 * The group of `view` (a node's LView, or `null` if not at hand), with its
 * destroy hook in place; `null` if the view is destroyed, or of a shape this
 * detector doesn't know. The first node of a view with something to track
 * pays for the injector and DestroyRef lookups and the hook, the others don't.
 */
function groupOf(view: object | null, injectorOf: () => NgInjector): ViewGroup | null {
  const known = view ? viewGroups.get(view) : undefined;
  if (known) return known.done ? null : known;
  const destroyRef = injectorOf().get(DestroyRef, null);
  if (!isViewDestroyRef(destroyRef)) return null;
  const group: ViewGroup = { entries: [], done: false };
  // Throws if the view is already destroyed: then nothing is tracked.
  destroyRef.onDestroy(onDestroyOfGroup(group));
  if (view) viewGroups.set(view, group);
  return group;
}

/** Run `ng.*` lookups on `node`, then put back what Angular had stored on it. */
function withPristineContext<T>(node: Node, lookup: () => T): T {
  const record = node as unknown as Record<string, unknown>;
  const before = record[CONTEXT_KEY];
  try {
    return lookup();
  } finally {
    if (record[CONTEXT_KEY] !== before) record[CONTEXT_KEY] = before;
  }
}

function isComponentViewRef(value: unknown): value is ComponentViewRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ComponentViewRef).onDestroy === "function" &&
    "destroyed" in value &&
    "context" in value
  );
}

function isViewDestroyRef(value: unknown): value is ViewDestroyRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ViewDestroyRef).onDestroy === "function"
  );
}

// ---------------------------------------------------------------------------
// Component-level services.
//
// Angular keeps what a node's injector provides in the view the node is in,
// next to the node's directives: slot `i` of the view (`lView[i]`), for `i`
// from the node's first provider (`tNode.providerIndexes & 0xFFFFF`) up to its
// first directive (`tNode.directiveStart`), view providers first. A slot holds
// the provider's factory (a NodeInjectorFactory, the one in
// `tView.blueprint[i]`) until something injects it, then the instance; its
// token is in `tView.data[i]`. This layout is the same on every Angular from
// 16 to 22.
//
// A slot counts only once Angular has created the instance, so the detector
// never creates a service itself, and only if the node owns that instance: a
// class provider (`CartStore`, `{ provide: Store, useClass: CartStore }`)
// creates one per node. A `useValue`, `useExisting` or `useFactory` one may
// hand out an object that lives longer (a constant, a root service), which
// isn't a leak when the view goes. Which kind a slot is, is found out without
// changing anything in the app:
//
// 1. The slot's factory is the class's own (`ɵfac`, which `@Injectable()`
//    and the other decorators add): a class provider. Every Angular.
// 2. Otherwise, how the app declared the provider, which Angular records in
//    development mode for its DevTools and lists with
//    `ng.ɵgetInjectorProviders`: that covers classes without a decorator, and
//    class providers with `deps`. Angular 16.2 and later. On 16.2 it lists
//    them only for the first view of each template, so what it says about a
//    template's slot is remembered for the others (`slotClasses`).

/** Where a node's providers start, in `tNode.providerIndexes` (Angular's TNodeProviderIndexes). */
const PROVIDERS_START_MASK = 0xfffff;
/** How many of them are view providers, in `tNode.providerIndexes`. */
const VIEW_PROVIDERS_SHIFT = 20;
/** Index of the TView in an LView. */
export const TVIEW = 1;

/** The private fields of the NodeInjector `ng.getInjector()` returns. */
type NodeInjectorInternals = {
  _tNode?: { providerIndexes?: unknown; directiveStart?: unknown } | null;
  _lView?: unknown;
};

type TView = { blueprint?: unknown; data?: unknown };

/**
 * Per template (TView), per slot: the class its provider creates, or `null`
 * for a provider that creates none (useValue, …). Keyed weakly: the detector
 * keeps no template alive.
 */
let slotClasses = new WeakMap<object, Map<number, Function | null>>();

type ForwardRef = (() => unknown) & { __forward_ref__?: unknown };

/** Angular's `resolveForwardRef`: `forwardRef(() => CartStore)` is CartStore. */
function resolveForwardRef(value: unknown): unknown {
  const ref = value as ForwardRef;
  return typeof ref === "function" && Object.prototype.hasOwnProperty.call(ref, "__forward_ref__")
    ? ref()
    : value;
}

/**
 * The class a provider creates its instance with, decided the way Angular's
 * `providerToFactory` decides it; `null` for a provider that creates none of
 * its own (`useValue`, `useExisting`, `useFactory`) and for a multi provider.
 */
function classOf(provider: unknown): Function | null {
  const resolved = resolveForwardRef(provider);
  if (typeof resolved === "function") return resolved; // `providers: [CartStore]`
  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) return null;
  const p = resolved as Record<string, unknown>;
  if (p["multi"] || "useValue" in p || p["useFactory"] || p["useExisting"]) return null;
  // `{ provide, useClass }`, with or without `deps`; `{ provide: CartStore }`.
  const classRef = resolveForwardRef(p["useClass"] || p["provide"]);
  return typeof classRef === "function" ? classRef : null;
}

/**
 * The class the provider of slot `i` creates, from how the app declared it:
 * `undefined` if Angular's records don't say, `null` if it creates none.
 * Several records for the slot's token must agree.
 */
function classFromRecords(
  records: readonly ProviderRecord[],
  token: unknown,
  isViewProvider: boolean,
): Function | null | undefined {
  let found: Function | null | undefined;
  for (const record of records) {
    if (record.token !== token || Boolean(record.isViewProvider) !== isViewProvider) continue;
    const classRef = classOf(record.provider);
    if (found !== undefined && found !== classRef) return null;
    found = classRef;
  }
  return found;
}

/** How the app declared the node's providers, if Angular recorded it. */
function providerRecords(injector: NgInjector, ng: NgDebugApi): readonly ProviderRecord[] {
  if (typeof ng.ɵgetInjectorProviders !== "function") return [];
  try {
    const records = ng.ɵgetInjectorProviders(injector);
    return Array.isArray(records)
      ? records.filter((r): r is ProviderRecord => typeof r === "object" && r !== null && "token" in r)
      : [];
  } catch {
    return [];
  }
}

/** A service the node's providers created, and which of them it is: `providers[0]`, `viewProviders[1]`, … */
type ProvidedService = { instance: object; provider: string };

/**
 * The instances the node's own providers have created. `recordsOf` lists how
 * the app declared them, asked only if a slot needs it.
 */
function providedServices(place: Place, recordsOf: () => readonly ProviderRecord[]): ProvidedService[] {
  const { tNode, lView, tView } = place;
  const { providerIndexes, directiveStart } = tNode;
  const { blueprint } = tView;
  const tokens = Array.isArray(tView.data) ? tView.data : [];

  const start = providerIndexes & PROVIDERS_START_MASK;
  const viewProvidersEnd = start + (providerIndexes >>> VIEW_PROVIDERS_SHIFT);
  let records: readonly ProviderRecord[] | undefined;
  let known = slotClasses.get(tView);
  const services: ProvidedService[] = [];
  // View providers first, as Angular lays them out.
  const providerAt = (i: number) =>
    i < viewProvidersEnd ? `viewProviders[${i - start}]` : `providers[${i - viewProvidersEnd}]`;
  for (let i = start; i < directiveStart; i++) {
    const value: unknown = lView[i];
    // Not created yet: the slot still holds the blueprint's factory. An
    // array is a multi provider's values.
    const pending = value === blueprint[i];
    if (pending || typeof value !== "object" || value === null || Array.isArray(value)) continue;

    // 1. Created with the class's own factory.
    const factory = (blueprint[i] as { factory?: unknown } | null | undefined)?.factory;
    const ctor: unknown = (value as { constructor?: unknown }).constructor;
    const ownFactory = typeof ctor === "function" && (ctor as { ɵfac?: unknown }).ɵfac;
    if (typeof factory === "function" && ownFactory === factory) {
      services.push({ instance: value, provider: providerAt(i) });
      continue;
    }

    // 2. Declared as a class provider.
    records ??= recordsOf();
    let classRef = classFromRecords(records, tokens[i], i < viewProvidersEnd);
    if (classRef !== undefined) {
      if (!known) slotClasses.set(tView, (known = new Map()));
      known.set(i, classRef);
    } else {
      classRef = known?.get(i);
    }
    // And this is what that class creates, not something else in its slot.
    if (classRef && Object.getPrototypeOf(value) === classRef.prototype) {
      services.push({ instance: value, provider: providerAt(i) });
    }
  }
  return services;
}

// ---------------------------------------------------------------------------
// Discovery.

/** Angular's TNodeType of the nodes it anchors with a comment: `<ng-template>` and `<ng-container>`. */
const TNODE_CONTAINER = 4;
const TNODE_ELEMENT_CONTAINER = 8;

/**
 * The tag to report for a node: the element's, or for a comment Angular
 * anchors a template or container with, `ng-template` / `ng-container`.
 * In development Angular writes which into the comment; in production the
 * comment is empty, and the node's TNode says (`tNodeType`, if known).
 */
function hostNameOf(node: Element | Comment, tNodeType: number | undefined): string {
  if (node.nodeType === Node.ELEMENT_NODE) return (node as Element).localName;
  const { data } = node as Comment;
  if (data === "container") return "ng-template";
  if (data === "ng-container") return "ng-container";
  if (tNodeType === TNODE_CONTAINER) return "ng-template";
  return "ng-container";
}

/** Track the component `el` hosts, if we haven't seen it. */
function trackComponent(el: Element, ng: NgDebugApi, instance: object): void {
  if (isKnown(instance)) return;
  try {
    const view = ng.getInjector(el).get(ChangeDetectorRef, null);
    // On a component host the ViewRef's context is the component itself.
    // Anything else is a shape this version of the detector doesn't know.
    if (!isComponentViewRef(view) || view.context !== instance || view.destroyed) return;
    const { name, className } = namesOf(instance, _config.renameMinifiedClasses);
    const entry = track(instance, name, el.localName, "component", className);
    view.onDestroy(onDestroyOf(entry));
  } finally {
    rejectUntracked(instance);
  }
}

/** Not tracked after a look: don't look again. */
function rejectUntracked(instance: object): void {
  if (entryOf(instance) === undefined) rejected.add(instance);
}

// ---------------------------------------------------------------------------
// Where a node's instances are.
//
// A node's TNode (in its template's TView) says which slots of the view it is
// in (its LView) hold its instances: its providers' from
// `providerIndexes & 0xFFFFF` up to `directiveStart`, its directives' (and
// component's) from `directiveStart` up to `directiveEnd`. A node with no
// directive has `directiveStart === directiveEnd` (both -1); providers only
// come with directives, which they shift along. The same on every Angular
// from 16 to 22.
//
// The TNode and LView are at hand after the first `ng.*` lookup on a node:
// it leaves a context on the node (an LContext: `lView` and `nodeIndex`).

/** `componentOffset`: where the node's component is among its directives, -1 if none (Angular 15 and later). */
type TNodeShape = {
  directiveStart: number;
  directiveEnd: number;
  providerIndexes: number;
  type?: number;
  componentOffset?: number;
};

/** A node's TNode and the view it is in. */
export type Place = { tNode: TNodeShape; lView: unknown[]; tView: TView & { blueprint: unknown[] } };

function placeOf(tNode: unknown, lView: unknown): Place | null {
  if (!Array.isArray(lView)) return null;
  const t = tNode as Partial<TNodeShape> | null | undefined;
  if (
    typeof t?.directiveStart !== "number" ||
    typeof t.directiveEnd !== "number" ||
    typeof t.providerIndexes !== "number"
  ) {
    return null;
  }
  const tView = lView[TVIEW] as TView | null | undefined;
  if (!tView || !Array.isArray(tView.blueprint)) return null;
  return { tNode: t as TNodeShape, lView, tView: tView as Place["tView"] };
}

/** From the context the first `ng.*` lookup left on the node. */
function placeFromContext(node: Node): Place | null {
  const context = (node as unknown as Record<string, unknown>)[CONTEXT_KEY] as
    | { lView?: unknown; nodeIndex?: unknown }
    | null
    | undefined;
  if (typeof context !== "object" || context === null) return null;
  const { lView, nodeIndex } = context;
  if (!Array.isArray(lView) || typeof nodeIndex !== "number") return null;
  const data = (lView[TVIEW] as TView | null | undefined)?.data;
  return placeOf(Array.isArray(data) ? data[nodeIndex] : undefined, lView);
}

/** From the NodeInjector `ng.getInjector()` returns. */
export function placeFromInjector(injector: NgInjector): Place | null {
  const { _tNode, _lView } = injector as NodeInjectorInternals;
  return placeOf(_tNode, _lView);
}

/** The node holds no component, directive or provider. */
const isBare = (place: Place) => place.tNode.directiveEnd <= place.tNode.directiveStart;

/**
 * The node's directives, from their slots: not the component (Angular's
 * `ng.getDirectives` leaves it out too), nor a slot not created yet.
 */
export function directivesAt(place: Place, component: object | null): object[] {
  const { tNode, lView, tView } = place;
  const directives: object[] = [];
  for (let i = tNode.directiveStart; i < tNode.directiveEnd; i++) {
    const value: unknown = lView[i];
    if (value === tView.blueprint[i] || value === component) continue;
    if (typeof value !== "object" || value === null) continue;
    const ctor: unknown = (value as { constructor?: unknown }).constructor;
    if (typeof ctor === "function" && (ctor as { ɵcmp?: unknown }).ɵcmp != null) continue;
    directives.push(value);
  }
  return directives;
}

/** Track what `node` holds: its component, directives and services. */
function visit(node: Element | Comment, ng: NgDebugApi): void {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
  if (el?.shadowRoot) observeRoot(el.shadowRoot, ng);
  // Every node Angular creates carries a view context. Nodes without one
  // can't hold a component or directive, and skipping them keeps the `ng.*`
  // lookups from walking up their ancestors.
  if (!(CONTEXT_KEY in node)) return;
  withPristineContext(node, () => {
    let component: object | null = null;
    let directives: readonly unknown[] | undefined;
    // A lookup on a node Angular is tearing down can throw. Never let the
    // detector break the app, and let each step fail on its own.
    try {
      // The one lookup every node gets (`ng.getComponent` takes elements
      // only). It leaves the context `placeFromContext` reads on the node.
      if (el) {
        component = ng.getComponent(el);
        if (component) trackComponent(el, ng, component);
      } else if (ng.getDirectives) {
        directives = ng.getDirectives(node);
      }
    } catch {
      // See above.
    }
    const place = placeFromContext(node);
    // Most nodes hold nothing: no more lookups for them.
    if (place && !component && isBare(place)) return;
    try {
      trackOnNode(node, ng, component, place, directives);
    } catch {
      // See above.
    }
  });
}

/**
 * Watch the router outlet the node holds, if any (router.ts), and track the
 * node's directives and the services it provides that we haven't seen.
 * `component` is the one the node hosts, if any: they become its companions,
 * and belong to it; otherwise they belong to the component whose template the
 * node is in (LiveEntry's `owner`). `place` is where its instances are, if the
 * first lookup's context said; else the injector says, or else the `ng.*`
 * lookups do.
 */
function trackOnNode(
  node: Element | Comment,
  ng: NgDebugApi,
  component: object | null,
  place: Place | null,
  directivesFound: readonly unknown[] | undefined,
): void {
  const outlet = heldNavigations > 0 && (node as Element).localName === OUTLET_TAG;
  if (!outlet && !_config.trackDirectives && !_config.trackServices) return;
  let injector: NgInjector | undefined;
  const injectorOf = () => (injector ??= ng.getInjector(node));
  const here = place ?? placeFromInjector(injectorOf());
  const directives =
    directivesFound ??
    (here ? directivesAt(here, component) : ng.getDirectives ? ng.getDirectives(node) : []);
  if (outlet) {
    for (const directive of directives) {
      if (isRouterOutlet(directive)) watchOutlet(directive);
    }
  }

  const found: Found[] = [];
  if (_config.trackDirectives) {
    for (const directive of directives) {
      if (typeof directive === "object" && directive !== null) found.push([directive, "directive", null]);
    }
  }
  if (_config.trackServices && here) {
    const services = providedServices(here, () => providerRecords(injectorOf(), ng));
    // Where a service is provided, to name it in a minified build (names.ts):
    // the element, by its component or else its first directive. Asked only
    // there, and only for a class not named yet.
    const element = () => {
      const first = component ?? directives.find((d): d is object => typeof d === "object" && d !== null);
      return first ? namesOf(first).name : hostNameOf(node, here.tNode.type);
    };
    for (const { instance, provider } of services) {
      found.push([instance, "service", () => `${element()} ${provider}`]);
    }
  }
  const fresh = found.filter(([instance]) => !isKnown(instance));
  if (fresh.length === 0) return;
  try {
    trackFresh(node, ng, here, injectorOf, component, fresh);
  } finally {
    fresh.forEach(([instance]) => rejectUntracked(instance));
  }
}

/** An instance on a node, its kind, and for a service, where it is provided (names.ts). */
type Found = [instance: object, kind: InstanceKind, provider: (() => string) | null];

function trackFresh(
  node: Element | Comment,
  ng: NgDebugApi,
  place: Place | null,
  injectorOf: () => NgInjector,
  component: object | null,
  fresh: readonly Found[],
): void {
  const group = groupOf(place?.lView ?? null, injectorOf);
  if (!group) return;
  const host = hostNameOf(node, place?.tNode.type);
  const hosted = component ? entryOf(component) : undefined;
  // Every node of a view belongs to the same component: looked up once.
  const owner = hosted ?? (group.owner === undefined ? (group.owner = ownerOf(node, ng) ?? null) : group.owner);
  for (const [instance, kind, provider] of fresh) {
    const rename = _config.renameMinifiedClasses;
    const { name, className } = provider ? serviceNamesOf(instance, provider, rename) : namesOf(instance, rename);
    const entry = track(instance, name, host, kind, className);
    entry.owner = owner;
    group.entries.push(entry);
    if (hosted) (hosted.companions ??= []).push(entry);
  }
}

/** The entry of the component whose template `node` is in, if we track it. */
function ownerOf(node: Node, ng: NgDebugApi): LiveEntry | undefined {
  try {
    const owning = ng.getOwningComponent?.(node);
    return typeof owning === "object" && owning !== null ? entryOf(owning) : undefined;
  } catch {
    return undefined;
  }
}

const isTracked = (node: Node) =>
  node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.COMMENT_NODE;

/** Visit `root` and every element and comment below it. */
function scan(root: Node, ng: NgDebugApi): void {
  if (isTracked(root)) visit(root as Element | Comment, ng);
  if (
    root.nodeType !== Node.ELEMENT_NODE &&
    root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE &&
    root.nodeType !== Node.DOCUMENT_NODE
  ) {
    return;
  }
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    visit(node as Element | Comment, ng);
  }
}

function observeRoot(root: Node, ng: NgDebugApi): void {
  if (!observer || observedRoots.has(root)) return;
  observedRoots.add(root);
  observer.observe(root, { childList: true, subtree: true });
  if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) scan(root, ng);
}

/** Track every component, directive and service in the document, now and as Angular renders more. */
export function startDiscovery(doc: Document = document): void {
  if (observer) return;
  observer = new MutationObserver((records) => {
    const ng = ngApi();
    if (!ng) return;
    for (const record of records) record.addedNodes.forEach((node) => scan(node, ng));
  });
  const ng = ngApi();
  if (ng) {
    observeRoot(doc, ng);
    scan(doc, ng);
  } else {
    observedRoots.add(doc);
    observer.observe(doc, { childList: true, subtree: true });
  }
}

/**
 * Re-scan the whole document, e.g. after rendering into a detached tree, or to
 * pick up component-level services created after their element was found.
 */
export function rescan(doc: Document = document): void {
  const ng = ngApi();
  if (ng) scan(doc, ng);
}

/** Stop watching the document and forget what was seen. */
export function stopDiscovery(): void {
  observer?.disconnect();
  observer = null;
  withoutDebugApi = null;
  rejected = new WeakSet();
  viewGroups = new WeakMap();
  observedRoots = new WeakSet();
  slotClasses = new WeakMap();
}
