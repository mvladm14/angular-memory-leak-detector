// Pages the Angular router itself keeps on Angular 16 and 20 (src/router.ts):
// held while the router keeps them, judged like any component once it lets go.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeakEvent } from "../src/types";
import { fakeAngular, flushObserver, loadRuntime, simulateGc, type Runtime } from "./helpers";

type Page = ReturnType<ReturnType<typeof fakeAngular>["host"]>;

/** A running app on Angular `major`: one outlet, and a page per name. */
async function app(major: number, names: string[]) {
  const mods = await loadRuntime({ angular: major });
  const { ChangeDetectorRef } = await import("@angular/core");
  const angular = fakeAngular(ChangeDetectorRef);
  const outlet = angular.outlet();
  const pages = Object.fromEntries(
    names.map((name) => {
      const Page = { [name]: class {} }[name]!;
      return [name, angular.host(`app-${name.toLowerCase()}`, new Page())];
    }),
  );
  mods.discovery.startDiscovery();
  document.body.append(outlet.el, ...Object.values(pages).map((p) => p.el));
  await flushObserver();

  const events: LeakEvent[] = [];
  mods.subscribers.subscribe((e) => events.push(e));
  /**
   * One navigation that takes these pages down, then creates a page, as the
   * router does; it ends at the next microtask. One that fails takes them
   * down and creates none: creating its page threw.
   */
  const navigate = async (taken: Page[], { fails = false } = {}) => {
    taken.forEach((page) => outlet.deactivate(page));
    if (!fails) outlet.activate({});
    await Promise.resolve();
  };
  /** A garbage collection, then a sweep, with every destroyed page long stale. */
  const collect = () => {
    mods.store.live.forEach((entry) => {
      if (entry.destroyedAt !== null) entry.destroyedAt = Date.now() - 1_000_000;
    });
    mods.sweep.sweep();
    simulateGc(mods);
    mods.sweep.sweep();
  };
  const row = (name: string) => mods.sweep.report().find((r) => r.name === name);
  const reported = () => [...new Set(events.map((e) => e.name))].sort();
  return { mods, outlet, pages, navigate, collect, row, reported };
}

