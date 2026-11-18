// What keeps a leaked instance in memory (src/causes.ts): the timers,
// animation frames, event listeners and subscriptions it started and never
// ended, recorded as they are started (src/instrument.ts) for whoever started
// them (src/ownership.ts), and named in its warning and event.
import v8 from "node:v8";
import vm from "node:vm";
import { BehaviorSubject, config as rxjsConfig, filter, map, of, Subject, take, takeUntil, throwError } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeakCause, LeakEvent } from "../src/types";
import { fakeAngular, flushObserver, loadRuntime, type Provider, simulateGc, type Runtime } from "./helpers";

/** Let timers of a few ms fire, and animation frames run. */
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cleanups for what tests leave running (intervals, listeners), run last first. */
let cleanups: Array<() => void> = [];
const later = (cleanup: () => void) => cleanups.push(cleanup);

class CardComponent {
  n = 0;
}

/** What jsdom lacks: a `ResizeObserver` or `IntersectionObserver` (of `name`) that only keeps its targets. */
function fakeObserver(name: string) {
  return {
    [name]: class {
      readonly targets = new Set<object>();
      constructor(readonly callback: () => void) {}
      observe(target: object) {
        this.targets.add(target);
      }
      unobserve(target: object) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  }[name]!;
}

describe("the causes of a leak", () => {
  let mods: Runtime;
  let angular: ReturnType<typeof fakeAngular>;
  let events: LeakEvent[];

  /** Animation frames requested and not run yet: `runFrames` runs them. */
  let frameQueue = new Map<number, FrameRequestCallback>();
  const runFrames = () => {
    const due = [...frameQueue.values()];
    frameQueue = new Map();
    due.forEach((callback) => callback(performance.now()));
  };
  /** Idle callbacks requested and not run yet: `runIdle` runs them. */
  let idleQueue = new Map<number, IdleRequestCallback>();
  const runIdle = () => {
    const due = [...idleQueue.values()];
    idleQueue = new Map();
    due.forEach((callback) => callback({ didTimeout: false, timeRemaining: () => 10 }));
  };

  async function setUp(options: Parameters<typeof fakeAngular>[1] = {}, runtime: Parameters<typeof loadRuntime>[0] = {}) {
    document.body.innerHTML = "";
    mods = await loadRuntime(runtime);
    const { ChangeDetectorRef, DestroyRef } = await import("@angular/core");
    angular = fakeAngular(ChangeDetectorRef, { DestroyRef, ...options });
    // What startProductionMemoryLeakDetector does before discovery starts.
    if (runtime.production) mods.discovery.useWithoutDebugApi(mods.production.productionApi());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "table").mockImplementation(() => {});
    // Frames that run when the test says, not on their own: wrapped by the detector.
    frameQueue = new Map();
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameQueue.set(nextFrame, callback);
      return nextFrame++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frameQueue.delete(id));
    idleQueue = new Map();
    let nextIdle = 1;
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      idleQueue.set(nextIdle, callback);
      return nextIdle++;
    });
    vi.stubGlobal("cancelIdleCallback", (id: number) => idleQueue.delete(id));
    vi.stubGlobal("ResizeObserver", fakeObserver("ResizeObserver"));
    vi.stubGlobal("IntersectionObserver", fakeObserver("IntersectionObserver"));
    mods.instrument.startCauses();
    mods.discovery.startDiscovery();
    events = [];
    mods.subscribers.subscribe((e) => events.push(e));
  }

  beforeEach(() => setUp());

  afterEach(() => {
    cleanups.reverse().forEach((cleanup) => cleanup());
    cleanups = [];
    mods.instrument.stopCauses();
    mods.discovery.stopDiscovery();
    delete (globalThis as any).ng;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A component Angular creates with `make`, in the document. */
  async function shown<T extends object>(make: (self: Provider) => T, tag = "app-card") {
    const built = angular.build(tag, make);
    document.body.appendChild(built.el);
    await flushObserver();
    return built;
  }

  /** Destroy `built`'s view, with its element, and judge it after a collection: it is still held (by this test). */
  function destroyAndCollect(...built: Array<{ el: Element; view: { destroy(): void } | null }>) {
    for (const { el, view } of built) {
      view?.destroy();
      el.remove();
    }
    mods.store.live.forEach((entry) => {
      if (entry.destroyedAt !== null) entry.destroyedAt = Date.now() - 1_000_000;
    });
    mods.sweep.sweep();
    simulateGc(mods);
    mods.sweep.sweep();
  }

  const causesOf = (name: string) => events.find((e) => e.name === name)?.causes;
  const warning = () => String(vi.mocked(console.warn).mock.calls.at(-1)?.[0]);
  const own = (cause: Partial<LeakCause>): LeakCause => ({
    kind: "interval",
    description: "",
    startedIn: "constructor",
    by: "CardComponent",
    byKind: "component",
    count: 1,
    ...cause,
  });

  describe("started in a constructor", () => {
    it("names an interval a component started and never cleared", async () => {
      class CardComponent {
        n = 0;
        constructor() {
          const id = setInterval(() => this.n++, 60_000);
          later(() => clearInterval(id));
        }
      }
      const card = await shown(() => new CardComponent());
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([own({ kind: "interval", description: "setInterval every 60000 ms" })]);
      expect(warning()).toBe(
        '[ng-leak] Suspected leak: CardComponent <app-card> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Likely cause: setInterval every 60000 ms, started in its constructor and never cleared. Take a heap snapshot and filter for "CardComponent" to see what holds it.',
      );
    });

    it("names each kind still active, the likeliest first", async () => {
      const ticks = new BehaviorSubject(0);
      class CardComponent {
        n = 0;
        constructor() {
          ticks.subscribe(() => this.n++);
          const onResize = () => this.n++;
          window.addEventListener("resize", onResize);
          const timeout = setTimeout(() => this.n++, 60_000);
          const interval = setInterval(() => this.n++, 1_000);
          const frame = requestAnimationFrame(() => this.n++);
          later(() => {
            window.removeEventListener("resize", onResize);
            clearTimeout(timeout);
            clearInterval(interval);
            cancelAnimationFrame(frame);
          });
        }
      }
      const card = await shown(() => new CardComponent());
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "interval", description: "setInterval every 1000 ms" }),
        own({ kind: "animationFrame", description: "requestAnimationFrame" }),
        own({ kind: "timeout", description: "setTimeout of 60000 ms" }),
        own({ kind: "eventListener", description: '"resize" listener on window' }),
        own({ kind: "subscription", description: "subscription to BehaviorSubject" }),
      ]);
      expect(warning()).toContain(
        'Likely causes: setInterval every 1000 ms, started in its constructor and never cleared; requestAnimationFrame, requested in its constructor and still pending; setTimeout of 60000 ms, set in its constructor and still pending; "resize" listener on window, added in its constructor and never removed; and 1 more. Take a heap snapshot',
      );
    });

    it("names nothing that ended: cleared, fired, cancelled, removed, unsubscribed or completed", async () => {
      const ticks = new BehaviorSubject(0);
      class CardComponent {
        n = 0;
        constructor() {
          clearInterval(setInterval(() => this.n++, 1_000));
          // Intervals and timeouts share their ids.
          clearTimeout(setInterval(() => this.n++, 1_000));
          clearInterval(setTimeout(() => this.n++, 1_000));
          setTimeout(() => this.n++, 0);
          cancelAnimationFrame(requestAnimationFrame(() => this.n++));
          const onResize = () => this.n++;
          window.addEventListener("resize", onResize);
          window.removeEventListener("resize", onResize);
          ticks.subscribe(() => this.n++).unsubscribe();
          of(1).subscribe(() => this.n++);
          const done = new Subject<number>();
          done.subscribe(() => this.n++);
          done.complete();
        }
      }
      const card = await shown(() => new CardComponent());
      await wait(); // the timeout fires
      destroyAndCollect(card);
      expect(events.map((e) => e.name)).toEqual(["CardComponent"]);
      expect(causesOf("CardComponent")).toEqual([]);
      // The warning as it always was.
      expect(warning()).toContain("(live 1 total). Take a heap snapshot");
      expect(mods.causes.timers.size).toBe(0);
      expect(mods.causes.frames.size).toBe(0);
    });

    it("counts alike causes of instances that leaked together", async () => {
      class CardComponent {
        n = 0;
        constructor() {
          const id = setInterval(() => this.n++, 1_000);
          later(() => clearInterval(id));
        }
      }
      const cards = [await shown(() => new CardComponent()), await shown(() => new CardComponent())];
      destroyAndCollect(...cards);
      expect(causesOf("CardComponent")).toEqual([own({ description: "setInterval every 1000 ms", count: 2 })]);
      expect(warning()).toContain("Likely cause: setInterval every 1000 ms ×2, started in its constructor and never cleared.");
    });
  });

  describe("event listeners", () => {
    it("counts a listener on what outlives the instance, not on an element that goes with it", async () => {
      const button = document.createElement("button");
      document.body.append(button);
      // An element of its own view, removed with it.
      const ownElement = document.createElement("div");
      document.body.append(ownElement);
      class Channel extends EventTarget {}
      const channel = new Channel();
      class CardComponent {
        n = 0;
        constructor() {
          const on = () => this.n++;
          window.addEventListener("resize", on);
          document.addEventListener("keydown", on);
          button.addEventListener("click", on);
          channel.addEventListener("message", on);
          ownElement.addEventListener("click", on);
          // Never in the document.
          document.createElement("div").addEventListener("click", on);
          later(() => {
            window.removeEventListener("resize", on);
            document.removeEventListener("keydown", on);
          });
        }
      }
      const card = await shown(() => new CardComponent());
      ownElement.remove();
      destroyAndCollect(card);
      expect(causesOf("CardComponent")!.map((c) => c.description)).toEqual([
        '"click" listener on <button>',
        '"keydown" listener on document',
        '"message" listener on Channel',
        '"resize" listener on window',
      ]);
    });

    it("knows a listener removed, aborted, added once, or added twice", async () => {
      const aborts = new AbortController();
      const once = new AbortController();
      class CardComponent {
        n = 0;
        constructor() {
          const on = () => this.n++;
          // Removed as added: with the same `capture`.
          window.addEventListener("scroll", on, { capture: true });
          window.removeEventListener("scroll", on, true);
          // Removed without `capture`: a different listener, still there.
          window.addEventListener("wheel", on, true);
          window.removeEventListener("wheel", on);
          // Added twice: one listener.
          window.addEventListener("keyup", on);
          window.addEventListener("keyup", on, false);
          // Removed by its signal.
          window.addEventListener("focus", on, { signal: aborts.signal });
          // Removed by its signal, then added again.
          window.addEventListener("resize", on, { signal: once.signal });
          once.abort();
          window.addEventListener("resize", on);
          // Added once: gone once it fires; until then, there.
          window.addEventListener("blur", on, { once: true });
          window.addEventListener("pageshow", on, { once: true });
          // An object with `handleEvent`.
          const handler = { handleEvent: on };
          window.addEventListener("online", handler);
          later(() => {
            window.removeEventListener("wheel", on, true);
            window.removeEventListener("keyup", on);
            window.removeEventListener("online", handler);
            window.removeEventListener("blur", on);
            window.removeEventListener("resize", on);
          });
        }
      }
      const card = await shown(() => new CardComponent());
      aborts.abort();
      window.dispatchEvent(new Event("pageshow"));
      destroyAndCollect(card);
      expect(causesOf("CardComponent")!.map((c) => c.description)).toEqual([
        '"blur" listener (once) on window',
        '"keyup" listener on window',
        '"online" listener on window',
        '"resize" listener on window',
        '"wheel" listener on window',
      ]);
      expect(warning()).toContain('"blur" listener (once) on window, added in its constructor and never fired nor removed');
    });
  });

  describe("what ends unseen", () => {
    it("forgets what ended as its owner keeps starting more, not a listener out of the document for now", async () => {
      const ticks = new BehaviorSubject(0);
      // Built before it is shown, as a portal's is.
      const overlay = document.createElement("div");
      class CardComponent {
        n = 0;
        constructor() {
          overlay.addEventListener("click", () => this.n++);
        }
      }
      const card = await shown(() => new CardComponent());
      const instance = card.instance!;
      // A request per click, each ending on its own.
      for (let i = 0; i < 1_000; i++) {
        angular.handler(instance, () => {
          const done = new Subject<number>();
          done.subscribe(() => instance.n++);
          ticks.subscribe(() => instance.n++).unsubscribe();
          done.complete();
        });
      }
      expect(mods.ownership.ownerOf(instance)!.resources.size).toBeLessThan(64);
      document.body.append(overlay);
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "eventListener", description: '"click" listener on <div>' }),
      ]);
    });
  });

  describe("subscriptions", () => {
    it("counts the one the app made, not each operator's, named after what emits", async () => {
      const ticks = new BehaviorSubject(1);
      const stop = new Subject<void>();
      const { EventEmitter } = await import("@angular/core");
      const changes = new EventEmitter<number>();
      class CardComponent {
        n = 0;
        constructor() {
          ticks
            .pipe(
              map((t) => t * 2),
              filter((t) => t > 0),
            )
            .subscribe(() => this.n++);
          changes.subscribe(() => this.n++);
          // Ended by its `takeUntil`.
          ticks.pipe(takeUntil(stop)).subscribe(() => this.n++);
        }
      }
      const card = await shown(() => new CardComponent());
      stop.next();
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "subscription", description: "subscription to BehaviorSubject" }),
        own({ kind: "subscription", description: "subscription to EventEmitter" }),
      ]);
    });

    it("names what it subscribed to as RxJS calls it, whatever a bundler renamed it", async () => {
      // A bundler appends a number to a class whose name clashes with another.
      const renamed = { BehaviorSubject2: class extends BehaviorSubject<number> {} }.BehaviorSubject2;
      const mine = { TickStream2: class extends BehaviorSubject<number> {} }.TickStream2;
      const ticks = [new renamed(1), new mine(1)];
      class CardComponent {
        n = 0;
        constructor() {
          ticks.forEach((t) => t.subscribe(() => this.n++));
        }
      }
      const card = await shown(() => new CardComponent());
      destroyAndCollect(card);
      expect(causesOf("CardComponent")!.map((c) => c.description)).toEqual([
        "subscription to BehaviorSubject",
        "subscription to TickStream2",
      ]);
    });

    it("counts a subscription made while another one emits", async () => {
      // As a component the router creates is: during an emission of its
      // navigation, inside the subscribe of an operator.
      const ticks = new BehaviorSubject(1);
      const other = new BehaviorSubject("a");
      class CardComponent {
        n = 0;
        constructor() {
          ticks.subscribe(() => other.subscribe(() => this.n++));
        }
      }
      const card = await shown(() => new CardComponent());
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "subscription", description: "subscription to BehaviorSubject" }),
        own({ kind: "subscription", description: "subscription to BehaviorSubject", startedIn: "subscription callback" }),
      ]);
    });
  });

  describe("who started it", () => {
    it("never blames a component for what a root service it creates starts", async () => {
      const { Injector, runInInjectionContext } = await import("@angular/core");
      const root = Injector.create({ providers: [] });
      class TickerService {
        constructor() {
          const id = setInterval(() => {}, 1_000);
          later(() => clearInterval(id));
        }
      }
      class CardComponent {
        // `inject(TickerService)`, which the root injector creates then.
        readonly ticker = runInInjectionContext(root, () => new TickerService());
      }
      const card = await shown(() => new CardComponent());
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([]);
    });

    it("tells a service its component's constructor creates from the component", async () => {
      class CardStore {
        static ɵfac = () => new CardStore();
        constructor() {
          const id = setInterval(() => {}, 2_000);
          later(() => clearInterval(id));
        }
      }
      class CardComponent {
        readonly store: CardStore;
        constructor(self: { provide(n: number, make: () => CardStore): CardStore }) {
          this.store = self.provide(0, () => new CardStore());
          const id = setTimeout(() => {}, 60_000);
          later(() => clearTimeout(id));
        }
      }
      // In an `@if`: its host's view, which the service goes with.
      const outer = angular.view();
      const built = angular.build("app-card", (self) => new CardComponent(self), {
        in: outer,
        providers: [{ lazy: CardStore }],
      });
      document.body.appendChild(built.el);
      await flushObserver();
      destroyAndCollect({ el: built.el, view: outer });
      expect(events.map((e) => e.name)).toEqual(["CardComponent"]);
      expect(events[0]!.retained).toEqual([{ name: "CardStore", kind: "service", count: 1 }]);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "timeout", description: "setTimeout of 60000 ms" }),
        own({ kind: "interval", description: "setInterval every 2000 ms", by: "CardStore", byKind: "service" }),
      ]);
      expect(warning()).toContain(
        "Likely causes: setTimeout of 60000 ms, set in its constructor and still pending; setInterval every 2000 ms, started by CardStore in its constructor and never cleared.",
      );
    });

    it("names what a directive in its template started, and who started it", async () => {
      // The directive keeps its view, and so the component whose template it is.
      class TooltipDirective {
        constructor() {
          const on = () => this;
          document.addEventListener("visibilitychange", on);
          later(() => document.removeEventListener("visibilitychange", on));
        }
      }
      const card = await shown(() => new CardComponent());
      const template = angular.view();
      const p = angular.build("p", null, { in: template, owner: card.instance!, directives: [() => new TooltipDirective()] });
      card.el.appendChild(p.el);
      await flushObserver();
      template.destroy();
      destroyAndCollect(card);
      expect(events.map((e) => e.name)).toEqual(["CardComponent"]);
      expect(causesOf("CardComponent")).toEqual([
        own({
          kind: "eventListener",
          description: '"visibilitychange" listener on document',
          by: "TooltipDirective",
          byKind: "directive",
        }),
      ]);
      expect(warning()).toContain(
        'together with 1 directive(s) of its own: TooltipDirective. Likely cause: "visibilitychange" listener on document, added by TooltipDirective in its constructor and never removed.',
      );
    });

    it("records nothing started outside an instance's code", async () => {
      const ticks = new BehaviorSubject(0);
      const id = setInterval(() => {}, 1_000);
      later(() => clearInterval(id));
      setTimeout(() => {}, 60_000);
      requestAnimationFrame(() => {});
      const sub = ticks.subscribe(() => {});
      later(() => sub.unsubscribe());
      expect(mods.causes.timers.size).toBe(0);
      expect(mods.causes.frames.size).toBe(0);
    });
  });

  describe("once listeners, observers and idle callbacks", () => {
    it("knows when a `once` listener fires, with the app's listener as it was", async () => {
      const calls: string[] = [];
      const aborts = new AbortController();
      class CardComponent {
        n = 0;
        constructor() {
          const first = () => calls.push("first");
          // Fired: gone.
          window.addEventListener("pageshow", first, { once: true });
          // Removed before it fired, by the app: the detector's goes too.
          const removed = () => calls.push("removed");
          document.addEventListener("keydown", removed, { once: true, capture: true });
          document.removeEventListener("keydown", removed, { capture: true });
          // Aborted: both go.
          window.addEventListener("focus", () => calls.push("aborted"), { once: true, signal: aborts.signal });
          // Never fired: there.
          window.addEventListener("beforeprint", () => this.n++, { once: true });
          // Added twice: one.
          const twice = () => calls.push("twice");
          document.addEventListener("visibilitychange", twice, { once: true });
          document.addEventListener("visibilitychange", twice, { once: true });
          later(() => document.removeEventListener("visibilitychange", twice));
        }
      }
      const card = await shown(() => new CardComponent());
      aborts.abort();
      for (const [target, type] of [
        [window, "pageshow"],
        [window, "pageshow"],
        [document, "keydown"],
        [window, "focus"],
      ] as const) {
        target.dispatchEvent(new Event(type));
      }
      // As without the detector: once each, and never what was removed.
      expect(calls).toEqual(["first"]);
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "eventListener", description: '"beforeprint" listener (once) on window' }),
        own({ kind: "eventListener", description: '"visibilitychange" listener (once) on document' }),
      ]);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(calls).toEqual(["first", "twice"]);
    });

    it("names an observer never disconnected, while it observes what is still in the document", async () => {
      const outside = document.createElement("section");
      document.body.append(outside);
      const inside = document.createElement("div");
      document.body.append(inside);
      class CardComponent {
        n = 0;
        constructor() {
          const callback = () => this.n++;
          // On the document: there.
          new MutationObserver(callback).observe(document.body, { childList: true });
          // On an element of its own view, and another outside it: one left.
          const resize = new ResizeObserver(callback);
          resize.observe(inside);
          resize.observe(outside);
          // Disconnected, or no longer observing: gone.
          const seen = new IntersectionObserver(callback);
          seen.observe(outside);
          seen.disconnect();
          const unobserved = new ResizeObserver(callback);
          unobserved.observe(outside);
          unobserved.unobserve(outside);
        }
      }
      const card = await shown(() => new CardComponent());
      inside.remove();
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "observer", description: "MutationObserver observing <body>" }),
        own({ kind: "observer", description: "ResizeObserver observing <section>" }),
      ]);
      expect(warning()).toContain(
        "Likely causes: MutationObserver observing <body>, started in its constructor and never disconnected; ResizeObserver observing <section>, started in its constructor and never disconnected.",
      );
    });

    it("leaves the observer classes as they were, to the app", async () => {
      const Native = (globalThis as any).__zone_symbol__MutationObserver ?? Object.getPrototypeOf(MutationObserver);
      const seen: unknown[] = [];
      class Watcher extends MutationObserver {
        readonly label = "mine";
      }
      const observer = new Watcher(function (this: unknown, records, self) {
        seen.push(this, records.length, self);
      });
      expect(observer).toBeInstanceOf(MutationObserver);
      expect(observer).toBeInstanceOf(Native);
      expect(observer.label).toBe("mine");
      expect(MutationObserver.name).toBe("MutationObserver");
      const target = document.createElement("div");
      observer.observe(target, { attributes: true });
      target.setAttribute("data-x", "1");
      await flushObserver();
      // Called with the observer the app made, as `this` and as its second argument.
      expect(seen).toEqual([observer, 1, observer]);
      observer.disconnect();
      expect(() => (MutationObserver as unknown as () => void)()).toThrow(TypeError);
    });

    it("with zone.js, knows its observer from the browser's one it wraps, which its callback gets", async () => {
      // As zone.js does: the app's observer keeps the browser's, forwards to
      // it, and its callback gets the browser's.
      mods.instrument.stopCauses();
      mods.discovery.stopDiscovery();
      vi.unstubAllGlobals();
      const Native = MutationObserver;
      const ZoneMutationObserver = function (this: { inner: MutationObserver }, callback: MutationCallback) {
        this.inner = new Native((records, inner) => callback.call(this as never, records, inner));
      } as unknown as typeof MutationObserver;
      Object.assign(ZoneMutationObserver.prototype, {
        observe(this: { inner: MutationObserver }, target: Node, options: MutationObserverInit) {
          return this.inner.observe(target, options);
        },
        disconnect(this: { inner: MutationObserver }) {
          return this.inner.disconnect();
        },
        takeRecords(this: { inner: MutationObserver }) {
          return this.inner.takeRecords();
        },
      });
      vi.stubGlobal("MutationObserver", ZoneMutationObserver);
      await setUp();
      class CardComponent {
        n = 0;
        constructor() {
          // Never disconnected: one observer, recorded once.
          new MutationObserver(() => this.n++).observe(document.body, { attributes: true });
          // Disconnected from its callback, through what the callback gets.
          new MutationObserver((_, observer) => observer.disconnect()).observe(document.body, { attributes: true });
        }
      }
      const card = await shown(() => new CardComponent());
      document.body.setAttribute("data-changed", "1");
      await flushObserver();
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([own({ kind: "observer", description: "MutationObserver observing <body>" })]);
      document.body.removeAttribute("data-changed");
    });

    it("knows an observer that observes again, after it was disconnected, by who observes then", async () => {
      const shared = new ResizeObserver(() => {});
      const target = document.createElement("div");
      document.body.append(target);
      later(() => shared.disconnect());
      const first = await shown(() => new CardComponent());
      angular.hook(first.instance!, "ngAfterViewInit", () => shared.observe(target));
      shared.disconnect();
      class ItemComponent {}
      const second = await shown(() => new ItemComponent(), "app-item");
      angular.hook(second.instance!, "ngAfterViewInit", () => shared.observe(target));
      destroyAndCollect(first, second);
      expect(causesOf("CardComponent")).toEqual([]);
      expect(causesOf("ItemComponent")).toEqual([
        own({ kind: "observer", description: "ResizeObserver observing <div>", startedIn: "ngAfterViewInit", by: "ItemComponent" }),
      ]);
    });

    it("names an idle callback still pending, or a loop of them, not one run or cancelled", async () => {
      class CardComponent {
        n = 0;
        stopped = false;
        constructor() {
          requestIdleCallback(() => this.n++);
          cancelIdleCallback(requestIdleCallback(() => this.n++));
          const work = () => {
            if (!this.stopped) requestIdleCallback(work);
          };
          requestIdleCallback(work);
          later(() => (this.stopped = true));
        }
      }
      const card = await shown(() => new CardComponent());
      runIdle();
      runIdle();
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([own({ kind: "idleCallback", description: "requestIdleCallback loop" })]);
      expect(warning()).toContain("Likely cause: requestIdleCallback loop, started in its constructor and never stopped.");
    });
  });

  describe("what a subscription's callback starts", () => {
    it("is its subscriber's, when it emits, even once it completed", async () => {
      const params = new Subject<number>();
      const ready = new BehaviorSubject(true);
      class CardComponent {
        n = 0;
        constructor() {
          params.subscribe(() => later(((id) => () => clearInterval(id))(setInterval(() => this.n++, 1_000))));
          // Completed after its first value: what that started stays.
          ready.pipe(take(1)).subscribe(() => {
            const on = () => this.n++;
            window.addEventListener("online", on);
            later(() => window.removeEventListener("online", on));
          });
        }
      }
      const card = await shown(() => new CardComponent());
      // Later, from outside anything Angular runs.
      params.next(1);
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "interval", description: "setInterval every 1000 ms", startedIn: "subscription callback" }),
        own({ kind: "eventListener", description: '"online" listener on window', startedIn: "subscription callback" }),
        own({ kind: "subscription", description: "subscription to Subject" }),
      ]);
      expect(warning()).toContain(
        "setInterval every 1000 ms, started in a subscription's callback and never cleared",
      );
    });

    it("is the subscriber's, when it emits within another's code: the innermost", async () => {
      const clicks = new Subject<void>();
      class ItemComponent {
        constructor() {
          clicks.subscribe(() => later(((id) => () => clearTimeout(id))(setTimeout(() => {}, 60_000))));
        }
      }
      const card = await shown(() => new CardComponent());
      const item = await shown(() => new ItemComponent(), "app-item");
      // The card's click handler emits; the item's callback runs within it.
      angular.handler(card.instance!, () => {
        clicks.next();
        later(((id) => () => clearTimeout(id))(setTimeout(() => {}, 1_000)));
      });
      destroyAndCollect(card, item);
      expect(causesOf("ItemComponent")).toEqual([
        own({ kind: "timeout", description: "setTimeout of 60000 ms", startedIn: "subscription callback", by: "ItemComponent" }),
        own({ kind: "subscription", description: "subscription to Subject", by: "ItemComponent" }),
      ]);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "timeout", description: "setTimeout of 1000 ms", startedIn: "event handler" }),
      ]);
    });

    it("leaves the app's observer as it was: its `this`, and no callback it didn't have", async () => {
      const unhandled = vi.fn();
      const previous = rxjsConfig.onUnhandledError;
      rxjsConfig.onUnhandledError = unhandled;
      later(() => (rxjsConfig.onUnhandledError = previous));
      const values: number[] = [];
      const failure = new Error("no one handles me");
      class CardComponent {
        readonly factor = 10;
        constructor() {
          of(1, 2).subscribe({
            factor: 3,
            next(this: { factor: number }, v: number) {
              values.push(v * this.factor);
            },
          } as Partial<{ next(v: number): void }>);
          // No error callback: RxJS reports the error, as always.
          throwError(() => failure).subscribe({ next: () => {} });
          // The deprecated `subscribe(next, error, complete)`.
          of(5).subscribe(
            (v) => values.push(v),
            undefined,
            () => values.push(-1),
          );
        }
      }
      await shown(() => new CardComponent());
      expect(values).toEqual([3, 6, 5, -1]);
      expect(unhandled).toHaveBeenCalledWith(failure);
    });

    it("is no one's if its subscription is no one's", async () => {
      const params = new Subject<number>();
      const sub = params.subscribe(() => later(((id) => () => clearInterval(id))(setInterval(() => {}, 1_000))));
      later(() => sub.unsubscribe());
      params.next(1);
      expect(mods.causes.timers.size).toBe(0);
    });
  });

  describe("asking Angular whether a constructor runs", () => {
    // It throws when none does: asked only where one may.
    class LazyStore {
      static ɵfac = () => new LazyStore();
      constructor() {
        later(((id) => () => clearInterval(id))(setInterval(() => {}, 1_000)));
      }
    }
    const lazily = async () => {
      const card = angular.build("app-card", () => new CardComponent(), { providers: [{ lazy: LazyStore }] });
      document.body.appendChild(card.el);
      await flushObserver();
      // Injected at last, from outside anything Angular runs.
      card.provide(0, () => new LazyStore());
      mods.discovery.rescan();
      destroyAndCollect({ el: card.el, view: angular.rootView });
      return events.find((e) => e.name === "CardComponent")?.retained;
    };

    it("from Angular 19.2 on, only within what Angular reports running: not for what is created outside", async () => {
      expect(await lazily()).toEqual([{ name: "LazyStore", kind: "service", count: 1 }]);
      expect(causesOf("CardComponent")).toEqual([]);
    });

    it("before 19.2, where Angular doesn't report creating a component outside a template, everywhere", async () => {
      mods.instrument.stopCauses();
      mods.discovery.stopDiscovery();
      vi.unstubAllGlobals();
      await setUp({ angular: 18 }, { angular: 18 });
      await lazily();
      expect(causesOf("CardComponent")).toEqual([
        own({ description: "setInterval every 1000 ms", by: "LazyStore", byKind: "service" }),
      ]);
    });

    it("everywhere until it knows what Angular runs: not if it started listening within it", async () => {
      // Angular publishes its profiler as it creates the first component,
      // whose creation the detector can't have seen start.
      mods.instrument.stopCauses();
      const ng = (globalThis as any).ng;
      const setProfiler = ng.ɵsetProfiler;
      setProfiler.mockClear();
      delete ng.ɵsetProfiler;
      mods.instrument.startCauses();
      ng.ɵsetProfiler = setProfiler;
      class CardComponent {
        n = 0;
        constructor() {
          later(((id) => () => clearInterval(id))(setInterval(() => this.n++, 1_000)));
        }
      }
      const card = await shown(() => new CardComponent());
      expect(setProfiler).toHaveBeenCalledTimes(1);
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([own({ description: "setInterval every 1000 ms" })]);
    });

    it("never for the listeners, output and async pipe subscriptions Angular makes for templates, which it ends", async () => {
      const { EventEmitter } = await import("@angular/core");
      const changed = new EventEmitter<number>();
      class CardComponent {
        n = 0;
        constructor() {
          // Angular's listener, and the one its DOM renderer wraps it in.
          const angularListener = { wrapListenerIn_markDirtyAndPreventDefault() {} }.wrapListenerIn_markDirtyAndPreventDefault;
          const rendererListener = (event: unknown) => (event === "__ngUnwrap__" ? angularListener : undefined);
          window.addEventListener("resize", angularListener);
          window.addEventListener("scroll", rendererListener);
          // Angular subscribing to an output with its listener.
          const output = changed.subscribe(angularListener);
          // Angular's `async` pipe subscribing, as it does, with its `next`.
          const pipe = { _updateLatestValue: (_obj: unknown, _value: unknown) => {} };
          const async = changed.subscribe({ next: (value: number) => pipe._updateLatestValue(changed, value) });
          const ticks = new BehaviorSubject(0);
          const asyncTicks = ticks.subscribe({ next: (value: number) => pipe._updateLatestValue(ticks, value) });
          // The app's own: counted.
          changed.subscribe(() => this.n++);
          later(() => {
            window.removeEventListener("resize", angularListener);
            window.removeEventListener("scroll", rendererListener);
            output.unsubscribe();
            async.unsubscribe();
            asyncTicks.unsubscribe();
          });
        }
      }
      const card = await shown(() => new CardComponent());
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([own({ kind: "subscription", description: "subscription to EventEmitter" })]);
    });

    it("from 19.2 on, takes a service created on demand by a hook for the hook's instance", async () => {
      class LazyStore {
        static ɵfac = () => new LazyStore();
        constructor() {
          later(((id) => () => clearInterval(id))(setInterval(() => {}, 1_000)));
        }
      }
      const card = angular.build("app-card", () => new CardComponent(), { providers: [{ lazy: LazyStore }] });
      document.body.appendChild(card.el);
      await flushObserver();
      angular.hook(card.instance!, "ngOnInit", () => card.provide(0, () => new LazyStore()));
      mods.discovery.rescan();
      destroyAndCollect({ el: card.el, view: angular.rootView });
      expect(causesOf("CardComponent")).toEqual([
        own({ description: "setInterval every 1000 ms", startedIn: "ngOnInit" }),
      ]);
    });
  });

  describe("in lifecycle hooks, event handlers and templates (Angular's profiler)", () => {
    it("names what they started, on Angular 20 and later", async () => {
      const ticks = new BehaviorSubject(0);
      const card = await shown(() => new CardComponent());
      const instance = card.instance!;
      angular.hook(instance, "ngOnInit", () => {
        const id = setTimeout(() => instance.n++, 60_000);
        later(() => clearTimeout(id));
      });
      angular.handler(instance, () => {
        const on = () => instance.n++;
        window.addEventListener("resize", on);
        later(() => window.removeEventListener("resize", on));
      });
      angular.template(instance, () => ticks.subscribe(() => instance.n++));
      // Nothing runs now: no one's.
      const id = setInterval(() => {}, 1_000);
      later(() => clearInterval(id));
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "timeout", description: "setTimeout of 60000 ms", startedIn: "ngOnInit" }),
        own({ kind: "eventListener", description: '"resize" listener on window', startedIn: "event handler" }),
        own({ kind: "subscription", description: "subscription to BehaviorSubject", startedIn: "template" }),
      ]);
      expect(warning()).toContain(
        'Likely causes: setTimeout of 60000 ms, set in ngOnInit and still pending; "resize" listener on window, added in an event handler and never removed; subscription to BehaviorSubject, opened in its template and never unsubscribed.',
      );
      // One profiler among several, removed when done.
      expect(angular.setProfiler).toHaveBeenCalledTimes(1);
      mods.instrument.stopCauses();
      const profiled = vi.fn();
      angular.setProfiler(profiled);
      angular.profile(4, instance);
      expect(profiled).toHaveBeenCalledTimes(1);
    });

    it("follows what Angular runs within what, and ignores an end without its start", async () => {
      const parent = await shown(() => new CardComponent());
      class ItemComponent {}
      const item = await shown(() => new ItemComponent(), "app-item");
      const timeout = (ms: number) => later(((id) => () => clearTimeout(id))(setTimeout(() => {}, ms)));
      angular.template(parent.instance!, () => {
        angular.hook(item.instance!, "ngOnChanges", () => timeout(60_001));
        // Angular 16 to 19 call ngOnChanges through a wrapper of theirs.
        angular.profile(4, item.instance!, function rememberChangeHistoryAndInvokeOnChangesHook() {});
        timeout(60_002);
        angular.profile(5, item.instance!, undefined);
        angular.profile(5, parent.el, undefined); // an end without its start
        timeout(60_003);
      });
      timeout(60_004);
      destroyAndCollect(parent, item);
      expect(causesOf("ItemComponent")).toEqual([
        own({ kind: "timeout", description: "setTimeout of 60001 ms", startedIn: "ngOnChanges", by: "ItemComponent" }),
        own({ kind: "timeout", description: "setTimeout of 60002 ms", startedIn: "ngOnChanges", by: "ItemComponent" }),
      ]);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "timeout", description: "setTimeout of 60003 ms", startedIn: "template" }),
      ]);
    });

    it("knows an instance by what its constructor and its hooks started alike", async () => {
      class CardComponent {
        n = 0;
        constructor() {
          const id = setInterval(() => this.n++, 1_000);
          later(() => clearInterval(id));
        }
      }
      const built = angular.build("app-card", () => new CardComponent());
      // ngOnInit runs before discovery sees the component.
      angular.hook(built.instance!, "ngOnInit", () => {
        const id = setInterval(() => built.instance!.n++, 1_000);
        later(() => clearInterval(id));
      });
      document.body.appendChild(built.el);
      await flushObserver();
      destroyAndCollect(built);
      expect(causesOf("CardComponent")).toEqual([
        own({ description: "setInterval every 1000 ms" }),
        own({ description: "setInterval every 1000 ms", startedIn: "ngOnInit" }),
      ]);
    });

    it("on Angular 16 to 19, shares Angular's one profiler with whoever sets one after it", async () => {
      mods.instrument.stopCauses();
      mods.discovery.stopDiscovery();
      vi.unstubAllGlobals();
      await setUp({ angular: 19 });
      const ng = (globalThis as any).ng;
      const setProfiler = angular.setProfiler;
      expect(setProfiler).toHaveBeenCalledTimes(1);
      expect(ng.ɵsetProfiler).not.toBe(setProfiler);
      // Angular DevTools starts profiling: it gets every event, and so do we.
      const devtools = vi.fn();
      ng.ɵsetProfiler(devtools);
      const card = await shown(() => new CardComponent());
      const instance = card.instance!;
      angular.hook(instance, "ngOnInit", () => later(((id) => () => clearTimeout(id))(setTimeout(() => {}, 5_000))));
      expect(devtools).toHaveBeenCalledWith(4, instance, expect.any(Function));
      expect(devtools).toHaveBeenCalledWith(5, instance, expect.any(Function));
      // It stops: we still listen.
      ng.ɵsetProfiler(null);
      devtools.mockClear();
      angular.hook(instance, "ngAfterViewInit", () => later(((id) => () => clearTimeout(id))(setTimeout(() => {}, 6_000))));
      expect(devtools).not.toHaveBeenCalled();
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "timeout", description: "setTimeout of 5000 ms", startedIn: "ngOnInit" }),
        own({ kind: "timeout", description: "setTimeout of 6000 ms", startedIn: "ngAfterViewInit" }),
      ]);
      // Stopped, the detector hands the profiler back.
      ng.ɵsetProfiler(devtools);
      mods.instrument.stopCauses();
      expect(ng.ɵsetProfiler).toBe(setProfiler);
      angular.profile(0, instance);
      expect(devtools).toHaveBeenCalledWith(0, instance, undefined);
    });

    it("without it, in a production build, names what constructors started only", async () => {
      mods.instrument.stopCauses();
      mods.discovery.stopDiscovery();
      vi.unstubAllGlobals();
      await setUp({ production: true }, { production: true });
      expect((globalThis as any).ng).toBeUndefined();
      class CardComponent {
        n = 0;
        constructor() {
          const id = setInterval(() => this.n++, 1_000);
          later(() => clearInterval(id));
        }
      }
      const card = await shown(() => new CardComponent());
      angular.hook(card.instance!, "ngOnInit", () => later(((id) => () => clearTimeout(id))(setTimeout(() => {}, 5_000))));
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([own({ description: "setInterval every 1000 ms" })]);
    });
  });

  describe("loops", () => {
    it("names an animation loop and a timeout loop its owner started", async () => {
      class CardComponent {
        n = 0;
        stopped = false;
        constructor() {
          const tick = () => {
            if (!this.stopped) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          // A new arrow function each round.
          const poll = () => {
            if (!this.stopped) setTimeout(() => poll(), 5);
          };
          setTimeout(() => poll(), 5);
          later(() => (this.stopped = true));
        }
      }
      const card = await shown(() => new CardComponent());
      // A few rounds of each.
      for (let i = 0; i < 3; i++) runFrames();
      await wait(80);
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([
        own({ kind: "animationFrame", description: "requestAnimationFrame loop" }),
        own({ kind: "timeout", description: "setTimeout loop (every 5 ms)" }),
      ]);
      expect(warning()).toContain(
        "Likely causes: requestAnimationFrame loop, started in its constructor and never stopped; setTimeout loop (every 5 ms), started in its constructor and never stopped.",
      );
    });

    it("names nothing else a timer's callback starts", async () => {
      // Such as change detection, run by a timer of one component, that
      // creates others: what they start isn't the first one's.
      const ticks = new BehaviorSubject(0);
      class CardComponent {
        n = 0;
        constructor() {
          setTimeout(() => {
            const id = setInterval(() => {}, 1_000);
            const sub = ticks.subscribe(() => {});
            const on = () => {};
            window.addEventListener("resize", on);
            // A timeout, but another one.
            const other = setTimeout(() => {}, 60_000);
            later(() => {
              clearInterval(id);
              sub.unsubscribe();
              window.removeEventListener("resize", on);
              clearTimeout(other);
            });
          }, 1);
          // Bound functions all read alike: not a loop either.
          const bound = function (this: unknown) {
            later(((id) => () => clearTimeout(id))(setTimeout(function () {}.bind(null), 60_000)));
          }.bind(this);
          setTimeout(bound, 1);
        }
      }
      const card = await shown(() => new CardComponent());
      await wait();
      destroyAndCollect(card);
      expect(causesOf("CardComponent")).toEqual([]);
    });
  });

  describe("trackCauses", () => {
    it("records nothing with it off, and names no cause", async () => {
      mods.config.configure({ trackCauses: false });
      class CardComponent {
        n = 0;
        constructor() {
          const id = setInterval(() => this.n++, 1_000);
          later(() => clearInterval(id));
        }
      }
      const off = await shown(() => new CardComponent());
      expect(mods.causes.timers.size).toBe(0);
      mods.config.configure({ trackCauses: true });
      const on = await shown(() => new CardComponent());
      expect(mods.causes.timers.size).toBe(1);
      mods.config.configure({ trackCauses: false });
      destroyAndCollect(off, on);
      expect(events[0]).toMatchObject({ name: "CardComponent", stale: 2, causes: [] });
      expect(warning()).not.toContain("Likely cause");
    });

    it("puts back what it wrapped", async () => {
      const { EventEmitter } = await import("@angular/core");
      const observable = Object.getPrototypeOf(Object.getPrototypeOf(EventEmitter.prototype));
      const wrapped = [globalThis.setTimeout, EventTarget.prototype.addEventListener, observable.subscribe];
      mods.instrument.stopCauses();
      const originals = [globalThis.setTimeout, EventTarget.prototype.addEventListener, observable.subscribe];
      originals.forEach((original, i) => expect(original).not.toBe(wrapped[i]));
      mods.instrument.startCauses();
      expect(globalThis.setTimeout).not.toBe(originals[0]);
      expect(observable.subscribe).not.toBe(originals[2]);
    });

    it("starts with the provider, before Angular creates the first component", async () => {
      mods.instrument.stopCauses();
      const original = globalThis.setTimeout;
      const { provideMemoryLeakDetector } = await import("../src/provider");
      provideMemoryLeakDetector({ trackCauses: false });
      expect(globalThis.setTimeout).toBe(original);
      provideMemoryLeakDetector();
      expect(globalThis.setTimeout).not.toBe(original);
    });

    it("starts once turned on, if the detector started with it off", async () => {
      mods.instrument.stopCauses();
      vi.spyOn(console, "info").mockImplementation(() => {});
      const original = globalThis.setInterval;
      const api = mods.detector.startMemoryLeakDetector({ trackCauses: false })!;
      try {
        expect(globalThis.setInterval).toBe(original);
        api.configure({ trackCauses: true });
        expect(globalThis.setInterval).not.toBe(original);
      } finally {
        delete window.__ngLeakDetector;
      }
    });
  });
});

