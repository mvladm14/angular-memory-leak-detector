import { expect, test, type CDPSession, type Page, type TestInfo } from "@playwright/test";

type LeakEvent = {
  name: string;
  kind: string;
  host: string;
  hosts: Array<{ host: string; count: number }>;
  stale: number;
  live: number;
  retained: Array<{ name: string; kind: string; count: number }>;
  causes: LeakCause[];
};
type LeakCause = { kind: string; description: string; startedIn: string | null; by: string; byKind: string; count: number };
type ReportRow = ReturnType<NonNullable<Window["__ngLeakDetector"]>["report"]>[number];

// `window.__ngLeakDetector` is declared by the detector (src/detector.ts).
declare global {
  interface Window {
    __leakTest?: { events: LeakEvent[]; zone: boolean; devMode: boolean; zoneTurns(): number };
  }
}

/** Set per project by playwright.config.ts. */
type ProjectMetadata = { angular: number; zone: boolean; production: boolean; minifiedNames: boolean };
const projectOf = (testInfo: TestInfo) => testInfo.project.metadata as ProjectMetadata;

/**
 * What the detector calls each class of the app in a production build whose
 * class names are minified (not restored by ng-leak-names): class names mean
 * nothing there, so a component or directive goes by its selector, and a
 * service by the element that provides it and its place among that
 * element's providers (src/names.ts).
 */
const PRODUCTION_NAMES: Readonly<Record<string, string>> = {
  AppComponent: "app-root",
  CardComponent: "app-card",
  HomePageComponent: "app-home-page",
  OtherPageComponent: "app-other-page",
  NestedPageComponent: "app-nested-page",
  NestedChildComponent: "app-nested-child",
  LeakyPageComponent: "app-leaky-page",
  StatefulPageComponent: "app-stateful-page",
  PageTitleDirective: "[appPageTitle]",
  PageStateService: "app-stateful-page providers[0]",
  LeakyTimerComponent: "app-leaky-timer",
  FixedTimerComponent: "app-fixed-timer",
  LeakySubscriptionComponent: "app-leaky-subscription",
  FixedSubscriptionComponent: "app-fixed-subscription",
  LeakyListenerComponent: "app-leaky-listener",
  FixedListenerComponent: "app-fixed-listener",
  LeakyTooltipDirective: "[appLeakyTooltip]",
  FixedTooltipDirective: "[appFixedTooltip]",
  LeakyServiceComponent: "app-leaky-service",
  FixedServiceComponent: "app-fixed-service",
  LeakyStore: "app-leaky-service providers[0]",
  FixedStore: "app-fixed-service providers[0]",
  LeakyPlainServiceComponent: "app-leaky-plain-service",
  FixedPlainServiceComponent: "app-fixed-plain-service",
  LeakyViewComponent: "app-leaky-view",
  HighlightDirective: "[appHighlight]",
  RouterLink: "[routerLink]",
  ViewState: "app-leaky-view providers[0]",
  LeakyTimeoutComponent: "app-leaky-timeout",
  FixedTimeoutComponent: "app-fixed-timeout",
  LeakyAnimationComponent: "app-leaky-animation",
  FixedAnimationComponent: "app-fixed-animation",
  LeakyPollingComponent: "app-leaky-polling",
  FixedPollingComponent: "app-fixed-polling",
  LeakyPanelComponent: "app-leaky-panel",
  FixedPanelComponent: "app-fixed-panel",
  LeakyVisibilityDirective: "[appLeakyVisibility]",
  FixedVisibilityDirective: "[appFixedVisibility]",
  LeakyOnlineComponent: "app-leaky-online",
  FixedOnlineComponent: "app-fixed-online",
  LeakyCacheComponent: "app-leaky-cache",
  FixedCacheComponent: "app-fixed-cache",
  LeakyResizeComponent: "app-leaky-resize",
  FixedResizeComponent: "app-fixed-resize",
  LeakyIdleComponent: "app-leaky-idle",
  FixedIdleComponent: "app-fixed-idle",
  LeakyOnceComponent: "app-leaky-once",
  FixedOnceComponent: "app-fixed-once",
  LeakyCallbackComponent: "app-leaky-callback",
  FixedCallbackComponent: "app-fixed-callback",
};

/** What the detector calls the class `className` in the build under test. */
function nameIn(testInfo: TestInfo): (className: string) => string {
  if (!projectOf(testInfo).minifiedNames) return (className) => className;
  return (className) => {
    const name = PRODUCTION_NAMES[className];
    if (name === undefined) throw new Error(`No production name for ${className}: add it to PRODUCTION_NAMES.`);
    return name;
  };
}

/**
 * A cause a leak must name (the event's `causes`), `by` the leaky class
 * unless said otherwise. A subscription's `description` names what it
 * subscribed to, which a build with minified class names can't say:
 * `subscription` there.
 */
