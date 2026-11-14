import { NgZone } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import type { LeakEvent } from "angular-memory-leak-detector";
import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";

// Hooks for the Playwright suite (../e2e): every leak event, and a helper
// that forces collections and sweeps until the verdicts are in.
const events: LeakEvent[] = [];

bootstrapApplication(AppComponent, appConfig).then((appRef) => {
  const detector = window.__ngLeakDetector;
  detector?.subscribe((event) => events.push(event));
  // Under zone.js, every task that runs inside Angular's zone makes it
  // unstable and leads to change detection. The detector must cause none.
  let zoneTurns = 0;
  appRef.injector.get(NgZone).onUnstable.subscribe(() => zoneTurns++);
  (window as any).__leakTest = {
    events,
    zone: typeof (globalThis as any).Zone !== "undefined",
    zoneTurns: () => zoneTurns,
    async collect(cycles = 5) {
      for (let i = 0; i < cycles; i++) {
        detector?.forceGc();
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      detector?.sweep();
      return { events: [...events], report: detector?.report() ?? [] };
    },
  };
});
