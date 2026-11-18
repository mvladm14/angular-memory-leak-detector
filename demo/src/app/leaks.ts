// Pairs of components, directives and component-level services: each leaky
// one forgets a cleanup, its fixed twin does it.
import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  Directive,
  HostListener,
  Injectable,
  type OnDestroy,
  type OnInit,
  inject,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { RouterLink } from "@angular/router";
import { BehaviorSubject, fromEvent, type Subscription, take } from "rxjs";

/** A long-lived (root) service: anything subscribed to it outlives components. */
@Injectable({ providedIn: "root" })
export class TickerService {
  readonly ticks$ = new BehaviorSubject(0);
}

/** Leak: the interval is never cleared and its callback references `this`. */
@Component({
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
@Directive({ selector: "[appLeakyTooltip]" })
export class LeakyTooltipDirective {
  value = 0;
  constructor() {
    inject(TickerService).ticks$.subscribe((v) => (this.value = v));
  }
}

@Directive({ selector: "[appFixedTooltip]" })
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
  selector: "app-leaky-service",
  providers: [LeakyStore],
  template: `<p data-testid="leaky-service">Leaky service: {{ store.value }}</p>`,
})
export class LeakyServiceComponent {
  readonly store = inject(LeakyStore);
}

@Component({
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
  selector: "app-leaky-plain-service",
  providers: [LeakyPlainStore],
  template: `<p data-testid="leaky-plain-service">Leaky plain service: {{ store.value }}</p>`,
})
export class LeakyPlainServiceComponent {
  readonly store = inject(LeakyPlainStore);
}

/** Also provides a constant (`useValue`), which must never be reported. */
@Component({
  selector: "app-fixed-plain-service",
  providers: [FixedPlainStore, { provide: Labels, useValue: SHARED_LABELS }],
  template: `<p data-testid="fixed-plain-service">{{ labels.title }}: {{ store.value }}</p>`,
})
export class FixedPlainServiceComponent {
  readonly store = inject(FixedPlainStore);
  readonly labels = inject(Labels);
}

/** A directive with nothing to clean up. */
@Directive({ selector: "[appHighlight]" })
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

// ---------------------------------------------------------------------------
// Leak culprits: what keeps each leaky one in memory is a different kind of
// resource it started, named in its warning as the likely cause.

/** Leak: a timeout set for an hour in ngOnInit, never cleared: it holds its callback, and `this`, until then. */
@Component({
  selector: "app-leaky-timeout",
  template: `<p data-testid="leaky-timeout">Leaky timeout: {{ expired ? "expired" : "pending" }}</p>`,
})
export class LeakyTimeoutComponent implements OnInit {
  expired = false;
  ngOnInit(): void {
    setTimeout(() => (this.expired = true), 60 * 60 * 1000);
  }
}

@Component({
  selector: "app-fixed-timeout",
  template: `<p data-testid="fixed-timeout">Fixed timeout: {{ expired ? "expired" : "pending" }}</p>`,
})
export class FixedTimeoutComponent implements OnInit, OnDestroy {
  expired = false;
  private timeout?: ReturnType<typeof setTimeout>;
  ngOnInit(): void {
    this.timeout = setTimeout(() => (this.expired = true), 60 * 60 * 1000);
  }
  ngOnDestroy(): void {
    clearTimeout(this.timeout);
  }
}

