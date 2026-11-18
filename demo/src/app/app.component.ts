import { Component, signal } from "@angular/core";
import { RouterLink, RouterOutlet } from "@angular/router";
import {
  FixedAnimationComponent,
  FixedCacheComponent,
  FixedCallbackComponent,
  FixedIdleComponent,
  FixedListenerComponent,
  FixedOnceComponent,
  FixedOnlineComponent,
  FixedPanelComponent,
  FixedPlainServiceComponent,
  FixedPollingComponent,
  FixedResizeComponent,
  FixedServiceComponent,
  FixedSubscriptionComponent,
  FixedTimeoutComponent,
  FixedTimerComponent,
  FixedTooltipDirective,
  LeakyAnimationComponent,
  LeakyCacheComponent,
  LeakyCallbackComponent,
  LeakyIdleComponent,
  LeakyListenerComponent,
  LeakyOnceComponent,
  LeakyOnlineComponent,
  LeakyPanelComponent,
  LeakyPlainServiceComponent,
  LeakyPollingComponent,
  LeakyResizeComponent,
  LeakyServiceComponent,
  LeakySubscriptionComponent,
  LeakyTimeoutComponent,
  LeakyTimerComponent,
  LeakyTooltipDirective,
  LeakyViewComponent,
} from "./leaks";

const DEMOS = [
  { id: "leaky-timer", label: "leaky timer" },
  { id: "fixed-timer", label: "fixed timer" },
  { id: "leaky-subscription", label: "leaky subscription" },
  { id: "fixed-subscription", label: "fixed subscription" },
  { id: "leaky-listener", label: "leaky listener" },
  { id: "fixed-listener", label: "fixed listener" },
  { id: "leaky-directive", label: "leaky directive" },
  { id: "fixed-directive", label: "fixed directive" },
  { id: "leaky-service", label: "leaky service" },
  { id: "fixed-service", label: "fixed service" },
  { id: "leaky-plain-service", label: "leaky service without @Injectable" },
  { id: "fixed-plain-service", label: "fixed service without @Injectable" },
  { id: "leaky-view", label: "component that keeps its view" },
  { id: "leaky-timeout", label: "leaky timeout" },
  { id: "fixed-timeout", label: "fixed timeout" },
  { id: "leaky-animation", label: "leaky animation loop" },
  { id: "fixed-animation", label: "fixed animation loop" },
  { id: "leaky-polling", label: "leaky polling" },
  { id: "fixed-polling", label: "fixed polling" },
  { id: "leaky-panel", label: "panel with a leaky directive" },
  { id: "fixed-panel", label: "panel with a fixed directive" },
  { id: "leaky-online", label: "leaky fromEvent" },
  { id: "fixed-online", label: "fixed fromEvent" },
  { id: "leaky-cache", label: "leaky cache" },
  { id: "fixed-cache", label: "fixed cache" },
  { id: "leaky-resize", label: "leaky ResizeObserver" },
  { id: "fixed-resize", label: "fixed ResizeObserver" },
  { id: "leaky-idle", label: "leaky idle callbacks" },
  { id: "fixed-idle", label: "fixed idle callbacks" },
  { id: "leaky-once", label: "leaky once listener" },
  { id: "fixed-once", label: "fixed once listener" },
  { id: "leaky-callback", label: "leaky subscription callback" },
  { id: "fixed-callback", label: "fixed subscription callback" },
] as const;

type DemoId = (typeof DEMOS)[number]["id"];

