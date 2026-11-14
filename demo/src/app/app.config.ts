import { type ApplicationConfig, provideZonelessChangeDetection } from "@angular/core";
import { provideRouter } from "@angular/router";
import { provideMemoryLeakDetector } from "angular-memory-leak-detector";
import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideMemoryLeakDetector({ leakAgeMs: 2_000 }),
  ],
};
