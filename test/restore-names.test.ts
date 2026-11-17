// ng-leak-names (src/cli/restore-names.ts): gives the classes of a minified
// build their names back from its source map, as a static `name` field, and
// keeps the source map in step.
import { describe, expect, it } from "vitest";
import { decodeMappings, encodeMappings, restoreClassNames, type SourceMap } from "../src/cli/restore-names";

/** The original source of the tests' minified code. */
const SOURCE = [
  "export class LeakyTimerComponent {", // line 0: the name at column 13
  "  static ɵfac = () => new LeakyTimerComponent();",
  "}",
  "class CartStore extends Base {}", // line 3: the name at column 6
  "const label = 'class Fake {';", // line 4: a string that looks like a class
  "class ɵEmptyOutletComponent {}", // line 5: a name that isn't ASCII
].join("\n");

/** A map of the generated `code` from `SOURCE`: `[generated column, original line, original column]` per line. */
function mapOf(lines: Array<Array<[number, number, number]>>): SourceMap {
  return {
    version: 3,
    sources: ["src/app/leaks.ts"],
    sourcesContent: [SOURCE],
    names: [],
    mappings: encodeMappings(lines.map((line) => line.map(([col, origLine, origCol]) => [col, 0, origLine, origCol]))),
  };
}

/** The generated character each mapping of line `line` points at, with its original position. */
function mapped(code: string, map: SourceMap, line = 0) {
  const text = code.split("\n")[line]!;
  return decodeMappings(map.mappings)[line]!.map(([col, , origLine, origCol]) => [text[col!], origLine, origCol]);
}

describe("source map mappings", () => {
  it("decode what they encode", () => {
    const lines = [
      [[0, 0, 0, 0], [5, 0, 0, 13, 0], [130, 1, 40, 2]],
      [],
      [[3, 0, 2, 0, 1], [70000, 0, 1, 1]],
    ];
    expect(decodeMappings(encodeMappings(lines))).toEqual(lines);
  });

  it("decode Base64 VLQ with negative and large values", () => {
    // "AAAA": all zero; "gBAAC": 16, then back by one column, and so on.
    expect(decodeMappings("AAAA,gBAAC;;AACD")).toEqual([[[0, 0, 0, 0], [16, 0, 0, 1]], [], [[0, 0, 1, 0]]]);
    expect(decodeMappings(encodeMappings([[[123456789, 0, 0, 0]]]))).toEqual([[[123456789, 0, 0, 0]]]);
  });
});

