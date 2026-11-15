// Pages the Angular router itself keeps in memory after navigating away from
// them, on Angular 16 and 20.
//
// A navigation's transition state lists the page components it deactivated.
// Angular 16's router keeps the state of the latest navigation that started,
// whether it succeeded or not (fixed in 17). Angular 20's keeps the state of
// the latest two navigations that succeeded, in their `Navigation.abort`
// closures (fixed in 21). So those pages stay in memory until later
// navigations replace that state.
//
// An app can't fix that. On these two versions a page the router still holds
// is therefore `heldByRouter`: it gets no verdict while held, and once later
// navigations push it out it is judged like any other destroyed component. A
// page that really leaks is still reported, a navigation or two later.
//
// The pages come from the public `deactivate` output of every
// `<router-outlet>`, which emits each page component the router destroys. All
// the pages one navigation takes down (a page and its child pages) are
// deactivated in one synchronous run, followed in the same run by the pages it
// creates (the outlets' `activate` output). So what the outlets emit until the
// next microtask makes up one navigation, and a navigation that took pages
// down but created none failed: creating its page threw.
//
// Not covered: on Angular 20, a navigation cancelled while it creates its page
// (e.g. by `router.navigate()` in that page's constructor) counts although the
// router doesn't count it; and on both versions, an outlet whose `name`
// changes takes its page down outside any navigation, which counts too. Either
// can release a page the router still holds, one navigation early.

import { VERSION } from "@angular/core";
import { entryOf } from "./store.js";
import type { LiveEntry } from "./types.js";
import { syncWitness } from "./witness.js";
import { outsideAngular } from "./zone.js";

type RouterHold = {
  /** How many of the latest counted navigations' pages the router holds. */
  navigations: number;
  /** Only navigations that succeeded count (20), or every one that started (16). */
  successfulOnly: boolean;
};

/** By Angular major: the routers that hold pages. */
const ROUTER_HOLDS: Readonly<Record<string, RouterHold>> = {
  "16": { navigations: 1, successfulOnly: false },
  "20": { navigations: 2, successfulOnly: true },
};

const hold: RouterHold | undefined = ROUTER_HOLDS[VERSION.major];

/** 0 on every version whose router holds no page. */
export const heldNavigations = hold?.navigations ?? 0;

/** The tag of Angular's router outlet. */
export const OUTLET_TAG = "router-outlet";

type OutletEvents = { subscribe(next: (component: unknown) => void): unknown };
type Outlet = { deactivateEvents: OutletEvents; activateEvents?: OutletEvents };

export function isRouterOutlet(value: unknown): value is Outlet {
  const events = (value as Partial<Outlet> | null)?.deactivateEvents;
  return typeof events === "object" && events !== null && typeof events.subscribe === "function";
}

/** What the outlets emitted in one synchronous run: one navigation's. */
type Run = { pages: Set<LiveEntry>; createdPage: boolean };

/** The pages each of the latest counted navigations took down, oldest first. */
const navigations: Set<LiveEntry>[] = [];
/** The run in progress, until the next microtask. */
let run: Run | null = null;
const watched = new WeakSet<object>();

/** Hold the pages `outlet` deactivates while the router keeps them. */
export function watchOutlet(outlet: Outlet): void {
  if (!hold || watched.has(outlet)) return;
  watched.add(outlet);
  // Module-level listeners: they hold no outlet, and no page after they return.
  outlet.deactivateEvents.subscribe(onDeactivate);
  if (hold.successfulOnly) outlet.activateEvents?.subscribe(onActivate);
}

function currentRun(): Run {
  if (run) return run;
  const started: Run = { pages: new Set(), createdPage: false };
  run = started;
  outsideAngular(() =>
    queueMicrotask(() => {
      if (run === started) run = null;
      endRun(started);
    }),
  );
  return started;
}

/** Angular has just destroyed `component`, a page, and emits it. */
function onDeactivate(component: unknown): void {
  if (typeof component !== "object" || component === null) return;
  const entry = entryOf(component);
  if (!entry) return;
  currentRun().pages.add(entry);
  entry.heldByRouter = true;
  // Drops a witness given when the page was destroyed (`leakAgeMs: 0`).
  syncWitness(entry, Date.now());
}

/** An outlet has just created a page. */
function onActivate(): void {
  currentRun().createdPage = true;
}

function endRun(ended: Run): void {
  if (ended.pages.size === 0) return;
  const now = Date.now();
  if (hold!.successfulOnly && !ended.createdPage) {
    // A navigation that failed: the router keeps none of its pages.
    ended.pages.forEach((page) => release(page, now));
    return;
  }
  navigations.push(ended.pages);
  // A navigation pushed out of the window: the router has let go of its pages.
  while (navigations.length > heldNavigations) {
    navigations.shift()!.forEach((page) => release(page, now));
  }
}

function release(page: LiveEntry, now: number): void {
  page.heldByRouter = false;
  syncWitness(page, now);
}