type ExpectedCause = { kind: string; description: string; startedIn: string; by?: string; byKind?: string };

type Pair = {
  id: string;
  leaky: string;
  fixed: string;
  /** A component unless said otherwise. */
  kind?: "directive" | "service";
  /** `app-leaky-<id>` unless said otherwise. */
  host?: string;
  /** Components that must be collected too, neither leaky nor fixed. */
  collected?: string[];
  /** Provided with `useValue` and kept on purpose: never tracked, never reported. */
  untracked?: string[];
  /**
   * Services whose class has no decorator: found through how Angular
   * records providers, in development only.
   */
  undecorated?: true;
  /** What keeps the leaky one in memory, as its event names it: nothing the detector watches if empty. */
  causes: ExpectedCause[];
  /**
   * The causes are found in development builds only: started in a
   * lifecycle hook or an event handler, which only Angular's profiler tells
   * the detector about. A production build reports the leak with no cause.
   */
  causesInDevelopment?: true;
  /** How the warning names them, with class names as in development. */
  sentence?: string;
  /** Directives that leak with the leaky component, in its warning and event: `retained`. */
  retained?: Array<{ name: string; kind: string; count: number }>;
  /** A button to click in both, `<action>-leaky-<id>` and `<action>-fixed-<id>`, before destroying them. */
  action?: string;
};

const PAIRS: Pair[] = [
  {
    id: "timer",
    leaky: "LeakyTimerComponent",
    fixed: "FixedTimerComponent",
    causes: [{ kind: "interval", description: "setInterval every 1000 ms", startedIn: "constructor" }],
    sentence: "Likely cause: setInterval every 1000 ms, started in its constructor and never cleared.",
  },
  {
    id: "subscription",
    leaky: "LeakySubscriptionComponent",
    fixed: "FixedSubscriptionComponent",
    causes: [{ kind: "subscription", description: "subscription to BehaviorSubject", startedIn: "constructor" }],
    sentence: "Likely cause: subscription to BehaviorSubject, opened in its constructor and never unsubscribed.",
  },
  {
    id: "listener",
    leaky: "LeakyListenerComponent",
    fixed: "FixedListenerComponent",
    causes: [{ kind: "eventListener", description: '"resize" listener on window', startedIn: "constructor" }],
    sentence: 'Likely cause: "resize" listener on window, added in its constructor and never removed.',
  },
  // On a `<p>` in the app's template.
  {
    id: "directive",
    leaky: "LeakyTooltipDirective",
    fixed: "FixedTooltipDirective",
    kind: "directive",
    host: "p",
    causes: [{ kind: "subscription", description: "subscription to BehaviorSubject", startedIn: "constructor" }],
  },
  // Provided by a component: only the service leaks, the component doesn't.
  {
    id: "service",
    leaky: "LeakyStore",
    fixed: "FixedStore",
    kind: "service",
    collected: ["LeakyServiceComponent", "FixedServiceComponent"],
    causes: [{ kind: "subscription", description: "subscription to BehaviorSubject", startedIn: "constructor" }],
  },
  // The same, in classes without `@Injectable()`.
  {
    id: "plain-service",
    leaky: "LeakyPlainStore",
    fixed: "FixedPlainStore",
    kind: "service",
    collected: ["LeakyPlainServiceComponent", "FixedPlainServiceComponent"],
    untracked: ["Labels"],
    undecorated: true,
    causes: [{ kind: "subscription", description: "subscription to BehaviorSubject", startedIn: "constructor" }],
  },
  // Leak culprits: a different resource keeps each leaky one.
  {
    id: "timeout",
    leaky: "LeakyTimeoutComponent",
    fixed: "FixedTimeoutComponent",
    causes: [{ kind: "timeout", description: "setTimeout of 3600000 ms", startedIn: "ngOnInit" }],
    causesInDevelopment: true,
    sentence: "Likely cause: setTimeout of 3600000 ms, set in ngOnInit and still pending.",
  },
  {
    id: "animation",
    leaky: "LeakyAnimationComponent",
    fixed: "FixedAnimationComponent",
    // Each frame requests the next: a loop, started by the first.
    causes: [{ kind: "animationFrame", description: "requestAnimationFrame loop", startedIn: "constructor" }],
    sentence: "Likely cause: requestAnimationFrame loop, started in its constructor and never stopped.",
  },
  {
    id: "polling",
    leaky: "LeakyPollingComponent",
    fixed: "FixedPollingComponent",
    action: "start",
    causes: [{ kind: "timeout", description: "setTimeout loop (every 200 ms)", startedIn: "event handler" }],
    causesInDevelopment: true,
    sentence: "Likely cause: setTimeout loop (every 200 ms), started in an event handler and never stopped.",
  },
  // The directive's listener keeps the component it is in: one leak, the component's.
  {
    id: "panel",
    leaky: "LeakyPanelComponent",
    fixed: "FixedPanelComponent",
    collected: ["FixedVisibilityDirective"],
    retained: [{ name: "LeakyVisibilityDirective", kind: "directive", count: 1 }],
    causes: [
      {
        kind: "eventListener",
        description: '"visibilitychange" listener on document',
        startedIn: "constructor",
        by: "LeakyVisibilityDirective",
        byKind: "directive",
      },
    ],
    sentence:
      'Likely cause: "visibilitychange" listener on document, added by LeakyVisibilityDirective in its constructor and never removed.',
  },
  // `fromEvent`: the subscription, and the listener it added.
  {
    id: "online",
    leaky: "LeakyOnlineComponent",
    fixed: "FixedOnlineComponent",
    causes: [
      { kind: "eventListener", description: '"online" listener on window', startedIn: "ngOnInit" },
      { kind: "subscription", description: "subscription to Observable", startedIn: "ngOnInit" },
    ],
    causesInDevelopment: true,
    sentence:
      'Likely causes: "online" listener on window, added in ngOnInit and never removed; subscription to Observable, opened in ngOnInit and never unsubscribed.',
  },
  // Kept by a root service: nothing the detector watches, so no cause.
  { id: "cache", leaky: "LeakyCacheComponent", fixed: "FixedCacheComponent", causes: [] },
  {
    id: "resize",
    leaky: "LeakyResizeComponent",
    fixed: "FixedResizeComponent",
    causes: [{ kind: "observer", description: "ResizeObserver observing <body>", startedIn: "constructor" }],
    sentence: "Likely cause: ResizeObserver observing <body>, started in its constructor and never disconnected.",
  },
  {
    id: "idle",
    leaky: "LeakyIdleComponent",
    fixed: "FixedIdleComponent",
    causes: [{ kind: "idleCallback", description: "requestIdleCallback loop", startedIn: "constructor" }],
    sentence: "Likely cause: requestIdleCallback loop, started in its constructor and never stopped.",
  },
  {
    id: "once",
    leaky: "LeakyOnceComponent",
    fixed: "FixedOnceComponent",
    causes: [{ kind: "eventListener", description: '"beforeprint" listener (once) on window', startedIn: "constructor" }],
    sentence:
      'Likely cause: "beforeprint" listener (once) on window, added in its constructor and never fired nor removed.',
  },
  // Its subscription completed; the interval its callback started didn't.
  {
    id: "callback",
    leaky: "LeakyCallbackComponent",
    fixed: "FixedCallbackComponent",
    causes: [{ kind: "interval", description: "setInterval every 1000 ms", startedIn: "subscription callback" }],
    sentence: "Likely cause: setInterval every 1000 ms, started in a subscription's callback and never cleared.",
  },
];