/** Keeps an instance in memory by its callbacks (`self`), or not (`null`). */
const gcTicks = new BehaviorSubject(0);
function startAll(self: { n: number } | null): void {
  const callback = self ? () => self.n++ : () => {};
  const interval = setInterval(callback, 60_000);
  const timeout = setTimeout(callback, 60_000);
  const frame = requestAnimationFrame(callback);
  window.addEventListener("resize", callback);
  const subscription = gcTicks.subscribe(callback);
  const idle = requestIdleCallback(callback);
  window.addEventListener("beforeprint", callback, { once: true });
  const observer = new MutationObserver(callback);
  observer.observe(document.body, { childList: true });
  // What its callback starts: a timeout (at once: a BehaviorSubject).
  let started: ReturnType<typeof setTimeout> | undefined;
  const inCallback = gcTicks.subscribe(() => (started = setTimeout(callback, 60_000)));
  later(() => {
    clearInterval(interval);
    clearTimeout(timeout);
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", callback);
    subscription.unsubscribe();
    cancelIdleCallback(idle);
    window.removeEventListener("beforeprint", callback);
    observer.disconnect();
    inCallback.unsubscribe();
    clearTimeout(started);
  });
}

/**
 * Starts an interval, a timeout, an animation frame, an idle callback,
 * listeners (one `once`), an observer and subscriptions (one whose callback
 * starts a timeout), whose callbacks refer to it if `holding`. Declared here, not
 * in a test: a closure keeps the whole scope it was made in.
 */
