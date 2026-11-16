# Performance measurements (internal)

> **Internal notes for maintainers, not user documentation.** Not published
> with the package, and not linked from the README.
>
> These numbers come from one-off runs in a development sandbox while 0.2.0
> was being optimized. The scripts that produced them are **not in this
> repository**, so nobody can re-run them as they are. And the machine was a
> shared virtual machine of unknown make, noticeably slow and noisy (the same
> render took from 88 to 260 ms from one run to the next), unlike a
> developer's laptop. Read them as comparisons between variants measured side
> by side on that machine, never as how fast the detector is; re-measure
> before relying on any of them.

## What was measured

- **App:** `demo/` (Angular 22.2.5, zoneless), development build
  (`ng build --configuration development`), served as static files. Added for
  the measurements: a component rendering N rows of a row component that
  provides a service (`providers: [RowStore]`), has a directive on its host,
  and a template of 11 elements, three of them with a directive. Per row: 12
  elements and 6 tracked instances (1 component, 4 directives, 1 service).
  `rows.set(n)` followed by `ApplicationRef.tick()` renders them at once.
- **Browser:** headless Chromium 153, driven by Playwright.
- **Variants:** no detector (provider removed), 0.1.0 (the release before
  directives and services), 0.2.0 before the optimizations, 0.2.0 after them.
- **Metrics:**
  - *render*: wall time of rendering the rows (Angular's own work);
  - *discovery*: time spent in the detector's MutationObserver callbacks,
    right after the render (`MutationObserver` was wrapped before the app
    loaded; only the detector uses one in that app);
  - *sweep, settled*: `__ngLeakDetector.sweep()` with the rows shown, after
    garbage collection has settled (nothing destroyed waiting for a verdict);
  - *sweep, after destroy*: `sweep()` right after all the rows were destroyed;
  - *memory*: `Runtime.getHeapUsage` after `HeapProfiler.collectGarbage`
    (three times), rows shown minus no rows.
- **Method:** each variant in a fresh browser context, with warm-up renders;
  the median of 3 to 7 cycles per variant; variants interleaved in a rotating
  order over 6 to 10 rounds, and the median of the rounds. Runs of one variant
  after the other proved misleading here: the machine's slow spells favoured
  whichever variant ran during a fast one (one such run showed a regression
  that disappeared once interleaved).

## Results

1000 rows (12,000 elements, 6,000 tracked instances), 6 interleaved rounds,
medians:

| | 0.1.0 | 0.2.0 before | 0.2.0 after |
| --- | --- | --- | --- |
| Discovery | 40 ms | 146 ms | 125 ms |
| Sweep, settled ¹ | 1.9 ms | 9.6 ms | 0.0 ms |
| Sweep, after destroy | 1.1 ms | 12.4 ms | 1.3 ms |
| Memory | +252 KB | +1472 KB | +1353 KB |
| Memory per tracked instance | ≈ 258 B (per component) | ≈ 251 B | ≈ 231 B |

For reference, Angular's own render of the 1000 rows took 120–157 ms without
the detector (median 136 ms), and render times didn't differ between variants
beyond the noise: the detector does nothing while Angular renders.

100 rows, 8 interleaved rounds: discovery 10.5 ms (0.1.0), 45 ms (0.2.0
before), 23 ms (0.2.0 after).

¹ From an earlier run of 3 × 7 cycles, on a build with the same sweep code
for that case.

0.1.0 tracks components only: 1 instance per row here, against 6 for 0.2.0.

## Findings

- **Where discovery time goes, after the optimizations.** Builds with one
  operation removed from the per-instance bookkeeping, interleaved, 1000 rows:
  without `new WeakRef`, discovery took 96 ms instead of 121 ms (≈ 20% less);
  without the FinalizationRegistry registration, the `live` Set or the
  `entries` WeakMap, no difference beyond the noise. The WeakRef can't go: the
  verdict needs the instance and the witness dereferenced in the same job
  (witness.ts), which only a WeakRef gives.
- **Those operations on their own**, in a Chromium page, per instance (6,000
  at a time): `new WeakRef` ≈ 0.55 µs, `WeakMap.set` ≈ 0.13 µs, `Set.add`
  ≈ 0.07 µs, `FinalizationRegistry.register` ≈ 0.03 µs.
- **Memory per record, piece by piece**, in Node (same V8, but without
  pointer compression, so larger than in Chrome; only the proportions carry
  over): the entry object ≈ 96 B, its WeakRef ≈ 66 B, the registration ≈ 72 B,
  a WeakMap or WeakSet entry ≈ 42 B each. Removed by the optimizations: a
  creation timestamp (a boxed number, ≈ 56 B), an empty companions array
  (≈ 40 B), a class-name string per instance (≈ 40 B with esbuild's `_Name`
  classes), and a WeakSet entry duplicating the WeakMap. In Chrome that came
  to ≈ 20 B per instance (251 → 231 B).
- **Before the optimizations**, discovery made three `ng.*` lookups on every
  element (`getComponent`, `getDirectives`, `getInjector`), and on each node
  that held something also `getOwningComponent` and a DestroyRef lookup; and
  every sweep, every 2 s, walked every tracked instance.

## Re-measuring

There is no script for this in the repository. To measure again: add a
component like the one above to `demo/`, build it for development with each
variant of the detector installed, serve each build, and measure the metrics
above in a fresh page per variant, interleaving the variants, on the machine
the numbers are meant for.
