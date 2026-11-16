// Pairs of components, directives and component-level services: each leaky
// one forgets a cleanup, its fixed twin does it. Same as
// demo/src/app/leaks.ts, declared `standalone: true` explicitly (the default
// only from Angular 19 on).
import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  Directive,
  HostListener,
  Injectable,
  type OnDestroy,
  inject,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { RouterLink } from "@angular/router";
import { BehaviorSubject, type Subscription } from "rxjs";

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

/** Leak: a directive that subscribes to a root service and never unsubscribes. */
@Directive({ standalone: true, selector: "[appLeakyTooltip]" })
export class LeakyTooltipDirective {
  value = 0;
  constructor() {
    inject(TickerService).ticks$.subscribe((v) => (this.value = v));
  }
}

@Directive({ standalone: true, selector: "[appFixedTooltip]" })
export class FixedTooltipDirective {
  value = 0;
  constructor() {
    inject(TickerService)
      .ticks$.pipe(takeUntilDestroyed())
      .subscribe((v) => (this.value = v));
  }
}

/**
 * Leak: a service a component provides (`providers: [LeakyStore]`). Angular
 * creates one per component and destroys it with the component, but its
 * subscription to a root service is never ended and keeps it in memory.
 */
@Injectable()
export class LeakyStore {
  value = 0;
  constructor() {
    inject(TickerService).ticks$.subscribe((v) => (this.value = v));
  }
}

/** Angular calls a component-level service's `ngOnDestroy` when it destroys it. */
@Injectable()
export class FixedStore implements OnDestroy {
  value = 0;
  private readonly subscription: Subscription = inject(TickerService).ticks$.subscribe(
    (v) => (this.value = v),
  );
  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }
}

@Component({
  standalone: true,
  selector: "app-leaky-service",
  providers: [LeakyStore],
  template: `<p data-testid="leaky-service">Leaky service: {{ store.value }}</p>`,
})
export class LeakyServiceComponent {
  readonly store = inject(LeakyStore);
}

@Component({
  standalone: true,
  selector: "app-fixed-service",
  providers: [FixedStore],
  template: `<p data-testid="fixed-service">Fixed service: {{ store.value }}</p>`,
})
export class FixedServiceComponent {
  readonly store = inject(FixedStore);
}

/**
 * Leak: like LeakyStore, but a class without `@Injectable()`. Angular creates
 * it all the same (its constructor takes no parameters), and the detector
 * tracks it all the same, with no change to the app.
 */
export class LeakyPlainStore {
  value = 0;
  constructor() {
    inject(TickerService).ticks$.subscribe((v) => (this.value = v));
  }
}

/**
 * Without a decorator a class can't have `ngOnDestroy` (the compiler refuses
 * it, NG2007): it ends its subscription with the DestroyRef of the view that
 * provides it instead.
 */
export class FixedPlainStore {
  value = 0;
  constructor() {
    inject(TickerService)
      .ticks$.pipe(takeUntilDestroyed())
      .subscribe((v) => (this.value = v));
  }
}

/** Labels shared by the whole app. */
export class Labels {
  readonly title = "Plain service";
}
/** Kept for as long as the app runs: not a leak when a component goes. */
export const SHARED_LABELS = new Labels();

@Component({
  standalone: true,
  selector: "app-leaky-plain-service",
  providers: [LeakyPlainStore],
  template: `<p data-testid="leaky-plain-service">Leaky plain service: {{ store.value }}</p>`,
})
export class LeakyPlainServiceComponent {
  readonly store = inject(LeakyPlainStore);
}

/** Also provides a constant (`useValue`), which must never be reported. */
@Component({
  standalone: true,
  selector: "app-fixed-plain-service",
  providers: [FixedPlainStore, { provide: Labels, useValue: SHARED_LABELS }],
  template: `<p data-testid="fixed-plain-service">{{ labels.title }}: {{ store.value }}</p>`,
})
export class FixedPlainServiceComponent {
  readonly store = inject(FixedPlainStore);
  readonly labels = inject(Labels);
}

/** A directive with nothing to clean up. */
@Directive({ standalone: true, selector: "[appHighlight]" })
export class HighlightDirective {}

/** A service with nothing to clean up, that a component provides. */
@Injectable()
export class ViewState {
  count = 0;
}

/**
 * Leak: its subscription to a root service, never ended, refreshes the view
 * through its ChangeDetectorRef, and so keeps the component's whole view:
 * the directives in its template and the service it provides too. They are
 * reported in its warning, not one by one.
 */
@Component({
  standalone: true,
  selector: "app-leaky-view",
  imports: [HighlightDirective, RouterLink],
  providers: [ViewState],
  template: `<p appHighlight data-testid="leaky-view">Leaky view: {{ value }}</p>
    <a appHighlight routerLink="/other">Other page</a>`,
})
export class LeakyViewComponent {
  value = 0;
  readonly state = inject(ViewState);
  private readonly cdr = inject(ChangeDetectorRef);
  constructor() {
    inject(TickerService).ticks$.subscribe((v) => {
      this.value = v;
      this.cdr.markForCheck();
    });
  }
}