@Component({
  selector: "app-root",
  imports: [
    RouterLink,
    RouterOutlet,
    LeakyTimerComponent,
    FixedTimerComponent,
    LeakySubscriptionComponent,
    FixedSubscriptionComponent,
    LeakyListenerComponent,
    FixedListenerComponent,
    LeakyTooltipDirective,
    FixedTooltipDirective,
    LeakyServiceComponent,
    FixedServiceComponent,
    LeakyPlainServiceComponent,
    FixedPlainServiceComponent,
    LeakyViewComponent,
    LeakyTimeoutComponent,
    FixedTimeoutComponent,
    LeakyAnimationComponent,
    FixedAnimationComponent,
    LeakyPollingComponent,
    FixedPollingComponent,
    LeakyPanelComponent,
    FixedPanelComponent,
    LeakyOnlineComponent,
    FixedOnlineComponent,
    LeakyCacheComponent,
    FixedCacheComponent,
    LeakyResizeComponent,
    FixedResizeComponent,
    LeakyIdleComponent,
    FixedIdleComponent,
    LeakyOnceComponent,
    FixedOnceComponent,
    LeakyCallbackComponent,
    FixedCallbackComponent,
  ],
  template: `
    <h1>Angular memory leak detector demo</h1>
    <p>
      Create a component, directive or service, destroy it, then click <b>Collect garbage</b> in
      DevTools → Memory. Leaky ones are reported in the console after about two seconds.
    </p>
    @for (demo of demos; track demo.id) {
      <button type="button" [attr.data-testid]="'toggle-' + demo.id" (click)="toggle(demo.id)">
        {{ shown().has(demo.id) ? "Destroy" : "Create" }} {{ demo.label }}
      </button>
    }
    @if (shown().has("leaky-timer")) { <app-leaky-timer /> }
    @if (shown().has("fixed-timer")) { <app-fixed-timer /> }
    @if (shown().has("leaky-subscription")) { <app-leaky-subscription /> }
    @if (shown().has("fixed-subscription")) { <app-fixed-subscription /> }
    @if (shown().has("leaky-listener")) { <app-leaky-listener /> }
    @if (shown().has("fixed-listener")) { <app-fixed-listener /> }
    @if (shown().has("leaky-directive")) {
      <p appLeakyTooltip data-testid="leaky-directive">Leaky directive</p>
    }
    @if (shown().has("fixed-directive")) {
      <p appFixedTooltip data-testid="fixed-directive">Fixed directive</p>
    }
    @if (shown().has("leaky-service")) { <app-leaky-service /> }
    @if (shown().has("fixed-service")) { <app-fixed-service /> }
    @if (shown().has("leaky-plain-service")) { <app-leaky-plain-service /> }
    @if (shown().has("fixed-plain-service")) { <app-fixed-plain-service /> }
    @if (shown().has("leaky-view")) { <app-leaky-view /> }
    @if (shown().has("leaky-timeout")) { <app-leaky-timeout /> }
    @if (shown().has("fixed-timeout")) { <app-fixed-timeout /> }
    @if (shown().has("leaky-animation")) { <app-leaky-animation /> }
    @if (shown().has("fixed-animation")) { <app-fixed-animation /> }
    @if (shown().has("leaky-polling")) { <app-leaky-polling /> }
    @if (shown().has("fixed-polling")) { <app-fixed-polling /> }
    @if (shown().has("leaky-panel")) { <app-leaky-panel /> }
    @if (shown().has("fixed-panel")) { <app-fixed-panel /> }
    @if (shown().has("leaky-online")) { <app-leaky-online /> }
    @if (shown().has("fixed-online")) { <app-fixed-online /> }
    @if (shown().has("leaky-cache")) { <app-leaky-cache /> }
    @if (shown().has("fixed-cache")) { <app-fixed-cache /> }
    @if (shown().has("leaky-resize")) { <app-leaky-resize /> }
    @if (shown().has("fixed-resize")) { <app-fixed-resize /> }
    @if (shown().has("leaky-idle")) { <app-leaky-idle /> }
    @if (shown().has("fixed-idle")) { <app-fixed-idle /> }
    @if (shown().has("leaky-once")) { <app-leaky-once /> }
    @if (shown().has("fixed-once")) { <app-fixed-once /> }
    @if (shown().has("leaky-callback")) { <app-leaky-callback /> }
    @if (shown().has("fixed-callback")) { <app-fixed-callback /> }
    <nav>
      <a routerLink="/" data-testid="nav-home">Home</a> |
      <a routerLink="/other" data-testid="nav-other">Other</a> |
      <a routerLink="/nested" data-testid="nav-nested">Nested</a> |
      <a routerLink="/leaky" data-testid="nav-leaky">Leaky page</a> |
      <a routerLink="/stateful" data-testid="nav-stateful">Stateful page</a> |
      <a routerLink="/broken" data-testid="nav-broken">Broken page</a>
    </nav>
    <router-outlet />
  `,
})
export class AppComponent {
  readonly demos = DEMOS;
  readonly shown = signal(new Set<DemoId>());

  toggle(id: DemoId): void {
    this.shown.update((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }
}
