// The demo app shell (demo/src/app/app.component.ts) in syntax Angular 16
// understands: `*ngFor` / `*ngIf` for `@for` / `@if`.
import { NgFor, NgIf } from "@angular/common";
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
  standalone: true,
  selector: "app-root",
  imports: [
    NgFor,
    NgIf,
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
    <button
      *ngFor="let demo of demos"
      type="button"
      [attr.data-testid]="'toggle-' + demo.id"
      (click)="toggle(demo.id)"
    >
      {{ shown().has(demo.id) ? "Destroy" : "Create" }} {{ demo.label }}
    </button>
    <app-leaky-timer *ngIf="shown().has('leaky-timer')" />
    <app-fixed-timer *ngIf="shown().has('fixed-timer')" />
    <app-leaky-subscription *ngIf="shown().has('leaky-subscription')" />
    <app-fixed-subscription *ngIf="shown().has('fixed-subscription')" />
    <app-leaky-listener *ngIf="shown().has('leaky-listener')" />
    <app-fixed-listener *ngIf="shown().has('fixed-listener')" />
    <p *ngIf="shown().has('leaky-directive')" appLeakyTooltip data-testid="leaky-directive">Leaky directive</p>
    <p *ngIf="shown().has('fixed-directive')" appFixedTooltip data-testid="fixed-directive">Fixed directive</p>
    <app-leaky-service *ngIf="shown().has('leaky-service')" />
    <app-fixed-service *ngIf="shown().has('fixed-service')" />
    <app-leaky-plain-service *ngIf="shown().has('leaky-plain-service')" />
    <app-fixed-plain-service *ngIf="shown().has('fixed-plain-service')" />
    <app-leaky-view *ngIf="shown().has('leaky-view')" />
    <app-leaky-timeout *ngIf="shown().has('leaky-timeout')" />
    <app-fixed-timeout *ngIf="shown().has('fixed-timeout')" />
    <app-leaky-animation *ngIf="shown().has('leaky-animation')" />
    <app-fixed-animation *ngIf="shown().has('fixed-animation')" />
    <app-leaky-polling *ngIf="shown().has('leaky-polling')" />
    <app-fixed-polling *ngIf="shown().has('fixed-polling')" />
    <app-leaky-panel *ngIf="shown().has('leaky-panel')" />
    <app-fixed-panel *ngIf="shown().has('fixed-panel')" />
    <app-leaky-online *ngIf="shown().has('leaky-online')" />
    <app-fixed-online *ngIf="shown().has('fixed-online')" />
    <app-leaky-cache *ngIf="shown().has('leaky-cache')" />
    <app-fixed-cache *ngIf="shown().has('fixed-cache')" />
    <app-leaky-resize *ngIf="shown().has('leaky-resize')" />
    <app-fixed-resize *ngIf="shown().has('fixed-resize')" />
    <app-leaky-idle *ngIf="shown().has('leaky-idle')" />
    <app-fixed-idle *ngIf="shown().has('fixed-idle')" />
    <app-leaky-once *ngIf="shown().has('leaky-once')" />
    <app-fixed-once *ngIf="shown().has('fixed-once')" />
    <app-leaky-callback *ngIf="shown().has('leaky-callback')" />
    <app-fixed-callback *ngIf="shown().has('fixed-callback')" />
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
