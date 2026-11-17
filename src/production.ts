// The lookups discovery makes (discovery.ts), for a production build, where
// Angular publishes no debugging API: `window.ng` exists only when
// `ngDevMode` is on. They are made with `DebugNode`, public API on every
// Angular from 16 to 22, and nothing else imported from Angular:
//
// - `new DebugNode(node).injector` is the node's injector, as
//   `ng.getInjector(node)` is: Angular turns the view id it stores on the node
//   (`__ngContext__`, in every build) into a context, leaves it on the node,
//   as `ng.*` lookups do (discovery puts the id back afterwards:
//   `withPristineContext`), and returns a NodeInjector for the node's TNode
//   and the view it is in. Unlike `getDebugNode`, `new DebugNode` stores
//   nothing on the node.
// - That TNode and view say where the node's component and directives are
//   (`placeFromInjector`, `directivesAt`), as they do in development.
// - `new DebugNode(node).componentInstance` is the node's component, or else
//   the one whose template it is in (`ng.getOwningComponent`).
//
// Angular's private functions (`ɵgetLContext`, `ɵgetDirectives`) would do
// too, but importing one that a later Angular renames or removes would break
// the build of every app that uses the detector, even where it only runs in
// development: a bundler rejects an import that doesn't exist. What is read
// here instead is read from objects at runtime: if a later Angular changes
// it, the detector finds nothing, and says so (detector.ts), but the app
// builds and runs.
//
// Property names survive minification (only variable, function and class
// names are renamed), so what discovery reads from Angular's view data reads
// the same there. Class names don't: see names.ts.
//
// Not available: how providers were declared (`ng.ɵgetInjectorProviders`),
// which Angular records in development only. So services whose class has no
// decorator (no `@Injectable()`) aren't found in a production build.

import { DebugNode } from "@angular/core";
import { directivesAt, type NgDebugApi, placeFromInjector } from "./discovery.js";

/** The node's injector, with its context left on the node (see above). */
const injectorOf = (node: Node) => new DebugNode(node).injector;

/**
 * The component `element` hosts, if any, read the way Angular's
 * `getComponent` reads it: the node's component is at
 * `directiveStart + componentOffset`, `componentOffset` being -1 on a node
 * that hosts none.
 */
function getComponent(element: Element): object | null {
  const place = placeFromInjector(injectorOf(element));
  const offset = place?.tNode.componentOffset;
  if (!place || typeof offset !== "number" || offset < 0) return null;
  const component: unknown = place.lView[place.tNode.directiveStart + offset];
  return typeof component === "object" && component !== null ? component : null;
}

/** The node's directives, not its component, as `ng.getDirectives` lists them. */
function getDirectives(node: Node): object[] {
  const place = placeFromInjector(injectorOf(node));
  return place ? directivesAt(place, null) : [];
}

/**
 * The lookups of Angular's debugging API, without it. Created on demand: a
 * build that never starts the detector in production drops this module.
 */
export function productionApi(): NgDebugApi {
  return {
    getComponent,
    getInjector: injectorOf,
    getDirectives,
    // The component the node hosts, or else the one whose template it is in:
    // asked only for nodes that host no component discovery tracks.
    getOwningComponent: (node) => {
      const owning: unknown = new DebugNode(node).componentInstance;
      return typeof owning === "object" && owning !== null ? owning : null;
    },
  };
}
