import {
  APP_BOOTSTRAP_LISTENER,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from "@angular/core";
import { startMemoryLeakDetector, startProductionMemoryLeakDetector } from "./detector.js";
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
 */
export function provideMemoryLeakDetector(
  options: Partial<LeakDetectorOptions> = {},
): EnvironmentProviders {
  if (typeof ngDevMode === "undefined" || ngDevMode) {
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
 */
export function provideProductionMemoryLeakDetector(
  options: Partial<LeakDetectorOptions> = {},
): EnvironmentProviders {
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