describe("pages the router keeps", () => {
  let mods: Runtime | undefined;

  afterEach(() => {
    mods?.discovery.stopDiscovery();
    delete (globalThis as any).ng;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("on Angular 16, holds the page of the latest navigation, then judges it", async () => {
    vi.spyOn(console, "table").mockImplementation(() => {});
    const t = await app(16, ["HomePage", "OtherPage"]);
    mods = t.mods;
    await t.navigate([t.pages.HomePage!]);
    t.collect();
    t.collect();
    expect(t.reported()).toEqual([]);
    expect(t.row("HomePage")).toMatchObject({ live: 1, stale: 0, awaitingGc: 0, heldByRouter: 1 });

    await t.navigate([t.pages.OtherPage!]);
    expect(t.row("HomePage")).toMatchObject({ heldByRouter: 0 });
    expect(t.row("OtherPage")).toMatchObject({ heldByRouter: 1 });
    // Still in memory after the router let go, and a collection since: a leak.
    t.collect();
    expect(t.reported()).toEqual(["HomePage"]);
  });

  it("on Angular 20, holds the pages of the latest two navigations", async () => {
    vi.spyOn(console, "table").mockImplementation(() => {});
    const t = await app(20, ["APage", "BPage", "CPage"]);
    mods = t.mods;
    await t.navigate([t.pages.APage!]);
    await t.navigate([t.pages.BPage!]);
    t.collect();
    expect(t.reported()).toEqual([]);
    expect([t.row("APage")?.heldByRouter, t.row("BPage")?.heldByRouter]).toEqual([1, 1]);

    await t.navigate([t.pages.CPage!]);
    t.collect();
    expect(t.reported()).toEqual(["APage"]);
    expect([t.row("BPage")?.heldByRouter, t.row("CPage")?.heldByRouter]).toEqual([1, 1]);
  });

  it("on Angular 20, a navigation that fails doesn't count, and the router keeps none of its pages", async () => {
    vi.spyOn(console, "table").mockImplementation(() => {});
    const t = await app(20, ["APage", "BPage", "CPage"]);
    mods = t.mods;
    await t.navigate([t.pages.APage!]);
    await t.navigate([t.pages.BPage!]);
    await t.navigate([t.pages.CPage!], { fails: true });
    // The router still keeps the pages of the last two navigations that
    // succeeded; the failed one's page is judged (here: still in memory).
    expect([t.row("APage")?.heldByRouter, t.row("BPage")?.heldByRouter, t.row("CPage")?.heldByRouter]).toEqual([1, 1, 0]);
    t.collect();
    expect(t.reported()).toEqual(["CPage"]);
  });

  it("on Angular 16, a navigation that fails still counts: the router keeps its pages", async () => {
    vi.spyOn(console, "table").mockImplementation(() => {});
    const t = await app(16, ["APage", "BPage"]);
    mods = t.mods;
    await t.navigate([t.pages.APage!]);
    await t.navigate([t.pages.BPage!], { fails: true });
    expect([t.row("APage")?.heldByRouter, t.row("BPage")?.heldByRouter]).toEqual([0, 1]);
    t.collect();
    expect(t.reported()).toEqual(["APage"]);
  });

  it("a navigation that takes no page down doesn't count", async () => {
    const t = await app(20, ["APage", "BPage"]);
    mods = t.mods;
    await t.navigate([t.pages.APage!]);
    await t.navigate([t.pages.BPage!]);
    await t.navigate([]);
    expect([t.row("APage")?.heldByRouter, t.row("BPage")?.heldByRouter]).toEqual([1, 1]);
  });

  it("holds a page and its child page as one navigation, and lets go of both", async () => {
    vi.spyOn(console, "table").mockImplementation(() => {});
    const t = await app(16, ["ChildPage", "ParentPage", "NextPage"]);
    mods = t.mods;
    await t.navigate([t.pages.ChildPage!, t.pages.ParentPage!]);
    t.collect();
    expect(t.reported()).toEqual([]);
    expect([t.row("ChildPage")?.heldByRouter, t.row("ParentPage")?.heldByRouter]).toEqual([1, 1]);

    await t.navigate([t.pages.NextPage!]);
    t.collect();
    expect(t.reported()).toEqual(["ChildPage", "ParentPage"]);
  });

  it("counts only collections after the router let go", async () => {
    const t = await app(16, ["HomePage", "OtherPage"]);
    mods = t.mods;
    await t.navigate([t.pages.HomePage!]);
    t.collect(); // collections while held
    t.collect();
    await t.navigate([t.pages.OtherPage!]);
    t.mods.sweep.sweep(); // no collection since it let go
    expect(t.reported()).toEqual([]);
    t.collect();
    expect(t.reported()).toEqual(["HomePage"]);
  });

  it("drops the witness a page got when it was destroyed (leakAgeMs: 0)", async () => {
    const t = await app(16, ["HomePage"]);
    mods = t.mods;
    t.mods.config.configure({ leakAgeMs: 0 });
    const entry = [...t.mods.store.live].find((e) => e.componentName === "HomePage")!;
    t.pages.HomePage!.view.destroy();
    expect(entry.witness).not.toBeNull();
    // What RouterOutlet emits right after destroying the page.
    t.outlet.listeners.forEach((listener) => listener(t.pages.HomePage!.instance));
    expect(entry.witness).toBeNull();
    expect(entry.heldByRouter).toBe(true);
  });

  it("ignores what it doesn't track", async () => {
    const t = await app(16, ["HomePage"]);
    mods = t.mods;
    expect(() => t.outlet.listeners.forEach((listener) => listener({}))).not.toThrow();
    expect(() => t.outlet.listeners.forEach((listener) => listener(null))).not.toThrow();
    await t.navigate([t.pages.HomePage!]);
    expect(t.mods.store.entryOf(t.pages.HomePage!.instance)?.heldByRouter).toBe(true);
  });

  it("puts back the outlet element's original context after looking it up", async () => {
    const t = await app(16, []);
    mods = t.mods;
    expect(typeof (t.outlet.el as any).__ngContext__).toBe("number");
    expect(t.outlet.listeners).toHaveLength(1);
    // Angular 16 counts every navigation: it needs no `activate`.
    expect(t.outlet.activateListeners).toHaveLength(0);
  });

  for (const major of [17, 19, 21, 22]) {
    it(`on Angular ${major}, watches no outlet and judges pages right away`, async () => {
      vi.spyOn(console, "table").mockImplementation(() => {});
      const t = await app(major, ["HomePage"]);
      mods = t.mods;
      expect(t.mods.router.heldNavigations).toBe(0);
      expect(t.outlet.listeners).toHaveLength(0);
      expect(t.outlet.activateListeners).toHaveLength(0);
      t.pages.HomePage!.view.destroy();
      t.collect();
      expect(t.reported()).toEqual(["HomePage"]);
      expect(t.row("HomePage")).toMatchObject({ heldByRouter: 0 });
    });
  }
});

describe("what a page provides and the directives on its host, with the router", () => {
  let mods: Runtime | undefined;

  afterEach(() => {
    mods?.discovery.stopDiscovery();
    delete (globalThis as any).ng;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  class PageStore {
    static ɵfac = () => new PageStore();
  }
  class TrackPageDirective {}

  /**
   * A running app on Angular `major`: one outlet, and a page per name, each
   * providing a PageStore (which the page can keep, e.g. `inject(PageStore)`)
   * and with a host directive. The outlet creates each page's host in a view
   * of its own.
   */
  async function app(major: number, names: string[]) {
    mods = await loadRuntime({ angular: major });
    const m = mods;
    vi.spyOn(console, "table").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    const angular = fakeAngular(ChangeDetectorRef, { DestroyRef, angular: major });
    const outlet = angular.outlet();
    const pages = Object.fromEntries(
      names.map((name) => {
        const Page = { [name]: class {} }[name]!;
        const hostView = angular.view();
        const page = angular.host(`app-${name.toLowerCase()}`, new Page(), {
          in: hostView,
          directives: [new TrackPageDirective()],
          providers: [{ instance: new PageStore() }],
        });
        return [name, { ...page, hostView }];
      }),
    );
    m.discovery.startDiscovery();
    document.body.append(outlet.el, ...Object.values(pages).map((p) => p.el));
    await flushObserver();
    const events: LeakEvent[] = [];
    m.subscribers.subscribe((e) => events.push(e));

    const navigate = async (taken: Array<(typeof pages)[string]>) => {
      taken.forEach((page) => outlet.deactivate(page));
      outlet.activate({});
      await Promise.resolve();
    };
    const collect = () => {
      m.store.live.forEach((entry) => {
        if (entry.destroyedAt !== null) entry.destroyedAt = Date.now() - 1_000_000;
      });
      m.sweep.sweep();
      simulateGc(m);
      m.sweep.sweep();
    };
    /** kind:name of each entry of `page`'s the router holds. */
    const held = () =>
      [...m.store.live].filter((e) => e.heldByRouter).map((e) => `${e.kind}:${e.componentName}`).sort();
    const reported = () => [...new Set(events.map((e) => `${e.kind}:${e.name}`))].sort();
    /** What the warnings about `page` listed with it. */
    const retainedWith = (page: string) =>
      events.filter((e) => e.name === page).flatMap((e) => e.retained.map((r) => `${r.kind}:${r.name}`));
    return { m, pages, navigate, collect, held, reported, retainedWith };
  }

  it("links a page's host directives and services to it", async () => {
    const t = await app(22, ["HomePage"]);
    const page = t.m.store.entryOf(t.pages.HomePage!.instance)!;
    expect(page.companions!.map((c) => `${c.kind}:${c.componentName}`)).toEqual([
      "directive:TrackPageDirective",
      "service:PageStore",
    ]);
  });

  it("on Angular 16, holds them with the page, then judges them with it", async () => {
    const t = await app(16, ["HomePage", "OtherPage"]);
    await t.navigate([t.pages.HomePage!]);
    t.collect();
    t.collect();
    expect(t.reported()).toEqual([]);
    expect(t.held()).toEqual(["component:HomePage", "directive:TrackPageDirective", "service:PageStore"]);
    expect(t.m.sweep.report().find((r) => r.name === "PageStore")).toMatchObject({ heldByRouter: 1, stale: 0 });

    await t.navigate([t.pages.OtherPage!]);
    expect(t.held()).toEqual(["component:OtherPage", "directive:TrackPageDirective", "service:PageStore"]);
    // Still in memory after the router let go, and a collection since: a
    // leak, its directive and service with it, in its warning.
    t.collect();
    expect(t.reported()).toEqual(["component:HomePage"]);
    expect(t.retainedWith("HomePage")).toEqual(["service:PageStore", "directive:TrackPageDirective"]);
  });

  it("on Angular 20, holds them for the latest two navigations", async () => {
    const t = await app(20, ["APage", "BPage", "CPage"]);
    await t.navigate([t.pages.APage!]);
    await t.navigate([t.pages.BPage!]);
    t.collect();
    expect(t.reported()).toEqual([]);
    expect(t.m.sweep.report().find((r) => r.name === "PageStore")).toMatchObject({ live: 3, heldByRouter: 2 });
    await t.navigate([t.pages.CPage!]);
    t.collect();
    // APage's own store and directive are the ones let go of, and judged:
    // leaked with APage.
    expect(t.m.sweep.report().find((r) => r.name === "PageStore")).toMatchObject({
      heldByRouter: 2,
      stale: 0,
      withOwner: 1,
    });
    expect(t.reported()).toEqual(["component:APage"]);
    expect(t.retainedWith("APage")).toEqual(["service:PageStore", "directive:TrackPageDirective"]);
  });

  it("still watches the outlets with `trackDirectives: false`", async () => {
    mods = await loadRuntime({ angular: 16 });
    mods.config.configure({ trackDirectives: false });
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    const outlet = fakeAngular(ChangeDetectorRef, { DestroyRef, angular: 16 }).outlet();
    document.body.appendChild(outlet.el);
    mods.discovery.startDiscovery();
    expect(outlet.listeners).toHaveLength(1);
    expect([...mods.store.live]).toEqual([]);
  });

  it("on Angular 22, judges them right away", async () => {
    const t = await app(22, ["HomePage"]);
    await t.navigate([t.pages.HomePage!]);
    expect(t.held()).toEqual([]);
    t.collect();
    expect(t.reported()).toEqual(["component:HomePage"]);
    expect(t.retainedWith("HomePage")).toEqual(["service:PageStore", "directive:TrackPageDirective"]);
  });
});
