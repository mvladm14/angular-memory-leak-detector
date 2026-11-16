# angular-memory-leak-detector

Spot Angular memory leaks while you develop. When a destroyed component,
directive or component-level service is still held in memory (by a
subscription, a timer, an event listener or a closure), you get a **console
warning** with its class name. No build plugin and no code changes beyond one
provider.

```
[ng-leak] Suspected leak: UserCardComponent <app-user-card> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Take a heap snapshot and filter for "UserCardComponent" to see what holds it.
[ng-leak] Suspected leak: directive TooltipDirective on <button> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Take a heap snapshot and filter for "TooltipDirective" to see what holds it.
[ng-leak] Suspected leak: service CartStore provided by <app-cart> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Take a heap snapshot and filter for "CartStore" to see what holds it.
```

What it watches:

- **Components**, destroyed with their view.
- **Directives**, attribute and structural (`*appIfRole`), Angular's own
  included, destroyed with the view their element is in.
- **Component-level services**: what the `providers` and `viewProviders` of
  a component or directive create. Angular creates one per element and
  destroys it with the view the element is in (calling its `ngOnDestroy`),
  so one still in memory after that has leaked just like a component.
  Root services (`providedIn: "root"`) live as long as the app and are not
  watched.

**Development only.** In a production build the provider compiles to an empty
provider list and the detector is not in the bundle (checked on every Angular
major from 16 to 22).

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

Everything below applies to directives and services as much as to components.

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

Instances waiting for that collection show up as **awaitingGc** in
`window.__ngLeakDetector.report()`.

## Finding the cause

The warning tells you *what* leaked. A heap snapshot tells you *why*. In
Chrome DevTools → Memory, take a snapshot and type the class name from the
warning in the class filter. Dev builds made with the Angular CLI's esbuild
builder name the class `_UserCardComponent`, and the filter matches either
form. Select an instance and read the **Retainers** panel bottom-up. The usual
causes are the same for components, directives and services:

- a subscription to a long-lived observable (a root service, the router, a
  store) that is never unsubscribed;
- `setInterval`, `setTimeout`, `requestAnimationFrame` or `addEventListener`
  that is never cleared;
- a root service or cache that stores the component or one of its callbacks.

**A leaked component's directives and services come in its warning.** A
component that holds something tied to its view (an injected
`ChangeDetectorRef`, `ElementRef`, `Injector` or `DestroyRef`) keeps its whole
view, and with it every directive and service in there. Those are not reported
one by one, but listed in the component's warning, most first:

```
[ng-leak] Suspected leak: CartComponent <app-cart> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total), together with 3 directive(s) and 1 service(s) of its own: RouterLink ×2, CartStore, TooltipDirective. Take a heap snapshot and filter for "CartComponent" to see what holds it.
```

A directive or service belongs to the component on its element, if there is
one (the component's `providers`, `viewProviders` and host directives), and
otherwise to the component whose template it is in, through `@if`, `@for` and
other embedded views, wherever content projection puts its element. While its
component isn't judged yet (destroyed too recently, waiting for a garbage
collection, or held by the router) it waits for that verdict, and it is kept
quietly with a component in `exclude`.

**What leaked on its own is still reported on its own.** A directive or
service whose component was freed, or is still alive, has something else
holding it: if `CartStore` subscribes to a root service and never
unsubscribes, the subscription keeps the store, not `CartComponent`, and the
warning is about `CartStore`. Unsubscribe in the service's `ngOnDestroy`, or
with `takeUntilDestroyed()` in its constructor; both run when Angular destroys
the component's view.

**Components are still reported one by one.** The destroyed view tree around a
component that keeps its view can stay reachable, and its parent or sibling
components are then reported too, each with its own directives and services.
The root cause is the instance whose retainers lead to something outside
Angular, such as a timer, a subscriber or a listener.

## Options

