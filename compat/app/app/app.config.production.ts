// Used by the `production-detector` build configuration of every workspace
// (`npm run start:production` builds it and serves the build): the app built
// for production (optimized and minified, `ngDevMode` off), on zone.js, with
// the detector that runs in production builds.
import { type ApplicationConfig, provideZoneChangeDetection } from "@angular/core";
import { provideRouter } from "@angular/router";
import { provideProductionMemoryLeakDetector } from "angular-memory-leak-detector";
import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideProductionMemoryLeakDetector({ leakAgeMs: 2_000 }),
  ],
};