/** The causes `pair`'s leak must name in the build under test. */
function causesOf(pair: Pair, testInfo: TestInfo): LeakCause[] {
  const { production, minifiedNames } = projectOf(testInfo);
  if (production && pair.causesInDevelopment) return [];
  const n = nameIn(testInfo);
  return pair.causes.map(({ kind, description, startedIn, by, byKind }) => ({
    kind,
    description: minifiedNames && kind === "subscription" ? "subscription" : description,
    startedIn,
    by: n(by ?? pair.leaky),
    byKind: byKind ?? pair.kind ?? "component",
    count: 1,
  }));
}

const hostOf = (pair: Pair) => pair.host ?? `app-leaky-${pair.id}`;

/** The start of the console warning for `pair`'s leaky one. */
function warningOf(pair: Pair, testInfo: TestInfo): string {
  const host = hostOf(pair);
  const name = nameIn(testInfo)(pair.leaky);
  if (pair.kind === "directive") return `Suspected leak: directive ${name} on <${host}>`;
  if (!projectOf(testInfo).minifiedNames) {
    if (pair.kind === "service") return `Suspected leak: service ${name} provided by <${host}>`;
    return `Suspected leak: ${name} <${host}>`;
  }
  // Named after the element already: `app-leaky-service providers[0]`, `app-leaky-timer`.
  if (pair.kind === "service") return `Suspected leak: service ${name} — `;
  return `Suspected leak: component <${host}> — `;
}

async function open(page: Page): Promise<CDPSession> {
  await page.goto("/");
  await page.waitForFunction(() => !!window.__ngLeakDetector && !!window.__leakTest);
  // Destroyed components go stale after 0.5 s; report every leak, every sweep.
  await page.evaluate(() => window.__ngLeakDetector!.configure({ leakAgeMs: 500, warnCooldownMs: 0 }));
  return page.context().newCDPSession(page);
}