/** Leak: an animation loop, each frame requesting the next, never stopped. */
@Component({
  selector: "app-leaky-animation",
  template: `<p data-testid="leaky-animation">Leaky animation</p>`,
})
export class LeakyAnimationComponent {
  frames = 0;
  constructor() {
    const tick = () => {
      this.frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

@Component({
  selector: "app-fixed-animation",
  template: `<p data-testid="fixed-animation">Fixed animation</p>`,
})
export class FixedAnimationComponent {
  frames = 0;
  constructor() {
    let frame = 0;
    const tick = () => {
      this.frames++;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(frame));
  }
}

/** Leak: polling started by a click, each timeout setting the next, never stopped. */
@Component({
  selector: "app-leaky-polling",
  template: `<p data-testid="leaky-polling">
    Leaky polling: {{ polls }} <button type="button" data-testid="start-leaky-polling" (click)="start()">Start</button>
  </p>`,
})
export class LeakyPollingComponent {
  polls = 0;
  start(): void {
    const poll = () => {
      this.polls++;
      setTimeout(poll, 200);
    };
    setTimeout(poll, 200);
  }
}

@Component({
  selector: "app-fixed-polling",
  template: `<p data-testid="fixed-polling">
    Fixed polling: {{ polls }} <button type="button" data-testid="start-fixed-polling" (click)="start()">Start</button>
  </p>`,
})
export class FixedPollingComponent {
  polls = 0;
  private timeout?: ReturnType<typeof setTimeout>;
  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timeout));
  }
  start(): void {
    const poll = () => {
      this.polls++;
      this.timeout = setTimeout(poll, 200);
    };
    this.timeout = setTimeout(poll, 200);
  }
}

/**
 * Leak: a directive that listens to `document` and never stops. Its listener
 * refreshes the view through the ChangeDetectorRef, and so keeps the view the
 * directive is in, and the component whose template that is: reported as the
 * component's leak, with the directive's listener as the cause.
 */
@Directive({ selector: "[appLeakyVisibility]" })
export class LeakyVisibilityDirective {
  private readonly cdr = inject(ChangeDetectorRef);
  constructor() {
    document.addEventListener("visibilitychange", () => this.cdr.markForCheck());
  }
}

@Directive({ selector: "[appFixedVisibility]" })
export class FixedVisibilityDirective {
  private readonly cdr = inject(ChangeDetectorRef);
  constructor() {
    const refresh = () => this.cdr.markForCheck();
    document.addEventListener("visibilitychange", refresh);
    inject(DestroyRef).onDestroy(() => document.removeEventListener("visibilitychange", refresh));
  }
}

@Component({
  selector: "app-leaky-panel",
  imports: [LeakyVisibilityDirective],
  template: `<p appLeakyVisibility data-testid="leaky-panel">Leaky panel</p>`,
})
export class LeakyPanelComponent {}

@Component({
  selector: "app-fixed-panel",
  imports: [FixedVisibilityDirective],
  template: `<p appFixedVisibility data-testid="fixed-panel">Fixed panel</p>`,
})
export class FixedPanelComponent {}

/** Leak: `fromEvent` in ngOnInit, never unsubscribed: the subscription, and the listener it added. */
@Component({
  selector: "app-leaky-online",
  template: `<p data-testid="leaky-online">Leaky online: {{ online }}</p>`,
})
export class LeakyOnlineComponent implements OnInit {
  online = navigator.onLine;
  ngOnInit(): void {
    fromEvent(window, "online").subscribe(() => (this.online = true));
  }
}

@Component({
  selector: "app-fixed-online",
  template: `<p data-testid="fixed-online">Fixed online: {{ online }}</p>`,
})
export class FixedOnlineComponent implements OnInit {
  online = navigator.onLine;
  private readonly destroyRef = inject(DestroyRef);
  ngOnInit(): void {
    fromEvent(window, "online")
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => (this.online = true));
  }
}

/** A root service that keeps what registers with it. */
@Injectable({ providedIn: "root" })
export class PanelRegistry {
  readonly panels = new Set<object>();
}

/**
 * Leak: registers itself with a root service, which keeps it. Not a timer, a
 * listener or a subscription: the detector reports the leak, and names no
 * cause rather than a wrong one.
 */
@Component({
  selector: "app-leaky-cache",
  template: `<p data-testid="leaky-cache">Leaky cache</p>`,
})
export class LeakyCacheComponent {
  constructor() {
    inject(PanelRegistry).panels.add(this);
  }
}

