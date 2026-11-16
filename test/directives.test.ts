// Directives (src/discovery.ts): found on elements and on the comments
// Angular anchors templates and containers with, destroyed with the view
// their node is in, and reported like components when they leak.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeakEvent } from "../src/types";
import { fakeAngular, flushObserver, loadRuntime, simulateGc, type Runtime } from "./helpers";

/** A WeakRef whose target has been collected. */
const collected = { deref: () => undefined } as unknown as WeakRef<object>;

describe("directives", () => {
  let mods: Runtime;
  let angular: ReturnType<typeof fakeAngular>;

  const setUp = async (major = 22) => {
    mods = await loadRuntime();
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    angular = fakeAngular(ChangeDetectorRef, { DestroyRef, angular: major });
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

  const tracked = (kind?: string) =>
    [...mods.store.live]
      .filter((e) => kind === undefined || e.kind === kind)
      .map((e) => ({ name: e.componentName, kind: e.kind, host: e.host, destroyed: e.destroyedAt !== null }));

  it("finds the directives on an element, with their class names", async () => {
    mods.discovery.startDiscovery();
    class _TooltipDirective {}
    class AutofocusDirective {}
    document.body.appendChild(angular.plain("button", { directives: [new _TooltipDirective(), new AutofocusDirective()] }));
    await flushObserver();
    expect(tracked()).toEqual([
      { name: "TooltipDirective", kind: "directive", host: "button", destroyed: false },
      { name: "AutofocusDirective", kind: "directive", host: "button", destroyed: false },
    ]);
  });

  it("finds the directives on a component's host, apart from the component", async () => {
    mods.discovery.startDiscovery();
    class CardComponent {}
    class HighlightDirective {}
    const card = angular.host("app-card", new CardComponent(), { directives: [new HighlightDirective()] });
    document.body.appendChild(card.el);
    await flushObserver();
    expect(tracked()).toEqual([
      { name: "CardComponent", kind: "component", host: "app-card", destroyed: false },
      { name: "HighlightDirective", kind: "directive", host: "app-card", destroyed: false },
    ]);
  });

  it("finds structural directives on template anchors, and directives on ng-container", async () => {
    mods.discovery.startDiscovery();
    class IfRoleDirective {}
    class TrackVisibleDirective {}
    const section = angular.plain("section");
    section.append(
      angular.anchor("template", { directives: [new IfRoleDirective()] }),
      angular.anchor("container", { directives: [new TrackVisibleDirective()] }),
      document.createComment("not Angular's"),
    );
    document.body.appendChild(section);
    await flushObserver();
    expect(tracked()).toEqual([
      { name: "IfRoleDirective", kind: "directive", host: "ng-template", destroyed: false },
      { name: "TrackVisibleDirective", kind: "directive", host: "ng-container", destroyed: false },
    ]);
  });

  it("finds an anchor Angular inserts on its own", async () => {
    mods.discovery.startDiscovery();
    class IfRoleDirective {}
    document.body.appendChild(angular.anchor("template", { directives: [new IfRoleDirective()] }));
    await flushObserver();
    expect(tracked().map((t) => t.name)).toEqual(["IfRoleDirective"]);
  });

  it("finds the directives already in the document", () => {
    class TooltipDirective {}
    document.body.appendChild(angular.plain("button", { directives: [new TooltipDirective()] }));
    mods.discovery.startDiscovery();
    expect(tracked().map((t) => t.name)).toEqual(["TooltipDirective"]);
  });

  it("marks directives destroyed when the view their element is in is destroyed", async () => {
    mods.discovery.startDiscovery();
    class TooltipDirective {}
    class HighlightDirective {}
    class CardComponent {}
    const embedded = angular.view(); // e.g. an @if's
    const card = angular.host("app-card", new CardComponent(), { in: embedded, directives: [new HighlightDirective()] });
    card.el.appendChild(angular.plain("button", { in: embedded, directives: [new TooltipDirective()] }));
    const staying = angular.plain("button", { directives: [new TooltipDirective()] });
    document.body.append(card.el, staying);
    await flushObserver();
    embedded.destroy();
    expect(tracked()).toEqual([
      { name: "CardComponent", kind: "component", host: "app-card", destroyed: true },
      { name: "HighlightDirective", kind: "directive", host: "app-card", destroyed: true },
      { name: "TooltipDirective", kind: "directive", host: "button", destroyed: true },
      { name: "TooltipDirective", kind: "directive", host: "button", destroyed: false },
    ]);
  });

  it("holds directives weakly, and the destroy hook holds no instance, node or view", async () => {
    mods.discovery.startDiscovery();
    class TooltipDirective {}
    class AutofocusDirective {}
    const embedded = angular.view();
    document.body.appendChild(
      angular.plain("button", { in: embedded, directives: [new TooltipDirective(), new AutofocusDirective()] }),
    );
    await flushObserver();
    for (const entry of mods.store.live) expect(entry.ref).toBeInstanceOf(WeakRef);
    // One hook for all of a node's directives.
    expect(embedded.hooks).toHaveLength(1);
    expect(embedded.hooks[0]!.toString()).not.toMatch(/instance|directive|node|view|el\b/);
  });

  it("puts back the original context of elements and anchors after looking them up", async () => {
    mods.discovery.startDiscovery();
    class TooltipDirective {}
    class IfRoleDirective {}
    const button = angular.plain("button", { directives: [new TooltipDirective()] });
    const anchor = angular.anchor("template", { directives: [new IfRoleDirective()] });
    const before = [(button as any).__ngContext__, (anchor as any).__ngContext__];
    document.body.append(button, anchor);
    await flushObserver();
    expect(angular.getComponent).toHaveBeenCalledWith(button);
    expect(angular.getDirectives).toHaveBeenCalledWith(anchor);
    expect(angular.getInjector).toHaveBeenCalledWith(button);
    expect([(button as any).__ngContext__, (anchor as any).__ngContext__]).toEqual(before);
  });

  it("tracks a directive once, when its element moves and on rescan", async () => {
    mods.discovery.startDiscovery();
    class TooltipDirective {}
    const button = angular.plain("button", { directives: [new TooltipDirective()] });
    const [a, b] = [document.createElement("section"), document.createElement("section")];
    document.body.append(a, b);
    a.appendChild(button);
    await flushObserver();
    b.appendChild(button);
    await flushObserver();
    mods.discovery.rescan();
    expect(tracked()).toHaveLength(1);
  });

  for (const major of [16, 19, 20, 22]) {
    it(`on Angular ${major}, does not track directives in a view already destroyed`, async () => {
      await setUp(major);
      class TooltipDirective {}
      const embedded = angular.view();
      document.body.appendChild(angular.plain("button", { in: embedded, directives: [new TooltipDirective()] }));
      embedded.destroyed = true;
      expect(() => mods.discovery.startDiscovery()).not.toThrow();
      expect(tracked()).toEqual([]);
    });
  }

  it("tracks no directive with `trackDirectives: false`, and hides those it tracked", async () => {
    vi.spyOn(console, "table").mockImplementation(() => {});
    mods.discovery.startDiscovery();
    class TooltipDirective {}
    class AutofocusDirective {}
    document.body.appendChild(angular.plain("button", { directives: [new TooltipDirective()] }));
    await flushObserver();
    mods.config.configure({ trackDirectives: false });
    document.body.appendChild(angular.plain("input", { directives: [new AutofocusDirective()] }));
    await flushObserver();
    expect(tracked().map((t) => t.name)).toEqual(["TooltipDirective"]);
    expect(mods.sweep.report()).toEqual([]);
    mods.config.configure({ trackDirectives: true });
    expect(mods.sweep.report().map((r) => r.name)).toEqual(["TooltipDirective"]);
  });

  it("still tracks the component when looking up directives fails", async () => {
    mods.discovery.startDiscovery();
    angular.getDirectives.mockImplementation(() => {
      throw new Error("node torn down");
    });
    class CardComponent {}
    document.body.appendChild(angular.host("app-card", new CardComponent()).el);
    await flushObserver();
    expect(tracked().map((t) => t.name)).toEqual(["CardComponent"]);
  });

  it("still tracks directives when looking up the component fails", async () => {
    mods.discovery.startDiscovery();
    angular.getComponent.mockImplementation(() => {
      throw new Error("node torn down");
    });
    class TooltipDirective {}
    document.body.appendChild(angular.plain("button", { directives: [new TooltipDirective()] }));
    await flushObserver();
    expect(tracked().map((t) => t.name)).toEqual(["TooltipDirective"]);
  });

  it("works without `ng.getDirectives`: reads directives from their view", async () => {
    delete (globalThis as any).ng.getDirectives;
    mods.discovery.startDiscovery();
    class CardComponent {}
    class HighlightDirective {}
    class IfRoleDirective {}
    document.body.append(
      angular.host("app-card", new CardComponent(), { directives: [new HighlightDirective()] }).el,
      angular.anchor("template", { directives: [new IfRoleDirective()] }),
    );
    await flushObserver();
    expect(tracked().map((t) => t.name)).toEqual(["CardComponent", "HighlightDirective", "IfRoleDirective"]);
  });

  describe("verdicts", () => {
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "table").mockImplementation(() => {});
    });

    /** Destroy `view`, age what it destroyed, then let a collection run. */
    const destroyAndCollect = (view: { destroy(): void }) => {
      view.destroy();
      mods.store.live.forEach((entry) => {
        if (entry.destroyedAt !== null) entry.destroyedAt = Date.now() - 1_000_000;
      });
      mods.sweep.sweep();
      simulateGc(mods);
      mods.sweep.sweep();
    };

    it("reports a leaked directive, and not its fixed twin once collected", async () => {
      const events: LeakEvent[] = [];
      mods.subscribers.subscribe((e) => events.push(e));
      mods.discovery.startDiscovery();
      class LeakyTooltipDirective {}
      class FixedTooltipDirective {}
      const embedded = angular.view();
      const fixed = new FixedTooltipDirective();
      document.body.append(
        angular.plain("p", { in: embedded, directives: [new LeakyTooltipDirective()] }),
        angular.plain("p", { in: embedded, directives: [fixed] }),
      );
      await flushObserver();
      // What a collection does to the one that cleaned up.
      mods.store.entryOf(fixed)!.ref = collected;
      destroyAndCollect(embedded);

      expect(events).toEqual([
        expect.objectContaining({ name: "LeakyTooltipDirective", kind: "directive", host: "p", stale: 1, live: 1 }),
      ]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("Suspected leak: directive LeakyTooltipDirective on <p> — 1 instance(s) destroyed"),
      );
      expect(mods.sweep.report()).toEqual([
        expect.objectContaining({ name: "LeakyTooltipDirective", kind: "directive", host: "p", stale: 1 }),
      ]);
    });

    it("does not report a directive whose view is alive", async () => {
      const listener = vi.fn();
      mods.subscribers.subscribe(listener);
      mods.discovery.startDiscovery();
      class TooltipDirective {}
      document.body.appendChild(angular.plain("p", { directives: [new TooltipDirective()] }));
      await flushObserver();
      destroyAndCollect({ destroy() {} });
      expect(listener).not.toHaveBeenCalled();
      expect(mods.sweep.report()[0]).toMatchObject({ name: "TooltipDirective", live: 1, stale: 0 });
    });

    it("never reports excluded directives", async () => {
      const listener = vi.fn();
      mods.subscribers.subscribe(listener);
      mods.config.configure({ exclude: [/^Router/] });
      mods.discovery.startDiscovery();
      class RouterLink {}
      const embedded = angular.view();
      document.body.appendChild(angular.plain("a", { in: embedded, directives: [new RouterLink()] }));
      await flushObserver();
      destroyAndCollect(embedded);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});

describe("startMemoryLeakDetector with directives and services", () => {
  afterEach(() => {
    delete (globalThis as any).ng;
    delete window.__ngLeakDetector;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("says how many of each it found", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const mods = await loadRuntime();
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    const angular = fakeAngular(ChangeDetectorRef, { DestroyRef });
    class CartComponent {}
    class CartStore {
      static ɵfac = () => new CartStore();
    }
    class TooltipDirective {}
    const cart = angular.host("app-cart", new CartComponent(), { providers: [{ instance: new CartStore() }] });
    cart.el.appendChild(angular.plain("button", { directives: [new TooltipDirective()] }));
    document.body.appendChild(cart.el);
    mods.detector.startMemoryLeakDetector();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("(1 components, 1 directives, 1 services found)"));
    mods.discovery.stopDiscovery();
  });
});

// Most nodes hold nothing. After the one lookup every node needs, the context
// it leaves on the node says so, and the detector looks no further.
describe("nodes that hold nothing", () => {
  let mods: Runtime;
  let angular: ReturnType<typeof fakeAngular>;

  beforeEach(async () => {
    document.body.innerHTML = "";
    mods = await loadRuntime();
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    angular = fakeAngular(ChangeDetectorRef, { DestroyRef });
    mods.discovery.startDiscovery();
  });

  afterEach(() => {
    mods.discovery.stopDiscovery();
    delete (globalThis as any).ng;
    vi.restoreAllMocks();
  });

  const lookups = (node: Node) =>
    (["getComponent", "getDirectives", "getInjector", "getOwningComponent", "getInjectorProviders"] as const).filter(
      (name) => angular[name].mock.calls.some(([arg]) => arg === node),
    );

  it("gives an element with nothing one lookup, and a comment with nothing one", async () => {
    const div = angular.plain("div");
    const anchor = angular.anchor("template");
    document.body.append(div, anchor);
    await flushObserver();
    expect(lookups(div)).toEqual(["getComponent"]);
    expect(lookups(anchor)).toEqual(["getDirectives"]);
    expect([(div as any).__ngContext__, (anchor as any).__ngContext__].map((c) => typeof c)).toEqual(["number", "number"]);
  });

  it("reads what there is from the view: the first node of a view pays for the view's lookups", async () => {
    class TooltipDirective {}
    class CardComponent {}
    const embedded = angular.view();
    const [first, second] = [0, 1].map(() =>
      angular.plain("button", { in: embedded, owner: {}, directives: [new TooltipDirective()] }),
    );
    const card = angular.host("app-card", new CardComponent());
    document.body.append(first!, second!, card.el);
    await flushObserver();
    // Its view's DestroyRef (through the injector) and owner.
    expect(lookups(first!)).toEqual(["getComponent", "getInjector", "getOwningComponent"]);
    expect(lookups(second!)).toEqual(["getComponent"]);
    // Its component's view.
    expect(lookups(card.el)).toEqual(["getComponent", "getInjector"]);
    expect([...mods.store.live].map((e) => e.componentName)).toEqual(["TooltipDirective", "TooltipDirective", "CardComponent"]);
  });

  it("reads no directive from a slot not created yet", async () => {
    class TooltipDirective {}
    const button = angular.plain("button", { directives: [new TooltipDirective(), new TooltipDirective()] });
    // The first slot still holds its factory, as before Angular creates it.
    const { _tNode, _lView } = angular.getInjector(button) as any;
    _lView[_tNode.directiveStart] = _lView[1].blueprint[_tNode.directiveStart];
    document.body.appendChild(button);
    await flushObserver();
    expect([...mods.store.live]).toHaveLength(1);
  });

  it("never takes the component for a directive, even when looking it up failed", async () => {
    class CardComponent {
      static ɵcmp = {};
    }
    class HighlightDirective {}
    angular.getComponent.mockImplementation(() => {
      throw new Error("node torn down");
    });
    document.body.appendChild(angular.host("app-card", new CardComponent(), { directives: [new HighlightDirective()] }).el);
    await flushObserver();
    expect([...mods.store.live].map((e) => e.componentName)).toEqual(["HighlightDirective"]);
  });

  it("looks at everything when the context isn't shaped as it knows", async () => {
    class TooltipDirective {}
    const { getComponent } = angular;
    (globalThis as any).ng.getComponent = (el: Element) => {
      const found = getComponent(el);
      (el as any).__ngContext__ = { somethingElse: true };
      return found;
    };
    document.body.appendChild(angular.plain("button", { directives: [new TooltipDirective()] }));
    const bare = angular.plain("div");
    document.body.appendChild(bare);
    await flushObserver();
    expect([...mods.store.live].map((e) => e.componentName)).toEqual(["TooltipDirective"]);
    expect(lookups(bare)).toContain("getInjector");
  });
});

describe("what the detector keeps per instance", () => {
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
  });

  it("a small record: no list of companions until there is one", async () => {
    class CardComponent {}
    class HighlightDirective {}
    const plain = angular.host("app-card", new CardComponent());
    const withHostDirective = angular.host("app-card", new CardComponent(), { directives: [new HighlightDirective()] });
    document.body.append(plain.el, withHostDirective.el);
    mods.discovery.startDiscovery();
    const entry = mods.store.entryOf(plain.instance)!;
    expect(Object.keys(entry).sort()).toEqual(
      ["companions", "componentName", "destroyedAt", "heldByRouter", "host", "kind", "owner", "ref", "witness"],
    );
    expect(entry.companions).toBeNull();
    expect(mods.store.entryOf(withHostDirective.instance)!.companions).toHaveLength(1);
  });

  it("reads a class's name once, for all its instances", () => {
    let reads = 0;
    class _CardComponent {
      static get name() {
        reads++;
        return "_CardComponent";
      }
    }
    const names = [new _CardComponent(), new _CardComponent(), new _CardComponent()].map(mods.lifecycle.componentNameOf);
    expect(names).toEqual(["CardComponent", "CardComponent", "CardComponent"]);
    expect(reads).toBe(1);
  });

  it("doesn't look again at a component it couldn't track", async () => {
    class GoneComponent {}
    const gone = angular.host("app-gone", new GoneComponent());
    gone.view.destroyed = true;
    document.body.appendChild(gone.el);
    // Count the lookups of its view (its ChangeDetectorRef).
    const { ChangeDetectorRef } = await import("@angular/core");
    let looks = 0;
    const { getInjector } = (globalThis as any).ng;
    (globalThis as any).ng.getInjector = (node: Node) => {
      const injector = getInjector(node);
      return { ...injector, get: (token: unknown) => ((looks += node === gone.el && token === ChangeDetectorRef ? 1 : 0), injector.get(token)) };
    };
    mods.discovery.startDiscovery();
    mods.discovery.rescan();
    mods.discovery.rescan();
    expect(looks).toBe(1);
    expect([...mods.store.live]).toEqual([]);
  });

  it("tracks an instance once, even when discovery starts over", async () => {
    class CardComponent {}
    class HighlightDirective {}
    document.body.appendChild(angular.host("app-card", new CardComponent(), { directives: [new HighlightDirective()] }).el);
    mods.discovery.startDiscovery();
    mods.discovery.stopDiscovery();
    mods.discovery.startDiscovery();
    expect([...mods.store.live].map((e) => e.componentName)).toEqual(["CardComponent", "HighlightDirective"]);
  });
});