class Widget {
  n = 0;
  constructor(holding: boolean) {
    startAll(holding ? this : null);
  }
}

describe("what the detector records for causes", () => {
  /** Node's garbage collector, on demand. */
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;

  afterEach(() => {
    cleanups.reverse().forEach((cleanup) => cleanup());
    cleanups = [];
  });

  it("never keeps an instance in memory, whatever it started", async () => {
    const mods = await loadRuntime();
    const { Injector, runInInjectionContext } = await import("@angular/core");
    // jsdom's own starts an interval of its own the first time.
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.set(frames.size + 1, callback).size);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const idles = new Map<number, IdleRequestCallback>();
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => idles.set(idles.size + 1, callback).size);
    vi.stubGlobal("cancelIdleCallback", (id: number) => idles.delete(id));
    later(() => vi.unstubAllGlobals());
    mods.instrument.startCauses();

    /** A Widget Angular creates in a view of its own, then forgets. */
    const create = (holding: boolean) => {
      const factory = { factory: () => undefined, resolving: true };
      const lView: unknown[] = [];
      lView[1] = { blueprint: [], data: [] };
      lView[30] = factory;
      const tNode = { providerIndexes: 30, directiveStart: 30, directiveEnd: 31 };
      const nodeInjector = { _tNode: tNode, _lView: lView, get: () => null };
      const instance = runInInjectionContext(
        { get: (token: unknown) => (token === Injector ? nodeInjector : null) },
        () => new Widget(holding),
      );
      lView[30] = instance;
      factory.resolving = false;
      const recorded = mods.ownership.ownerOf(instance)?.resources.size;
      return { ref: new WeakRef(instance), recorded };
    };

    const free = create(false);
    const held = create(true);
    // Interval, timeout, frame, idle callback, two listeners, observer, two
    // subscriptions, and the timeout one's callback started.
    expect([free.recorded, held.recorded]).toEqual([10, 10]);
    expect(mods.causes.timers.size).toBe(6);
    // A WeakRef keeps its target until the job that made it ends.
    await wait(0);
    gc();
    expect(free.ref.deref(), "recorded, and collected all the same").toBeUndefined();
    // The same, its callbacks referring to it: kept, by them.
    expect(held.ref.deref()).toBeDefined();
    mods.instrument.stopCauses();
    frames.clear();
  });
});
