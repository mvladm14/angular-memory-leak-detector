// Component-level services (src/discovery.ts): what a component's or
// directive's `providers` / `viewProviders` create for its element, found in
// the element's injector, destroyed with the view the element is in, and
// reported when they leak.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeakEvent } from "../src/types";
import { fakeAngular, flushObserver, loadRuntime, simulateGc, type Runtime } from "./helpers";

/** A WeakRef whose target has been collected. */
const collected = { deref: () => undefined } as unknown as WeakRef<object>;

// Classes as Angular's compiler emits them: `@Injectable()` adds a static
// factory, `ɵfac`, which a class provider creates the instance with.
class _CartStore {
  static ɵfac = () => new _CartStore();
}
class FormState {
  static ɵfac = () => new FormState();
}
class PageStore {
  static ɵfac = () => new PageStore();
}
class CartComponent {}

describe("component-level services", () => {
  let mods: Runtime;
  let angular: ReturnType<typeof fakeAngular>;

  beforeEach(async () => {
    document.body.innerHTML = "";
    mods = await loadRuntime();
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    angular = fakeAngular(ChangeDetectorRef, { DestroyRef });
  });

  afterEach(() => {
    mods.discovery.stopDiscovery();
    delete (globalThis as any).ng;
    vi.restoreAllMocks();
  });

  const tracked = (kind?: string) =>
    [...mods.store.live]
      .filter((e) => kind === undefined || e.kind === kind)
      .map((e) => ({ name: e.componentName, kind: e.kind, host: e.host, destroyed: e.destroyedAt !== null }));

  it("finds the services a component's providers created, on its host", async () => {
    mods.discovery.startDiscovery();
    const cart = angular.host("app-cart", new CartComponent(), {
      providers: [{ instance: new _CartStore() }, { instance: new FormState() }],
    });
    document.body.appendChild(cart.el);
    await flushObserver();
    expect(tracked()).toEqual([
      { name: "CartComponent", kind: "component", host: "app-cart", destroyed: false },
      { name: "CartStore", kind: "service", host: "app-cart", destroyed: false },
      { name: "FormState", kind: "service", host: "app-cart", destroyed: false },
    ]);
  });

  it("finds the services a directive's providers created, on elements and anchors", async () => {
    mods.discovery.startDiscovery();
    class FormDirective {}
    class IfRoleDirective {}
    const form = angular.plain("form", { directives: [new FormDirective()], providers: [{ instance: new FormState() }] });
    const anchor = angular.anchor("template", { directives: [new IfRoleDirective()], providers: [{ instance: new PageStore() }] });
    document.body.append(form, anchor);
    await flushObserver();
    expect(tracked("service")).toEqual([
      { name: "FormState", kind: "service", host: "form", destroyed: false },
      { name: "PageStore", kind: "service", host: "ng-template", destroyed: false },
    ]);
  });

  it("finds a `useClass` provider's instance", async () => {
    mods.discovery.startDiscovery();
    // `{ provide: AbstractStore, useClass: CartStore }`: created with CartStore's own factory.
    document.body.appendChild(angular.host("app-cart", new CartComponent(), { providers: [{ instance: new _CartStore() }] }).el);
    await flushObserver();
    expect(tracked("service").map((t) => t.name)).toEqual(["CartStore"]);
  });

  it("ignores what the node doesn't own: useValue, useExisting, useFactory and multi providers", async () => {
    mods.discovery.startDiscovery();
    const rootService = new PageStore(); // e.g. `useExisting` a root service
    const constant = { apiUrl: "/api" }; // `useValue`
    const cart = angular.host("app-cart", new CartComponent(), {
      providers: [{ value: rootService }, { value: constant }, { multi: [new FormState(), new FormState()] }],
    });
    document.body.appendChild(cart.el);
    await flushObserver();
    expect(tracked("service")).toEqual([]);
  });

  it("never creates a service nothing has injected, and finds it on rescan once Angular has", async () => {
    mods.discovery.startDiscovery();
    const cart = angular.host("app-cart", new CartComponent(), { providers: [{ lazy: _CartStore }] });
    document.body.appendChild(cart.el);
    await flushObserver();
    expect(tracked("service")).toEqual([]);
    // Something injects it later, e.g. on a click.
    cart.create(0, new _CartStore());
    mods.discovery.rescan();
    expect(tracked("service")).toEqual([{ name: "CartStore", kind: "service", host: "app-cart", destroyed: false }]);
    // The component is still tracked once.
    expect(tracked("component")).toHaveLength(1);
  });

  it("marks services destroyed when the view their element is in is destroyed", async () => {
    mods.discovery.startDiscovery();
    const embedded = angular.view();
    const cart = angular.host("app-cart", new CartComponent(), { in: embedded, providers: [{ instance: new _CartStore() }] });
    const other = angular.host("app-cart", new CartComponent(), { providers: [{ instance: new _CartStore() }] });
    document.body.append(cart.el, other.el);
    await flushObserver();
    embedded.destroy();
    expect(tracked("service").map((t) => t.destroyed)).toEqual([true, false]);
  });

  it("holds services weakly, and the destroy hook holds no instance, node or view", async () => {
    mods.discovery.startDiscovery();
    const embedded = angular.view();
    document.body.appendChild(
      angular.host("app-cart", new CartComponent(), { in: embedded, providers: [{ instance: new _CartStore() }] }).el,
    );
    await flushObserver();
    for (const entry of mods.store.live) expect(entry.ref).toBeInstanceOf(WeakRef);
    expect(embedded.hooks).toHaveLength(1);
    expect(embedded.hooks[0]!.toString()).not.toMatch(/instance|service|node|view|el\b/);
  });

  it("tracks a service once", async () => {
    mods.discovery.startDiscovery();
    const cart = angular.host("app-cart", new CartComponent(), { providers: [{ instance: new _CartStore() }] });
    document.body.appendChild(cart.el);
    await flushObserver();
    mods.discovery.rescan();
    mods.discovery.rescan();
    expect(tracked("service")).toHaveLength(1);
  });

  it("ignores a view of an unknown shape", async () => {
    mods.discovery.startDiscovery();
    const { getInjector, getComponent } = (globalThis as any).ng;
    // Neither the lookups' context nor the injector shows a view it knows.
    const unknown = (node: Node) => ((node as any).__ngContext__ = { lView: { not: "an array" }, nodeIndex: 1 });
    (globalThis as any).ng.getComponent = (el: Element) => {
      const found = getComponent(el);
      unknown(el);
      return found;
    };
    (globalThis as any).ng.getInjector = (node: Node) => {
      const injector = { ...getInjector(node), _lView: { not: "an array" } };
      unknown(node);
      return injector;
    };
    document.body.appendChild(angular.host("app-cart", new CartComponent(), { providers: [{ instance: new _CartStore() }] }).el);
    await flushObserver();
    expect(tracked().map((t) => t.kind)).toEqual(["component"]);
  });

  it("tracks no service with `trackServices: false`, and hides those it tracked", async () => {
    vi.spyOn(console, "table").mockImplementation(() => {});
    mods.config.configure({ trackDirectives: false });
    mods.discovery.startDiscovery();
    // Providers come with a directive: `<form appForm>`, whose `providers` they are.
    const form = () => angular.plain("form", { directives: [{}], providers: [{ instance: new FormState() }] });
    document.body.appendChild(form());
    await flushObserver();
    mods.config.configure({ trackServices: false });
    document.body.appendChild(form());
    await flushObserver();
    expect(tracked()).toHaveLength(1);
    expect(mods.sweep.report()).toEqual([]);
  });

  describe("verdicts", () => {
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "table").mockImplementation(() => {});
    });

    const destroyAndCollect = (view: { destroy(): void }) => {
      view.destroy();
      mods.store.live.forEach((entry) => {
        if (entry.destroyedAt !== null) entry.destroyedAt = Date.now() - 1_000_000;
      });
      mods.sweep.sweep();
      simulateGc(mods);
      mods.sweep.sweep();
    };

    it("reports a leaked service, not the component that provided it once collected", async () => {
      const events: LeakEvent[] = [];
      mods.subscribers.subscribe((e) => events.push(e));
      mods.discovery.startDiscovery();
      const embedded = angular.view();
      const cart = angular.host("app-cart", new CartComponent(), { in: embedded, providers: [{ instance: new _CartStore() }] });
      document.body.appendChild(cart.el);
      await flushObserver();
      // The store subscribed to a root service and never unsubscribed; the
      // component itself is collected.
      mods.store.entryOf(cart.instance)!.ref = collected;
      destroyAndCollect(embedded);

      expect(events).toEqual([
        expect.objectContaining({ name: "CartStore", kind: "service", host: "app-cart", stale: 1, live: 1 }),
      ]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Suspected leak: service CartStore provided by <app-cart> — 1 instance(s) destroyed'),
      );
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('filter for "CartStore"'));
    });

    it("has the class under `name` in events, report rows and what leaked with a component", async () => {
      const events: LeakEvent[] = [];
      mods.subscribers.subscribe((e) => events.push(e));
      mods.discovery.startDiscovery();
      const embedded = angular.view();
      document.body.appendChild(
        angular.host("app-cart", new CartComponent(), { in: embedded, providers: [{ instance: new _CartStore() }] }).el,
      );
      await flushObserver();
      destroyAndCollect(embedded);
      expect(Object.keys(events[0]!).sort()).toEqual(
        ["at", "host", "kind", "leakAgeMs", "live", "name", "retained", "stale"],
      );
      expect(events[0]!.retained).toEqual([{ name: "CartStore", kind: "service", count: 1 }]);
      expect(Object.keys(mods.sweep.report()[0]!).sort()).toEqual(
        ["awaitingGc", "heldByRouter", "host", "kind", "lastCreatedSecsAgo", "live", "name", "stale", "withOwner"],
      );
    });

    it("reports components as before, now with their kind", async () => {
      const events: LeakEvent[] = [];
      mods.subscribers.subscribe((e) => events.push(e));
      mods.discovery.startDiscovery();
      const embedded = angular.view();
      document.body.appendChild(angular.host("app-cart", new CartComponent(), { in: embedded }).el);
      await flushObserver();
      destroyAndCollect(embedded);
      expect(events).toEqual([expect.objectContaining({ name: "CartComponent", kind: "component", host: "app-cart" })]);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Suspected leak: CartComponent <app-cart> — 1 instance(s)"));
      expect(mods.sweep.report()[0]).toMatchObject({ name: "CartComponent", kind: "component" });
    });
  });
});

