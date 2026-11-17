// Production builds: the detector started with startProductionMemoryLeakDetector
// (src/detector.ts) runs where Angular publishes no debugging API, making the
// same lookups without it (src/production.ts), and in a minified build names
// classes by what minification keeps: selectors, and where services are
// provided (src/names.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeakEvent } from "../src/types";
import { fakeAngular, flushObserver, loadRuntime, minifiedClass, simulateGc, type Runtime } from "./helpers";

/** A WeakRef whose target has been collected. */
const collected = { deref: () => undefined } as unknown as WeakRef<object>;

type Angular = ReturnType<typeof fakeAngular>;

/** A production build of Angular `major`, minified or not, with the detector's discovery running on it. */
async function productionBuild({ minified = true, angular: major = 22 }: { minified?: boolean; angular?: number } = {}) {
  const mods = await loadRuntime({ production: true, minified, angular: major });
  const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
  const angular = fakeAngular(ChangeDetectorRef, { DestroyRef, production: true, angular: major });
  // What startProductionMemoryLeakDetector does before discovery starts.
  mods.discovery.useWithoutDebugApi(mods.production.productionApi());
  return { mods, angular };
}

const trackedIn = (mods: Runtime) =>
  [...mods.store.live].map((e) => ({ name: e.componentName, kind: e.kind, host: e.host, destroyed: e.destroyedAt !== null }));

/** Destroy `view`, let every destroyed instance go stale, then a garbage collection and a sweep. */
function destroyAndCollect(mods: Runtime, view: { destroy(): void }) {
  view.destroy();
  mods.store.live.forEach((entry) => {
    if (entry.destroyedAt !== null) entry.destroyedAt = Date.now() - 1_000_000;
  });
  mods.sweep.sweep();
  simulateGc(mods);
  mods.sweep.sweep();
}

