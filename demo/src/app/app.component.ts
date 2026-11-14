import { Component, signal } from "@angular/core";
import { RouterLink, RouterOutlet } from "@angular/router";
import {
  FixedListenerComponent,
  FixedSubscriptionComponent,
  FixedTimerComponent,
  LeakyListenerComponent,
  LeakySubscriptionComponent,
  LeakyTimerComponent,
} from "./leaks";

const DEMOS = [
  { id: "leaky-timer", label: "leaky timer" },
  { id: "fixed-timer", label: "fixed timer" },
  { id: "leaky-subscription", label: "leaky subscription" },
  { id: "fixed-subscription", label: "fixed subscription" },
  { id: "leaky-listener", label: "leaky listener" },
  { id: "fixed-listener", label: "fixed listener" },
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
  ],
  template: `
    <h1>Angular memory leak detector demo</h1>
    <p>
      Create a component, destroy it, then click <b>Collect garbage</b> in DevTools → Memory.
      Leaky components are reported in the console after about two seconds.
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
    <nav>
      <a routerLink="/" data-testid="nav-home">Home</a> |
      <a routerLink="/other" data-testid="nav-other">Other</a>
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