```ts
provideMemoryLeakDetector({
  leakAgeMs: 10_000,      // how long a destroyed instance may stay in memory
  sweepIntervalMs: 2_000, // how often leaks are checked
  warnCooldownMs: 30_000, // minimum time between two reports of one class
  suspectThreshold: 1,    // stale instances of a class needed to report it
  logging: true,          // console output
  exclude: [],            // class names or RegExps never reported, e.g. kept on purpose
  trackDirectives: true,  // watch directives too
  trackServices: true,    // watch component-level services too
});
```

`exclude` applies to components, directives and services alike, e.g.
`exclude: [/^Router/]` for Angular's `RouterLink` and `RouterOutlet`.
Turning `trackDirectives` or `trackServices` off stops tracking new ones and
hides those already tracked from `report()` and from leak reports. With both
off, only components are tracked: a place to start if an app with many
directives or component-level services feels slow to render in development.

Change them while the app runs with `window.__ngLeakDetector.configure({ … })`.

## API

Upgrading from 0.1? `component` is now `name` in events and `report()` rows,
which also cover directives and services now: see the
[changelog](CHANGELOG.md).

`window.__ngLeakDetector`, in the browser console or from code:

| Method | |
| --- | --- |
| `report()` | Prints and returns a table: per class, its `name`, its `kind` (`component`, `directive` or `service`), instances in memory (`live`), leaked and reported (`stale`), leaked as part of their component's leak (`withOwner`), `awaitingGc`, and `heldByRouter` (Angular 16 and 20, see below). |
| `sweep()` | Check for leaks now. |
| `forceGc()` | `window.gc()` then `sweep()`. Needs Chrome started with `--js-flags="--expose-gc"`. |
| `configure(options)` | Change options. |
| `subscribe(listener)` | Get each leak as an event (`{ name, kind, host, stale, live, leakAgeMs, at, retained }`), `retained` being the directives and services that leaked with a component (`[{ name, kind, count }]`). Returns an unsubscribe function. |
| `rescan()` | Look through the whole document again: for components rendered into a detached tree, and for services created after their element appeared (see [Limitations](#limitations)). |

In events and rows, `name` is the class name (of a component, a directive or
a service: see `kind`), and `host` is the tag of the component's host, of the
directive's element (`ng-template` / `ng-container` for one on those), or of
the element that provides the service.

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
2. **Finding directives.** Directives live on elements, and on the comments
   Angular anchors `<ng-template>` and `<ng-container>` with (structural
   directives). The one `ng.*` lookup each of those nodes gets leaves
   Angular's context on it, whose view data says whether the node holds a
   component, directive or provider at all: most hold nothing and are left
   at that. The directives of the others are read from the view they are in
   (with `ng.getDirectives(node)` if that data looks unfamiliar).
3. **Finding component-level services.** No public API lists what an
   element's injector has created, so the detector reads it from Angular's
   internal view data: the slots where Angular keeps the element's providers
   (the same layout on every Angular from 16 to 22). It takes only instances
   Angular has already created, so it never creates a service itself, and
   only those of class providers (`providers: [CartStore]`, `useClass`,
   `{ provide, useClass, deps }`), which the element owns: a `useValue`,
   `useExisting` or `useFactory` provider may hand out an object that
   outlives the component, such as a constant or a root service, and that
   isn't a leak. It tells them apart by the class's own factory, which
   `@Injectable()` adds, or else by how the app declared the provider, which
   Angular records in development mode for its DevTools
   (`ng.ɵgetInjectorProviders`, Angular 16.2 and later): classes without a
   decorator are found too, with no change to the app. The detector only
   reads all this: it never changes a class or a provider. If a future
   Angular changes that layout, the detector finds no services and keeps
   working for the rest.
4. **Knowing when one is destroyed.** On a component's host element,
   `ng.getInjector(element).get(ChangeDetectorRef)` is the `ViewRef` of the
   component's own view. Its `onDestroy` callback fires when Angular destroys
   that view. Directives and component-level services live in the view their
   element is in: `ng.getInjector(node).get(DestroyRef)` is that view's
   `DestroyRef`, whose `onDestroy` fires when Angular destroys them. The
   nodes of a view share one such callback.
5. **Never holding what it watches.** Each instance is held in a `WeakRef` and
   a `FinalizationRegistry`. The destroy callbacks hold only those records.
   `ng.getComponent`, `ng.getDirectives` and `ng.getInjector` cache the
   component and directives on the element, where Angular normally keeps only
   a numeric view id, so the detector puts the original value back after each
   lookup. Without that step, an element kept by anything would make its
   component and directives look leaked.
6. **The verdict.** When instances have been destroyed for `leakAgeMs`, the
   detector releases a *witness*: an object it has held long enough to be in
   the old generation, which only a major garbage collection frees. Witness
   gone but instance still reachable means a major collection ran and
   something kept it, so the detector warns and emits an event.
7. **Pages the router keeps.** On Angular 16 and 20 only, the detector also
   subscribes to each `<router-outlet>`'s `deactivate` output, to know which
   pages the router itself still holds (see
   [Angular 16 and 20](#angular-16-and-20-pages-the-router-keeps)).
8. **Staying out of change detection.** With zone.js, the detector's timer and
   observer run outside Angular's zone, so they never trigger change detection.

## Limitations

- A component-level service is found when its element appears. One created
  later (first injected from a click handler, say) is found only by
  `rescan()`.
- Multi providers and `useFactory` providers are not watched: nothing says
  the element owns what they hand out.
- On Angular 16.0 and 16.1, which don't record how providers were declared,
  only services whose class has a decorator (`@Injectable()`) are watched.
  On 16.2, a template's undecorated services are found once the detector
  has seen the first instance of that template.
- Like components, directives in views that are never attached to the
  document are not seen.

## Compatibility

- Angular 16 or later, standalone or NgModule, with or without zone.js.
  The end-to-end suite runs on every major from 16 to 22: with zone.js on
  all of them, and zoneless from 18 on (experimental in Angular 18 and 19).
- A browser with `WeakRef` and `FinalizationRegistry` (all current browsers).
  The suite runs in Chromium.
- Does nothing during server-side rendering.

### Angular 16 and 20: pages the router keeps

On these two versions the Angular router itself keeps the pages it has
navigated away from in memory for a while: Angular 16 those of the latest
navigation that started, even one that failed (fixed in 17), Angular 20 those
of the latest two that succeeded (fixed in 21). In
a heap snapshot the router is what holds them: `Router` →
`navigationTransitions` → `currentTransition` (16) or
`lastSuccessfulNavigation` (20). Later navigations release them, so memory
doesn't grow, and an app can't fix it.

So on these two versions the detector doesn't judge a page the router still
holds. `report()` counts it under **heldByRouter**, and once later navigations
have made the router let go, it is judged like any other destroyed component:
a page that really leaks is still reported, a navigation or two later than on
other versions. Nothing changes for components that aren't pages.

The same goes for the directives on the page's host element (its
`hostDirectives`) and the services that element provides (the page's own
`providers`): the page can keep them (`store = inject(PageStore)`), so while
the router holds the page, it holds them too, and the directives and services
in its template wait for its verdict like those of any component. Components
in its template, which the page can keep through an injected
`ChangeDetectorRef`, are judged as usual, and can be reported while the
router still holds the page.

The detector learns which pages those are from the `deactivate` and
`activate` outputs of Angular's `<router-outlet>`: what they emit together is
one navigation, and one that takes pages down without creating one has failed
(creating its page threw). A few cases slip through, and a page the router
still holds may then be reported, until the next navigation:

- pages shown by a custom outlet (Ionic's `<ion-router-outlet>`, for one);
- on Angular 20, a navigation cancelled while it creates its page, e.g. by
  `router.navigate()` in that page's constructor;
- an outlet whose `name` changes while the app runs.

## Development

```bash
npm install
npm test             # unit tests (Vitest)
npm run typecheck
npm run build
```

End-to-end tests run the app in [`demo/`](demo/) (Angular 22, which needs
Node 22.22+, see `.nvmrc`) in headless Chromium. They cover each leak pattern
next to its fixed version (a directive and component-level services, with
and without `@Injectable()`, included), a component that keeps its view
(reported once, with the directives and services in it), router navigation (nested routes, a page that leaks, and a page
that keeps the service it provides included), heap-snapshot names, zone.js,
and retained elements:

```bash
npm run demo:install # build, pack and install the detector into demo/
npx playwright install chromium
npm run e2e
```

To try it by hand, run `npm --prefix demo start`, open http://localhost:4200,
create and destroy the leaky components, directives and services, then click
**Collect garbage** in DevTools → Memory.

### Older Angular versions

The same suite runs on each older major against [`compat/`](compat/): the demo
app in [`compat/app/`](compat/app/), written in syntax Angular 16 understands
(`*ngIf`, `@Input()`, `standalone: true`), and one workspace per major,
`compat/ng16` to `compat/ng21`, set up the way `ng new` sets up that major
(builder, TypeScript, zone.js, tsconfig), each with its own lockfile. Every
run first checks that the page runs the expected major.

Most of these majors are out of support, so their toolchains are frozen: each
workspace pins the exact Node version it is known to work on in its `.nvmrc`
(today 24.21.0 for all of them), and CI runs each one on its own pin. The
root and `demo/` follow the current major instead (`24`). Change a pin only in
a pull request where the whole matrix passes; a workspace that breaks on a
newer Node keeps its old pin. The scripts warn when the Node running them
isn't the one an app pins: run `nvm install && nvm use` in that app's folder.

```bash
npm run compat:install                 # build, pack and install the detector into every compat/ngNN
npm run e2e:compat                     # the suite on each older major, one after the other
npm run e2e:compat -- 16 20            # some majors only (22 is demo/)
npm run e2e:compat -- 18 --grep timer  # extra arguments go to Playwright
```

`npm run bundle:check` (or `npm run bundle:check -- 16 22`) builds each app
for production and checks that none of the detector's code is left in it. It
also builds each app for development and checks that the detector's code is
found there, so the check can't pass by looking for the wrong thing.

`compat/app/` is copied into each workspace's `src/` by both commands; edit
it there, not in the copies. To try a major by hand, run
`npm --prefix compat/ng16 start` after `compat:install`.

When `demo/` moves to a new major, add a `compat/ngNN` for the major it
leaves (its `package.json`, `angular.json` and `tsconfig.json` as `ng new`
makes them, and an `.nvmrc` with the exact Node version it passes on) and run
`npm run compat:install -- NN`. CI picks it up on its own.

### Continuous integration

Two GitHub Actions workflows run on every push to `main` and every pull
request, side by side: [`ci.yml`](.github/workflows/ci.yml) runs the unit
tests, the typecheck and the build, and [`e2e.yml`](.github/workflows/e2e.yml)
runs the end-to-end suite and the production-bundle check with one job per
Angular major, all in parallel (the majors come from
`node scripts/e2e-matrix.mjs`). The detector is built and packed once, in a
job of its own, and every Angular job installs that same tarball
(`node scripts/install-demo.mjs NN --tarball <file>`): the one npm would
publish. In CI the apps are installed with `npm ci`, so a lockfile out of step
with its `package.json` fails the job.
A failed job uploads Playwright's traces as an artifact.

The workflows pin each action to a commit SHA, with its release in a comment
(`actions/checkout@<sha> # v5.1.0`): a tag can be moved to other code, a SHA
can't. Dependabot ([`dependabot.yml`](.github/dependabot.yml)) opens one
pull request a week when an action has a new release, bumping the SHA and the
comment together. It watches the actions only: npm dependencies are updated
by hand, and the compat workspaces' lockfiles stay frozen.

## License

MIT
