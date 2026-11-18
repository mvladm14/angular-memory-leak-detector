import {
  APP_BOOTSTRAP_LISTENER,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from "@angular/core";
import { startMemoryLeakDetector, startProductionMemoryLeakDetector } from "./detector.js";
import { startCauses } from "./instrument.js";
import type { LeakDetectorOptions } from "./types.js";

/**
 * Start the memory leak detector once the application has bootstrapped.
 *
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [provideMemoryLeakDetector()],
 * });
 * ```
 *
 * Development only. In a production build the Angular CLI sets `ngDevMode` to
 * `false`, this function returns no providers, and the detector is removed
 * from the bundle. To detect leaks in production builds too, use
 * `provideProductionMemoryLeakDetector` instead.
 *
 * With `trackCauses`, the cause-tracking wrappers are installed here, before
 * Angular creates the first component, so its constructor is covered.
 */
export function provideMemoryLeakDetector(
  options: Partial<LeakDetectorOptions> = {},
): EnvironmentProviders {
  if (typeof ngDevMode === "undefined" || ngDevMode) {
    startCauses(options.trackCauses ?? true);
    return makeEnvironmentProviders([
      {
        provide: APP_BOOTSTRAP_LISTENER,
        multi: true,
        useValue: () => {
          startMemoryLeakDetector(options);
        },
      },
    ]);
  }
  return makeEnvironmentProviders([]);
}

/**
 * Start the memory leak detector once the application has bootstrapped, in
 * every build: development, and production too, minified or not.
 *
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [provideProductionMemoryLeakDetector({ logging: false })],
 * });
 * ```
 *
 * In development it is `provideMemoryLeakDetector`. In a production build,
 * where Angular publishes no debugging API, it finds components, directives
 * and services without it, and in a minified one it names components and
 * directives by their selectors. The detector stays in the production bundle.
 * Like `provideMemoryLeakDetector`, installs the cause-tracking wrappers here.
 */
export function provideProductionMemoryLeakDetector(
  options: Partial<LeakDetectorOptions> = {},
): EnvironmentProviders {
  startCauses(options.trackCauses ?? true);
  return makeEnvironmentProviders([
    {
      provide: APP_BOOTSTRAP_LISTENER,
      multi: true,
      useValue: () => {
        startProductionMemoryLeakDetector(options);
      },
    },
  ]);
}