/**
 * What a user does by clicking "Collect garbage" in DevTools → Memory, a few
 * times, sweeping after each. Returns the events so far and a fresh report.
 */
async function collect(page: Page, cdp: CDPSession, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await page.waitForTimeout(250);
    await cdp.send("HeapProfiler.collectGarbage");
    await page.evaluate(() => window.__ngLeakDetector!.sweep());
  }
  return page.evaluate(() => ({
    events: [...window.__leakTest!.events],
    report: window.__ngLeakDetector!.report(),
  }));
}

/** `action`: a button to click in it (`<action>-<id>`) before destroying it. */
async function createAndDestroy(page: Page, id: string, action?: string) {
  const toggle = page.getByTestId(`toggle-${id}`);
  await toggle.click();
  await expect(page.getByTestId(id)).toBeVisible();
  if (action) await page.getByTestId(`${action}-${id}`).click();
  await toggle.click();
  await expect(page.getByTestId(id)).toHaveCount(0);
}

test("runs on the Angular version under test", async ({ page }, testInfo) => {
  // Every root component carries the version of the Angular that rendered it.
  // Guards against testing some other app, e.g. a server reused on the port.
  await page.goto("/");
  const version = await page.locator("[ng-version]").first().getAttribute("ng-version");
  expect(version?.split(".")[0]).toBe(String(projectOf(testInfo).angular));
});

test("finds the running components with their class names", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await open(page);
  const zone = await page.evaluate(() => window.__leakTest!.zone);
  expect(zone).toBe(projectOf(testInfo).zone);

  const n = nameIn(testInfo);
  const report = await page.evaluate(() => window.__ngLeakDetector!.report());
  const live = Object.fromEntries(report.map((r) => [r.name, r.live]));
  expect(live).toMatchObject({ [n("AppComponent")]: 1, [n("HomePageComponent")]: 1, [n("CardComponent")]: 3 });
  expect(report.find((r) => r.name === n("CardComponent"))?.host).toBe("app-card");
  expect(errors).toEqual([]);
});

test("runs in the production build, without Angular's debugging API", async ({ page }, testInfo) => {
  test.skip(!projectOf(testInfo).production, "production build only");
  const infos: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "info") infos.push(msg.text());
  });
  await open(page);
  const build = await page.evaluate(() => ({
    devMode: window.__leakTest!.devMode,
    debugApi: typeof (window as { ng?: { getComponent?: unknown } }).ng?.getComponent,
  }));
  expect(build).toEqual({ devMode: false, debugApi: "undefined" });
  // With class names minified, or restored by ng-leak-names.
  const banner = projectOf(testInfo).minifiedNames
    ? "[ng-leak] Memory leak detector running in a production build, without Angular's debugging API, classes named by selector (minified build) ("
    : "[ng-leak] Memory leak detector running in a production build, without Angular's debugging API (";
  expect(infos.some((info) => info.startsWith(banner)), `no "${banner}" in ${JSON.stringify(infos)}`).toBe(true);
});

test("finds no service whose class has no decorator in the production build, and reports nothing about them", async ({ page }, testInfo) => {
  // Angular records how providers were declared in development only, and
  // without its own factory a class provider can't be told from a `useValue`
  // one. So neither plain store is found, whether it leaks or not, nor the
  // constant, and their components are collected as in development.
  test.skip(!projectOf(testInfo).production, "production build only");
  const cdp = await open(page);
  await createAndDestroy(page, "leaky-plain-service");
  await createAndDestroy(page, "fixed-plain-service");
  const { events, report } = await collect(page, cdp, 10);
  expect(events).toEqual([]);
  const hosts = ["app-leaky-plain-service", "app-fixed-plain-service"];
  expect(report.filter((r) => hosts.includes(r.host)), "their components must be collected, no service tracked").toEqual([]);
});

