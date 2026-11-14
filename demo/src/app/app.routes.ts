import type { Routes } from "@angular/router";
import { HomePageComponent, OtherPageComponent } from "./pages";

export const routes: Routes = [
  { path: "", component: HomePageComponent },
  { path: "other", component: OtherPageComponent },
];
