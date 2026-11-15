// Pairs of components: each leaky one forgets a cleanup, its fixed twin does it.
// Same components as demo/src/app/leaks.ts, declared `standalone: true`
// explicitly (the default only from Angular 19 on).
import { Component, DestroyRef, HostListener, Injectable, inject, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { BehaviorSubject } from "rxjs";

/** A long-lived (root) service: anything subscribed to it outlives components. */
@Injectable({ providedIn: "root" })
export class TickerService {
  readonly ticks$ = new BehaviorSubject(0);
}

/** Leak: the interval is never cleared and its callback references `this`. */
@Component({
  standalone: true,
  selector: "app-leaky-timer",
  template: `<p data-testid="leaky-timer">Leaky timer: {{ ticks() }}</p>`,
})
export class LeakyTimerComponent {
  readonly ticks = signal(0);
  constructor() {
    setInterval(() => this.ticks.update((t) => t + 1), 1000);
  }
}

@Component({
  standalone: true,
  selector: "app-fixed-timer",
  template: `<p data-testid="fixed-timer">Fixed timer: {{ ticks() }}</p>`,
})
export class FixedTimerComponent {
  readonly ticks = signal(0);
  constructor() {
    const id = setInterval(() => this.ticks.update((t) => t + 1), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }
}

/** Leak: subscribes to a root service and never unsubscribes. */
@Component({
  standalone: true,
  selector: "app-leaky-subscription",
  template: `<p data-testid="leaky-subscription">Leaky subscription: {{ value }}</p>`,
})
export class LeakySubscriptionComponent {
  value = 0;
  constructor() {
    inject(TickerService).ticks$.subscribe((v) => (this.value = v));
  }
}

@Component({
  standalone: true,
  selector: "app-fixed-subscription",
  template: `<p data-testid="fixed-subscription">Fixed subscription: {{ value }}</p>`,
})
export class FixedSubscriptionComponent {
  value = 0;
  constructor() {
    inject(TickerService)
      .ticks$.pipe(takeUntilDestroyed())
      .subscribe((v) => (this.value = v));
  }
}

/** Leak: a window listener added by hand and never removed. */
@Component({
  standalone: true,
  selector: "app-leaky-listener",
  template: `<p data-testid="leaky-listener">Leaky listener: {{ width() }}px</p>`,
})
export class LeakyListenerComponent {
  readonly width = signal(window.innerWidth);
  constructor() {
    window.addEventListener("resize", () => this.width.set(window.innerWidth));
  }
}

/** Angular removes `@HostListener` listeners when the component is destroyed. */
@Component({
  standalone: true,
  selector: "app-fixed-listener",
  template: `<p data-testid="fixed-listener">Fixed listener: {{ width() }}px</p>`,
})
export class FixedListenerComponent {
  readonly width = signal(window.innerWidth);
  @HostListener("window:resize")
  onResize(): void {
    this.width.set(window.innerWidth);
  }
}