afterEach(() => {
  delete (globalThis as any).ng;
  delete (globalThis as any).ngDevMode;
  delete window.__ngLeakDetector;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("startProductionMemoryLeakDetector", () => {
  let mods: Runtime | undefined;

  afterEach(() => {
    mods?.discovery.stopDiscovery();
    mods = undefined;
  });

  it("runs in production mode, where startMemoryLeakDetector does nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let angular: Angular;
    ({ mods, angular } = await productionBuild());
    mods.discovery.useWithoutDebugApi(null);
    (globalThis as any).ngDevMode = false;
    const Card = minifiedClass({ component: [["app-card"]] });
    document.body.appendChild(angular.host("app-card", new Card()).el);

    expect(mods.detector.startMemoryLeakDetector()).toBeNull();
    expect(window.__ngLeakDetector).toBeUndefined();

    const api = mods.detector.startProductionMemoryLeakDetector({ leakAgeMs: 5_000 });
    expect(api).not.toBeNull();
    expect(window.__ngLeakDetector).toBe(api);
    expect(mods.config._config.leakAgeMs).toBe(5_000);
    expect(trackedIn(mods)).toEqual([{ name: "app-card", kind: "component", host: "app-card", destroyed: false }]);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        "[ng-leak] Memory leak detector running in a production build, without Angular's debugging API, classes named by selector (minified build) (1 components",
      ),
    );
  });

  it("says nothing of production in development, where it is startMemoryLeakDetector", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    mods = await loadRuntime();
    const { ChangeDetectorRef } = await import("@angular/core");
    const angular = fakeAngular(ChangeDetectorRef);
    class CardComponent {}
    document.body.appendChild(angular.host("app-card", new CardComponent()).el);
    mods.detector.startProductionMemoryLeakDetector();
    // Angular's debugging API, not the production lookups.
    expect(angular.getComponent).toHaveBeenCalled();
    expect(mods.discovery.runsWithoutDebugApi()).toBe(false);
    expect(trackedIn(mods)).toEqual([{ name: "CardComponent", kind: "component", host: "app-card", destroyed: false }]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("[ng-leak] Memory leak detector running (1 components"));
  });

  it("only applies its options once a detector runs", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    mods = await loadRuntime();
    const { ChangeDetectorRef } = await import("@angular/core");
    fakeAngular(ChangeDetectorRef);
    const api = mods.detector.startMemoryLeakDetector();
    expect(mods.detector.startProductionMemoryLeakDetector({ leakAgeMs: 7_000 })).toBe(api);
    expect(mods.config._config.leakAgeMs).toBe(7_000);
  });

  it("warns if Angular has rendered the app but it can't see its components", async () => {
    // As if a later Angular laid its views out in a way the detector doesn't
    // know: the root component's host is there, the detector finds nothing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    ({ mods } = await productionBuild());
    const root = document.createElement("app-root");
    root.setAttribute("ng-version", "23.0.0");
    (root as any).__ngContext__ = 1;
    document.body.appendChild(root);
    mods.detector.startProductionMemoryLeakDetector();
    expect(warn).toHaveBeenCalledWith(
      "[ng-leak] Found none of this app's components, although Angular 23.0.0 has rendered <app-root>: this version of Angular may keep them in a way this version of the detector doesn't know (it supports Angular 16 to 22). It will report no leaks.",
    );
  });

  it("doesn't warn when it sees the app's components, or before Angular has rendered it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    let angular: Angular;
    ({ mods, angular } = await productionBuild());
    // Not rendered yet: started by hand before bootstrap.
    mods.detector.startProductionMemoryLeakDetector();
    delete window.__ngLeakDetector;
    mods.discovery.stopDiscovery();

    ({ mods, angular } = await productionBuild());
    const App = minifiedClass({ component: [["app-root"]] });
    const app = angular.host("app-root", new App());
    app.el.setAttribute("ng-version", "22.2.5");
    document.body.appendChild(app.el);
    mods.detector.startProductionMemoryLeakDetector();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does nothing on the server", async () => {
    mods = await loadRuntime({ production: true });
    vi.stubGlobal("window", undefined);
    try {
      expect(mods.detector.startProductionMemoryLeakDetector()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("provideProductionMemoryLeakDetector", () => {
  it("provides the detector in production mode, where provideMemoryLeakDetector provides nothing", async () => {
    const mods = await loadRuntime();
    const { provideMemoryLeakDetector, provideProductionMemoryLeakDetector } = await import("../src/index");
    (globalThis as any).ngDevMode = false;
    const providers = (p: unknown) => (p as { ɵproviders: unknown[] }).ɵproviders;
    expect(providers(provideMemoryLeakDetector())).toEqual([]);
    const { APP_BOOTSTRAP_LISTENER } = await import("@angular/core");
    expect(providers(provideProductionMemoryLeakDetector())).toEqual([
      expect.objectContaining({ provide: APP_BOOTSTRAP_LISTENER, multi: true }),
    ]);
    mods.discovery.stopDiscovery();
  });
});

describe("discovery without Angular's debugging API", () => {
  let mods: Runtime;
  let angular: Angular;

  beforeEach(async () => {
    ({ mods, angular } = await productionBuild());
  });

  afterEach(() => {
    mods.discovery.stopDiscovery();
  });

  const tracked = () => trackedIn(mods);

  it("finds components, directives and the services they provide", async () => {
    mods.discovery.startDiscovery();
    const Cart = minifiedClass({ component: [["app-cart"]] });
    const Tooltip = minifiedClass({ directive: [["", "appTooltip", ""]] });
    const Store = minifiedClass();
    const cart = angular.host("app-cart", new Cart(), { providers: [{ instance: new Store() }] });
    cart.el.appendChild(angular.plain("button", { directives: [new Tooltip()] }));
    document.body.appendChild(cart.el);
    await flushObserver();
    expect(tracked()).toEqual([
      { name: "app-cart", kind: "component", host: "app-cart", destroyed: false },
      { name: "app-cart providers[0]", kind: "service", host: "app-cart", destroyed: false },
      { name: "[appTooltip]", kind: "directive", host: "button", destroyed: false },
    ]);
    // Through DebugNode's injector, as in a production build.
    expect(angular.getInjector).toHaveBeenCalledWith(cart.el);
  });

  it("tells templates from containers, whose comments are empty in production", async () => {
    mods.discovery.startDiscovery();
    const IfRole = minifiedClass({ directive: [["", "appIfRole", ""]] });
    const TrackVisible = minifiedClass({ directive: [["", "appTrackVisible", ""]] });
    const template = angular.anchor("template", { directives: [new IfRole()] });
    const container = angular.anchor("container", { directives: [new TrackVisible()] });
    expect([template.data, container.data]).toEqual(["", ""]);
    document.body.append(template, container);
    await flushObserver();
    expect(tracked()).toEqual([
      { name: "[appIfRole]", kind: "directive", host: "ng-template", destroyed: false },
      { name: "[appTrackVisible]", kind: "directive", host: "ng-container", destroyed: false },
    ]);
  });

  it("marks what Angular destroys", async () => {
    mods.discovery.startDiscovery();
    const Card = minifiedClass({ component: [["app-card"]] });
    const Highlight = minifiedClass({ directive: [["", "appHighlight", ""]] });
    const embedded = angular.view();
    const card = angular.host("app-card", new Card(), { in: embedded, directives: [new Highlight()] });
    document.body.appendChild(card.el);
    await flushObserver();
    expect(tracked().map((t) => t.destroyed)).toEqual([false, false]);
    embedded.destroy();
    expect(tracked().map((t) => t.destroyed)).toEqual([true, true]);
  });

  it("puts back the nodes' original context, and holds no instance", async () => {
    mods.discovery.startDiscovery();
    const Card = minifiedClass({ component: [["app-card"]] });
    const IfRole = minifiedClass({ directive: [["", "appIfRole", ""]] });
    const card = angular.host("app-card", new Card());
    const anchor = angular.anchor("template", { directives: [new IfRole()] });
    const before = [(card.el as any).__ngContext__, (anchor as any).__ngContext__];
    document.body.append(card.el, anchor);
    await flushObserver();
    expect(angular.getInjector).toHaveBeenCalledWith(card.el);
    expect([(card.el as any).__ngContext__, (anchor as any).__ngContext__]).toEqual(before);
    for (const entry of mods.store.live) expect(entry.ref).toBeInstanceOf(WeakRef);
    expect(card.view.hooks).toHaveLength(1);
    expect(card.view.hooks[0]!.toString()).not.toMatch(/instance|view|el\b/);
  });

  it("finds no service whose class has no decorator, and none a provider hands out", async () => {
    // Production builds record no provider declarations
    // (`ng.ɵgetInjectorProviders`): without its own factory, a class provider
    // can't be told from a `useValue` one.
    mods.discovery.startDiscovery();
    const Cart = minifiedClass({ component: [["app-cart"]] });
    const Plain = { e: class {} }.e;
    const Labels = { e: class {} }.e;
    const cart = angular.host("app-cart", new Cart(), {
      providers: [{ declared: Plain, instance: new Plain() }, { value: new Labels() }],
    });
    document.body.appendChild(cart.el);
    await flushObserver();
    expect(tracked()).toEqual([{ name: "app-cart", kind: "component", host: "app-cart", destroyed: false }]);
  });

  it("links what is in a component's template to it", async () => {
    mods.discovery.startDiscovery();
    const Card = minifiedClass({ component: [["app-card"]] });
    const Highlight = minifiedClass({ directive: [["", "appHighlight", ""]] });
    const card = angular.host("app-card", new Card());
    const inTemplate = angular.view();
    const p = angular.plain("p", { in: inTemplate, directives: [new Highlight()], owner: card.instance });
    card.el.appendChild(p);
    document.body.appendChild(card.el);
    await flushObserver();
    const [highlight] = [...mods.store.live].filter((e) => e.kind === "directive");
    expect(highlight!.owner).toBe(mods.store.entryOf(card.instance));
  });

  it("uses Angular's debugging API where it is published", async () => {
    // A development build with the detector that runs in production too.
    mods = await loadRuntime();
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    angular = fakeAngular(ChangeDetectorRef, { DestroyRef });
    mods.discovery.useWithoutDebugApi(mods.production.productionApi());
    mods.discovery.startDiscovery();
    class CardComponent {}
    document.body.appendChild(angular.host("app-card", new CardComponent()).el);
    await flushObserver();
    expect(mods.discovery.runsWithoutDebugApi()).toBe(false);
    expect(angular.getComponent).toHaveBeenCalled();
    expect(tracked()).toEqual([{ name: "CardComponent", kind: "component", host: "app-card", destroyed: false }]);
  });
});

describe("names in a minified build", () => {
  let mods: Runtime;
  let angular: Angular;

  beforeEach(async () => {
    ({ mods, angular } = await productionBuild());
  });

  afterEach(() => {
    mods.discovery.stopDiscovery();
  });

  const nameOf = (def: Parameters<typeof minifiedClass>[0]) => {
    const Cls = minifiedClass(def);
    return mods.names.namesOf(new Cls()).name;
  };

  it("names components and directives by their selector, as Angular writes it", () => {
    expect(nameOf({ component: [["app-user-card"]] })).toBe("app-user-card");
    expect(nameOf({ directive: [["", "appTooltip", ""]] })).toBe("[appTooltip]");
    expect(nameOf({ directive: [["button", "mat-button", ""]] })).toBe("button[mat-button]");
    expect(nameOf({ directive: [["input", "type", "checkbox", "ngModel", ""]] })).toBe('input[type="checkbox"][ngModel]');
    expect(nameOf({ directive: [["", 8, "card", "large"]] })).toBe(".card.large");
    expect(nameOf({ directive: [["", "routerLink", "", 5, "a"]] })).toBe("[routerLink]:not(a)");
    expect(nameOf({ directive: [["a", "appLink", ""], ["area", "appLink", ""]] })).toBe("a[appLink],area[appLink]");
  });

  it("names a component that declares no selector by its component id", () => {
    expect(nameOf({ component: [["ng-component"]], id: "c2736387395" })).toBe("ng-component (c2736387395)");
  });

  it("keeps the minified class name under className", () => {
    const Card = minifiedClass({ component: [["app-card"]] });
    expect(mods.names.namesOf(new Card())).toEqual({ name: "app-card", className: "e" });
  });

  it("gives classes that share a selector that one name", () => {
    expect(nameOf({ directive: [["", "appTooltip", ""]] })).toBe("[appTooltip]");
    expect(nameOf({ directive: [["", "appTooltip", ""]] })).toBe("[appTooltip]");
  });

  it("names a class the same for all its instances", () => {
    const Card = minifiedClass({ component: [["app-card"]] });
    expect(new Set([new Card(), new Card()].map((card) => mods.names.namesOf(card).name))).toEqual(new Set(["app-card"]));
  });

  it("names services by the element that provides them and their place among its providers, view providers first", async () => {
    mods.discovery.startDiscovery();
    const Cart = minifiedClass({ component: [["app-cart"]] });
    const Form = minifiedClass({ directive: [["form", "appForm", ""]] });
    const [Store, Api, ViewState, FormState] = [minifiedClass(), minifiedClass(), minifiedClass(), minifiedClass()];
    const cart = angular.host("app-cart", new Cart(), {
      providers: [{ instance: new Store() }, { instance: new Api() }, { instance: new ViewState(), isViewProvider: true }],
    });
    cart.el.appendChild(angular.plain("form", { directives: [new Form()], providers: [{ instance: new FormState() }] }));
    document.body.appendChild(cart.el);
    await flushObserver();
    expect([...mods.store.live].filter((e) => e.kind === "service").map((e) => [e.componentName, e.host])).toEqual([
      ["app-cart viewProviders[0]", "app-cart"],
      ["app-cart providers[0]", "app-cart"],
      ["app-cart providers[1]", "app-cart"],
      ["form[appForm] providers[0]", "form"],
    ]);
  });

  it("keeps class names where the build does, and renames no class", async () => {
    ({ mods, angular } = await productionBuild({ minified: false }));
    mods.discovery.startDiscovery();
    class CartComponent {
      static ɵcmp = { selectors: [["app-cart"]] };
    }
    class CartStore {
      static ɵfac = () => new CartStore();
    }
    document.body.appendChild(angular.host("app-cart", new CartComponent(), { providers: [{ instance: new CartStore() }] }).el);
    await flushObserver();
    expect(trackedIn(mods).map((t) => t.name)).toEqual(["CartComponent", "CartStore"]);
    expect([CartComponent.name, CartStore.name]).toEqual(["CartComponent", "CartStore"]);
  });

  it("goes by the names ng-leak-names restored", async () => {
    // What a class looks like once ng-leak-names has run on a minified build:
    // its minified binding, `e`, and its name back as a static field.
    ({ mods, angular } = await productionBuild({ minified: false }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mods.discovery.startDiscovery();
    const Timer = {
      e: class {
        static name = "LeakyTimerComponent";
        static ɵcmp = { selectors: [["app-leaky-timer"]] };
      },
    }.e;
    const embedded = angular.view();
    document.body.appendChild(angular.host("app-leaky-timer", new Timer(), { in: embedded }).el);
    await flushObserver();
    destroyAndCollect(mods, embedded);
    expect(console.warn).toHaveBeenCalledWith(
      '[ng-leak] Suspected leak: LeakyTimerComponent <app-leaky-timer> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Take a heap snapshot and filter for "LeakyTimerComponent" to see what holds it.',
    );
  });

  it("gives a minified class the name it goes by as its `name`, which a heap snapshot shows, if asked", async () => {
    mods.config.configure({ renameMinifiedClasses: true });
    mods.discovery.startDiscovery();
    const Cart = minifiedClass({ component: [["app-cart"]] });
    const Tooltip = minifiedClass({ directive: [["", "appTooltip", ""]] });
    const Store = minifiedClass();
    const cart = angular.host("app-cart", new Cart(), { directives: [new Tooltip()], providers: [{ instance: new Store() }] });
    document.body.appendChild(cart.el);
    await flushObserver();
    expect([Cart.name, Tooltip.name, Store.name]).toEqual(["app-cart", "[appTooltip]", "app-cart providers[0]"]);
    // What the detector reports, and calls the class at runtime.
    expect(mods.names.namesOf(cart.instance)).toEqual({ name: "app-cart", className: "app-cart" });
  });

  it("renames no class unless asked, and says the class name is minified", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(mods.config._config.renameMinifiedClasses).toBe(false);
    mods.discovery.startDiscovery();
    const Card = minifiedClass({ component: [["app-card"]] });
    const embedded = angular.view();
    document.body.appendChild(angular.host("app-card", new Card(), { in: embedded }).el);
    await flushObserver();
    expect(Card.name).toBe("e");
    destroyAndCollect(mods, embedded);
    expect(console.warn).toHaveBeenCalledWith(
      '[ng-leak] Suspected leak: component <app-card> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Its class is minified ("e"): to see what holds it in a heap snapshot, restore class names with ng-leak-names if the build has source maps, or reproduce the leak in a development build.',
    );
  });

  it("knows a build that keeps class names", async () => {
    mods.names.setClassNamesMinified(undefined);
    // Unit tests run the detector's own code as written.
    expect(mods.names.classNamesMinified()).toBe(false);
  });
});

describe("names that don't depend on what was seen first", () => {
  // The same app, in two sessions that render its parts in opposite orders:
  // every leak must be reported under the same name in both, or leaks from
  // many sessions can't be grouped.

  /** The app's classes, afresh for each session, as each page load has its own. */
  function app() {
    return {
      Cart: minifiedClass({ component: [["app-cart"]] }),
      MiniCart: minifiedClass({ component: [["app-mini-cart"]] }),
      Tooltip: minifiedClass({ directive: [["", "appTooltip", ""]] }),
      // Another library's directive with the same selector.
      OtherTooltip: minifiedClass({ directive: [["", "appTooltip", ""]] }),
      // A service both carts provide, the cart second of its two.
      Store: minifiedClass(),
      Api: minifiedClass(),
    };
  }

  /** What each part of `app` is reported as, once rendered in `order`. */
  async function session(order: Array<"cart" | "mini" | "tooltip" | "other">) {
    const { mods, angular } = await productionBuild();
    const classes = app();
    const { Cart, MiniCart, Tooltip, OtherTooltip, Store, Api } = classes;
    const parts = {
      cart: () => angular.host("app-cart", new Cart(), { providers: [{ instance: new Api() }, { instance: new Store() }] }).el,
      mini: () => angular.host("app-mini-cart", new MiniCart(), { providers: [{ instance: new Store() }] }).el,
      tooltip: () => angular.plain("button", { directives: [new Tooltip()] }),
      other: () => angular.plain("a", { directives: [new OtherTooltip()] }),
    };
    mods.discovery.startDiscovery();
    for (const part of order) {
      document.body.appendChild(parts[part]());
      await flushObserver();
    }
    const named = [...mods.store.live].map((entry) => {
      const instance = entry.ref.deref()!;
      const role = Object.entries(classes).find(([, cls]) => instance instanceof cls)![0];
      return `${role}@${entry.host}: ${entry.componentName}`;
    });
    mods.discovery.stopDiscovery();
    document.body.innerHTML = "";
    return named.sort();
  }

  it("names every instance the same, whatever the order things are rendered in", async () => {
    const first = await session(["cart", "mini", "tooltip", "other"]);
    const second = await session(["other", "tooltip", "mini", "cart"]);
    expect(second).toEqual(first);
    expect(first).toEqual([
      "Api@app-cart: app-cart providers[0]",
      "Cart@app-cart: app-cart",
      "MiniCart@app-mini-cart: app-mini-cart",
      "OtherTooltip@a: [appTooltip]",
      // Each instance of a service by where it is provided.
      "Store@app-cart: app-cart providers[1]",
      "Store@app-mini-cart: app-mini-cart providers[0]",
      "Tooltip@button: [appTooltip]",
    ]);
  });
});

describe("a service provided in several places, in a minified build", () => {
  let mods: Runtime;
  let angular: Angular;
  const Cart = minifiedClass({ component: [["app-cart"]] });
  const MiniCart = minifiedClass({ component: [["app-mini-cart"]] });

  beforeEach(async () => {
    ({ mods, angular } = await productionBuild());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Classes renamed: what a heap snapshot calls the class is then a name of its own.
    mods.config.configure({ renameMinifiedClasses: true });
    mods.discovery.startDiscovery();
  });

  afterEach(() => {
    mods.discovery.stopDiscovery();
  });

  /** Both carts provide a Store, each in a view of its own. */
  async function render(Store: new () => object) {
    const cartView = angular.view();
    const miniView = angular.view();
    const cart = angular.host("app-cart", new Cart(), { in: cartView, providers: [{ instance: new Store() }] });
    document.body.appendChild(cart.el);
    await flushObserver();
    const mini = angular.host("app-mini-cart", new MiniCart(), { in: miniView, providers: [{ instance: new Store() }] });
    document.body.appendChild(mini.el);
    await flushObserver();
    // The carts are collected: only the services leak.
    for (const host of [cart, mini]) mods.store.entryOf(host.instance)!.ref = collected;
    return { cartView, miniView };
  }

  it("reports each place's leak under its own name, saying what its class is called in a heap snapshot", async () => {
    const Store = minifiedClass();
    const { miniView } = await render(Store);
    // The class goes by where it was first seen provided.
    expect(Store.name).toBe("app-cart providers[0]");
    destroyAndCollect(mods, miniView);
    expect(console.warn).toHaveBeenCalledWith(
      '[ng-leak] Suspected leak: service app-mini-cart providers[0] — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Take a heap snapshot and filter for "app-cart providers[0]", what its class is called there, to see what holds it.',
    );
    expect(mods.sweep.report().find((r) => r.kind === "service" && r.stale === 1)).toMatchObject({
      name: "app-mini-cart providers[0]",
      host: "app-mini-cart",
    });
  });

  it("excludes a service class wherever it is provided", async () => {
    const Store = minifiedClass();
    mods.config.configure({ exclude: [Store] });
    const { cartView, miniView } = await render(Store);
    destroyAndCollect(mods, cartView);
    destroyAndCollect(mods, miniView);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("service"));
    expect(mods.sweep.report().filter((r) => r.kind === "service")).toEqual([]);
  });
});

describe("names in a build that minifies the app's code only", () => {
  // Angular 17's dev server, serving an optimized configuration, minifies the
  // app's code but not its dependencies (the detector's included), and keeps
  // Angular's debugging API: the detector's own classes keep their names.
  let mods: Runtime;
  let angular: Angular;

  beforeEach(async () => {
    mods = await loadRuntime();
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    angular = fakeAngular(ChangeDetectorRef, { DestroyRef });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    mods.discovery.stopDiscovery();
  });

  it("names the app's minified classes as in a minified build, and keeps the others' names", async () => {
    expect(mods.names.classNamesMinified()).toBe(false);
    mods.discovery.startDiscovery();
    const Card = minifiedClass({ component: [["app-card"]] });
    const Store = minifiedClass();
    class RouterLink {}
    const card = angular.host("app-card", new Card(), { directives: [new RouterLink()], providers: [{ instance: new Store() }] });
    document.body.appendChild(card.el);
    await flushObserver();
    expect(trackedIn(mods).map((t) => t.name)).toEqual(["app-card", "RouterLink", "app-card providers[0]"]);
  });

  it("words warnings for each class as its name calls for", async () => {
    const Card = minifiedClass({ component: [["app-card"]] });
    class TooltipDirective {}
    mods.config.configure({ renameMinifiedClasses: true });
    mods.discovery.startDiscovery();
    const embedded = angular.view();
    document.body.append(
      angular.host("app-card", new Card(), { in: embedded }).el,
      angular.plain("p", { in: embedded, directives: [new TooltipDirective()] }),
    );
    await flushObserver();
    destroyAndCollect(mods, embedded);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Suspected leak: component <app-card> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Take a heap snapshot and filter for "app-card"'),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Suspected leak: directive TooltipDirective on <p> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Take a heap snapshot and filter for "TooltipDirective"'),
    );
  });
});

describe("verdicts in a minified production build", () => {
  let mods: Runtime;
  let angular: Angular;
  const events: LeakEvent[] = [];

  beforeEach(async () => {
    ({ mods, angular } = await productionBuild());
    events.length = 0;
    mods.subscribers.subscribe((e) => events.push(e));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "table").mockImplementation(() => {});
    mods.discovery.startDiscovery();
  });

  afterEach(() => {
    mods.discovery.stopDiscovery();
  });

  it("reports a leaked component by its selector, and not its fixed twin once collected", async () => {
    const Leaky = minifiedClass({ component: [["app-leaky-timer"]] });
    const Fixed = minifiedClass({ component: [["app-fixed-timer"]] });
    const embedded = angular.view();
    const leaky = angular.host("app-leaky-timer", new Leaky(), { in: embedded });
    const fixed = angular.host("app-fixed-timer", new Fixed(), { in: embedded });
    document.body.append(leaky.el, fixed.el);
    await flushObserver();
    // What a collection does to the one that cleaned up.
    mods.store.entryOf(fixed.instance)!.ref = collected;
    destroyAndCollect(mods, embedded);

    expect(events).toEqual([
      expect.objectContaining({ name: "app-leaky-timer", kind: "component", host: "app-leaky-timer", stale: 1, live: 1 }),
    ]);
    // By default the class keeps its minified name: the warning says so.
    expect(console.warn).toHaveBeenCalledWith(
      '[ng-leak] Suspected leak: component <app-leaky-timer> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Its class is minified ("e"): to see what holds it in a heap snapshot, restore class names with ng-leak-names if the build has source maps, or reproduce the leak in a development build.',
    );
    expect(Leaky.name).toBe("e");
    expect(mods.sweep.report()).toEqual([expect.objectContaining({ name: "app-leaky-timer", stale: 1 })]);
  });

  it("reports a leaked directive and a leaked service", async () => {
    const Tooltip = minifiedClass({ directive: [["", "appTooltip", ""]] });
    const Cart = minifiedClass({ component: [["app-cart"]] });
    const Store = minifiedClass();
    const embedded = angular.view();
    const cart = angular.host("app-cart", new Cart(), { in: embedded, providers: [{ instance: new Store() }] });
    document.body.append(angular.plain("p", { in: embedded, directives: [new Tooltip()] }), cart.el);
    await flushObserver();
    // The component was collected: the service leaked on its own.
    mods.store.entryOf(cart.instance)!.ref = collected;
    destroyAndCollect(mods, embedded);

    expect(events.map((e) => [e.kind, e.name, e.host])).toEqual([
      ["directive", "[appTooltip]", "p"],
      ["service", "app-cart providers[0]", "app-cart"],
    ]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Suspected leak: directive [appTooltip] on <p> — 1 instance(s)"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Suspected leak: service app-cart providers[0] — 1 instance(s)"));
  });

  it("names what leaked with a component in its warning", async () => {
    const Card = minifiedClass({ component: [["app-card"]] });
    const Highlight = minifiedClass({ directive: [["", "appHighlight", ""]] });
    const State = minifiedClass();
    const embedded = angular.view();
    const card = angular.host("app-card", new Card(), { in: embedded, providers: [{ instance: new State() }] });
    const inTemplate = angular.view();
    card.el.append(
      angular.plain("p", { in: inTemplate, directives: [new Highlight()], owner: card.instance }),
      angular.plain("a", { in: inTemplate, directives: [new Highlight()], owner: card.instance }),
    );
    document.body.appendChild(card.el);
    await flushObserver();
    inTemplate.destroy();
    destroyAndCollect(mods, embedded);

    expect(events).toEqual([
      expect.objectContaining({
        name: "app-card",
        retained: [
          { name: "[appHighlight]", kind: "directive", count: 2 },
          { name: "app-card providers[0]", kind: "service", count: 1 },
        ],
      }),
    ]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Suspected leak: component <app-card> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total), together with 2 directive(s) and 1 service(s) of its own: [appHighlight] ×2, app-card providers[0].",
      ),
    );
  });

  it("names a component on an element of another name by selector and tag", async () => {
    const Button = minifiedClass({ component: [["button", "app-button", ""]] });
    const embedded = angular.view();
    document.body.appendChild(angular.host("button", new Button(), { in: embedded }).el);
    await flushObserver();
    destroyAndCollect(mods, embedded);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Suspected leak: component button[app-button] <button> —"));
  });

  it("never reports classes excluded by class or by selector", async () => {
    const Cache = minifiedClass({ component: [["app-cache"]] });
    const Tooltip = minifiedClass({ directive: [["", "appTooltip", ""]] });
    mods.config.configure({ exclude: [Cache, "[appTooltip]"] });
    const embedded = angular.view();
    document.body.append(
      angular.host("app-cache", new Cache(), { in: embedded }).el,
      angular.plain("p", { in: embedded, directives: [new Tooltip()] }),
    );
    await flushObserver();
    destroyAndCollect(mods, embedded);
    expect(events).toEqual([]);
    expect(mods.sweep.report()).toEqual([]);
  });
});

describe("pages the router keeps, in a production build", () => {
  it("on Angular 20, watches router outlets without the debugging API", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "table").mockImplementation(() => {});
    const { mods, angular } = await productionBuild({ angular: 20 });
    const outlet = angular.outlet();
    const Home = minifiedClass({ component: [["app-home"]] });
    const home = angular.host("app-home", new Home());
    mods.discovery.startDiscovery();
    document.body.append(outlet.el, home.el);
    await flushObserver();
    const events: LeakEvent[] = [];
    mods.subscribers.subscribe((e) => events.push(e));

    outlet.deactivate(home);
    outlet.activate({});
    await Promise.resolve();
    mods.store.live.forEach((entry) => {
      if (entry.destroyedAt !== null) entry.destroyedAt = Date.now() - 1_000_000;
    });
    mods.sweep.sweep();
    simulateGc(mods);
    mods.sweep.sweep();
    expect(events).toEqual([]);
    expect(mods.sweep.report().find((r) => r.name === "app-home")).toMatchObject({ heldByRouter: 1 });
    mods.discovery.stopDiscovery();
  });
});
