// Used by `ng serve --configuration zone`: the same app on zone.js.
import { type ApplicationConfig, provideZoneChangeDetection } from "@angular/core";
import { provideRouter } from "@angular/router";
import { provideMemoryLeakDetector } from "angular-memory-leak-detector";
import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideMemoryLeakDetector({ leakAgeMs: 2_000 }),
  ],
};
