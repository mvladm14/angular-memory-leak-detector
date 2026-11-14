import {
  APP_BOOTSTRAP_LISTENER,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from "@angular/core";
import { startMemoryLeakDetector } from "./detector.js";
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
 * from the bundle.
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
