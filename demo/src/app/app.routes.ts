import type { Routes } from "@angular/router";
import {
  BrokenPageComponent,
  HomePageComponent,
  LeakyPageComponent,
  NestedChildComponent,
  NestedPageComponent,
  OtherPageComponent,
} from "./pages";

export const routes: Routes = [
  { path: "", component: HomePageComponent },
  { path: "other", component: OtherPageComponent },
  { path: "nested", component: NestedPageComponent, children: [{ path: "", component: NestedChildComponent }] },
  { path: "leaky", component: LeakyPageComponent },
  { path: "broken", component: BrokenPageComponent },
];
