// Two routes, each with a nested component, to check that plain navigation
// (the router destroying a page) is never reported.
import { Component, input } from "@angular/core";

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