describe("restoreClassNames", () => {
  it("gives a minified class its name back, as a static field", () => {
    const code = "var Xt=class e{static ɵfac=()=>new e};";
    const { code: restored, restored: classes } = restoreClassNames(code, mapOf([[[7, 0, 7], [13, 0, 13]]]));
    expect(restored).toBe('var Xt=class e{static name="LeakyTimerComponent";static ɵfac=()=>new e};');
    expect(classes).toEqual([{ name: "LeakyTimerComponent", minified: "e", source: "src/app/leaks.ts" }]);
  });

  it("leaves a class that works as before, under its name", () => {
    const code = "globalThis.__restored=class e{static self=e;static ɵfac=function(){return new e}};";
    const { code: restored } = restoreClassNames(code, mapOf([[[22, 0, 7], [28, 0, 13]]]));
    new Function(restored)();
    const cls = (globalThis as any).__restored;
    delete (globalThis as any).__restored;
    expect(cls.name).toBe("LeakyTimerComponent");
    expect(cls.self).toBe(cls);
    expect(cls.ɵfac()).toBeInstanceOf(cls);
  });

  it("names a class that extends another, and an anonymous class by the class it was declared as", () => {
    const code = "class t extends n.Base{}var s=class{};";
    // `t` maps to CartStore's name; the anonymous class's `class` keyword to `class CartStore`.
    const map = mapOf([[[6, 3, 6], [30, 3, 0]]]);
    expect(restoreClassNames(code, map).code).toBe(
      'class t extends n.Base{static name="CartStore";}var s=class{static name="CartStore";};',
    );
  });

  it("writes names that aren't ASCII escaped, as minified code is", () => {
    const code = "class e{}";
    expect(restoreClassNames(code, mapOf([[[6, 5, 6]]])).code).toBe('class e{static name="\\u0275EmptyOutletComponent";}');
  });

  it("moves the mappings after each insertion, and only those", () => {
    const code = "var a=class e{x(){}};var b=class t{y(){}};";
    // At `var`, `e`, `x`, the second `class`, `t` and `y`.
    const map = mapOf([[[0, 1, 2], [12, 0, 13], [14, 1, 9], [27, 3, 0], [33, 3, 6], [35, 1, 20]]]);
    const result = restoreClassNames(code, map);
    expect(result.code).toBe('var a=class e{static name="LeakyTimerComponent";x(){}};var b=class t{static name="CartStore";y(){}};');
    // Every mapping still points at the same code, and the same original.
    expect(mapped(result.code, result.map)).toEqual(mapped(code, map));
  });

  it("moves no mapping of another line", () => {
    const code = "x();\nvar a=class e{y(){}};";
    const map = mapOf([[[0, 1, 2]], [[12, 0, 13], [14, 1, 9]]]);
    const result = restoreClassNames(code, map);
    expect(result.code.split("\n")[0]).toBe("x();");
    expect(mapped(result.code, result.map, 0)).toEqual(mapped(code, map, 0));
    expect(mapped(result.code, result.map, 1)).toEqual(mapped(code, map, 1));
  });

  it("leaves what only looks like a class alone", () => {
    // In a string: its mapping is at the quote, not at the name.
    const inString = "var s='class e{';";
    expect(restoreClassNames(inString, mapOf([[[6, 4, 14]]])).restored).toEqual([]);
    // Mapped to something in the source that isn't a class declaration.
    const notAClass = "class e{}";
    expect(restoreClassNames(notAClass, mapOf([[[6, 1, 2]]])).restored).toEqual([]);
    // Not mapped at all.
    expect(restoreClassNames("class e{}", mapOf([[]])).restored).toEqual([]);
  });

  it("goes only by a mapping at the class's name itself, not one before it", () => {
    // `var` is mapped, to a class's name even; `e` isn't mapped.
    const code = "var Xt=class e{}";
    expect(restoreClassNames(code, mapOf([[[0, 0, 13]]])).restored).toEqual([]);
  });

  it("leaves a class whose superclass is an expression alone", () => {
    const code = "class e extends (0,n.mixin)(t){}";
    expect(restoreClassNames(code, mapOf([[[6, 0, 13]]])).code).toBe(code);
  });

  it("leaves a class that kept its name alone", () => {
    const code = "class LeakyTimerComponent{}";
    expect(restoreClassNames(code, mapOf([[[6, 0, 13]]])).restored).toEqual([]);
  });

  it("changes nothing the second time", () => {
    const code = "var Xt=class e{static ɵfac=()=>new e};";
    const map = mapOf([[[7, 0, 7], [13, 0, 13]]]);
    const once = restoreClassNames(code, map);
    const twice = restoreClassNames(once.code, once.map);
    expect(twice.restored).toEqual([]);
    expect(twice.code).toBe(once.code);
  });

  it("leaves the classes of a source that gives a class a static `name` of its own alone", () => {
    const code = "class e{}";
    for (const own of ["static get name() { return 'x'; }", "static name = 'x';", "static name() {}"]) {
      const map = mapOf([[[6, 0, 13]]]);
      map.sourcesContent = [SOURCE.replace("  static ɵfac", `  ${own}\n  static ɵfac`)];
      expect(restoreClassNames(code, map).code, own).toBe(code);
    }
  });

  it("needs the original source in the map", () => {
    const code = "class e{}";
    const { sourcesContent: _, ...withoutSources } = mapOf([[[6, 0, 13]]]);
    expect(restoreClassNames(code, withoutSources).code).toBe(code);
  });
});
