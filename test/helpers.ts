// Re-loads the runtime modules with fresh state for each test. The modules
// hold module-level singletons (the live set, listeners, config), so every
// test gets its own copies while the cross-module references stay shared.

import { vi } from "vitest";

export type Runtime = {
  config: typeof import("../src/config");
  store: typeof import("../src/store");
  subscribers: typeof import("../src/subscribers");
  lifecycle: typeof import("../src/lifecycle");
  sweep: typeof import("../src/sweep");
  witness: typeof import("../src/witness");
  discovery: typeof import("../src/discovery");
  detector: typeof import("../src/detector");
  router: typeof import("../src/router");
  names: typeof import("../src/names");
  production: typeof import("../src/production");
};

/**
 * What src/production.ts uses of `@angular/core` (`DebugNode`), standing in
 * for a production build's: set by `fakeAngular(…, { production: true })`,
 * used by `loadRuntime({ production: true })`.
 */
type ProductionCore = {
  injector(node: Node): unknown;
  componentInstance(node: Node): unknown;
};
let productionCore: ProductionCore | null = null;
const core = () => {
  if (!productionCore) throw new Error("fakeAngular(…, { production: true }) first");
  return productionCore;
};

/** Angular's public DebugNode, as src/production.ts uses it. */
class FakeDebugNode {
  constructor(readonly nativeNode: Node) {}
  get injector() {
    return core().injector(this.nativeNode);
  }
  get componentInstance() {
    return core().componentInstance(this.nativeNode);
  }
}

/**
 * `angular` stands in for the Angular major (`VERSION.major`) the detector
 * runs on; by default, the one installed. `production`: what the detector
 * imports from `@angular/core` for production builds (src/production.ts) is
 * the fake's, see `fakeAngular`. `minified`: class names are minified, as in
 * a minified production build (src/names.ts).
 */
export async function loadRuntime({
  seasoned = true,
  angular,
  production = false,
  minified = false,
}: { seasoned?: boolean; angular?: number; production?: boolean; minified?: boolean } = {}): Promise<Runtime> {
  vi.resetModules();
  if (angular === undefined && !production) vi.doUnmock("@angular/core");
  else {
    vi.doMock("@angular/core", async (importOriginal) => {
      const real = await importOriginal<typeof import("@angular/core")>();
      return {
        ...real,
        ...(angular === undefined ? {} : { VERSION: { ...real.VERSION, major: String(angular) } }),
        ...(production ? { DebugNode: FakeDebugNode } : {}),
      };
    });
  }
  const mods: Runtime = {
    config: await import("../src/config"),
    store: await import("../src/store"),
    subscribers: await import("../src/subscribers"),
    lifecycle: await import("../src/lifecycle"),
    sweep: await import("../src/sweep"),
    witness: await import("../src/witness"),
    discovery: await import("../src/discovery"),
    detector: await import("../src/detector"),
    router: await import("../src/router"),
    names: await import("../src/names"),
    production: await import("../src/production"),
  };
  if (minified) mods.names.setClassNamesMinified(true);
  // What starting the detector does (src/detector.ts).
  mods.witness.startWitnesses();
  // A page that has been running for a while: the whole witness stock has
  // been held through enough collections (src/witness.ts).
  if (seasoned) for (let i = 0; i < 3; i++) mods.witness.noteGc();
  return mods;
}

/** A WeakRef whose target has been collected. */
const collected = { deref: () => undefined } as unknown as WeakRef<object>;

/**
 * Stand-in for one major garbage collection: every released witness is
 * collected, then the collection is counted. Tracked instances are left
 * alone, as if each one were still referenced — the leak a real collection
 * would expose.
 */
export function simulateGc(mods: Runtime): void {
  mods.store.live.forEach((entry) => {
    if (entry.witness) entry.witness.ref = collected;
  });
  mods.witness.noteGc();
}

export type FakeView = {
  context: unknown;
  destroyed: boolean;
  hooks: Array<() => void>;
  onDestroy(cb: () => void): void;
  destroy(): void;
};

/**
 * A view elements are declared in (an LView): the DestroyRef of every node in
 * it fires when it is destroyed, and so do the component views of the hosts
 * in it, as in Angular.
 */
