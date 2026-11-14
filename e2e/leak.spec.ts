import { expect, test, type CDPSession, type Page } from "@playwright/test";

type LeakEvent = { component: string; host: string; stale: number; live: number };

// `window.__ngLeakDetector` is declared by the detector (src/detector.ts).
declare global {
  interface Window {
    __leakTest?: { events: LeakEvent[]; zone: boolean; zoneTurns(): number };
  }
}

const PAIRS = [
  { id: "timer", leaky: "LeakyTimerComponent", fixed: "FixedTimerComponent" },
  { id: "subscription", leaky: "LeakySubscriptionComponent", fixed: "FixedSubscriptionComponent" },
  { id: "listener", leaky: "LeakyListenerComponent", fixed: "FixedListenerComponent" },
];

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

async function createAndDestroy(page: Page, id: string) {
  const toggle = page.getByTestId(`toggle-${id}`);
  await toggle.click();
  await expect(page.getByTestId(id)).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId(id)).toHaveCount(0);
}

test("finds the running components with their class names", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await open(page);
  const zone = await page.evaluate(() => window.__leakTest!.zone);
  expect(zone).toBe(testInfo.project.name === "zone");

  const report = await page.evaluate(() => window.__ngLeakDetector!.report());
  const live = Object.fromEntries(report.map((r) => [r.component, r.live]));
  expect(live).toMatchObject({ AppComponent: 1, HomePageComponent: 1, CardComponent: 3 });
  expect(report.find((r) => r.component === "CardComponent")?.host).toBe("app-card");
  expect(errors).toEqual([]);
});

for (const pair of PAIRS) {
  test(`reports the leaky ${pair.id} and not the fixed one`, async ({ page }) => {
    const warnings: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "warning") warnings.push(msg.text());
    });
    const cdp = await open(page);

    await createAndDestroy(page, `leaky-${pair.id}`);
    await createAndDestroy(page, `fixed-${pair.id}`);

    let result = await collect(page, cdp);
    for (let i = 0; i < 5 && !result.events.some((e) => e.component === pair.leaky); i++)
      result = await collect(page, cdp);

    const leak = result.events.find((e) => e.component === pair.leaky);
    expect(leak, `${pair.leaky} should be reported`).toMatchObject({ stale: 1, host: `app-leaky-${pair.id}` });
    expect(result.events.some((e) => e.component === pair.fixed), `${pair.fixed} must not be reported`).toBe(false);
    expect(result.report.some((r) => r.component === pair.fixed), `${pair.fixed} must be collected`).toBe(false);
    expect(warnings.some((w) => w.includes(`Suspected leak: ${pair.leaky} <app-leaky-${pair.id}>`))).toBe(true);
  });
}

test("does not report pages the router destroyed", async ({ page }) => {
  const cdp = await open(page);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("nav-other").click();
    await expect(page.getByTestId("other-page")).toBeVisible();
    await page.getByTestId("nav-home").click();
    await expect(page.getByTestId("home-page")).toBeVisible();
  }
  const { events, report } = await collect(page, cdp, 10);
  expect(events).toEqual([]);
  const live = Object.fromEntries(report.map((r) => [r.component, r.live]));
  // Only what is on screen is left: the home page and its three cards.
  expect(live.OtherPageComponent).toBeUndefined();
  expect(live.HomePageComponent).toBe(1);
  expect(live.CardComponent).toBe(3);
});

test("a leaked component is in the heap snapshot under its class name", async ({ page }) => {
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

test("never runs inside Angular's zone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "zone", "zone.js only");
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

test("a host element kept after destroy does not keep its component", async ({ page }) => {
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
  expect(events.some((e) => e.component === "FixedTimerComponent")).toBe(false);
  expect(report.some((r) => r.component === "FixedTimerComponent")).toBe(false);
});
