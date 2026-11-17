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

**Development only, unless you opt in.** With `provideMemoryLeakDetector()`,
a production build compiles the provider to an empty provider list and the
detector is not in the bundle (checked on every Angular major from 16 to 22).
To catch leaks in production builds too, minified ones included, use
`provideProductionMemoryLeakDetector()` instead: see
[Production builds](#production-builds).

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
  exclude: [],            // class names, RegExps or classes never reported, e.g. kept on purpose
  trackDirectives: true,  // watch directives too
  trackServices: true,    // watch component-level services too
  renameMinifiedClasses: false, // in a minified build, see Production builds
});
```

`exclude` applies to components, directives and services alike, e.g.
`exclude: [/^Router/]` for Angular's `RouterLink` and `RouterOutlet`. It
takes the classes themselves too (`exclude: [CacheComponent]`), which work
in every build, minified ones included, where class names don't (see
[Production builds](#production-builds)).
Turning `trackDirectives` or `trackServices` off stops tracking new ones and
hides those already tracked from `report()` and from leak reports. With both
off, only components are tracked: a place to start if an app with many
directives or component-level services feels slow to render in development.

Change them while the app runs with `window.__ngLeakDetector.configure({ … })`.

## Production builds

Some leaks only show with real users, real data and long sessions. To watch
for them in production, use `provideProductionMemoryLeakDetector()` in place
of `provideMemoryLeakDetector()`, and install the package as a dependency
rather than a dev dependency. It takes the same options. Keep the console
quiet and send the leaks to your monitoring instead:

```ts
import { provideProductionMemoryLeakDetector } from "angular-memory-leak-detector";

