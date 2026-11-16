# Changelog

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
