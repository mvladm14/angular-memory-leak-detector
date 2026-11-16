// A destroyed component still in memory often keeps its whole view, and with
// it every directive and service in there (src/sweep.ts). Those are reported
// in its warning, not one by one; what leaked on its own still is.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeakEvent } from "../src/types";
import { fakeAngular, flushObserver, loadRuntime, simulateGc, type Runtime } from "./helpers";

/** A WeakRef whose target has been collected. */
const collected = { deref: () => undefined } as unknown as WeakRef<object>;

class AppComponent {}
class CardComponent {}
class HighlightDirective {}
class RouterLink {}
class NgIf {}
class TooltipDirective {}
class CardStore {
  static ɵfac = () => new CardStore();
}

describe("directives and services in a leaked component's view", () => {
  let mods: Runtime;
  let angular: ReturnType<typeof fakeAngular>;
  let events: LeakEvent[];
  let app: object;

  beforeEach(async () => {
    document.body.innerHTML = "";
    mods = await loadRuntime();
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    angular = fakeAngular(ChangeDetectorRef, { DestroyRef });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "table").mockImplementation(() => {});
    mods.discovery.startDiscovery();
    events = [];
    mods.subscribers.subscribe((e) => events.push(e));
    app = new AppComponent();
    document.body.appendChild(angular.host("app-root", app).el);
    await flushObserver();
  });

  afterEach(() => {
    mods.discovery.stopDiscovery();
    delete (globalThis as any).ng;
    vi.restoreAllMocks();
  });

  /**
   * A CardComponent in the app's template, inside an `@if` (`outer`): a
   * directive on its host and a service it provides, and in its own template
   * (`template`) two links and an `*ngIf`. `destroy` is the `@if` going.
   */
  async function card(templateDirectives: object[] = []) {
    const outer = angular.view();
    const template = angular.view();
    const instance = new CardComponent();
    const host = angular.host("app-card", instance, {
      in: outer,
      owner: app,
      directives: [new HighlightDirective()],
      providers: [{ instance: new CardStore() }],
    });
    const inTemplate = { in: template, owner: instance };
    host.el.append(
      angular.plain("a", { ...inTemplate, directives: [new RouterLink()] }),
      angular.plain("a", { ...inTemplate, directives: [new RouterLink()] }),
      angular.anchor("template", { ...inTemplate, directives: [new NgIf(), ...templateDirectives] }),
    );
    document.body.appendChild(host.el);
    await flushObserver();
    const destroy = () => {
      outer.destroy();
      template.destroy();
    };
    return { instance, host, template, destroy, entry: () => mods.store.entryOf(instance)! };
  }

  /** Every destroyed instance long stale, then a collection and a sweep. */
  const collect = () => {
    mods.store.live.forEach((entry) => {
      if (entry.destroyedAt !== null) entry.destroyedAt = Date.now() - 1_000_000;
    });
    mods.sweep.sweep();
    simulateGc(mods);
    mods.sweep.sweep();
  };
  const reported = () => events.map((e) => `${e.kind}:${e.name}`);
  const row = (name: string) => mods.sweep.report().find((r) => r.name === name);
  /** Free `instance`, as a collection would. */
  const free = (instance: object) => (mods.store.entryOf(instance)!.ref = collected);

  it("reports a leaked component once, with the directives and services of its own in its warning", async () => {
    const c = await card();
    c.destroy();
    collect();
    expect(reported()).toEqual(["component:CardComponent"]);
    expect(events[0]!.retained).toEqual([
      { name: "RouterLink", kind: "directive", count: 2 },
      { name: "CardStore", kind: "service", count: 1 },
      { name: "HighlightDirective", kind: "directive", count: 1 },
      { name: "NgIf", kind: "directive", count: 1 },
    ]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Suspected leak: CardComponent <app-card> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total), together with 4 directive(s) and 1 service(s) of its own: RouterLink ×2, CardStore, HighlightDirective, NgIf. Take a heap snapshot",
      ),
    );
    expect(row("RouterLink")).toMatchObject({ stale: 0, withOwner: 2, live: 2 });
    expect(row("CardStore")).toMatchObject({ stale: 0, withOwner: 1 });
    expect(row("CardComponent")).toMatchObject({ stale: 1, withOwner: 0 });
  });

  it("reports a component with nothing of its own left as before", async () => {
    const c = await card();
    c.destroy();
    mods.store.live.forEach((entry) => {
      if (entry.kind !== "component") entry.ref = collected;
    });
    collect();
    expect(events).toEqual([expect.objectContaining({ name: "CardComponent", retained: [] })]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/\(live 1 total\)\. Take a heap snapshot and filter for "CardComponent"/),
    );
  });

  it("counts what leaked with several instances of a component in one warning", async () => {
    const [a, b] = [await card(), await card()];
    a.destroy();
    b.destroy();
    collect();
    expect(reported()).toEqual(["component:CardComponent"]);
    expect(events[0]).toMatchObject({ stale: 2 });
    expect(events[0]!.retained[0]).toEqual({ name: "RouterLink", kind: "directive", count: 4 });
  });

  it("names the first six classes and counts the rest", async () => {
    const extra = ["A", "B", "C", "D"].map((n) => new ({ [`${n}Directive`]: class {} } as any)[`${n}Directive`]());
    const c = await card(extra);
    c.destroy();
    collect();
    expect(events[0]!.retained).toHaveLength(8);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "together with 8 directive(s) and 1 service(s) of its own: RouterLink ×2, ADirective, BDirective, CardStore, CDirective, DDirective and 2 more.",
      ),
    );
  });

  it("still reports a directive that leaked on its own: its component was collected", async () => {
    const c = await card([new TooltipDirective()]);
    c.destroy();
    // Only the tooltip is still in memory: something outside keeps it.
    mods.store.live.forEach((entry) => {
      if (entry.componentName !== "TooltipDirective") entry.ref = collected;
    });
    collect();
    expect(reported()).toEqual(["directive:TooltipDirective"]);
    expect(events[0]!.retained).toEqual([]);
    expect(row("TooltipDirective")).toMatchObject({ stale: 1, withOwner: 0 });
  });

  it("still reports a service that leaked on its own", async () => {
    const c = await card();
    c.destroy();
    mods.store.live.forEach((entry) => {
      if (entry.componentName !== "CardStore") entry.ref = collected;
    });
    collect();
    expect(reported()).toEqual(["service:CardStore"]);
  });

  it("still reports a destroyed directive that a live component holds", async () => {
    const c = await card();
    // An `@if` in the card's template goes; the card stays.
    const inner = angular.view();
    const tooltip = new TooltipDirective();
    c.host.el.appendChild(angular.plain("span", { in: inner, owner: c.instance, directives: [tooltip] }));
    await flushObserver();
    inner.destroy();
    collect();
    expect(reported()).toEqual(["directive:TooltipDirective"]);
  });

  it("waits for its component's verdict, and reports it alone if the component goes", async () => {
    const c = await card([new TooltipDirective()]);
    c.destroy();
    // The card's collection is still to come: it has a witness of its own
    // that no collection has freed.
    const kept = {};
    collect();
    c.entry().witness = { ref: new WeakRef(kept) };
    events.length = 0;
    mods.sweep.sweep();
    expect(row("CardComponent")).toMatchObject({ awaitingGc: 1, stale: 0 });
    expect(row("TooltipDirective")).toMatchObject({ stale: 0, withOwner: 1 });
    expect(events).toEqual([]);

    // The card is freed; the tooltip isn't: it leaked on its own.
    free(c.instance);
    mods.store.live.forEach((entry) => {
      if (entry.componentName !== "TooltipDirective") entry.ref = collected;
    });
    mods.sweep.sweep();
    expect(reported()).toEqual(["directive:TooltipDirective"]);
    expect(kept).toBeTruthy();
  });

  it("waits while its component was destroyed too recently to be judged", async () => {
    const c = await card();
    c.destroy();
    collect();
    events.length = 0;
    c.entry().destroyedAt = Date.now();
    mods.witness.syncWitness(c.entry(), Date.now());
    mods.sweep.sweep();
    expect(events).toEqual([]);
    expect(row("RouterLink")).toMatchObject({ withOwner: 2 });
  });

  it("keeps quiet about what an excluded component keeps", async () => {
    mods.config.configure({ exclude: ["CardComponent"] });
    const c = await card();
    c.destroy();
    collect();
    expect(events).toEqual([]);
    expect(row("RouterLink")).toMatchObject({ stale: 0, withOwner: 2 });
  });

  it("reports the directives of a component with `trackDirectives: false` nowhere", async () => {
    const c = await card();
    mods.config.configure({ trackDirectives: false });
    c.destroy();
    collect();
    expect(events[0]!.retained).toEqual([{ name: "CardStore", kind: "service", count: 1 }]);
  });

  describe("owners", () => {
    const ownerOf = (instance: object) => mods.store.entryOf(instance)!.owner?.componentName ?? null;

    it("the component on the element for what is on its host, the one whose template it is in otherwise", async () => {
      const highlight = new HighlightDirective();
      const store = new CardStore();
      const link = new RouterLink();
      const instance = new CardComponent();
      const host = angular.host("app-card", instance, {
        owner: app,
        directives: [highlight],
        providers: [{ instance: store }],
      });
      host.el.appendChild(angular.plain("a", { owner: instance, directives: [link] }));
      document.body.appendChild(host.el);
      await flushObserver();
      expect([ownerOf(highlight), ownerOf(store), ownerOf(link)]).toEqual([
        "CardComponent",
        "CardComponent",
        "CardComponent",
      ]);
      // Looked up only where no component is on the element.
      expect(angular.getOwningComponent).not.toHaveBeenCalledWith(host.el);
    });

    it("by template, not by where the element ends up: projected content belongs to the parent", async () => {
      const host = angular.host("app-card", new CardComponent(), { owner: app });
      // `<app-card><button appTooltip></app-card>` in the app's template.
      const tooltip = new TooltipDirective();
      host.el.appendChild(angular.plain("button", { owner: app, directives: [tooltip] }));
      document.body.appendChild(host.el);
      await flushObserver();
      expect(ownerOf(tooltip)).toBe("AppComponent");
    });

    it("none outside any component's view, or without `ng.getOwningComponent`", async () => {
      const tooltip = new TooltipDirective();
      document.body.appendChild(angular.plain("button", { directives: [tooltip] }));
      delete (globalThis as any).ng.getOwningComponent;
      const other = new TooltipDirective();
      document.body.appendChild(angular.plain("button", { owner: app, directives: [other] }));
      await flushObserver();
      expect([ownerOf(tooltip), ownerOf(other)]).toEqual([null, null]);
    });

    it("puts back the element's original context after looking its owner up", async () => {
      const button = angular.plain("button", { owner: app, directives: [new TooltipDirective()] });
      const before = (button as any).__ngContext__;
      document.body.appendChild(button);
      await flushObserver();
      expect(angular.getOwningComponent).toHaveBeenCalledWith(button);
      expect((button as any).__ngContext__).toBe(before);
    });
  });
});

