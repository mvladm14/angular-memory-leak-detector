// Restores class names in a minified build, from its source maps: what the
// `ng-leak-names` command (ng-leak-names.ts) does to each script of a
// production build after `ng build`. Apps never import this.
//
// A minifier renames classes (esbuild names nearly every one `e`), and a
// class's name is what both the detector's warnings and a heap snapshot show
// (Chromium names an object by its constructor's `name` property). The
// build's source map still knows each class's name: it maps the minified
// `e` in `class e{` to `LeakyTimerComponent` in `export class
// LeakyTimerComponent {`. So each class gets its name back as a static field,
// the first thing in its body:
//
//   class e{static ɵfac=…}   becomes   class e{static name="LeakyTimerComponent";static ɵfac=…}
//
// A static field defines `name` on the class as it is created, before any of
// its other static fields run, and with a syntax minified Angular bundles
// already use (`static ɵfac=`). The class's binding stays `e`: no code that
// refers to it changes. The source map is updated to match, so stack traces
// and error reports still map to the right place.
//
// Only what the source map confirms is touched: a `class` whose name (or,
// for an anonymous class, whose `class` keyword) is mapped, at exactly that
// column, to a class declaration in the original source. Text that merely
// looks like a class, in a string or a comment, has no mapping of its own.
// And no class from a source file that declares a static `name` of its own:
// a getter or method would be overridden by the field. (The field makes
// `name` enumerable, where the built-in one isn't: nothing Angular does
// depends on that.)

/** A source map, version 3, as the Angular CLI writes it (one per file, not sectioned). */
export type SourceMap = {
  version: number;
  sources: string[];
  sourcesContent?: Array<string | null>;
  names: string[];
  mappings: string;
  [key: string]: unknown;
};

/** A class given its name back. */
export type RestoredClass = {
  /** Its original name, from the source. */
  name: string;
  /** Its name in the minified code; empty for an anonymous class. */
  minified: string;
  /** The original file it is declared in, as the source map lists it. */
  source: string;
};

export type RestoreResult = { code: string; map: SourceMap; restored: RestoredClass[] };

/**
 * One mapping: generated column, then, if it has a source, source index,
 * original line and original column (all 0-based, absolute), and a name
 * index if it has one.
 */
type Segment = number[];

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Map([...BASE64].map((char, i) => [char, i]));

