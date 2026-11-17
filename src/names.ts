// What a tracked class is called in warnings, events and `report()`.
//
// A name depends only on what it names, never on what the detector saw
// before, so that a leak is reported under the same name in every session
// and leaks from many sessions can be grouped.
//
// In a development build that is the class name (`UserCardComponent`). A
// minified production build renames classes: esbuild names nearly every one
// `e` (`var Xt = class e {…}`), so such names say nothing, and many classes
// share one. So there, a class is named by what its code declares as
// strings, which minifiers keep, the same in every build:
//
// - a component or directive by its selector (`app-user-card`,
//   `[appTooltip]`); a component that declares none by its component id,
//   the one in its host's `_nghost-ng-c…` attribute:
//   `ng-component (c2736387395)`. Classes that share a selector share the
//   name: telling them apart by which came first would name them
//   differently from one session to the next;
// - each instance of a service by where it is provided: the element, and
//   its place among the element's providers, view providers first:
//   `app-cart providers[0]`, where `app-cart` is the name of the element's
//   component, or else of its first directive. A service class provided by
//   two components goes by two names, one for each.
//
// The same goes, in any build, for a class named by a single character: a
// build can minify some code and not the rest (see `isMinified`).
//
// A heap snapshot names an object by its constructor's `name` property, so
// such a class can be given its name as its `name` too
// (`renameMinifiedClasses`, off by default), the first one it is given for
// a service: the warning gives the name the heap snapshot shows
// (`className`). Only classes whose name is minified, and so says nothing,
// are renamed.
//
// Better still, `ng-leak-names` (cli/) gives a build's classes their real
// names back after `ng build`, from its source maps: then none is minified,
// and every class goes by its real name here too.

/** What a tracked class is called. */
export type ClassNames = {
  /** Its name in warnings, events and `report()`: see above. */
  name: string;
  /**
   * What its class is called at runtime, the name a heap snapshot shows: its
   * name, minified or not, or the one the detector gave it
   * (`renameMinifiedClasses`), for a service the one of the first place it
   * was seen provided.
   */
  className: string;
};

/**
 * A class of the detector's own, bundled and minified along with the app's
 * code: its name says whether the build keeps class names.
 */
class NameProbe {}

let minified: boolean | undefined;

/** Whether the build renamed classes: a minified production build. */
export function classNamesMinified(): boolean {
  // A bundler that renames a class to avoid a clash appends a number.
  minified ??= !/^_*NameProbe\d*$/.test(NameProbe.name);
  return minified;
}

/** Stand in for a minified build, or not (`undefined`: look again). For unit tests. */
export function setClassNamesMinified(value: boolean | undefined): void {
  minified = value;
}

/**
 * Whether a class's name (`className`) is minified: the whole build's are, or
 * this one is a single character, as no class is named by hand. A build can
 * minify the app's code and not its dependencies, the detector's included:
 * Angular 17's dev server does, serving an optimized configuration.
 */
function isMinified(className: string): boolean {
  return classNamesMinified() || className.length <= 1;
}

/** What the detector knows of a class, looked up once (its name is read once). */
type ClassRecord = {
  /** Its name when first seen. */
  runtimeName: string;
  minified: boolean;
  /** Of a component or directive: its one name (services are named per instance). */
  name?: string;
  /** The names given to its instances, for `exclude`. */
  given: Set<string>;
  /** The name it was given as its `name`, if it was. */
  renamedTo?: string;
  renameTried: boolean;
};

const records = new WeakMap<Function, ClassRecord>();

/** The names given to minified classes (see above), rather than their class names. */
const labels = new Set<string>();

/** Whether `name` was given to a minified class, rather than being its class name. */
export function isMinifiedName(name: string): boolean {
  return labels.has(name);
}

const UNKNOWN: ClassNames = { name: "Unknown", className: "Unknown" };

/**
 * The names of the instance's class: a component's or a directive's.
 * `rename`: give a minified class its name as its `name`, when first named.
 */
export function namesOf(instance: object, rename = false): ClassNames {
  const ctor = classOf(instance);
  if (!ctor) return UNKNOWN;
  const record = recordOf(ctor);
  if (!record.minified) return given(record, devName(record.runtimeName));
  record.name ??= selectorOf(ctor) ?? (record.runtimeName || "Unknown");
  return named(ctor, record, record.name, rename);
}

/**
 * The names of a service instance. `provider` says where it is provided
 * (`app-cart providers[0]`): its name in a minified build, asked only there.
 * `rename`: as for `namesOf`.
 */
export function serviceNamesOf(instance: object, provider: () => string, rename = false): ClassNames {
  const ctor = classOf(instance);
  if (!ctor) return UNKNOWN;
  const record = recordOf(ctor);
  if (!record.minified) return given(record, devName(record.runtimeName));
  return named(ctor, record, provider(), rename);
}

