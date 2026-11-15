// Zoneless, Angular 18 and 19, where the provider was still experimental
// (`ng serve --configuration zoneless`).
import { type ApplicationConfig, provideExperimentalZonelessChangeDetection } from "@angular/core";
import { provideRouter } from "@angular/router";
import { provideMemoryLeakDetector } from "angular-memory-leak-detector";
import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [
    provideExperimentalZonelessChangeDetection(),
    provideRouter(routes),
    provideMemoryLeakDetector({ leakAgeMs: 2_000 }),
  ],
};
