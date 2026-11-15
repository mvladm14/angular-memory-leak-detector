// Re-loads the runtime modules with fresh state for each test. The modules
// hold module-level singletons (the live set, listeners, config), so every
// test gets its own copies while the cross-module references stay shared.

import { vi } from "vitest";

export type Runtime = {
  config: typeof import("../src/config");
  store: typeof import("../src/store");
  subscribers: typeof import("../src/subscribers");
  lifecycle: typeof import("../src/lifecycle");
  sweep: typeof import("../src/sweep");
  witness: typeof import("../src/witness");
  discovery: typeof import("../src/discovery");
  detector: typeof import("../src/detector");
  router: typeof import("../src/router");
};

/**
 * `angular` stands in for the Angular major (`VERSION.major`) the detector
 * runs on; by default, the one installed.
 */
export async function loadRuntime({ seasoned = true, angular }: { seasoned?: boolean; angular?: number } = {}): Promise<Runtime> {
  vi.resetModules();
  if (angular === undefined) vi.doUnmock("@angular/core");
  else {
    vi.doMock("@angular/core", async (importOriginal) => {
      const core = await importOriginal<typeof import("@angular/core")>();
      return { ...core, VERSION: { ...core.VERSION, major: String(angular) } };
    });
  }
  const mods: Runtime = {
    config: await import("../src/config"),
    store: await import("../src/store"),
    subscribers: await import("../src/subscribers"),
    lifecycle: await import("../src/lifecycle"),
    sweep: await import("../src/sweep"),
    witness: await import("../src/witness"),
    discovery: await import("../src/discovery"),
    detector: await import("../src/detector"),
    router: await import("../src/router"),
  };
  // What starting the detector does (src/detector.ts).
  mods.witness.startWitnesses();
  // A page that has been running for a while: the whole witness stock has
  // been held through enough collections (src/witness.ts).
  if (seasoned) for (let i = 0; i < 3; i++) mods.witness.noteGc();
  return mods;
}

/** A WeakRef whose target has been collected. */
const collected = { deref: () => undefined } as unknown as WeakRef<object>;

/**
 * Stand-in for one major garbage collection: every released witness is
 * collected, then the collection is counted. Tracked instances are left
 * alone, as if each one were still referenced — the leak a real collection
 * would expose.
 */
export function simulateGc(mods: Runtime): void {
  mods.store.live.forEach((entry) => {
    if (entry.witness) entry.witness.ref = collected;
  });
  mods.witness.noteGc();
}

export type FakeView = {
  context: unknown;
  destroyed: boolean;
  hooks: Array<() => void>;
  onDestroy(cb: () => void): void;
  destroy(): void;
};

/**
 * A stand-in for Angular's dev-mode `window.ng`, shaped like Angular's from
 * 16 to 22 (the end-to-end suite runs on each): elements Angular creates carry
 * a numeric `__ngContext__`, and a lookup replaces it with a context object
 * that caches the component.
 */
export function fakeAngular(ChangeDetectorRef: unknown) {
  const hosts = new Map<Element, { instance: object; view: FakeView }>();
  const directives = new Map<Element, unknown[]>();
  let nextId = 1;
  const getComponent = vi.fn((el: Element) => {
    const found = hosts.get(el);
    (el as any).__ngContext__ = { lViewId: 1, component: found?.instance ?? null };
    return found?.instance ?? null;
  });

  const getDirectives = vi.fn((el: Element) => {
    (el as any).__ngContext__ = { lViewId: 1, directives: directives.get(el) ?? [] };
    return [...(directives.get(el) ?? [])];
  });

  (globalThis as any).ng = {
    getComponent,
    getDirectives,
    getInjector: (el: Element) => ({
      get: (token: unknown) =>
        token === ChangeDetectorRef
          ? (hosts.get(el)?.view ?? { context: "parent", destroyed: false, onDestroy() {} })
          : null,
    }),
  };

  return {
    getComponent,
    getDirectives,
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
      return { el, view, instance };
    },
    /**
     * A `<router-outlet>` and its RouterOutlet directive. `deactivate` does
     * what RouterOutlet does: destroy the page's view, then emit the page;
     * `activate` emits a page it has created.
     */
    outlet() {
      const el = document.createElement("router-outlet");
      (el as any).__ngContext__ = nextId++;
      const listeners: Array<(component: unknown) => void> = [];
      const activateListeners: Array<(component: unknown) => void> = [];
      const emitter = (to: Array<(component: unknown) => void>) => ({
        subscribe(next: (component: unknown) => void) {
          to.push(next);
          return { unsubscribe() {} };
        },
      });
      const outlet = { deactivateEvents: emitter(listeners), activateEvents: emitter(activateListeners) };
      directives.set(el, [{ someOtherDirective: true }, outlet]);
      return {
        el,
        listeners,
        activateListeners,
        deactivate(page: { instance: object; view: FakeView }) {
          page.view.destroy();
          listeners.forEach((listener) => listener(page.instance));
        },
        activate(instance: object) {
          activateListeners.forEach((listener) => listener(instance));
        },
      };
    },
    /** An element created by Angular that hosts no component. */
    plain(tag: string) {
      const el = document.createElement(tag);
      (el as any).__ngContext__ = nextId++;
      return el;
    },
  };
}

/** Let the MutationObserver deliver. */
export const flushObserver = () => new Promise((resolve) => setTimeout(resolve, 0));