// The nodes of a view share its destroy signal: one DestroyRef lookup and one
// hook per view, not per node.
describe("one destroy hook per view", () => {
  let mods: Runtime;
  let angular: ReturnType<typeof fakeAngular>;
  let destroyRefLookups: number;

  class TooltipDirective {}

  beforeEach(async () => {
    document.body.innerHTML = "";
    mods = await loadRuntime();
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    angular = fakeAngular(ChangeDetectorRef, { DestroyRef });
    destroyRefLookups = 0;
    const { getInjector } = (globalThis as any).ng;
    (globalThis as any).ng.getInjector = (node: Node) => {
      const injector = getInjector(node);
      return { ...injector, get: (token: unknown) => ((destroyRefLookups += token === DestroyRef ? 1 : 0), injector.get(token)) };
    };
    mods.discovery.startDiscovery();
  });

  afterEach(() => {
    mods.discovery.stopDiscovery();
    delete (globalThis as any).ng;
  });

  const destroyed = () => [...mods.store.live].map((e) => e.destroyedAt !== null);

  it("shares one among the nodes of a view", async () => {
    const embedded = angular.view();
    document.body.append(
      angular.plain("button", { in: embedded, directives: [new TooltipDirective()] }),
      angular.plain("a", { in: embedded, directives: [new TooltipDirective(), new TooltipDirective()] }),
    );
    await flushObserver();
    expect(embedded.hooks).toHaveLength(1);
    expect(destroyRefLookups).toBe(1);
    embedded.destroy();
    expect(destroyed()).toEqual([true, true, true]);
  });

  it("gives each view its own", async () => {
    const [a, b] = [angular.view(), angular.view()];
    document.body.append(
      angular.plain("button", { in: a, directives: [new TooltipDirective()] }),
      angular.plain("button", { in: b, directives: [new TooltipDirective()] }),
    );
    await flushObserver();
    expect([a.hooks.length, b.hooks.length]).toEqual([1, 1]);
    a.destroy();
    expect(destroyed()).toEqual([true, false]);
  });

  it("tracks nothing more in a view once it is destroyed", async () => {
    const embedded = angular.view();
    document.body.appendChild(angular.plain("button", { in: embedded, directives: [new TooltipDirective()] }));
    await flushObserver();
    embedded.destroy();
    document.body.appendChild(angular.plain("a", { in: embedded, directives: [new TooltipDirective()] }));
    await flushObserver();
    expect(destroyed()).toEqual([true]);
  });

  it("falls back to one per node without the view at hand", async () => {
    const { getInjector, getComponent } = (globalThis as any).ng;
    // Neither the lookups' context nor the injector shows the view.
    (globalThis as any).ng.getComponent = (el: Element) => {
      const found = getComponent(el);
      (el as any).__ngContext__ = { somethingElse: true };
      return found;
    };
    (globalThis as any).ng.getInjector = (node: Node) => ({ ...getInjector(node), _lView: null });
    const embedded = angular.view();
    document.body.append(
      angular.plain("button", { in: embedded, directives: [new TooltipDirective()] }),
      angular.plain("a", { in: embedded, directives: [new TooltipDirective()] }),
    );
    await flushObserver();
    expect(embedded.hooks).toHaveLength(2);
    embedded.destroy();
    expect(destroyed()).toEqual([true, true]);
  });
});