for (const pair of PAIRS) {
  test(`reports the leaky ${pair.id} and not the fixed one`, async ({ page }, testInfo) => {
    test.skip(
      projectOf(testInfo).production && pair.undecorated === true,
      "not found in a production build: see the test about services without a decorator",
    );
    const n = nameIn(testInfo);
    const warnings: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "warning") warnings.push(msg.text());
    });
    const cdp = await open(page);

    await createAndDestroy(page, `leaky-${pair.id}`, pair.action);
    await createAndDestroy(page, `fixed-${pair.id}`, pair.action);

    let result = await collect(page, cdp);
    for (let i = 0; i < 5 && !result.events.some((e) => e.name === n(pair.leaky)); i++)
      result = await collect(page, cdp);

    const leak = result.events.find((e) => e.name === n(pair.leaky));
    expect(leak, `${pair.leaky} should be reported`).toMatchObject({
      stale: 1,
      host: hostOf(pair),
      hosts: [{ host: hostOf(pair), count: 1 }],
      kind: pair.kind ?? "component",
    });
    for (const name of [pair.fixed, ...(pair.collected ?? [])]) {
      expect(result.events.some((e) => e.name === n(name)), `${name} must not be reported`).toBe(false);
      expect(result.report.some((r) => r.name === n(name)), `${name} must be collected`).toBe(false);
    }
    // Still in memory, on purpose: only never tracking it keeps it out of the report.
    for (const name of pair.untracked ?? []) {
      expect(result.events.some((e) => e.name === name), `${name} must not be reported`).toBe(false);
      expect(result.report.some((r) => r.name === name), `${name} must not be tracked`).toBe(false);
    }
    expect(warnings.some((w) => w.includes(warningOf(pair, testInfo)))).toBe(true);

    // What keeps it in memory.
    const causes = causesOf(pair, testInfo);
    expect(leak!.causes, `${pair.leaky}'s causes`).toEqual(causes);
    expect(leak!.retained).toEqual((pair.retained ?? []).map((r) => ({ ...r, name: n(r.name) })));
    // Reported with the component that leaked, not on their own.
    for (const { name } of pair.retained ?? []) {
      expect(result.events.some((e) => e.name === n(name)), `${name} must not be reported on its own`).toBe(false);
    }
    const warning = warnings.find((w) => w.includes(warningOf(pair, testInfo)))!;
    expect(warning.includes("Likely cause"), warning).toBe(causes.length > 0);
    if (pair.sentence && causes.length > 0 && !projectOf(testInfo).minifiedNames) {
      expect(warning).toContain(` ${pair.sentence} Take a heap snapshot`);
    }
  });
}

test("reports a component that keeps its view once, with the directives and services in it", async ({ page }, testInfo) => {
  // Its subscription keeps its ChangeDetectorRef, so its whole view: two
  // HighlightDirective, a RouterLink, and the ViewState it provides. One
  // warning, not one per class.
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });
  const n = nameIn(testInfo);
  const cdp = await open(page);
  await createAndDestroy(page, "leaky-view");
  const leaked = (events: LeakEvent[]) => events.some((e) => e.name === n("LeakyViewComponent"));
  let result = await collect(page, cdp);
  for (let i = 0; i < 5 && !leaked(result.events); i++) result = await collect(page, cdp);

  expect([...new Set(result.events.map((e) => e.name))]).toEqual([n("LeakyViewComponent")]);
  expect(result.events[0]).toMatchObject({ kind: "component", host: "app-leaky-view", stale: 1 });
  expect(result.events[0]!.retained).toEqual([
    { name: n("HighlightDirective"), kind: "directive", count: 2 },
    { name: n("RouterLink"), kind: "directive", count: 1 },
    { name: n("ViewState"), kind: "service", count: 1 },
  ]);
  expect(warnings.filter((w) => w.includes("Suspected leak")).every((w) => w.includes(n("LeakyViewComponent")))).toBe(true);
  const described = projectOf(testInfo).minifiedNames ? "component <app-leaky-view>" : "LeakyViewComponent <app-leaky-view>";
  expect(
    warnings.some((w) =>
      w.includes(
        `Suspected leak: ${described} — 1 instance(s) destroyed >0.5s ago still retained after garbage collection (live 1 total), together with 3 directive(s) and 1 service(s) of its own: ${n("HighlightDirective")} ×2, ${n("RouterLink")}, ${n("ViewState")}.`,
      ),
    ),
  ).toBe(true);
  const row = (name: string) => result.report.find((r) => r.name === n(name));
  expect(row("HighlightDirective")).toMatchObject({ stale: 0, withOwner: 2 });
  expect(row("ViewState")).toMatchObject({ stale: 0, withOwner: 1 });
  // Its subscription, not anything of what it keeps.
  const subscription = projectOf(testInfo).minifiedNames ? "subscription" : "subscription to BehaviorSubject";
  expect(result.events[0]!.causes).toEqual([
    { kind: "subscription", description: subscription, startedIn: "constructor", by: n("LeakyViewComponent"), byKind: "component", count: 1 },
  ]);
});

/** Navigate with the app's link to `id`, and wait for its page. */
async function go(page: Page, id: "home" | "other" | "nested" | "leaky" | "stateful") {
  await page.getByTestId(`nav-${id}`).click();
  await expect(page.getByTestId(`${id}-page`)).toBeVisible();
}

/**
 * On Angular 16 and 20 the router itself keeps the pages of its latest
 * navigation (16) or latest two (20) in memory. The detector holds them,
 * `heldByRouter`, instead of reporting them (src/router.ts).
 */
const HELD_NAVIGATIONS: Partial<Record<number, number>> = { 16: 1, 20: 2 };
const heldNavigations = (testInfo: TestInfo) => HELD_NAVIGATIONS[projectOf(testInfo).angular] ?? 0;

