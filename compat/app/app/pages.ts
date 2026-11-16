// Routed pages, to check that plain navigation (the router destroying a page)
// is never reported: two pages with cards in them, and a page with a child
// route, and a page with a service and a host directive it keeps. Plus a page
// that leaks, which must be reported, and one whose navigation fails. Same
// pages as demo/src/app/pages.ts, in syntax Angular 16 understands:
// `@Input()` for `input()` and `*ngFor` for `@for`.
import { NgFor } from "@angular/common";
import { Component, Directive, Injectable, Input, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { TickerService } from "./leaks";

@Component({
  standalone: true,
  selector: "app-card",
  template: `<div class="card">{{ title }}</div>`,
})
export class CardComponent {
  @Input() title = "";
}

@Component({
  standalone: true,
  selector: "app-home-page",
  imports: [CardComponent, NgFor],
  template: `<h2 data-testid="home-page">Home</h2>
    <app-card *ngFor="let n of items" [title]="'Home card ' + n" />`,
})
export class HomePageComponent {
  readonly items = [1, 2, 3];
}

@Component({
  standalone: true,
  selector: "app-other-page",
  imports: [CardComponent],
  template: `<h2 data-testid="other-page">Other</h2>
    <app-card title="Other card" />`,
})
export class OtherPageComponent {}

@Component({
  standalone: true,
  selector: "app-nested-child",
  template: `<p data-testid="nested-child">Nested child</p>`,
})
export class NestedChildComponent {}

/** A page with a child route: navigating away takes both pages down. */
@Component({
  standalone: true,
  selector: "app-nested-page",
  imports: [RouterOutlet],
  template: `<h2 data-testid="nested-page">Nested</h2>
    <router-outlet />`,
})
export class NestedPageComponent {}

/** State a page provides for itself (`providers: [PageStateService]`). */
@Injectable()
export class PageStateService {
  visits = 1;
}

@Directive({ standalone: true, selector: "[appPageTitle]" })
export class PageTitleDirective {
  title = "Stateful";
}

/**
 * A page that keeps the service it provides and its host directive: where
 * the router keeps the page (Angular 16 and 20), it keeps them too.
 */
@Component({
  standalone: true,
  selector: "app-stateful-page",
  hostDirectives: [PageTitleDirective],
  providers: [PageStateService],
  template: `<h2 data-testid="stateful-page">{{ title.title }}: {{ state.visits }}</h2>`,
})
export class StatefulPageComponent {
  readonly state = inject(PageStateService);
  readonly title = inject(PageTitleDirective);
}

/** Leak: a page that subscribes to a root service and never unsubscribes. */
@Component({
  standalone: true,
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
  standalone: true,
  selector: "app-broken-page",
  template: `<h2 data-testid="broken-page">Broken page</h2>`,
})
export class BrokenPageComponent {
  constructor() {
    throw new Error("BrokenPageComponent can't be created, on purpose.");
  }
}