@Component({
  selector: "app-fixed-cache",
  template: `<p data-testid="fixed-cache">Fixed cache</p>`,
})
export class FixedCacheComponent {
  constructor() {
    const { panels } = inject(PanelRegistry);
    panels.add(this);
    inject(DestroyRef).onDestroy(() => panels.delete(this));
  }
}

/** Leak: observes the page's size and never disconnects: the body keeps the observer, and it `this`. */
@Component({
  selector: "app-leaky-resize",
  template: `<p data-testid="leaky-resize">Leaky resize: {{ width }}px</p>`,
})
export class LeakyResizeComponent {
  width = 0;
  constructor() {
    new ResizeObserver(([entry]) => (this.width = entry?.contentRect.width ?? 0)).observe(document.body);
  }
}

@Component({
  selector: "app-fixed-resize",
  template: `<p data-testid="fixed-resize">Fixed resize: {{ width }}px</p>`,
})
export class FixedResizeComponent {
  width = 0;
  constructor() {
    const observer = new ResizeObserver(([entry]) => (this.width = entry?.contentRect.width ?? 0));
    observer.observe(document.body);
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }
}

/** Leak: work done when the browser is idle, each round requesting the next, never stopped. */
@Component({
  selector: "app-leaky-idle",
  template: `<p data-testid="leaky-idle">Leaky idle work</p>`,
})
export class LeakyIdleComponent {
  rounds = 0;
  constructor() {
    const work = () => {
      this.rounds++;
      requestIdleCallback(work);
    };
    requestIdleCallback(work);
  }
}

@Component({
  selector: "app-fixed-idle",
  template: `<p data-testid="fixed-idle">Fixed idle work</p>`,
})
export class FixedIdleComponent {
  rounds = 0;
  constructor() {
    let request = 0;
    const work = () => {
      this.rounds++;
      request = requestIdleCallback(work);
    };
    request = requestIdleCallback(work);
    inject(DestroyRef).onDestroy(() => cancelIdleCallback(request));
  }
}

/** Leak: a listener added `once`, for an event that never comes: it stays, and never goes. */
@Component({
  selector: "app-leaky-once",
  template: `<p data-testid="leaky-once">Leaky once: {{ printing }}</p>`,
})
export class LeakyOnceComponent {
  printing = false;
  constructor() {
    window.addEventListener("beforeprint", () => (this.printing = true), { once: true });
  }
}

@Component({
  selector: "app-fixed-once",
  template: `<p data-testid="fixed-once">Fixed once: {{ printing }}</p>`,
})
export class FixedOnceComponent {
  printing = false;
  constructor() {
    const onPrint = () => (this.printing = true);
    window.addEventListener("beforeprint", onPrint, { once: true });
    inject(DestroyRef).onDestroy(() => window.removeEventListener("beforeprint", onPrint));
  }
}

/**
 * Leak: its subscription ends after the first value (`take(1)`), but the
 * interval its callback started runs on: that is what holds it.
 */
@Component({
  selector: "app-leaky-callback",
  template: `<p data-testid="leaky-callback">Leaky callback: {{ ticks }}</p>`,
})
export class LeakyCallbackComponent {
  ticks = 0;
  constructor() {
    inject(TickerService)
      .ticks$.pipe(take(1))
      .subscribe(() => setInterval(() => this.ticks++, 1000));
  }
}

@Component({
  selector: "app-fixed-callback",
  template: `<p data-testid="fixed-callback">Fixed callback: {{ ticks }}</p>`,
})
export class FixedCallbackComponent {
  ticks = 0;
  constructor() {
    let interval: ReturnType<typeof setInterval> | undefined;
    inject(TickerService)
      .ticks$.pipe(take(1))
      .subscribe(() => (interval = setInterval(() => this.ticks++, 1000)));
    inject(DestroyRef).onDestroy(() => clearInterval(interval));
  }
}
