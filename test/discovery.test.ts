import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntime, type Runtime } from "./helpers";

type FakeView = {
  context: unknown;
  destroyed: boolean;
  hooks: Array<() => void>;
  onDestroy(cb: () => void): void;
  destroy(): void;
};

/**
 * A stand-in for Angular's dev-mode `window.ng`, shaped like Angular 22's:
 * elements Angular creates carry a numeric `__ngContext__`, and a lookup
 * replaces it with a context object that caches the component.
 */
function fakeAngular(ChangeDetectorRef: unknown) {
  const hosts = new Map<Element, { instance: object; view: FakeView }>();
  let nextId = 1;
  const getComponent = vi.fn((el: Element) => {
    const found = hosts.get(el);
    (el as any).__ngContext__ = { lViewId: 1, component: found?.instance ?? null };
    return found?.instance ?? null;
  });

  (globalThis as any).ng = {
    getComponent,
    getInjector: (el: Element) => ({
      get: (token: unknown) =>
        token === ChangeDetectorRef
          ? (hosts.get(el)?.view ?? { context: "parent", destroyed: false, onDestroy() {} })
          : null,
    }),
  };

  return {
    getComponent,
    /** An element created by Angular that hosts `instance`. */
    host(tag: string, instance: object) {
      const el = document.createElement(tag);
      (el as any).__ngContext__ = nextId++;
      const view: FakeView = {
        context: instance,
        destroyed: false,
        hooks: [],
        onDestroy(cb) {
          this.hooks.push(cb);
        },
        destroy() {
          this.destroyed = true;
          this.hooks.forEach((h) => h());
        },
      };
      hosts.set(el, { instance, view });
      return { el, view };
    },
    /** An element created by Angular that hosts no component. */
    plain(tag: string) {
      const el = document.createElement(tag);
      (el as any).__ngContext__ = nextId++;
      return el;
    },
  };
}

const flushObserver = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("discovery", () => {
  let mods: Runtime;
  let angular: ReturnType<typeof fakeAngular>;

  beforeEach(async () => {
    document.body.innerHTML = "";
    mods = await loadRuntime();
    const { ChangeDetectorRef } = await import("@angular/core");
    angular = fakeAngular(ChangeDetectorRef);
  });

  afterEach(() => {
    mods.discovery.stopDiscovery();
    delete (globalThis as any).ng;
  });

  const tracked = () =>
    [...mods.store.live].map((e) => ({ name: e.componentName, host: e.host, destroyed: e.destroyedAt !== null }));

  it("finds the components already in the document", () => {
    class _AppComponent {}
    const { el } = angular.host("app-root", new _AppComponent());
    el.appendChild(angular.plain("div"));
    document.body.appendChild(el);
    mods.discovery.startDiscovery();
    expect(tracked()).toEqual([{ name: "AppComponent", host: "app-root", destroyed: false }]);
  });

  it("finds components Angular renders later, including nested ones", async () => {
    mods.discovery.startDiscovery();
    class ListComponent {}
    class ItemComponent {}
    const list = angular.host("app-list", new ListComponent());
    const item = angular.host("app-item", new ItemComponent());
    list.el.appendChild(angular.plain("ul")).appendChild(item.el);
    document.body.appendChild(list.el);
    await flushObserver();
    expect(tracked().map((t) => t.name).sort()).toEqual(["ItemComponent", "ListComponent"]);
  });

  it("marks a component destroyed when Angular destroys its view", async () => {
    mods.discovery.startDiscovery();
    class CardComponent {}
    const { el, view } = angular.host("app-card", new CardComponent());
    document.body.appendChild(el);
    await flushObserver();
    view.destroy();
    expect(tracked()).toEqual([{ name: "CardComponent", host: "app-card", destroyed: true }]);
  });

  it("puts back the element's original context after looking it up", async () => {
    mods.discovery.startDiscovery();
    class CardComponent {}
    const { el } = angular.host("app-card", new CardComponent());
    const div = angular.plain("div");
    const contextBefore = (el as any).__ngContext__;
    document.body.append(el, div);
    await flushObserver();
    expect(angular.getComponent).toHaveBeenCalledWith(el);
    expect((el as any).__ngContext__).toBe(contextBefore);
    expect(typeof (div as any).__ngContext__).toBe("number");
  });

  it("holds the instance weakly and the destroy hook holds no instance", async () => {
    mods.discovery.startDiscovery();
    class CardComponent {}
    const { el, view } = angular.host("app-card", new CardComponent());
    document.body.appendChild(el);
    await flushObserver();
    const [entry] = [...mods.store.live];
    expect(entry!.ref).toBeInstanceOf(WeakRef);
    expect(view.hooks).toHaveLength(1);
    expect(view.hooks[0]!.toString()).not.toMatch(/instance|view|el\b/);
  });

  it("skips elements Angular did not create", async () => {
    mods.discovery.startDiscovery();
    document.body.appendChild(document.createElement("div"));
    await flushObserver();
    expect(angular.getComponent).not.toHaveBeenCalled();
  });

  it("tracks a component once even when its host moves", async () => {
    mods.discovery.startDiscovery();
    class CardComponent {}
    const { el } = angular.host("app-card", new CardComponent());
    const a = document.createElement("section");
    const b = document.createElement("section");
    document.body.append(a, b);
    a.appendChild(el);
    await flushObserver();
    b.appendChild(el);
    await flushObserver();
    expect(tracked()).toHaveLength(1);
  });

  it("does not track a component whose view is already destroyed", () => {
    class GoneComponent {}
    const { el, view } = angular.host("app-gone", new GoneComponent());
    view.destroyed = true;
    document.body.appendChild(el);
    mods.discovery.startDiscovery();
    expect(tracked()).toEqual([]);
  });

  it("finds components inside open shadow roots", async () => {
    mods.discovery.startDiscovery();
    class ShellComponent {}
    class InnerComponent {}
    const shell = angular.host("app-shell", new ShellComponent());
    shell.el.attachShadow({ mode: "open" });
    document.body.appendChild(shell.el);
    await flushObserver();
    shell.el.shadowRoot!.appendChild(angular.host("app-inner", new InnerComponent()).el);
    await flushObserver();
    expect(tracked().map((t) => t.name).sort()).toEqual(["InnerComponent", "ShellComponent"]);
  });

  it("does nothing without Angular's dev-mode global", async () => {
    delete (globalThis as any).ng;
    class CardComponent {}
    document.body.appendChild(angular.host("app-card", new CardComponent()).el);
    mods.discovery.startDiscovery();
    await flushObserver();
    expect(tracked()).toEqual([]);
  });
});

describe("startMemoryLeakDetector", () => {
  afterEach(() => {
    delete (globalThis as any).ngDevMode;
    delete window.__ngLeakDetector;
    vi.restoreAllMocks();
  });

  it("installs window.__ngLeakDetector once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const mods = await loadRuntime();
    const api = mods.detector.startMemoryLeakDetector({ leakAgeMs: 5_000 });
    expect(api).toBe(window.__ngLeakDetector);
    expect(mods.detector.startMemoryLeakDetector({ leakAgeMs: 7_000 })).toBe(api);
    expect(mods.config._config.leakAgeMs).toBe(7_000);
    mods.discovery.stopDiscovery();
  });

  it("does nothing in production mode", async () => {
    const mods = await loadRuntime();
    (globalThis as any).ngDevMode = false;
    expect(mods.detector.startMemoryLeakDetector()).toBeNull();
    expect(window.__ngLeakDetector).toBeUndefined();
  });
});
