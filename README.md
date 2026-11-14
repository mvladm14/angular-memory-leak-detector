# angular-memory-leak-detector

Spot Angular memory leaks while you develop. When a destroyed component is
still held in memory (by a subscription, a timer, an event listener or a
closure), you get a **console warning** with the component's name. No build
plugin and no code changes beyond one provider.

```
[ng-leak] Suspected leak: UserCardComponent <app-user-card> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Take a heap snapshot and filter for "UserCardComponent" to see what holds it.
```

**Development only.** In a production build the provider compiles to an empty
provider list and the detector is not in the bundle.

## Setup

```bash
npm install --save-dev angular-memory-leak-detector
```

Standalone app (`app.config.ts`):

```ts
import { provideMemoryLeakDetector } from "angular-memory-leak-detector";

export const appConfig: ApplicationConfig = {
  providers: [
    // ...
    provideMemoryLeakDetector(),
  ],
};
```

NgModule app: add `provideMemoryLeakDetector()` to the root module's
`providers`.

Run `ng serve`, then use the app. The console shows
`[ng-leak] Memory leak detector running` once the app has bootstrapped.

## When leaks are reported

A destroyed component that is still in memory is not necessarily leaked: the
browser may not have collected garbage since. So the detector waits until the
component has been destroyed for `leakAgeMs` (10 s), and then for the browser's
next *major* garbage collection. It reports the component only if that
collection didn't free it. Minor collections don't count, because in Chrome a
removed listener or cleared timer can keep a correctly cleaned-up component
alive until the next major collection.

Browsers run major collections on their own schedule, so warnings can come
later than `leakAgeMs`. To get a verdict right away, click **Collect garbage**
(the trash-can icon) in Chrome DevTools → **Memory**. One click judges every
component destroyed before it.

Components waiting for that collection show up as **awaitingGc** in
`window.__ngLeakDetector.report()`.

## Finding the cause

The warning tells you *what* leaked. A heap snapshot tells you *why*. In
Chrome DevTools → Memory, take a snapshot and type the component's name in the
class filter. Dev builds made with the Angular CLI's esbuild builder name the
class `_UserCardComponent`, and the filter matches either form. Select an
instance and read the **Retainers** panel bottom-up. The usual causes are:

- a subscription to a long-lived observable (a root service, the router, a
  store) that is never unsubscribed;
- `setInterval`, `setTimeout`, `requestAnimationFrame` or `addEventListener`
  that is never cleared;
- a root service or cache that stores the component or one of its callbacks.

**One bug can produce several reports.** If the leaked component holds
something tied to its view (an injected `ChangeDetectorRef`, `ElementRef`,
`Injector` or `DestroyRef`), the destroyed view tree around it can stay
reachable, and its parent or sibling components are then reported too. The
root cause is the instance whose retainers lead to something outside Angular,
such as a timer, a subscriber or a listener.

## Options

```ts
provideMemoryLeakDetector({
  leakAgeMs: 10_000,      // how long a destroyed component may stay in memory
  sweepIntervalMs: 2_000, // how often leaks are checked
  warnCooldownMs: 30_000, // minimum time between two reports of one component
  suspectThreshold: 1,    // stale instances of a component needed to report it
  logging: true,          // console output
  exclude: [],            // class names or RegExps never reported, e.g. kept on purpose
});
```

Change them while the app runs with `window.__ngLeakDetector.configure({ … })`.

## API

`window.__ngLeakDetector`, in the browser console or from code:

| Method | |
| --- | --- |
| `report()` | Prints and returns a table: per component, instances in memory (`live`), leaked (`stale`), and `awaitingGc`. |
| `sweep()` | Check for leaks now. |
| `forceGc()` | `window.gc()` then `sweep()`. Needs Chrome started with `--js-flags="--expose-gc"`. |
| `configure(options)` | Change options. |
| `subscribe(listener)` | Get each leak as an event (`{ component, host, stale, live, leakAgeMs, at }`). Returns an unsubscribe function. |
| `rescan()` | Look through the whole document again for components. |

To forward leaks somewhere, for example in an end-to-end test:

```ts
window.__ngLeakDetector?.subscribe((event) => console.log("leak", event));
```

`startMemoryLeakDetector(options)` starts the detector without the provider
and returns the same API, or `null` outside development mode.

## How it works

1. **Finding components.** In development mode Angular publishes its debugging
   API as `window.ng`. A `MutationObserver` sees every element added to the
   document, including inside open shadow roots, and `ng.getComponent(element)`
   says whether it hosts a component and returns the instance. The name comes
   from the instance's class.
2. **Knowing when one is destroyed.** On a component's host element,
   `ng.getInjector(element).get(ChangeDetectorRef)` is the `ViewRef` of the
   component's own view. Its `onDestroy` callback fires when Angular destroys
   that view.
3. **Never holding what it watches.** Each instance is held in a `WeakRef` and
   a `FinalizationRegistry`. The destroy callback holds only that record.
   `ng.getComponent` caches the component on the host element, where Angular
   normally keeps only a numeric view id, so the detector puts the original
   value back after each lookup. Without that step, a host element kept by
   anything would make its component look leaked.
4. **The verdict.** When components have been destroyed for `leakAgeMs`, the
   detector releases a *witness*: an object it has held long enough to be in
   the old generation, which only a major garbage collection frees. Witness
   gone but component still reachable means a major collection ran and
   something kept the component, so the detector warns and emits an event.
5. **Staying out of change detection.** With zone.js, the detector's timer and
   observer run outside Angular's zone, so they never trigger change detection.

## Compatibility

- Angular 16 or later, standalone or NgModule, with or without zone.js.
  The end-to-end suite runs on Angular 22, zoneless and with zone.js. The
  Angular internals it relies on are the same in 16 and 19.
- A browser with `WeakRef` and `FinalizationRegistry` (all current browsers).
  The suite runs in Chromium.
- Does nothing during server-side rendering.

## Development

```bash
npm install
npm test             # unit tests (Vitest)
npm run typecheck
npm run build
```

End-to-end tests run the app in [`demo/`](demo/) (Angular 22, which needs
Node 22.22+, see `.nvmrc`) in headless Chromium. They cover each leak pattern
next to its fixed version, router navigation, heap-snapshot names, zone.js, and
a retained host element:

```bash
npm run demo:install # build, pack and install the detector into demo/
npx playwright install chromium
npm run e2e
```

To try it by hand, run `npm --prefix demo start`, open http://localhost:4200,
create and destroy the leaky components, then click **Collect garbage** in
DevTools → Memory.

## License

MIT