/** The pages the report shows as held by the router, and how many of each. */
const heldByRouter = (report: ReportRow[]) =>
  Object.fromEntries(report.filter((r) => r.heldByRouter > 0).map((r) => [r.name, r.heldByRouter]));

test("does not report pages the router destroyed", async ({ page }, testInfo) => {
  // What the router keeps after these navigations: the other page, left
  // last, and on Angular 20 also the home page left before it.
  const n = nameIn(testInfo);
  const held = ["OtherPageComponent", "HomePageComponent"].slice(0, heldNavigations(testInfo));
  const cdp = await open(page);
  for (let i = 0; i < 3; i++) {
    await go(page, "other");
    await go(page, "home");
  }
  const { events, report } = await collect(page, cdp, 10);
  expect(events).toEqual([]);
  expect(heldByRouter(report)).toEqual(Object.fromEntries(held.map((name) => [n(name), 1])));
  const live = Object.fromEntries(report.map((r) => [r.name, r.live]));
  const kept = (name: string) => (held.includes(name) ? 1 : 0);
  // Only what is on screen is left, the home page and its three cards, plus
  // what the router keeps.
  expect(live[n("OtherPageComponent")] ?? 0).toBe(kept("OtherPageComponent"));
  expect(live[n("HomePageComponent")]).toBe(1 + kept("HomePageComponent"));
  expect(live[n("CardComponent")]).toBe(3);
});

test("does not report a page and its child page the router destroyed together", async ({ page }, testInfo) => {
  const n = nameIn(testInfo);
  const cdp = await open(page);
  await go(page, "nested");
  await expect(page.getByTestId("nested-child")).toBeVisible();
  await go(page, "home");
  let { events, report } = await collect(page, cdp, 10);
  expect(events).toEqual([]);
  // The pages each navigation took down, latest last. The last one took both
  // nested pages down at once: both are held, or both collected.
  const navigations = [["HomePageComponent"], ["NestedChildComponent", "NestedPageComponent"]];
  const held = navigations.slice(navigations.length - heldNavigations(testInfo)).flat();
  expect(heldByRouter(report)).toEqual(Object.fromEntries(held.map((name) => [n(name), 1])));

  // Two more navigations: every router has let go of them.
  await go(page, "other");
  await go(page, "home");
  ({ events, report } = await collect(page, cdp, 10));
  expect(events).toEqual([]);
  const nested = [n("NestedPageComponent"), n("NestedChildComponent")];
  expect(report.some((r) => nested.includes(r.name)), "the nested pages must be collected").toBe(false);
});

test("does not report pages after a navigation that fails", async ({ page }, testInfo) => {
  const n = nameIn(testInfo);
  const cdp = await open(page);
  await go(page, "other");
  await go(page, "home");
  // Creating the broken page throws: the navigation fails after the router
  // has taken the home page down.
  await page.getByTestId("nav-broken").click();
  await expect(page.getByTestId("home-page")).toHaveCount(0);
  const { events, report } = await collect(page, cdp, 10);
  expect(events).toEqual([]);
  // Angular 16 keeps the pages of the latest navigation that started, the
  // failed one; Angular 20 those of the latest two that succeeded.
  const held: Partial<Record<number, string[]>> = {
    16: ["HomePageComponent"],
    20: ["HomePageComponent", "OtherPageComponent"],
  };
  const expected = held[projectOf(testInfo).angular] ?? [];
  expect(heldByRouter(report)).toEqual(Object.fromEntries(expected.map((name) => [n(name), 1])));
});

test("reports a page that leaks, once the router lets go of it", async ({ page }, testInfo) => {
  const n = nameIn(testInfo);
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });
  const cdp = await open(page);
  await go(page, "leaky");
  await go(page, "home");
  const leaked = (events: LeakEvent[]) => events.some((e) => e.name === n("LeakyPageComponent"));
  if (heldNavigations(testInfo) > 0) {
    // Held, not judged yet, however many collections run.
    const { events, report } = await collect(page, cdp);
    expect(leaked(events)).toBe(false);
    expect(heldByRouter(report)[n("LeakyPageComponent")]).toBe(1);
  }

  // Two more navigations: every router has let go of it, and it is still in
  // memory after a collection.
  await go(page, "other");
  await go(page, "home");
  let result = await collect(page, cdp);
  for (let i = 0; i < 5 && !leaked(result.events); i++) result = await collect(page, cdp);
  expect(result.events.find((e) => e.name === n("LeakyPageComponent"))).toMatchObject({
    stale: 1,
    host: "app-leaky-page",
  });
  // Created by the router, and its constructor's subscription found all the same.
  const subscription = projectOf(testInfo).minifiedNames ? "subscription" : "subscription to BehaviorSubject";
  expect(result.events.find((e) => e.name === n("LeakyPageComponent"))!.causes).toEqual([
    { kind: "subscription", description: subscription, startedIn: "constructor", by: n("LeakyPageComponent"), byKind: "component", count: 1 },
  ]);
  // Nothing else: the pages the router only kept are not reported.
  expect([...new Set(result.events.map((e) => e.name))]).toEqual([n("LeakyPageComponent")]);
  const described = projectOf(testInfo).minifiedNames ? "component <app-leaky-page>" : "LeakyPageComponent <app-leaky-page>";
  expect(warnings.some((w) => w.includes(`Suspected leak: ${described}`))).toBe(true);
});

