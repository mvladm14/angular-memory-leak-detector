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
    expect(mods.sweep.report()[0]).toMatchObject({ component: "CardComponent", live: 1, stale: 0 });
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
      component: "CardComponent",
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

describe("componentNameOf", () => {
  it("drops the underscore esbuild adds to class names", async () => {
    const { lifecycle } = await loadRuntime();
    class _UserCardComponent {}
    class Plain {}
    class _private {}
    expect(lifecycle.componentNameOf(new _UserCardComponent())).toBe("UserCardComponent");
    expect(lifecycle.componentNameOf(new Plain())).toBe("Plain");
    expect(lifecycle.componentNameOf(new _private())).toBe("_private");
    expect(lifecycle.componentNameOf(Object.create(null))).toBe("Unknown");
  });
});