/** The mappings of each generated line, with absolute values. */
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  // Source, original line, original column and name are relative to the
  // previous segment's across lines; the generated column within a line.
  const state = [0, 0, 0, 0, 0];
  for (const text of mappings.split(";")) {
    const line: Segment[] = [];
    state[0] = 0;
    if (text !== "") {
      for (const encoded of text.split(",")) {
        if (encoded === "") continue;
        const fields = decodeVlq(encoded);
        const segment: Segment = [];
        fields.forEach((delta, i) => {
          state[i]! += delta;
          segment.push(state[i]!);
        });
        line.push(segment);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The inverse of `decodeMappings`. */
export function encodeMappings(lines: readonly Segment[][]): string {
  const state = [0, 0, 0, 0, 0];
  return lines
    .map((line) => {
      state[0] = 0;
      return line
        .map((segment) =>
          segment
            .map((value, i) => {
              const delta = value - state[i]!;
              state[i] = value;
              return encodeVlq(delta);
            })
            .join(""),
        )
        .join(",");
    })
    .join(";");
}

function decodeVlq(text: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of text) {
    const digit = BASE64_VALUES.get(char);
    if (digit === undefined) throw new Error(`Invalid source map mappings: "${char}"`);
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    values.push(value % 2 === 1 ? -(value - 1) / 2 : value / 2);
    value = 0;
    shift = 0;
  }
  return values;
}

function encodeVlq(value: number): string {
  let rest = value < 0 ? -value * 2 + 1 : value * 2;
  let text = "";
  do {
    let digit = rest % 32;
    rest = Math.floor(rest / 32);
    if (rest > 0) digit |= 32;
    text += BASE64[digit];
  } while (rest > 0);
  return text;
}

/**
 * `class`, its name if any, and a superclass given by name (`extends Ud`,
 * `extends t.Base`), up to the brace that opens its body. A class whose
 * superclass is any other expression is left alone: finding its body's brace
 * would take a parser.
 */
const CLASS_HEAD = /(?<![\w$.])class(?:\s+([A-Za-z_$][\w$]*))?(?:\s+extends\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)?\s*\{/g;

/** An identifier at the start of the text, Unicode included (`ɵEmptyOutletComponent`). */
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*/u;

/** What the static field is written as, in ASCII, as minified code is. */
const fieldFor = (name: string) =>
  `static name=${JSON.stringify(name).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)};`;

/** A class member `static name`, `static get name()` or `static name()`. */
const OWN_STATIC_NAME = /\bstatic\s+(?:(?:get|set|async)\s+)?\*?\s*name\s*[(=;]/;

/** The segment at exactly `column`, if any. */
function segmentAt(line: readonly Segment[], column: number): Segment | undefined {
  let low = 0;
  let high = line.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const at = line[mid]![0]!;
    if (at === column) return line[mid];
    if (at < column) low = mid + 1;
    else high = mid - 1;
  }
  return undefined;
}

/**
 * The name of the class the segment points at in the original source: the
 * identifier there, after `class` (a named class's name is mapped, an
 * anonymous one's `class` keyword). `null` if the source isn't a class
 * declaration there, or isn't included in the map.
 */
function originalName(segment: Segment | undefined, named: boolean, map: SourceMap, lines: Map<number, string[]>): string | null {
  if (!segment || segment.length < 4) return null;
  const [, source, line, column] = segment as [number, number, number, number];
  const content = map.sourcesContent?.[source];
  if (typeof content !== "string" || OWN_STATIC_NAME.test(content)) return null;
  let sourceLines = lines.get(source);
  if (!sourceLines) lines.set(source, (sourceLines = content.split(/\r?\n/)));
  const text = sourceLines[line];
  if (text === undefined) return null;
  if (named) {
    if (!/(?:^|[^\w$.])class\s+$/.test(text.slice(0, column))) return null;
    return IDENTIFIER.exec(text.slice(column))?.[0] ?? null;
  }
  const declared = /^class\s+/.exec(text.slice(column));
  return declared ? (IDENTIFIER.exec(text.slice(column + declared[0].length))?.[0] ?? null) : null;
}

/**
 * Give the minified classes of `code` their names back, from `map`, its
 * source map. Returns the new code and source map, and what was restored.
 * Safe to run twice: a class that has its name already is left alone.
 */
export function restoreClassNames(code: string, map: SourceMap): RestoreResult {
  const segments = decodeMappings(map.mappings);
  const codeLines = code.split("\n");
  const sourceLines = new Map<number, string[]>();
  const restored: RestoredClass[] = [];

  const newLines = codeLines.map((text, lineIndex) => {
    const line = segments[lineIndex];
    if (!line || line.length === 0 || !text.includes("class")) return text;
    // Where to insert what, in order.
    const insertions: Array<{ at: number; text: string }> = [];
    for (const match of text.matchAll(CLASS_HEAD)) {
      const minified = match[1] ?? "";
      const start = match.index!;
      const column = minified ? start + match[0].indexOf(minified, "class".length) : start;
      const segment = segmentAt(line, column);
      const name = originalName(segment, minified !== "", map, sourceLines);
      if (!name || name === minified) continue;
      const at = start + match[0].length;
      if (text.startsWith("static name=", at)) continue;
      insertions.push({ at, text: fieldFor(name) });
      restored.push({ name, minified, source: map.sources[segment![1]!] ?? "" });
    }
    if (insertions.length === 0) return text;

    // The mappings after each insertion move right by what was inserted before them.
    let shift = 0;
    let next = 0;
    for (const segment of line) {
      while (next < insertions.length && insertions[next]!.at <= segment[0]!) shift += insertions[next++]!.text.length;
      segment[0]! += shift;
    }
    let result = "";
    let from = 0;
    for (const { at, text: inserted } of insertions) {
      result += text.slice(from, at) + inserted;
      from = at;
    }
    return result + text.slice(from);
  });

  if (restored.length === 0) return { code, map, restored };
  return {
    code: newLines.join("\n"),
    map: { ...map, mappings: encodeMappings(segments) },
    restored,
  };
}
