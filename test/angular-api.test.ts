// What the detector imports from Angular. Only public API: a private one (`ɵ`)
// that a later Angular renamed or removed would break the build of every app
// that uses the detector, even where it only runs in development, since a
// bundler rejects an import that doesn't exist. What the detector needs of
// Angular's internals it reads from objects at runtime instead, where a
// change makes it find nothing rather than break the build.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sources(file);
    return name.endsWith(".ts") ? [file] : [];
  });
}

/** Each name imported from an `@angular/…` package, with the file that imports it. */
function angularImports(): Array<{ file: string; name: string }> {
  return sources(SRC).flatMap((file) => {
    const code = readFileSync(file, "utf8");
    return [...code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@angular\/[^"']+["']/g)].flatMap((match) =>
      match[1]!
        .split(",")
        .map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!)
        .filter(Boolean)
        .map((name) => ({ file: path.relative(SRC, file), name })),
    );
  });
}

describe("what the detector imports from Angular", () => {
  it("is public API only", () => {
    const imports = angularImports();
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter(({ name }) => name.startsWith("ɵ"))).toEqual([]);
  });

  it("imports nothing from Angular by namespace, where a private name could hide", () => {
    const namespaces = sources(SRC).filter((file) => /import\s+\*\s+as\s+\w+\s+from\s+["']@angular\//.test(readFileSync(file, "utf8")));
    expect(namespaces).toEqual([]);
  });
});
