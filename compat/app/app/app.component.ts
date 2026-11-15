// The demo app shell (demo/src/app/app.component.ts) in syntax Angular 16
// understands: `*ngFor` / `*ngIf` for `@for` / `@if`.
import { NgFor, NgIf } from "@angular/common";
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
  ],
  template: `
    <h1>Angular memory leak detector demo</h1>
    <p>
      Create a component, destroy it, then click <b>Collect garbage</b> in DevTools → Memory.
      Leaky components are reported in the console after about two seconds.
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
    <nav>
      <a routerLink="/" data-testid="nav-home">Home</a> |
      <a routerLink="/other" data-testid="nav-other">Other</a> |
      <a routerLink="/nested" data-testid="nav-nested">Nested</a> |
      <a routerLink="/leaky" data-testid="nav-leaky">Leaky page</a> |
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
