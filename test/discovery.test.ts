import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAngular, flushObserver, loadRuntime, type Runtime } from "./helpers";


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

  it("does nothing when its modules load, so production builds can drop them", async () => {
    vi.resetModules();
    vi.doUnmock("@angular/core");
    const created = vi.fn();
    vi.stubGlobal(
      "FinalizationRegistry",
      class extends FinalizationRegistry<unknown> {
        constructor(cleanup: (held: unknown) => void) {
          super(cleanup);
          created();
        }
      },
    );
    try {
      await import("../src/index");
      expect(created).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does nothing in production mode", async () => {
    const mods = await loadRuntime();
    (globalThis as any).ngDevMode = false;
    expect(mods.detector.startMemoryLeakDetector()).toBeNull();
    expect(window.__ngLeakDetector).toBeUndefined();
  });
});