describe("a page's view, while the router holds the page", () => {
  afterEach(() => {
    delete (globalThis as any).ng;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("on Angular 16, what is in the page's template waits, then leaks with the page", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "table").mockImplementation(() => {});
    const mods = await loadRuntime({ angular: 16 });
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    const angular = fakeAngular(ChangeDetectorRef, { DestroyRef, angular: 16 });
    const outlet = angular.outlet();
    const pages = ["HomePage", "OtherPage"].map((name) => {
      const instance = new ({ [name]: class {} } as any)[name]();
      const hostView = angular.view();
      const template = angular.view();
      const page = angular.host(`app-${name.toLowerCase()}`, instance, { in: hostView });
      page.el.appendChild(angular.plain("a", { in: template, owner: instance, directives: [new RouterLink()] }));
      return { ...page, hostView, template };
    });
    mods.discovery.startDiscovery();
    document.body.append(outlet.el, ...pages.map((p) => p.el));
    await flushObserver();
    const events: LeakEvent[] = [];
    mods.subscribers.subscribe((e) => events.push(e));
    const navigate = async (page: (typeof pages)[number]) => {
      page.template.destroy();
      outlet.deactivate(page);
      outlet.activate({});
      await Promise.resolve();
    };
    const collect = () => {
      mods.store.live.forEach((entry) => {
        if (entry.destroyedAt !== null) entry.destroyedAt = Date.now() - 1_000_000;
      });
      mods.sweep.sweep();
      simulateGc(mods);
      mods.sweep.sweep();
    };

    await navigate(pages[0]!);
    collect();
    collect();
    // The router holds the page, and the page its view: not a leak yet.
    expect(events).toEqual([]);
    expect(mods.sweep.report().find((r) => r.name === "RouterLink")).toMatchObject({ stale: 0, withOwner: 1 });

    await navigate(pages[1]!);
    collect();
    expect(events.map((e) => e.name)).toEqual(["HomePage"]);
    expect(events[0]!.retained).toEqual([{ name: "RouterLink", kind: "directive", count: 1 }]);
  });
});
