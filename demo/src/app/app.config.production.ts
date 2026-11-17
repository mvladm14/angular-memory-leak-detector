// Used by the `production-detector` build configuration (`npm run
// start:production` builds it and serves the build): the app built for
// production (optimized and minified, `ngDevMode` off), zoneless, with the
// detector that runs in production builds.
import { type ApplicationConfig, provideZonelessChangeDetection } from "@angular/core";
import { provideRouter } from "@angular/router";
import { provideProductionMemoryLeakDetector } from "angular-memory-leak-detector";
import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideProductionMemoryLeakDetector({ leakAgeMs: 2_000 }),
  ],
};