export type FakeContainerView = {
  destroyed: boolean;
  /** Callbacks registered through the DestroyRef of its nodes. */
  hooks: Array<() => void>;
  /** Component views of the hosts declared in it. */
  children: FakeView[];
  /**
   * Its LView: the slots of all the nodes declared in it (each node's at
   * other indexes), and its template's TView at index 1.
   */
  lView: unknown[];
  destroy(): void;
};

/**
 * One slot of a node's providers (see `providedServices` in src/discovery.ts):
 * - `instance`: a class provider Angular has created (`providers: [CartStore]`,
 *   or `useClass`); its class needs a static `ɵfac`, as Angular's compiler gives it;
 * - `lazy`: a class provider nothing has injected yet;
 * - `value`: what a `useValue` / `useExisting` / `useFactory` provider gave;
 * - `multi`: a multi provider's values;
 * - `declared`: a provider as the app declared it (`CartStore`,
 *   `{ provide: Store, useValue: … }`, …), whose factory is one Angular makes
 *   up (as for a class without a decorator), and `instance` what it created,
 *   if anything has injected it yet.
 */
export type ProviderSlot =
  | { instance: object; isViewProvider?: boolean }
  | { lazy: abstract new (...args: never[]) => unknown }
  | { value: object }
  | { multi: object[] }
  | { declared: unknown; instance?: object; isViewProvider?: boolean };

/**
 * A component's template (a TView): the nodes made `from` one share its
 * provider slots, as the instances of one component do.
 */
export type FakeTemplate = { tView: { blueprint: unknown[]; data: unknown[] }; providerStart: number };

type NodeOptions = {
  /** The view the node is declared in. By default, one shared view. */
  in?: FakeContainerView;
  directives?: object[];
  providers?: ProviderSlot[];
  /** Another instance of the same template: same providers, same slots. */
  from?: FakeTemplate;
  /** The component whose template the node is in (`ng.getOwningComponent`). */
  owner?: object;
};

/** A provider record, as Angular's `ng.ɵgetInjectorProviders` lists it. */
type ProviderRecord = { token: unknown; provider: unknown; isViewProvider: boolean };

/** Which node a fake NodeInjector is for (Angular's knows its TNode and LView). */
const INJECTOR_NODE = Symbol("node");

const unwrapForwardRef = (value: any) =>
  typeof value === "function" && Object.prototype.hasOwnProperty.call(value, "__forward_ref__") ? value() : value;

/** `TNodeProviderIndexes.ProvidersStartIndexMask` and the index of the TView in an LView. */
const PROVIDERS_START_MASK = 0xfffff;
const TVIEW = 1;
/** Angular's TNodeType of an element, an `<ng-template>` and an `<ng-container>`. */
const TNODE_ELEMENT = 2;
const TNODE_CONTAINER = 4;
const TNODE_ELEMENT_CONTAINER = 8;

/**
 * A stand-in for Angular's dev-mode `window.ng`, shaped like Angular's from
 * 16 to 22 (the end-to-end suite runs on each): nodes Angular creates carry
 * a numeric `__ngContext__`, and a lookup replaces it with a context object
 * that caches the component. `ng.getInjector(node)` returns a NodeInjector
 * with Angular's private `_tNode` / `_lView` fields, laid out as Angular lays
 * out a node's providers; `get(DestroyRef)` is the DestroyRef of the view the
 * node is in. `angular` is the major to mimic: before 20, a DestroyRef has no
 * `destroyed` and throws on a destroyed view.
 *
 * `records` is what `ng.ɵgetInjectorProviders` knows of how providers were
 * declared: each node's (`"node"`, Angular 17 and later), only the first
 * view's of each template (`"first-view"`, 16.2), or it doesn't exist
 * (`"none"`, 16.0 and 16.1).
 *
 * `production`: a production build instead, where Angular publishes no
 * `window.ng` (and records no providers), and anchors templates and
 * containers with empty comments. What the detector uses there instead
 * (src/production.ts), `DebugNode`, is faked from the same views, for
 * `loadRuntime({ production: true })`: its `injector` is `getInjector`'s.
 */
