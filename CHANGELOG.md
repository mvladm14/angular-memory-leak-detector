# Changelog

## Unreleased

The detector can now run in production builds too, minified ones included.
And a leak's warning now says what most likely holds it.

### Added

- **The cause of a leak.** A warning names what most likely keeps the
  leaked instance in memory: the timers, animation frames, event listeners
  and RxJS subscriptions it started, never ended, and that are still active
  long after Angular destroyed it (`Likely cause: setInterval every 1000 ms,
  started in its constructor and never cleared.`). Events have them as
  `causes` (type `LeakCause`): `kind` (`interval`, `timeout`,
  `animationFrame`, `eventListener` or `subscription`, type
  `LeakCauseKind`), `description` (`"resize" listener on window`),
  `startedIn` (`"constructor"`, `"ngOnInit"`, …, `"event handler"`,
  `"template"`), `by` and `byKind` (who started it: the leaked class, or a
  directive or service that leaked with it and keeps it through its view),
  and `count`. What constructors and field initializers start is known in
  every build; what lifecycle hooks, event handlers and templates start, in
  development builds (from Angular's profiler); loops (a timer or animation
  frame whose callback schedules itself again) in every build. What the
  detector doesn't know who started is never named: a leak with no cause it
  knows of is reported as before.
  Also named: `requestIdleCallback` (`idleCallback`), listeners added
  `{ once: true }` until they fire, observers (`observer`: a
  `ResizeObserver`, `MutationObserver` or `IntersectionObserver` never
  disconnected, observing what is still in the document), and what the
  callback of an instance's subscription starts (`startedIn: "subscription
  callback"`, in every build).
- **`trackCauses`** (default `true`): turns that off. It wraps `setTimeout`,
  `setInterval`, `requestAnimationFrame`, `requestIdleCallback`,
  `addEventListener`, the observer classes and their `observe` (and what
  clears, removes or disconnects them) and RxJS's `subscribe`, from when the
  provider is called; turned off, the wrappers only call through.
- **`provideProductionMemoryLeakDetector(options)`** and
  **`startProductionMemoryLeakDetector(options)`**: the detector in every
  build, production included. In development they are
  `provideMemoryLeakDetector` and `startMemoryLeakDetector`. In a production
  build, where Angular publishes no `window.ng`, the detector makes the same
  lookups through `DebugNode`, public API on every major from 16 to 22, and
  imports nothing private from Angular: a later Angular can't break the build
  of an app that uses it. Verdicts are the same as in development. `provideMemoryLeakDetector` is unchanged: still nothing
  of the detector in a production build.
- **Names that survive minification.** In a minified build, where class names
  are mangled (esbuild names nearly every class `e`), components and
  directives are named by their selector (`app-user-card`, `[appTooltip]`),
  a component with none by its component id (`ng-component (c2736387395)`),
  and services by the element that provides them and their place among its
  providers (`app-cart providers[0]`, one name for each place a service is
  provided). These names depend only on what leaked, never on what was
  seen first, so the same leak has the same name in every session, and
  from one build to the next. Builds that keep class names, or whose names `ng-leak-names`
  restored (below), keep them. A build that minifies the app's code but not its
  dependencies (Angular 17's dev server, serving an optimized configuration)
  names the app's classes this way, where they used to share one name.
- **`ng-leak-names`**, a command that comes with the package, an extra layer
  over selector names for builds that make source maps anyway: run after
  `ng build` (`npx ng-leak-names dist/my-app`), it gives every class of the
  build its name back from the build's source maps (hidden ones are enough),
  as a static `name` field, and updates the source maps. Warnings and heap
  snapshots of a production build then show `UserCardComponent`, as in
  development. Without source maps, or with maps that lack the sources, it
  warns and leaves the build as it is (exit code 0). It updates the hashes
  Angular writes of what it changes (Subresource Integrity in
  `index.html`, `ngsw.json`), and leaves a build that pins them anywhere
  else as it is (exit code 0), e.g. webpack's hashes of lazy chunks with
  Subresource Integrity. It changes the build all at once or not at all,
  and refuses one a previous run was interrupted in (exit code 1).
- **`renameMinifiedClasses`** (default `false`): a minified class the
  detector names by its selector or provider gets that name as its `name`
  too, so a heap snapshot shows the leaked instance under the name the
  warning gives. Only classes whose name is minified are renamed. Off by
  default: a class is renamed when the detector first sees it, so errors
  thrown in it before and after have different stack traces.
- **`exclude` takes classes** (`exclude: [CacheComponent]`), which work in
  every build, where names change with minification.
- **`hosts`** on events and `report()` rows: the tags of the elements the
  class's instances are on, in alphabetical order, each with how many (type
  `HostCount`): in an event, where it leaked; in a row, where its instances
  in memory are. A warning about instances on elements of several tags
  lists them: `directive TooltipDirective on <a>, <button> ×2`.