test("holds what a page provides and its host directive while the router holds the page", async ({ page }, testInfo) => {
  // The stateful page keeps the service it provides and its host directive.
  // Where the router keeps the page (Angular 16 and 20), it keeps them too:
  // they must be held with the page, not reported.
  const n = nameIn(testInfo);
  const cdp = await open(page);
  await go(page, "stateful");
  await go(page, "home");
  const stateful = ["StatefulPageComponent", "PageStateService", "PageTitleDirective"];
  let { events, report } = await collect(page, cdp, 10);
  expect(events).toEqual([]);
  // The pages (and what they keep) each navigation took down, latest last.
  const navigations = [["HomePageComponent"], stateful];
  const held = navigations.slice(navigations.length - heldNavigations(testInfo)).flat();
  expect(heldByRouter(report)).toEqual(Object.fromEntries(held.map((name) => [n(name), 1])));

  // Two more navigations: every router has let go of them.
  await go(page, "other");
  await go(page, "home");
  ({ events, report } = await collect(page, cdp, 10));
  expect(events).toEqual([]);
  const kept = stateful.map(n);
  expect(report.filter((r) => kept.includes(r.name)), "the stateful page and what it keeps must be collected").toEqual([]);
});

test("a leaked component is in the heap snapshot under its class name", async ({ page }, testInfo) => {
  // Its class name: in a production build, the one ng-leak-names restored.
  test.skip(projectOf(testInfo).minifiedNames, "class names restored or kept only: see the next test");
  const cdp = await open(page);
  await createAndDestroy(page, "leaky-timer");
  await createAndDestroy(page, "fixed-timer");
  await collect(page, cdp, 3);

  const chunks: string[] = [];
  cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => chunks.push(chunk));
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  const snapshot = JSON.parse(chunks.join("")) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[]] } };
    nodes: number[];
    strings: string[];
  };
  const { node_fields, node_types } = snapshot.snapshot.meta;
  const width = node_fields.length;
  const typeAt = node_fields.indexOf("type");
  const nameAt = node_fields.indexOf("name");
  const objectType = node_types[0].indexOf("object");
  const objects = new Map<string, number>();
  for (let i = 0; i < snapshot.nodes.length; i += width) {
    if (snapshot.nodes[i + typeAt] !== objectType) continue;
    const name = snapshot.strings[snapshot.nodes[i + nameAt]!]!;
    if (/TimerComponent$/.test(name)) objects.set(name, (objects.get(name) ?? 0) + 1);
  }
  // esbuild names the class `_LeakyTimerComponent` in dev builds.
  const leaked = [...objects].filter(([name]) => name.replace(/^_/, "") === "LeakyTimerComponent");
  expect(leaked.reduce((n, [, count]) => n + count, 0)).toBe(1);
  expect([...objects.keys()].some((name) => name.includes("FixedTimerComponent"))).toBe(false);
});

/** How many objects of each name a heap snapshot of the page holds. */
async function heapObjects(cdp: CDPSession): Promise<Map<string, number>> {
  const chunks: string[] = [];
  const onChunk = ({ chunk }: { chunk: string }) => chunks.push(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  const snapshot = JSON.parse(chunks.join("")) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[]] } };
    nodes: number[];
    strings: string[];
  };
  const { node_fields, node_types } = snapshot.snapshot.meta;
  const width = node_fields.length;
  const typeAt = node_fields.indexOf("type");
  const nameAt = node_fields.indexOf("name");
  const objectType = node_types[0].indexOf("object");
  const objects = new Map<string, number>();
  for (let i = 0; i < snapshot.nodes.length; i += width) {
    if (snapshot.nodes[i + typeAt] !== objectType) continue;
    const name = snapshot.strings[snapshot.nodes[i + nameAt]!]!;
    objects.set(name, (objects.get(name) ?? 0) + 1);
  }
  return objects;
}

