// The elements a class's instances are on (src/sweep.ts, src/store.ts): in
// events, where its leaked instances were, in `report()` rows, where its
// instances in memory are; `host` the first of those tags in alphabetical
// order, whatever order they were seen in, and `hosts` how many on each.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeakEvent } from "../src/types";
import { fakeAngular, flushObserver, loadRuntime, simulateGc, type Runtime } from "./helpers";

/** A WeakRef whose target has been collected. */
const collected = { deref: () => undefined } as unknown as WeakRef<object>;

let mods: Runtime;

afterEach(() => {
  mods?.discovery.stopDiscovery();
  delete (globalThis as any).ng;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/**
 * A session of an app whose TooltipDirective is on elements of the `tags`
 * given, rendered in that order, each in a view that is then destroyed
 * (`keep`: tags whose view stays), and a collection.
 */
async function session(tags: string[], { keep = [] as string[] } = {}) {
  mods?.discovery.stopDiscovery();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  mods = await loadRuntime();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "table").mockImplementation(() => {});
  const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
  const angular = fakeAngular(ChangeDetectorRef, { DestroyRef });
  class TooltipDirective {}
  const events: LeakEvent[] = [];
  mods.subscribers.subscribe((e) => events.push(e));
  mods.discovery.startDiscovery();
  const views: Array<{ tag: string; view: ReturnType<typeof angular.view> }> = [];
  for (const tag of tags) {
    const view = angular.view();
    document.body.appendChild(angular.plain(tag, { in: view, directives: [new TooltipDirective()] }));
    await flushObserver();
    views.push({ tag, view });
  }
  for (const { tag, view } of views) if (!keep.includes(tag)) view.destroy();
  mods.store.live.forEach((entry) => {
    if (entry.destroyedAt !== null) entry.destroyedAt = Date.now() - 1_000_000;
  });
  mods.sweep.sweep();
  simulateGc(mods);
  mods.sweep.sweep();
  const warnings = warn.mock.calls.map(([message]) => String(message));
  const row = () => mods.sweep.report().find((r) => r.name === "TooltipDirective");
  return { events, warnings, row };
}

describe("hosts", () => {
  it("are the same whatever order the elements were seen in", async () => {
    const first = await session(["button", "a"]);
    const second = await session(["a", "button"]);
    for (const { events } of [first, second]) {
      expect(events).toEqual([
        expect.objectContaining({
          name: "TooltipDirective",
          host: "a",
          hosts: [
            { host: "a", count: 1 },
            { host: "button", count: 1 },
          ],
        }),
      ]);
    }
    expect(second.warnings).toEqual(first.warnings);
  });

  it("list each tag once, in alphabetical order, with how many instances leaked on it", async () => {
    const { events, warnings } = await session(["button", "button", "a", "section"]);
    expect(events[0]).toMatchObject({
      stale: 4,
      host: "a",
      hosts: [
        { host: "a", count: 1 },
        { host: "button", count: 2 },
        { host: "section", count: 1 },
      ],
    });
    expect(warnings[0]).toContain("Suspected leak: directive TooltipDirective on <a>, <button> ×2, <section> — 4 instance(s)");
  });

  it("in an event, are where it leaked; in a report row, where its instances in memory are", async () => {
    // The one on <section> is alive: in memory, not leaked.
    const { events, row } = await session(["button", "section"], { keep: ["section"] });
    expect(events[0]).toMatchObject({ host: "button", hosts: [{ host: "button", count: 1 }] });
    expect(row()).toMatchObject({
      host: "button",
      hosts: [
        { host: "button", count: 1 },
        { host: "section", count: 1 },
      ],
    });
  });

  it("in a report row, follow the instances as they are collected", async () => {
    const { row } = await session(["button", "a"]);
    expect(row()).toMatchObject({ host: "a", live: 2 });
    const onA = [...mods.store.live].find((entry) => entry.host === "a")!;
    onA.ref = collected;
    expect(row()).toMatchObject({ host: "button", hosts: [{ host: "button", count: 1 }], live: 1 });
  });

  it("name a single tag as before, however many instances leaked on it", async () => {
    const { events, warnings } = await session(["button", "button"]);
    expect(events[0]).toMatchObject({ host: "button", hosts: [{ host: "button", count: 2 }] });
    expect(warnings[0]).toContain("Suspected leak: directive TooltipDirective on <button> — 2 instance(s)");
  });

  it("name a single element as before", async () => {
    const { events, warnings } = await session(["p"]);
    expect(events[0]).toMatchObject({ host: "p", hosts: [{ host: "p", count: 1 }] });
    expect(warnings[0]).toContain("Suspected leak: directive TooltipDirective on <p> — 1 instance(s)");
  });
});

describe("report rows", () => {
  it("come in the same order whatever order their classes were seen in", async () => {
    vi.spyOn(console, "table").mockImplementation(() => {});
    const orderOf = async (names: string[]) => {
      mods = await loadRuntime();
      for (const name of names) mods.lifecycle.track({}, name, "p", "directive");
      return mods.sweep.report().map((r) => r.name);
    };
    expect(await orderOf(["TooltipDirective", "HighlightDirective"])).toEqual(["HighlightDirective", "TooltipDirective"]);
    expect(await orderOf(["HighlightDirective", "TooltipDirective"])).toEqual(["HighlightDirective", "TooltipDirective"]);
  });
});
