// zone.js: the change detection every Angular version from 16 on supports,
// and the default build of every compat workspace. The zoneless variants
// replace this file through `fileReplacements` in the workspaces that have them.
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