export function fakeAngular(
  ChangeDetectorRef: unknown,
  {
    DestroyRef,
    angular = 22,
    records = "node",
    production = false,
  }: { DestroyRef?: unknown; angular?: number; records?: "node" | "first-view" | "none"; production?: boolean } = {},
) {
  const hosts = new Map<Node, { instance: object; view: FakeView }>();
  const directives = new Map<Node, unknown[]>();
  const owners = new Map<Node, object>();
  const contexts = new Map<Node, { lView: unknown[]; nodeIndex: number }>();
  /**
   * What an `ng.*` lookup leaves on a node, as Angular's does: an LContext,
   * whose `lView` and `nodeIndex` lead to the node's TNode.
   */
  const lContext = (node: Node, cached: object) => {
    const found = contexts.get(node);
    return { lViewId: 1, nodeIndex: found?.nodeIndex ?? -1, lView: found?.lView ?? null, ...cached };
  };
  const injectors = new Map<
    Node,
    { tNode: object; lView: unknown[]; container: FakeContainerView; records: ProviderRecord[] | null }
  >();
  let nextId = 1;

  /** A view, of a template of its own, or of `template` (another instance of it). */
  const view = (template?: FakeTemplate): FakeContainerView => ({
    destroyed: false,
    hooks: [],
    children: [],
    lView: Object.assign([], { [TVIEW]: template?.tView ?? { blueprint: [], data: [] } }),
    destroy() {
      this.destroyed = true;
      this.hooks.forEach((h) => h());
      this.children.forEach((child) => child.destroy());
    },
  });
  const rootView = view();

  const destroyRefOf = (container: FakeContainerView) => {
    const ref = {
      onDestroy(cb: () => void) {
        if (container.destroyed) throw new Error("NG0911: View has already been destroyed.");
        container.hooks.push(cb);
        return () => {};
      },
    };
    if (angular >= 20) Object.defineProperty(ref, "destroyed", { get: () => container.destroyed });
    return ref;
  };

  /**
   * Give `node` a view context, directives and providers, like Angular.
   * `type`: its TNodeType, an element (2) unless said otherwise.
   */
  const setUp = (
    node: Node,
    { in: given, directives: dirs = [], providers = [], from, owner }: NodeOptions,
    { host, type = TNODE_ELEMENT }: { host?: object; type?: number } = {},
  ) => {
    (node as any).__ngContext__ = nextId++;
    if (owner) owners.set(node, owner);
    if (dirs.length > 0) directives.set(node, dirs);
    // Another instance of a template is in a view of its own (an LView on
    // the same TView), unless told which.
    const container = given ?? (from ? view(from) : rootView);
    const { lView } = container;
    const tView = lView[TVIEW] as FakeTemplate["tView"];
    // Real views hold many nodes' slots: each node's at its own indexes.
    const providerStart = from?.providerStart ?? 20 + nextId * 10;
    const template: FakeTemplate = { tView, providerStart };
    const { blueprint, data } = tView;
    const nodeRecords: ProviderRecord[] = [];
    // View providers come first, as in Angular.
    const ordered = [...providers].sort(
      (a, b) => Number("isViewProvider" in b && !!b.isViewProvider) - Number("isViewProvider" in a && !!a.isViewProvider),
    );
    const viewProviders = ordered.filter((slot) => "isViewProvider" in slot && slot.isViewProvider).length;
    ordered.forEach((slot, n) => {
      const i = providerStart + n;
      const record = (provider: unknown, token: unknown = provider) =>
        nodeRecords.push({ token, provider, isViewProvider: n < viewProviders });
      const made = (factory: unknown) => {
        // Another instance of the template reuses its slots.
        if (!from) blueprint[i] = { factory, resolving: false };
        return blueprint[i];
      };
      if ("declared" in slot) {
        const { declared } = slot;
        const token = typeof declared === "function" ? declared : unwrapForwardRef((declared as any).provide);
        data[i] = token;
        // What Angular makes up for what has no `ɵfac` of its own.
        const factory = made(() => undefined);
        lView[i] = slot.instance ?? factory;
        record(declared, token);
      } else if ("instance" in slot) {
        data[i] = slot.instance.constructor;
        made((slot.instance.constructor as any).ɵfac);
        lView[i] = slot.instance;
        record(slot.instance.constructor);
      } else if ("lazy" in slot) {
        data[i] = slot.lazy;
        lView[i] = made((slot.lazy as any).ɵfac);
        record(slot.lazy);
      } else if ("value" in slot) {
        const { value } = slot;
        data[i] = value.constructor;
        made(() => value);
        lView[i] = value;
        record({ provide: value.constructor, useValue: value }, value.constructor);
      } else {
        const token = { multiToken: true };
        data[i] = token;
        made(() => slot.multi);
        lView[i] = [...slot.multi];
        record({ provide: token, useValue: slot.multi, multi: true }, token);
      }
    });
    // A node with no directive has both at -1, as in Angular; a component
    // counts as one of the node's directives, the first.
    const instances = host ? [host, ...dirs] : dirs;
    const directiveCount = instances.length;
    // `componentOffset`: where its component is among them, -1 if none.
    const tNode =
      directiveCount === 0
        ? { type, providerIndexes: 0, directiveStart: -1, directiveEnd: -1, componentOffset: -1 }
        : {
            type,
            providerIndexes: (providerStart & PROVIDERS_START_MASK) + viewProviders * 2 ** 20,
            directiveStart: providerStart + providers.length,
            directiveEnd: providerStart + providers.length + directiveCount,
            componentOffset: host ? 0 : -1,
          };
    // Its directives' slots hold them; the template's, their factories.
    instances.forEach((instance, k) => {
      const i = tNode.directiveStart + k;
      if (!from) blueprint[i] = { factory: () => instance, resolving: false };
      lView[i] = instance;
    });
    // The node's TNode, where a lookup's context (LContext) points.
    const nodeIndex = providerStart - 5;
    data[nodeIndex] = tNode;
    contexts.set(node, { lView, nodeIndex });
    // Angular 16.2 records only the first view of a template.
    const recorded = records === "node" || (records === "first-view" && !from);
    injectors.set(node, { tNode, lView, container, records: recorded ? nodeRecords : null });
    return { lView, providerStart, container, template };
  };

  const getComponent = vi.fn((el: Element) => {
    const found = hosts.get(el);
    (el as any).__ngContext__ = lContext(el, { component: found?.instance ?? null });
    return found?.instance ?? null;
  });

  const getDirectives = vi.fn((node: Node) => {
    (node as any).__ngContext__ = lContext(node, { directives: directives.get(node) ?? [] });
    return [...(directives.get(node) ?? [])];
  });

  const getInjector = vi.fn((node: Node) => {
    (node as any).__ngContext__ = lContext(node, {});
    const internals = injectors.get(node);
    return {
      [INJECTOR_NODE]: node,
      _tNode: internals?.tNode ?? null,
      _lView: internals?.lView ?? null,
      get: (token: unknown) => {
        if (token === ChangeDetectorRef) {
          return hosts.get(node)?.view ?? { context: "parent", destroyed: false, onDestroy() {} };
        }
        if (DestroyRef !== undefined && token === DestroyRef && internals) {
          return destroyRefOf(internals.container);
        }
        return null;
      },
    };
  });

  const getInjectorProviders = vi.fn((injector: { [INJECTOR_NODE]?: Node }) => {
    const internals = injector[INJECTOR_NODE] && injectors.get(injector[INJECTOR_NODE]);
    if (internals) return internals.records ?? [];
    throw new Error("getInjectorProviders only supports NodeInjector and EnvironmentInjector");
  });

  const getOwningComponent = vi.fn((node: Node) => {
    (node as any).__ngContext__ = lContext(node, {});
    return owners.get(node) ?? null;
  });

  if (production) {
    delete (globalThis as any).ng;
    productionCore = {
      // Angular's DebugNode: the node's injector, leaving its context on it.
      injector: (node) => getInjector(node),
      // Angular's DebugNode: the node's component, or else its owning one.
      componentInstance: (node) => {
        (node as any).__ngContext__ = lContext(node, {});
        return hosts.get(node)?.instance ?? owners.get(node) ?? null;
      },
    };
  } else {
    (globalThis as any).ng = { getComponent, getDirectives, getInjector, getOwningComponent };
    if (records !== "none") (globalThis as any).ng.ɵgetInjectorProviders = getInjectorProviders;
  }

  return {
    getComponent,
    getDirectives,
    getInjector,
    getInjectorProviders,
    getOwningComponent,
    /** The view nodes are declared in unless told otherwise. */
    rootView,
    /** A new view to declare nodes in, e.g. the embedded view of an `@if`. */
    view,
    /** An element created by Angular that hosts `instance`. */
    host(tag: string, instance: object, options: NodeOptions = {}) {
      const el = document.createElement(tag);
      const view: FakeView = {
        context: instance,
        destroyed: false,
        hooks: [],
        onDestroy(cb) {
          this.hooks.push(cb);
        },
        destroy() {
          if (this.destroyed) return;
          this.destroyed = true;
          this.hooks.forEach((h) => h());
        },
      };
      hosts.set(el, { instance, view });
      const { lView, providerStart, container, template } = setUp(el, options, { host: instance });
      container.children.push(view);
      return {
        el,
        view,
        instance,
        /** Its component's template: pass it as `from` for another instance. */
        template,
        /** Angular creates the `n`th provider, e.g. when something injects it later. */
        create(n: number, created: object) {
          lView[providerStart + n] = created;
        },
      };
    },
    /**
     * A `<router-outlet>` and its RouterOutlet directive. `deactivate` does
     * what RouterOutlet does: destroy the page's view, then emit the page;
     * `activate` emits a page it has created.
     */
    outlet() {
      const el = document.createElement("router-outlet");
      const listeners: Array<(component: unknown) => void> = [];
      const activateListeners: Array<(component: unknown) => void> = [];
      const emitter = (to: Array<(component: unknown) => void>) => ({
        subscribe(next: (component: unknown) => void) {
          to.push(next);
          return { unsubscribe() {} };
        },
      });
      const outlet = { deactivateEvents: emitter(listeners), activateEvents: emitter(activateListeners) };
      setUp(el, { directives: [{ someOtherDirective: true }, outlet] });
      return {
        el,
        outlet,
        listeners,
        activateListeners,
        /**
         * `view` is the view the page's host is in (the outlet creates one per
         * page): its DestroyRef fires too, for the directives and services on
         * the host.
         */
        deactivate(page: { instance: object; view: FakeView; hostView?: FakeContainerView }) {
          if (page.hostView) page.hostView.destroy();
          page.view.destroy();
          listeners.forEach((listener) => listener(page.instance));
        },
        activate(instance: object) {
          activateListeners.forEach((listener) => listener(instance));
        },
      };
    },
    /** An element created by Angular that hosts no component. */
    plain(tag: string, options: NodeOptions = {}) {
      const el = document.createElement(tag);
      setUp(el, options);
      return el;
    },
    /**
     * The comment Angular anchors an `<ng-template>` (`kind: "template"`, e.g.
     * what `*ngIf` makes) or an `<ng-container>` with, in dev mode.
     */
    anchor(kind: "template" | "container", options: NodeOptions = {}) {
      // A production build leaves them empty.
      const text = production ? "" : kind === "template" ? "container" : "ng-container";
      const comment = document.createComment(text);
      setUp(comment, options, { type: kind === "template" ? TNODE_CONTAINER : TNODE_ELEMENT_CONTAINER });
      return comment;
    },
  };
}

/** Let the MutationObserver deliver. */
export const flushObserver = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A class as a minified production build has it: named `e`, as esbuild names
 * nearly every class, with the definition Angular's compiler adds to a
 * component (`ɵcmp`) or directive (`ɵdir`), which holds its selector as
 * written (`[["app-card"]]`, `[["", "appTooltip", ""]]`), and for a
 * component its id. Or, with no definition, a service: `@Injectable()` adds
 * its factory.
 */
export function minifiedClass(
  def?: { component?: unknown[][]; directive?: unknown[][]; id?: string },
): new () => object {
  const cls = { e: class {} }.e;
  if (def?.component) Object.assign(cls, { ɵcmp: { selectors: def.component, id: def.id ?? "c1" } });
  else if (def?.directive) Object.assign(cls, { ɵdir: { selectors: def.directive } });
  else Object.assign(cls, { ɵfac: () => new cls() });
  return cls;
}
