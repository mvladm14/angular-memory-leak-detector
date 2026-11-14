// Finds component instances and learns when Angular destroys them, with no
// build step: everything goes through Angular's dev-mode debugging API
// (`window.ng`, published only when `ngDevMode` is on).
//
// - A MutationObserver sees every element Angular inserts into the document.
//   `ng.getComponent(el)` says whether it hosts a component, and returns the
//   instance.
// - `ng.getInjector(el).get(ChangeDetectorRef)` on a component's host returns
//   the ViewRef of that component's own view. Its `onDestroy` callback fires
//   when Angular destroys the view: that is the "destroyed" signal.
//
// The detector must never retain what it watches. Two things matter:
//
// 1. `ng.getComponent` / `ng.getInjector` cache a context object on the host
//    element (Angular normally stores only a numeric view id there), and that
//    cache holds the component instance strongly. A destroyed component whose
//    detached host element is still referenced (by a DOM leak, or by the
//    browser itself for a while) would then look leaked because of us. So the
//    element's original value is restored after every lookup.
// 2. The onDestroy callback lives in the component's view. It is created in a
//    function of its own so that its closure holds only the entry (a WeakRef
//    and a name), never the instance, element or view.

import { ChangeDetectorRef } from "@angular/core";
import { componentNameOf, markDestroyed, track } from "./lifecycle.js";
import type { LiveEntry } from "./types.js";

type NgInjector = { get(token: unknown, notFoundValue?: unknown): unknown };

/** The parts of Angular's dev-mode global (`window.ng`) the detector uses. */
type NgDebugApi = {
  getComponent(element: Element): object | null;
  getInjector(element: Element): NgInjector;
};

/** What `ChangeDetectorRef` resolves to on a component host: its view's ViewRef. */
type ComponentViewRef = {
  readonly context: unknown;
  readonly destroyed: boolean;
  onDestroy(callback: () => void): unknown;
};

/** Where Angular stores an element's view context (a numeric view id by default). */
const CONTEXT_KEY = "__ngContext__";

export function ngApi(): NgDebugApi | null {
  const ng = (globalThis as { ng?: Partial<NgDebugApi> }).ng;
  return ng && typeof ng.getComponent === "function" && typeof ng.getInjector === "function"
    ? (ng as NgDebugApi)
    : null;
}

let seen = new WeakSet<object>();
let observedRoots = new WeakSet<Node>();
let observer: MutationObserver | null = null;

function onDestroyOf(entry: LiveEntry): () => void {
  return () => markDestroyed(entry);
}

/** Run an `ng.*` lookup on `el`, then put back what Angular had stored on it. */
function withPristineContext<T>(el: Element, lookup: () => T): T {
  const record = el as unknown as Record<string, unknown>;
  const before = record[CONTEXT_KEY];
  try {
    return lookup();
  } finally {
    if (record[CONTEXT_KEY] !== before) record[CONTEXT_KEY] = before;
  }
}

function isComponentViewRef(value: unknown): value is ComponentViewRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ComponentViewRef).onDestroy === "function" &&
    "destroyed" in value &&
    "context" in value
  );
}

/** Track `el`'s component, if it hosts one we haven't seen. */
function visit(el: Element, ng: NgDebugApi): void {
  if (el.shadowRoot) observeRoot(el.shadowRoot, ng);
  // Every element Angular creates carries a view context. Elements without one
  // can't host a component, and skipping them keeps `ng.getComponent` from
  // walking up their ancestors.
  if (!(CONTEXT_KEY in el)) return;
  try {
    withPristineContext(el, () => {
      const instance = ng.getComponent(el);
      if (!instance || seen.has(instance)) return;
      seen.add(instance);
      const view = ng.getInjector(el).get(ChangeDetectorRef, null);
      // On a component host the ViewRef's context is the component itself.
      // Anything else is a shape this version of the detector doesn't know.
      if (!isComponentViewRef(view) || view.context !== instance || view.destroyed) return;
      const entry = track(instance, componentNameOf(instance), el.localName);
      view.onDestroy(onDestroyOf(entry));
    });
  } catch {
    // A lookup on a node Angular is tearing down can throw. Never let the
    // detector break the app.
  }
}

/** Visit `root` and every element below it. */
function scan(root: Node, ng: NgDebugApi): void {
  if (root.nodeType === Node.ELEMENT_NODE) visit(root as Element, ng);
  else if (root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE)
    return;
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) visit(node as Element, ng);
}

function observeRoot(root: Node, ng: NgDebugApi): void {
  if (!observer || observedRoots.has(root)) return;
  observedRoots.add(root);
  observer.observe(root, { childList: true, subtree: true });
  if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) scan(root, ng);
}

/** Track every component in the document, now and as Angular renders more. */
export function startDiscovery(doc: Document = document): void {
  if (observer) return;
  observer = new MutationObserver((records) => {
    const ng = ngApi();
    if (!ng) return;
    for (const record of records) record.addedNodes.forEach((node) => scan(node, ng));
  });
  const ng = ngApi();
  if (ng) {
    observeRoot(doc, ng);
    scan(doc, ng);
  } else {
    observedRoots.add(doc);
    observer.observe(doc, { childList: true, subtree: true });
  }
}

/** Re-scan the whole document, e.g. after rendering into a detached tree. */
export function rescan(doc: Document = document): void {
  const ng = ngApi();
  if (ng) scan(doc, ng);
}

/** Stop watching the document and forget which components were seen. */
export function stopDiscovery(): void {
  observer?.disconnect();
  observer = null;
  seen = new WeakSet();
  observedRoots = new WeakSet();
}
