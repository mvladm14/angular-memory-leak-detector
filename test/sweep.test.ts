import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeakEvent } from "../src/types";
import { loadRuntime, simulateGc, type Runtime } from "./helpers";

function destroyedLongAgo(mods: Runtime, name: string, host = "app-x") {
  const instance = {};
  const entry = mods.lifecycle.track(instance, name, host);
  mods.lifecycle.markDestroyed(entry);
  entry.destroyedAt = Date.now() - 1_000_000;
  return { instance, entry };
}

describe("sweep", () => {
  let mods: Runtime;

  beforeEach(async () => {
    mods = await loadRuntime();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "table").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not report a component that is still alive", () => {
    const listener = vi.fn();
    mods.subscribers.subscribe(listener);
    const instance = {};
    mods.lifecycle.track(instance, "CardComponent", "app-card");
    simulateGc(mods);
    mods.sweep.sweep();
    expect(listener).not.toHaveBeenCalled();
    expect(mods.sweep.report()[0]).toMatchObject({ name: "CardComponent", live: 1, stale: 0 });
  });

  it("does not report a destroyed component before a garbage collection ran", () => {
    const listener = vi.fn();
    mods.subscribers.subscribe(listener);
    const { instance, entry } = destroyedLongAgo(mods, "CardComponent");
    mods.witness.syncWitness(entry, Date.now());
    mods.sweep.sweep();
    expect(listener).not.toHaveBeenCalled();
    expect(mods.sweep.report()[0]).toMatchObject({ stale: 0, awaitingGc: 1 });
    expect(instance).toBeTruthy();
  });

  it("reports a destroyed component still in memory after a garbage collection", () => {
    const events: LeakEvent[] = [];
    mods.subscribers.subscribe((e) => events.push(e));
    const { instance, entry } = destroyedLongAgo(mods, "CardComponent", "app-card");
    mods.witness.syncWitness(entry, Date.now());
    simulateGc(mods);
    mods.sweep.sweep();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "CardComponent",
      host: "app-card",
      stale: 1,
      live: 1,
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Suspected leak: CardComponent <app-card>"));
    expect(instance).toBeTruthy();
  });

  it("does not count a collection that ran before the component went stale", () => {
    const listener = vi.fn();
    mods.subscribers.subscribe(listener);
    const instance = {};
    const entry = mods.lifecycle.track(instance, "CardComponent", "app-card");
    mods.lifecycle.markDestroyed(entry); // destroyed now: not over age yet
    mods.sweep.sweep(); // no witness while young
    simulateGc(mods); // a collection while it was young
    entry.destroyedAt = Date.now() - 1_000_000; // now it is old
    mods.sweep.sweep();
    expect(listener).not.toHaveBeenCalled();
    simulateGc(mods);
    mods.sweep.sweep();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("re-reports a leak once the cooldown has passed", () => {
    const listener = vi.fn();
    mods.subscribers.subscribe(listener);
    const { entry } = destroyedLongAgo(mods, "CardComponent");
    mods.witness.syncWitness(entry, Date.now());
    simulateGc(mods);
    mods.sweep.sweep();
    mods.sweep.sweep();
    expect(listener).toHaveBeenCalledTimes(1);
    mods.store.getStats("CardComponent").lastWarnedAt -= mods.config._config.warnCooldownMs + 1;
    mods.sweep.sweep();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("never reports excluded components", () => {
    const listener = vi.fn();
    mods.subscribers.subscribe(listener);
    mods.config.configure({ exclude: ["CachedComponent", /^Kept/] });
    for (const name of ["CachedComponent", "KeptPanelComponent"]) {
      const { entry } = destroyedLongAgo(mods, name);
      mods.witness.syncWitness(entry, Date.now());
    }
    simulateGc(mods);
    mods.sweep.sweep();
    expect(listener).not.toHaveBeenCalled();
    expect(mods.sweep.report()).toEqual([]);
  });

  it("drops entries whose instance was collected", () => {
    const { entry } = destroyedLongAgo(mods, "CardComponent");
    entry.ref = { deref: () => undefined } as unknown as WeakRef<object>;
    expect(mods.sweep.report()).toEqual([]);
    expect(mods.store.live.size).toBe(0);
  });

  it("waits for a seasoned witness right after load", async () => {
    mods = await loadRuntime({ seasoned: false });
    const listener = vi.fn();
    mods.subscribers.subscribe(listener);
    const { entry } = destroyedLongAgo(mods, "CardComponent");
    mods.witness.syncWitness(entry, Date.now());
    expect(entry.witness).toBeNull();
    // Collections season the stock; the first ones prove nothing.
    simulateGc(mods);
    mods.sweep.sweep();
    expect(listener).not.toHaveBeenCalled();
    simulateGc(mods);
    expect(entry.witness).not.toBeNull();
    simulateGc(mods);
    mods.sweep.sweep();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("class names (src/names.ts)", () => {
  it("drops the underscore esbuild adds to class names", async () => {
    const { names } = await loadRuntime();
    const nameOf = (instance: object) => names.namesOf(instance).name;
    class _UserCardComponent {}
    class Plain {}
    class _private {}
    expect(nameOf(new _UserCardComponent())).toBe("UserCardComponent");
    expect(nameOf(new Plain())).toBe("Plain");
    expect(nameOf(new _private())).toBe("_private");
    expect(nameOf(Object.create(null))).toBe("Unknown");
  });
});

// Only destroyed instances can have a verdict: sweeps and reports look at no
// other, and count the rest as they come and go.
describe("what a sweep looks at", () => {
  let mods: Runtime;

  beforeEach(async () => {
    mods = await loadRuntime();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "table").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Track `instance`, counting how often the detector looks it up. */
  const watched = (name: string) => {
    const instance = {};
    const entry = mods.lifecycle.track(instance, name, "app-x");
    let lookups = 0;
    entry.ref = { deref: () => (lookups++, instance) } as unknown as WeakRef<object>;
    return { instance, entry, lookups: () => lookups };
  };

  it("never looks at an instance Angular hasn't destroyed", () => {
    const alive = Array.from({ length: 1000 }, () => watched("CardComponent"));
    const gone = watched("CardComponent");
    mods.lifecycle.markDestroyed(gone.entry);
    gone.entry.destroyedAt = Date.now() - 1_000_000;
    mods.sweep.sweep();
    mods.sweep.report();
    expect(alive.reduce((n, a) => n + a.lookups(), 0)).toBe(0);
    expect(gone.lookups()).toBe(2);
    expect(mods.sweep.report()[0]).toMatchObject({ name: "CardComponent", live: 1001 });
  });

  it("skips an instance destroyed too recently to be judged", () => {
    const recent = Array.from({ length: 1000 }, () => watched("CardComponent"));
    recent.forEach((r) => mods.lifecycle.markDestroyed(r.entry));
    mods.sweep.sweep();
    expect(recent.reduce((n, r) => n + r.lookups(), 0)).toBe(0);
    // Once over age, it is looked at.
    recent[0]!.entry.destroyedAt = Date.now() - 1_000_000;
    mods.sweep.sweep();
    expect(recent[0]!.lookups()).toBe(1);
    // A recent one with a witness to drop (leakAgeMs was raised) is too.
    mods.witness.syncWitness(recent[0]!.entry, Date.now());
    expect(recent[0]!.entry.witness).not.toBeNull();
    mods.config.configure({ leakAgeMs: 100_000_000 });
    mods.sweep.sweep();
    expect(recent[0]!.entry.witness).toBeNull();
  });

  it("does nothing while nothing destroyed is in memory", () => {
    watched("CardComponent");
    const listener = vi.fn();
    mods.subscribers.subscribe(listener);
    expect(mods.store.destroyed.size).toBe(0);
    mods.sweep.sweep();
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps the number of instances in memory right as they are collected", () => {
    const [a, b] = [watched("CardComponent"), watched("CardComponent")];
    mods.lifecycle.markDestroyed(a.entry);
    expect(mods.store.destroyed.has(a.entry)).toBe(true);
    // Collected: the registry's callback and a sweep can both notice.
    mods.store.forget(a.entry);
    mods.store.forget(a.entry);
    a.entry.ref = { deref: () => undefined } as unknown as WeakRef<object>;
    mods.sweep.sweep();
    expect(mods.store.getStats("CardComponent").live).toBe(1);
    expect(mods.store.destroyed.size).toBe(0);
    mods.store.forget(b.entry);
    expect(mods.sweep.report()).toEqual([]);
  });

  it("still tells an alive owner from a collected one", () => {
    const listener = vi.fn();
    mods.subscribers.subscribe(listener);
    const owner = watched("CardComponent");
    const child = mods.lifecycle.track({}, "TooltipDirective", "p", "directive");
    child.owner = owner.entry;
    mods.lifecycle.markDestroyed(child);
    child.destroyedAt = Date.now() - 1_000_000;
    mods.witness.syncWitness(child, Date.now());
    simulateGc(mods);
    mods.sweep.sweep();
    // Its owner is alive and holds it: reported on its own.
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ name: "TooltipDirective", stale: 1 }));
    expect(owner.lookups()).toBe(0);
  });
});
