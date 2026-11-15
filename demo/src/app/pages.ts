// Routed pages, to check that plain navigation (the router destroying a page)
// is never reported: two pages with cards in them, and a page with a child
// route. Plus a page that leaks, which must be reported, and one whose
// navigation fails.
import { Component, inject, input } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { TickerService } from "./leaks";

@Component({
  selector: "app-card",
  template: `<div class="card">{{ title() }}</div>`,
})
export class CardComponent {
  readonly title = input("");
}

@Component({
  selector: "app-home-page",
  imports: [CardComponent],
  template: `<h2 data-testid="home-page">Home</h2>
    @for (n of items; track n) {
      <app-card [title]="'Home card ' + n" />
    }`,
})
export class HomePageComponent {
  readonly items = [1, 2, 3];
}

@Component({
  selector: "app-other-page",
  imports: [CardComponent],
  template: `<h2 data-testid="other-page">Other</h2>
    <app-card title="Other card" />`,
})
export class OtherPageComponent {}

@Component({
  selector: "app-nested-child",
  template: `<p data-testid="nested-child">Nested child</p>`,
})
export class NestedChildComponent {}

/** A page with a child route: navigating away takes both pages down. */
@Component({
  selector: "app-nested-page",
  imports: [RouterOutlet],
  template: `<h2 data-testid="nested-page">Nested</h2>
    <router-outlet />`,
})
export class NestedPageComponent {}

/** Leak: a page that subscribes to a root service and never unsubscribes. */
@Component({
  selector: "app-leaky-page",
  template: `<h2 data-testid="leaky-page">Leaky page: {{ value }}</h2>`,
})
export class LeakyPageComponent {
  value = 0;
  constructor() {
    inject(TickerService).ticks$.subscribe((v) => (this.value = v));
  }
}

/**
 * A page that can't be created: navigating to it fails after the router has
 * taken the current page down.
 */
@Component({
  selector: "app-broken-page",
  template: `<h2 data-testid="broken-page">Broken page</h2>`,
})
export class BrokenPageComponent {
  constructor() {
    throw new Error("BrokenPageComponent can't be created, on purpose.");
  }
}