// A class without a decorator has no `ɵfac`: Angular makes its factory up
// (`() => new CartStore()`), like the ones of `useValue`, `useExisting` and
// `useFactory` providers. How the app declared the provider, which Angular
// records in development mode (`ng.ɵgetInjectorProviders`, 16.2 and later),
// tells them apart, and the app doesn't change.
describe("component-level services without a decorator", () => {
  let mods: Runtime;
  let angular: ReturnType<typeof fakeAngular>;

  // No `ɵfac`: none of them has a decorator.
  class PlainStore {}
  class PlainBase {}
  class PlainCartStore extends PlainBase {}
  class Config {}
  const forwardRef = (fn: () => unknown) => Object.assign(fn, { __forward_ref__: true });

  const setUp = async (records: "node" | "first-view" | "none" = "node") => {
    mods = await loadRuntime();
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    angular = fakeAngular(ChangeDetectorRef, { DestroyRef, records });
    mods.discovery.startDiscovery();
  };

  beforeEach(async () => {
    document.body.innerHTML = "";
    await setUp();
  });

  afterEach(() => {
    mods.discovery.stopDiscovery();
    delete (globalThis as any).ng;
    vi.restoreAllMocks();
  });

  const services = () =>
    [...mods.store.live].filter((e) => e.kind === "service").map((e) => `${e.componentName} <${e.host}>`);

  it("tracks what a class provider created: `providers: [PlainStore]`, useClass, deps, `{ provide }`, forwardRef", async () => {
    const token = { description: "STORE" };
    document.body.appendChild(
      angular.host("app-cart", new CartComponent(), {
        providers: [
          { declared: PlainStore, instance: new PlainStore() },
          { declared: { provide: token, useClass: PlainCartStore }, instance: new PlainCartStore() },
          { declared: { provide: PlainBase, useClass: PlainCartStore, deps: [] }, instance: new PlainCartStore() },
          { declared: { provide: Config }, instance: new Config() },
          { declared: { provide: forwardRef(() => FormState), useClass: forwardRef(() => FormState) }, instance: new FormState() },
        ],
      }).el,
    );
    await flushObserver();
    expect(services()).toEqual([
      "PlainStore <app-cart>",
      "PlainCartStore <app-cart>",
      "PlainCartStore <app-cart>",
      "Config <app-cart>",
      "FormState <app-cart>",
    ]);
  });

  it("tracks view providers too", async () => {
    document.body.appendChild(
      angular.host("app-cart", new CartComponent(), {
        providers: [
          { declared: Config, instance: new Config(), isViewProvider: true },
          { declared: PlainStore, instance: new PlainStore() },
        ],
      }).el,
    );
    await flushObserver();
    expect(services()).toEqual(["Config <app-cart>", "PlainStore <app-cart>"]);
  });

  it("tells a token's view provider from its provider", async () => {
    // `viewProviders: [{ provide: Config, useValue }]` and `providers: [Config]`: two slots.
    const constant = new Config();
    document.body.appendChild(
      angular.host("app-cart", new CartComponent(), {
        providers: [
          { declared: { provide: Config, useValue: constant }, instance: constant, isViewProvider: true },
          { declared: Config, instance: new Config() },
        ],
      }).el,
    );
    await flushObserver();
    const [entry, ...others] = [...mods.store.live].filter((e) => e.kind === "service");
    expect(others).toEqual([]);
    expect(entry!.ref.deref()).not.toBe(constant);
  });

  it("never tracks what useValue, useExisting, useFactory or multi providers gave", async () => {
    const shared = new PlainStore();
    document.body.appendChild(
      angular.host("app-cart", new CartComponent(), {
        providers: [
          { declared: { provide: Config, useValue: new Config() }, instance: new Config() },
          { declared: { provide: PlainBase, useExisting: PlainCartStore }, instance: new PlainCartStore() },
          { declared: { provide: PlainStore, useFactory: () => shared }, instance: shared },
          // `useValue: undefined` is still a value provider.
          { declared: { provide: FormState, useValue: undefined }, instance: new FormState() },
        ],
      }).el,
    );
    await flushObserver();
    expect(services()).toEqual([]);
  });

  it("doesn't track an instance of another class than its provider's", async () => {
    document.body.appendChild(
      angular.host("app-cart", new CartComponent(), { providers: [{ declared: PlainStore, instance: new Config() }] }).el,
    );
    await flushObserver();
    expect(services()).toEqual([]);
  });

  it("doesn't track a slot whose records disagree", async () => {
    // Two records for one token and slot, saying different things.
    const cart = angular.host("app-cart", new CartComponent(), { providers: [{ declared: PlainStore, instance: new PlainStore() }] });
    const [record] = angular.getInjectorProviders(angular.getInjector(cart.el)) as any[];
    angular.getInjectorProviders.mockImplementation(() => [{ ...record, provider: { provide: PlainStore, useValue: {} } }, record]);
    document.body.appendChild(cart.el);
    await flushObserver();
    expect(services()).toEqual([]);
  });

  it("never creates a service nothing has injected", async () => {
    document.body.appendChild(angular.host("app-cart", new CartComponent(), { providers: [{ declared: PlainStore }] }).el);
    await flushObserver();
    expect(services()).toEqual([]);
  });

  it("reports a leaked one, and marks it destroyed with its view", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: LeakEvent[] = [];
    mods.subscribers.subscribe((e) => events.push(e));
    const embedded = angular.view();
    const cart = angular.host("app-cart", new CartComponent(), {
      in: embedded,
      providers: [{ declared: PlainStore, instance: new PlainStore() }],
    });
    document.body.appendChild(cart.el);
    await flushObserver();
    mods.store.entryOf(cart.instance)!.ref = collected;
    embedded.destroy();
    mods.store.live.forEach((entry) => (entry.destroyedAt = Date.now() - 1_000_000));
    mods.sweep.sweep();
    simulateGc(mods);
    mods.sweep.sweep();
    expect(events).toEqual([expect.objectContaining({ name: "PlainStore", kind: "service", host: "app-cart" })]);
  });

  it("changes nothing in the app's classes", async () => {
    document.body.appendChild(
      angular.host("app-cart", new CartComponent(), { providers: [{ declared: PlainStore, instance: new PlainStore() }] }).el,
    );
    await flushObserver();
    expect(services()).toEqual(["PlainStore <app-cart>"]);
    expect(Object.getOwnPropertyNames(PlainStore).sort()).toEqual(["length", "name", "prototype"]);
  });

  it("on Angular 16.2, remembers what the first view of a template said for the others", async () => {
    await setUp("first-view");
    const first = angular.host("app-cart", new CartComponent(), { providers: [{ declared: PlainStore, instance: new PlainStore() }] });
    const second = angular.host("app-cart", new CartComponent(), {
      from: first.template,
      providers: [{ declared: PlainStore, instance: new PlainStore() }],
    });
    expect(angular.getInjectorProviders(angular.getInjector(second.el))).toEqual([]);
    document.body.append(first.el, second.el);
    await flushObserver();
    expect(services()).toEqual(["PlainStore <app-cart>", "PlainStore <app-cart>"]);
  });

  it("on Angular 16.2, doesn't guess for a template whose first view it never saw", async () => {
    await setUp("first-view");
    const first = angular.host("app-cart", new CartComponent(), { providers: [{ declared: PlainStore, instance: new PlainStore() }] });
    const second = angular.host("app-cart", new CartComponent(), {
      from: first.template,
      providers: [{ declared: PlainStore, instance: new PlainStore() }],
    });
    document.body.append(second.el); // the first one was gone before the detector started
    await flushObserver();
    expect(services()).toEqual([]);
  });

  it("on Angular 16.0 and 16.1, tracks only classes with a decorator", async () => {
    await setUp("none");
    document.body.appendChild(
      angular.host("app-cart", new CartComponent(), {
        providers: [{ declared: PlainStore, instance: new PlainStore() }, { instance: new _CartStore() }],
      }).el,
    );
    await flushObserver();
    expect(services()).toEqual(["CartStore <app-cart>"]);
  });

  it("ignores records it can't read", async () => {
    angular.getInjectorProviders.mockImplementation(() => {
      throw new Error("getInjectorProviders only supports NodeInjector and EnvironmentInjector");
    });
    document.body.appendChild(
      angular.host("app-cart", new CartComponent(), {
        providers: [{ declared: PlainStore, instance: new PlainStore() }, { instance: new _CartStore() }],
      }).el,
    );
    await flushObserver();
    expect(services()).toEqual(["CartStore <app-cart>"]);
  });

  it("asks for the records only when a slot needs them", async () => {
    document.body.appendChild(angular.host("app-cart", new CartComponent(), { providers: [{ instance: new _CartStore() }] }).el);
    await flushObserver();
    expect(services()).toEqual(["CartStore <app-cart>"]);
    expect(angular.getInjectorProviders).not.toHaveBeenCalled();
  });
});