/** Whether instances of the class were given `name`: for `exclude`. */
export function isNameOf(ctor: Function, name: string): boolean {
  return records.get(ctor)?.given.has(name) ?? false;
}

function classOf(instance: object): Function | null {
  const ctor = (instance as { constructor?: unknown }).constructor;
  return typeof ctor === "function" ? ctor : null;
}

function recordOf(ctor: Function): ClassRecord {
  let record = records.get(ctor);
  if (record === undefined) {
    const runtimeName = ctor.name;
    record = { runtimeName, minified: isMinified(runtimeName), given: new Set(), renameTried: false };
    records.set(ctor, record);
  }
  return record;
}

/**
 * Dev builds made with esbuild (the Angular CLI's default builder since v17)
 * emit `class _UserCardComponent`: a leading underscore before a capital
 * letter is dropped.
 */
const devName = (runtimeName: string) => runtimeName.replace(/^_+(?=[A-Z])/, "") || "Unknown";

function given(record: ClassRecord, name: string): ClassNames {
  record.given.add(name);
  return { name, className: name };
}

/** A minified class's instance named `name`; `className` is what its class is called now. */
function named(ctor: Function, record: ClassRecord, name: string, rename: boolean): ClassNames {
  record.given.add(name);
  labels.add(name);
  if (rename && !record.renameTried) {
    record.renameTried = true;
    if (renameClass(ctor, name)) record.renamedTo = name;
  }
  return { name, className: record.renamedTo ?? (record.runtimeName || "Unknown") };
}

/**
 * Make `name` the class's `name`, which is what a heap snapshot shows. A
 * class's `name` can be redefined (it is configurable); `false` if not.
 */
function renameClass(ctor: Function, name: string): boolean {
  try {
    Object.defineProperty(ctor, "name", { value: name, configurable: true });
    return ctor.name === name;
  } catch {
    return false;
  }
}

/**
 * Angular's `CssSelector`: the element name first, then attribute name and
 * value pairs, and class names, each group after a `SelectorFlags` marker.
 */
type CssSelector = ReadonlyArray<string | number>;

/** Angular's SelectorFlags. */
const NOT = 0b0001;
const ATTRIBUTE = 0b0010;
const ELEMENT = 0b0100;
const CLASS = 0b1000;

/** The default selector Angular gives a component that declares none. */
const DEFAULT_SELECTOR = "ng-component";

/** What Angular's compiler adds to a component or directive class (`ɵcmp`, `ɵdir`). */
type Definition = { selectors?: unknown; id?: unknown };

/**
 * The selector of a component or directive class, as its decorator declared
 * it, from the definition Angular's compiler adds to the class, which
 * production builds keep. A component that declares none has Angular's
 * default one, shared by all such components: its component id tells them
 * apart. `null` for any other class.
 */
function selectorOf(ctor: Function): string | null {
  const { ɵcmp, ɵdir } = ctor as { ɵcmp?: Definition | null; ɵdir?: Definition | null };
  const def = ɵcmp ?? ɵdir;
  const selectors = def?.selectors;
  if (!Array.isArray(selectors)) return null;
  const text = selectors
    .filter((s): s is CssSelector => Array.isArray(s))
    .map(stringifySelector)
    .filter(Boolean)
    .join(",");
  if (text === "") return null;
  if (text === DEFAULT_SELECTOR && typeof def?.id === "string") return `${text} (${def.id})`;
  return text;
}

/** Angular's own `stringifyCSSSelector` (what `reflectComponentType(…).selector` gives). */
function stringifySelector(selector: CssSelector): string {
  let result = typeof selector[0] === "string" ? selector[0] : "";
  let mode = ATTRIBUTE;
  let chunk = "";
  let negated = false;
  const flush = () => {
    if (chunk !== "") result += negated ? `:not(${chunk.trim()})` : chunk;
    chunk = "";
  };
  for (let i = 1; i < selector.length; i++) {
    const value = selector[i];
    if (typeof value === "string") {
      if (mode & ATTRIBUTE) {
        const attrValue = selector[++i];
        chunk += `[${value}${typeof attrValue === "string" && attrValue.length > 0 ? `="${attrValue}"` : ""}]`;
      } else if (mode & CLASS) {
        chunk += `.${value}`;
      } else if (mode & ELEMENT) {
        chunk += ` ${value}`;
      }
    } else if (typeof value === "number") {
      if ((value & NOT) !== 0) flush();
      mode = value;
      negated ||= (mode & NOT) !== 0;
    }
  }
  flush();
  return result;
}