- `ClassRef`, the type of a class in `exclude`.
- A warning when Angular has rendered the app but the detector finds none of
  its components, as it would on a version of Angular that lays out its
  views in a way the detector doesn't know: it then reports no leaks, and
  says so.

### Changed

- **`host` no longer depends on the order elements were seen in.** It was the
  tag of the first element the detector saw with the class on, which could
  differ from one session to the next. In an event it is now the first, in
  alphabetical order, of the tags the leaked instances are on; in a
  `report()` row, of those its instances in memory are on. Rows with the
  same counts are in the order of their names, not of when their classes
  were first seen.

### Fixed

- A template anchor whose comment Angular rewrote with its bindings
  (`bindings={…}`, in development on Angular 16 to 19, and later with
  ng-reflect on) is reported as `ng-template`, not `ng-container`: the
  node's type says which, when the comment doesn't.

### Limitations

- In a production build, services whose class has no decorator are not
  found: Angular records how providers were declared in development only.
- Causes: not watched are `on…` event properties and other observers
  (`PerformanceObserver`, …); not known who started is what code after an
  `await` starts (nothing carries who runs across one), and in a production
  build what lifecycle hooks, event handlers and templates start. On Angular 16 to 19, whose
  profiler takes one callback, a profiler set before the detector starts is
  replaced; one set after it (Angular DevTools') is shared.

## 0.2.0

The detector now watches directives and component-level services too, not
only components.

### Breaking changes

- **`component` is now `name`** in leak events (`LeakEvent`) and in the rows
  of `report()` (`ReportRow`). It is the class name of a component, a
  directive or a service, so `component` no longer fit:

  ```ts
  // 0.1
  window.__ngLeakDetector?.subscribe((event) => console.log(event.component));
  // 0.2
  window.__ngLeakDetector?.subscribe((event) => console.log(event.name, event.kind));
  ```

- **Events and `report()` rows also cover directives and services.** Each has
  a `kind`: `"component"`, `"directive"` or `"service"`. Code that expects
  only components should keep `kind === "component"`. To watch components
  only, as in 0.1, set `trackDirectives: false` and `trackServices: false`.
- **`stale` in `report()` counts only what is reported on its own.**
  Directives and services that leaked with their component are counted under
  the new `withOwner` column instead.
- The startup message now reads `(N components, M directives, K services
  found)`.

### Added

- **Directives** are tracked: attribute and structural ones (on
  `<ng-template>` and `<ng-container>`), host directives, and Angular's own
  (`RouterLink`, `NgIf`, …). A directive is destroyed with the view its
  element is in.
- **Component-level services** are tracked: what the `providers` and
  `viewProviders` of a component or directive create (`providers:
  [CartStore]`, `useClass`, `deps`), with or without `@Injectable()` (without
  it from Angular 16.2 on). `useValue`, `useExisting`, `useFactory` and multi
  providers are not: nothing says the element owns what they hand out. The
  detector never creates a service itself, and never changes the app's
  classes.
- **A leaked component's directives and services come in its warning**,
  listed as `together with 3 directive(s) and 1 service(s) of its own:
  RouterLink ×2, …`, and in its event as `retained: [{ name, kind, count }]`
  (type `RetainedInstances`). They get no warning of their own. A directive
  or service whose component was freed, or is still alive, leaked on its
  own and is reported on its own.
- `kind` on events and rows (type `InstanceKind`), and `withOwner` on rows.
- Options `trackDirectives` and `trackServices` (both `true` by default).
  `exclude` applies to directives and services too.
- On Angular 16 and 20, the directives on a page's host element and the
  services it provides are held with the page while the router holds it,
  and those in its template wait for its verdict, instead of being reported
  while the router still holds the page.
- `rescan()` also finds services created after their element appeared.

### Performance

- **Sweeps look only at instances destroyed at least `leakAgeMs` ago and
  still in memory**, not at every tracked one: while none is waiting for a
  verdict, a sweep has nothing to do, however big the app.
- Each rendered element or comment gets one lookup in Angular's debugging
  API; those that hold no component, directive or provider (most) get no
  other. The nodes of a view share one destroy hook.

## 0.1.0

First release.