test("the warning names a leaked component as the heap snapshot does", async ({ page }, testInfo) => {
  // Whatever the build, what the warning says to filter a heap snapshot for
  // finds the leaked instance there: its class name (restored by
  // ng-leak-names in production), or with class names minified, the name
  // the detector gives the class, if asked to (renameMinifiedClasses).
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });
  const n = nameIn(testInfo);
  const cdp = await open(page);
  // Before the leaky component's class is first seen: renamed then.
  if (projectOf(testInfo).minifiedNames) {
    await page.evaluate(() => window.__ngLeakDetector!.configure({ renameMinifiedClasses: true }));
  }
  await createAndDestroy(page, "leaky-timer");
  await createAndDestroy(page, "fixed-timer");
  const reported = () => warnings.find((w) => w.includes("Suspected leak:") && w.includes("<app-leaky-timer>"));
  for (let i = 0; i < 6 && !reported(); i++) await collect(page, cdp);

  const filterFor = /filter for "([^"]+)" to see what holds it/.exec(reported() ?? "")?.[1];
  expect(filterFor, `the warning: ${reported()}`).toBe(n("LeakyTimerComponent"));
  const objects = await heapObjects(cdp);
  // esbuild names the class `_LeakyTimerComponent` in dev builds; DevTools'
  // filter matches either.
  const count = (name: string) => (objects.get(name) ?? 0) + (objects.get(`_${name}`) ?? 0);
  expect(count(filterFor!)).toBe(1);
  expect(count(n("FixedTimerComponent")), "the fixed one must be collected").toBe(0);
});

test("with class names minified, leaves classes as they are by default, and says so", async ({ page }, testInfo) => {
  test.skip(!projectOf(testInfo).minifiedNames, "minified class names only");
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });
  const cdp = await open(page);
  await createAndDestroy(page, "leaky-timer");
  const reported = () => warnings.find((w) => w.includes("Suspected leak: component <app-leaky-timer>"));
  for (let i = 0; i < 6 && !reported(); i++) await collect(page, cdp);
  const minifiedAs = /Its class is minified \("([^"]+)"\)/.exec(reported() ?? "")?.[1];
  expect(minifiedAs, `the warning: ${reported()}`).toBeTruthy();
  // Under that name in the heap snapshot, not under the detector's.
  const objects = await heapObjects(cdp);
  expect(objects.get("app-leaky-timer") ?? 0).toBe(0);
  expect(objects.get(minifiedAs!) ?? 0).toBeGreaterThan(0);
});

test("never runs inside Angular's zone", async ({ page }, testInfo) => {
  test.skip(!projectOf(testInfo).zone, "zone.js only");
  // Not open(): configure() from here would recreate the sweep timer outside
  // the zone. The timer and observer under test are the ones set up at startup.
  await page.goto("/");
  await page.waitForFunction(() => !!window.__ngLeakDetector && !!window.__leakTest);
  const before = await page.evaluate(() => window.__leakTest!.zoneTurns());
  // A DOM change the observer has to look at, made outside Angular...
  await page.evaluate(() => document.body.appendChild(document.createElement("div")));
  // ...and two sweeps at the default 2 s interval.
  await page.waitForTimeout(4_500);
  const after = await page.evaluate(() => window.__leakTest!.zoneTurns());
  expect(after - before).toBe(0);
});

test("a host element kept after destroy does not keep its component", async ({ page }, testInfo) => {
  // Angular stores only a numeric view id on elements. Looking a component up
  // through `ng.*` swaps in a context object that holds the component; the
  // detector must undo that, or any retained host element (a DOM-only leak, or
  // the browser itself for a while) would make its component look leaked.
  const cdp = await open(page);
  await page.getByTestId("toggle-fixed-timer").click();
  await expect(page.getByTestId("fixed-timer")).toBeVisible();
  await page.evaluate(() => {
    (window as any).__keptHost = document.querySelector("app-fixed-timer");
  });
  await page.getByTestId("toggle-fixed-timer").click();
  await expect(page.getByTestId("fixed-timer")).toHaveCount(0);
  const { events, report } = await collect(page, cdp, 8);
  const fixed = nameIn(testInfo)("FixedTimerComponent");
  expect(events.some((e) => e.name === fixed)).toBe(false);
  expect(report.some((r) => r.name === fixed)).toBe(false);
});

test("an element kept after destroy does not keep its directive", async ({ page }, testInfo) => {
  // The same for directives: `ng.getDirectives` caches them on the element.
  const cdp = await open(page);
  await page.getByTestId("toggle-fixed-directive").click();
  await expect(page.getByTestId("fixed-directive")).toBeVisible();
  await page.evaluate(() => {
    (window as any).__keptElement = document.querySelector('[data-testid="fixed-directive"]');
  });
  await page.getByTestId("toggle-fixed-directive").click();
  await expect(page.getByTestId("fixed-directive")).toHaveCount(0);
  const { events, report } = await collect(page, cdp, 8);
  const fixed = nameIn(testInfo)("FixedTooltipDirective");
  expect(events.some((e) => e.name === fixed)).toBe(false);
  expect(report.some((r) => r.name === fixed)).toBe(false);
});