export const appConfig: ApplicationConfig = {
  providers: [
    // ...
    provideProductionMemoryLeakDetector({ logging: false }),
  ],
};
```

```ts
bootstrapApplication(AppComponent, appConfig).then(() => {
  window.__ngLeakDetector?.subscribe((leak) => monitoring.track("memory-leak", leak));
});
```

In a development build it is `provideMemoryLeakDetector()`: everything above
applies. A production build differs in three ways.

**No debugging API.** Angular publishes `window.ng` in development only. In
production the detector makes the same lookups without it, through what
Angular keeps in every build: the view id it stores on the elements and
comments it creates, which the public `DebugNode` turns into the node's
injector and view, and the view data that says where the node's component
and directives are. It imports nothing private from Angular (see
[Compatibility](#compatibility)). Verdicts are the same as in development: the
end-to-end suite runs on a production build of each major, with the same
leaks reported, the same ones not, and the same pages held by the router.
What production doesn't keep is how providers were declared, so services
whose class has no decorator aren't watched there (see
[Limitations](#limitations)).

**Names by selector.** A minified build renames classes: esbuild and terser
name nearly all of them `e`. So in a production build, the detector names
each class by what its code declares as a string, which minifiers keep and
which stays the same from one build to the next. This works on any build,
with nothing to set up:

| | Development | Minified production build |
| --- | --- | --- |
| Component | `UserCardComponent` | its selector: `app-user-card` |
| Directive | `TooltipDirective` | its selector: `[appTooltip]` |
| Service | `CartStore` | the element that provides it, and its place among that element's providers (view providers first): `app-cart providers[0]` |

A name depends only on what leaked, never on what the detector saw before
it: the same leak has the same name in every session, so leaks reported
from many sessions can be grouped by `name`.

```
[ng-leak] Suspected leak: component <app-user-card> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Its class is minified ("e"): to see what holds it in a heap snapshot, restore class names with ng-leak-names if the build has source maps, or reproduce the leak in a development build.
[ng-leak] Suspected leak: directive [appTooltip] on <button> — …
[ng-leak] Suspected leak: service app-cart providers[0] — …
```

A heap snapshot names an object after its class's `name` (in Chromium), and
the detector leaves classes as they are, so there the leaked instance is
still an `e`. To find it by the warning's name, set `renameMinifiedClasses:
true`: the detector then makes that name the class's `name` too, and the
warning says `Take a heap snapshot and filter for "app-user-card"`. It is
off by default because a class is renamed only when the detector first sees
one of its instances: an error thrown in it before then has `e` in its stack
trace, and one thrown after has `app-user-card`, which error trackers may
group as two errors. Or restore class names with `ng-leak-names` (below),
which names every class before the app starts.

Only classes whose name is minified are renamed: a name like `e` says
nothing, so nothing can depend on it. A component that declares no selector
goes by its component id, the one in its host's `_nghost-ng-c…` attribute:
`ng-component (c2736387395)`. A service's element is named after its
component, or else its first directive. Each instance of a service is named
after where it is provided, so a `CartStore` that two components provide
goes by two names, one for each. Its class can have only one `name`, though:
the first one the detector gives it, and each warning says which name to
filter a heap snapshot for. Classes that share a selector share their name.
In a build that keeps class names, the detector keeps them too; in one that
minifies the app's code but not its dependencies (Angular 17's dev server
does, serving an optimized configuration), only the app's classes go by
these names.

That name is `name` in events and `report()` rows, and what `exclude`
matches: list the classes themselves to exclude them in every build.

**Class names, if the build makes source maps.** An extra layer, for builds
that make source maps for their scripts anyway (for error reporting, say):
the maps still know every class's name, and `ng-leak-names`, which comes
with the package, puts them back into the build after `ng build`. Warnings
and heap snapshots then read exactly as in development:

```
[ng-leak] Suspected leak: UserCardComponent <app-user-card> — 1 instance(s) destroyed >10s ago still retained after garbage collection (live 1 total). Take a heap snapshot and filter for "UserCardComponent" to see what holds it.
```

```bash
ng build && npx ng-leak-names dist/my-app
```

Hidden source maps are enough (`"sourceMap": { "scripts": true, "hidden":
true }` in `angular.json`): the code doesn't point to them, so they needn't
be deployed. They must include the sources (`sourcesContent`, which the
Angular CLI writes), where the names are read from. A build without source
maps, or a map without its sources, is left as it is, with a warning, and
the command still exits with 0: the detector goes on naming those classes by
selector.

It gives every class of the build, the app's and its libraries' (Angular's
`RouterLink`, RxJS's `SafeSubscriber`, …), its name back as a static field,
the first thing in its body: `class e{static name="UserCardComponent";…}`.
The class is still `e` for the code that uses it, so nothing else changes.
It only touches a class the source map says is a class of that name, checks
that the result parses (with the app's own esbuild), and updates the source
maps, so stack traces and error reports map as before. It is safe to run
twice. On the demo app it restores 178 class names, adding 5.5 kB to the
bundle (1 to 1.2 kB gzipped, on Angular 16 and 22).

Run it right after `ng build`, before anything else uses the build:
uploading its source maps to an error tracker, compressing its files,
deploying it. Whatever ran before saw the old files.

A changed script has a new hash, and a build can pin those. `ng-leak-names`
updates the ones Angular writes: the `integrity` attributes of `index.html`
(Subresource Integrity) and the hashes in `ngsw.json` (the service worker).
If anything else holds a hash of a file it would change, such as the hashes
of lazy chunks webpack's runtime checks them against (Angular 16 with
Subresource Integrity), or the server bundle of a server-rendered app with
Subresource Integrity, which embeds `index.html`, it leaves the whole build
as it is, with a warning, and exits with 0.

It changes the build all at once or not at all: it writes every new file
next to the old one, then moves each into place. If it is stopped while
moving them, it leaves a marker, and the next run refuses that build (exit
code 1): build it again, and run it on the new build.

Three things change for whoever looks at the build: stack traces read
`UserCardComponent.ngOnInit` rather than `e.ngOnInit` (an error tracker that
groups errors by their raw stack traces will group them anew once), a
file's contents change but not the hash in its name, and anyone who loads
the app can read its class names. Keep the source maps off the server: move
or delete them once `ng-leak-names` (and any upload) has run.

**Finding the cause.** With class names restored by `ng-leak-names`, or
renamed by the detector (`renameMinifiedClasses`), filter the heap snapshot
for the name the warning gives, and read the leaked instance's retainers, as
in development. Renamed, only the classes the detector tracks have names
there; restored, the classes along the way (the subscriber, the router, your
services) have theirs too. With neither, the warning still says which
component, directive or service leaked and where: reproduce it in a
development build to see what holds it. Functions and closures keep their
minified names in any case: with the source maps loaded in DevTools, each
links to its source.

What it costs: the detector stays in the bundle (about 23 kB minified, 8 kB
gzipped, measured on Angular 16 and 22), and does in production what it does
in development: one lookup for each element Angular inserts, and a sweep every
`sweepIntervalMs` that looks only at what was destroyed and is still in
memory (see [performance](docs/internal/performance.md)). To watch a share of
sessions only, add the provider conditionally:

```ts
...(Math.random() < 0.05 ? [provideProductionMemoryLeakDetector({ logging: false })] : []),
```

## API

Upgrading from 0.1? `component` is now `name` in events and `report()` rows,
which also cover directives and services now: see the
[changelog](CHANGELOG.md).

`window.__ngLeakDetector`, in the browser console or from code:

| Method | |
| --- | --- |
| `report()` | Prints and returns a table: per class, its `name`, its `kind` (`component`, `directive` or `service`), the elements its instances in memory are on (`host`, `hosts`), instances in memory (`live`), leaked and reported (`stale`), leaked as part of their component's leak (`withOwner`), `awaitingGc`, and `heldByRouter` (Angular 16 and 20, see below). |
| `sweep()` | Check for leaks now. |
| `forceGc()` | `window.gc()` then `sweep()`. Needs Chrome started with `--js-flags="--expose-gc"`. |
| `configure(options)` | Change options. |
| `subscribe(listener)` | Get each leak as an event (`{ name, kind, host, hosts, stale, live, leakAgeMs, at, retained }`), `retained` being the directives and services that leaked with a component (`[{ name, kind, count }]`). Returns an unsubscribe function. |
| `rescan()` | Look through the whole document again: for components rendered into a detached tree, and for services created after their element appeared (see [Limitations](#limitations)). |

In events and rows, `name` is the class name (of a component, a directive or
a service: see `kind`). `hosts` lists the tags of the elements its
instances are on (the component's host, the directive's element,
`ng-template` / `ng-container` for one on those, or the element that
provides the service), in alphabetical order, with how many instances on
each: in an event, the instances that leaked; in a row, those in memory. A
directive that leaked on two `<button>`s and an `<a>` has `hosts: [{ host:
"a", count: 1 }, { host: "button", count: 2 }]`, and its warning says `on
<a>, <button> ×2`. `host` is the first of them, a single tag to show or
group by: it doesn't depend on the order the detector saw the elements in,
only on which ones there are.

To forward leaks somewhere, for example in an end-to-end test:

```ts
window.__ngLeakDetector?.subscribe((event) => console.log("leak", event));
```

`startMemoryLeakDetector(options)` starts the detector without the provider
and returns the same API, or `null` outside development mode.
`startProductionMemoryLeakDetector(options)` does the same in every build,
like `provideProductionMemoryLeakDetector()`.

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
9. **Production builds.** Without `window.ng`, the same lookups are made
   with `new DebugNode(node)` (public API, which unlike `getDebugNode`
   stores nothing on the node): its `injector` is the node's injector, whose
   view data says where the node's component and directives are, as in
   development; its `componentInstance` is the node's component, or else the
   component whose template it is in. Angular's anchor comments are
   empty in production, so whether one anchors an `<ng-template>` or an
   `<ng-container>` comes from its node's type. Whether the build minified
   class names comes from a class of the detector's own, bundled along with
   the app's; a class named by a single character counts as minified too,
   for builds that minify the app's code and not its dependencies. With
   `renameMinifiedClasses` on, such a class gets the name the detector gives
   it as its `name`, the one a heap snapshot shows: the only change the
   detector ever makes to a class, and only to one whose name says nothing.
   Where the build makes source maps, `ng-leak-names` (`src/cli/`) can also
   restore class names after the build, so that none is minified.

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
- In a production build, services whose class has no decorator are not
  watched: Angular records how providers were declared in development only,
  and without a factory of its own a class provider can't be told from a
  `useValue` one. Add `@Injectable()` to have them watched there too.
- `ng-leak-names` needs the build's source maps, with the sources in them
  (the Angular CLI includes them); without, it leaves the build as it is.
  It leaves alone the rare class whose superclass is an expression rather
  than a name (`extends mixin(Base)`).

## Compatibility

- Angular 16 or later, standalone or NgModule, with or without zone.js,
  development or production build.
  The end-to-end suite runs on every major from 16 to 22: with zone.js on
  all of them, zoneless from 18 on (experimental in Angular 18 and 19), and
  as a production build with `provideProductionMemoryLeakDetector()`.
- A browser with `WeakRef` and `FinalizationRegistry` (all current browsers).
  The suite runs in Chromium.
- Does nothing during server-side rendering.

### Later versions of Angular

The detector imports only Angular's public API (a test checks it), so no
version of Angular can break the build of an app that uses it: a bundler
fails on an import that doesn't exist, even one that is never used, and a
private one (`ɵ…`) can be renamed or removed in any release.

What it needs of Angular's internals (how a view lays out its nodes'
directives and providers, the view id on each node, the definition the
compiler adds to each class), it reads from objects at runtime, on every
version from 16 to 22 alike. If a later Angular changes them, the detector
finds less, never anything wrong: services, say, if the providers' layout
changes; and if it finds none of the app's components although Angular has
rendered the app, it says so in the console rather than passing for an app
without leaks:

```
[ng-leak] Found none of this app's components, although Angular 23.0.0 has rendered <app-root>: this version of Angular may keep them in a way this version of the detector doesn't know (it supports Angular 16 to 22). It will report no leaks.
```

A new major is supported once the end-to-end suite passes on it (see
[Older Angular versions](#older-angular-versions) for adding one).

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
and retained elements. They run on the app served four ways: zoneless, on
zone.js, and twice built for production (optimized and minified,
`ngDevMode` off, hidden source maps) with
`provideProductionMemoryLeakDetector()`, its `production-detector`
configuration: once with the class names `ng-leak-names` restores, where
they expect the same names as in development, heap snapshots included, and
once without, where they expect the names of a minified build. The
production builds are made with `ng build` and served as is
(`scripts/serve-static.mjs`), not by the dev server, which on some versions
keeps development mode on:

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
found there, so the check can't pass by looking for the wrong thing. And it
builds each app for production with `provideProductionMemoryLeakDetector()`
(the `production-detector` configuration) and checks that the detector is
there.

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
