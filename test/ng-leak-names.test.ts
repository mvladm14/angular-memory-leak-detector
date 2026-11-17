// The ng-leak-names command (src/cli/ng-leak-names.ts) on a build in memory:
// what it does to the files, what it says, and its exit code.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MARKER, ngLeakNames, TEMP_SUFFIX, type Files } from "../src/cli/ng-leak-names";
import { decodeMappings, encodeMappings, type SourceMap } from "../src/cli/restore-names";

/** A minified class, and the map of it back to its source: at its name, and at what follows its `{`. */
const CODE = "var Xt=class e{static ɵfac=()=>new e};";
const INSERTED = 'static name="LeakyTimerComponent";';
const map = (withSources = true): SourceMap => ({
  version: 3,
  sources: ["src/app/leaks.ts"],
  ...(withSources ? { sourcesContent: ["export class LeakyTimerComponent {}"] } : {}),
  names: [],
  mappings: encodeMappings([[[13, 0, 0, 13], [15, 0, 0, 35]]]),
});

const digest = (algorithm: string, text: string, encoding: "hex" | "base64") =>
  createHash(algorithm).update(text, "utf8").digest(encoding);
const sri = (text: string) => `sha384-${digest("sha384", text, "base64")}`;

/**
 * A file system in memory: paths to contents, directories implied by them.
 * `failing` makes an operation on a path throw, as a full disk or a crash would.
 */
function memory(initial: Record<string, string>, failing: { write?: (path: string) => boolean; rename?: (to: string) => boolean } = {}) {
  const contents = new Map(Object.entries(initial));
  const isDirectory = (path: string) => [...contents.keys()].some((file) => file.startsWith(`${path}/`));
  const files: Files = {
    exists: (path) => contents.has(path) || isDirectory(path),
    isDirectory,
    list: (dir) => [...new Set([...contents.keys()].filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1).split("/")[0]!))],
    read: (path) => contents.get(path)!,
    write: (path, text) => {
      if (failing.write?.(path)) throw new Error(`ENOSPC: no space left, writing ${path}`);
      contents.set(path, text);
    },
    rename: (from, to) => {
      if (failing.rename?.(to)) throw new Error(`interrupted while moving ${from}`);
      contents.set(to, contents.get(from)!);
      contents.delete(from);
    },
    remove: (path) => void contents.delete(path),
    join: (...parts) => parts.join("/").replace(/\/\.\//g, "/"),
    dirname: (path) => path.slice(0, path.lastIndexOf("/")),
    relative: (from, to) => to.slice(from.length + 1),
    display: (path) => path,
    digest: (algorithm, text, encoding) => digest(algorithm, text, encoding),
  };
  return { files, contents };
}

/** What the build's script becomes. */
const RESTORED = 'var Xt=class e{static name="LeakyTimerComponent";static ɵfac=()=>new e};';

function run(args: string[], files: Files, check?: (code: string) => void) {
  const said = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  const out = { log: (m: string) => said.log.push(m), warn: (m: string) => said.warn.push(m), error: (m: string) => said.error.push(m) };
  const code = ngLeakNames(args, files, out, check ?? null);
  return { code, ...said };
}

describe("ng-leak-names", () => {
  it("restores the class names of every script with a source map, and updates the maps", () => {
    const { files, contents } = memory({
      "dist/browser/main.js": CODE,
      "dist/browser/main.js.map": JSON.stringify(map()),
      "dist/browser/chunks/lazy.js": CODE,
      "dist/browser/chunks/lazy.js.map": JSON.stringify(map()),
      "dist/browser/index.html": "<app-root></app-root>",
    });
    const result = run(["dist"], files);
    expect(result.code).toBe(0);
    for (const script of ["dist/browser/main.js", "dist/browser/chunks/lazy.js"]) {
      expect(contents.get(script)).toBe('var Xt=class e{static name="LeakyTimerComponent";static ɵfac=()=>new e};');
      // The mapping after the class's `{` moved by what was inserted there.
      const columns = decodeMappings(JSON.parse(contents.get(`${script}.map`)!).mappings)[0]!.map((segment) => segment[0]);
      expect(columns).toEqual([13, 15 + INSERTED.length]);
    }
    expect(result.log.at(-1)).toBe("ng-leak-names: restored 2 class name(s) in dist.");
    expect(result.warn).toEqual([]);
  });

  it("finds a map by the sourceMappingURL of its script", () => {
    const code = `${CODE}\n//# sourceMappingURL=maps/main.map`;
    const { files, contents } = memory({ "dist/main.js": code, "dist/maps/main.map": JSON.stringify(map()) });
    expect(run(["dist", "--quiet"], files).code).toBe(0);
    expect(contents.get("dist/main.js")).toContain('static name="LeakyTimerComponent"');
  });

  it("warns and exits with 0 on a build without source maps, leaving it as it is", () => {
    const { files, contents } = memory({ "dist/main.js": CODE });
    const result = run(["dist"], files);
    expect(result.code).toBe(0);
    expect(contents.get("dist/main.js")).toBe(CODE);
    expect(result.warn).toEqual([
      expect.stringContaining("ng-leak-names: warning: no source maps next to the 1 script(s) in dist, so no class names to restore"),
    ]);
    expect(result.error).toEqual([]);
  });

  it("warns of source maps without the sources, and leaves their scripts as they are", () => {
    const { files, contents } = memory({
      "dist/main.js": CODE,
      "dist/main.js.map": JSON.stringify(map()),
      "dist/vendor.js": CODE,
      "dist/vendor.js.map": JSON.stringify(map(false)),
    });
    const result = run(["dist", "--quiet"], files);
    expect(result.code).toBe(0);
    expect(contents.get("dist/vendor.js")).toBe(CODE);
    expect(contents.get("dist/main.js")).toContain('static name="LeakyTimerComponent"');
    expect(result.warn).toEqual([
      "ng-leak-names: warning: 1 source map(s) without the sources (sourcesContent) class names are read from, so their scripts' classes keep minified names: dist/vendor.js.map.",
    ]);
    expect(result.log).toEqual(["ng-leak-names: restored 1 class name(s) in dist."]);
  });

  it("leaves a script whose new code doesn't parse as it was, and exits with 1", () => {
    const { files, contents } = memory({ "dist/main.js": CODE, "dist/main.js.map": JSON.stringify(map()) });
    const result = run(["dist"], files, () => {
      throw new Error("Unexpected token");
    });
    expect(result.code).toBe(1);
    expect(contents.get("dist/main.js")).toBe(CODE);
    expect(result.error).toEqual(["ng-leak-names: left dist/main.js as it was: Unexpected token"]);
  });

  it("exits with 1 on a usage error", () => {
    const { files } = memory({ "dist/main.js": CODE });
    expect(run([], files)).toMatchObject({ code: 1, error: [expect.stringContaining("Usage: ng-leak-names")] });
    expect(run(["nowhere"], files)).toMatchObject({ code: 1, error: ["ng-leak-names: nowhere is not a directory."] });
    expect(run(["--help"], files)).toMatchObject({ code: 0, log: [expect.stringContaining("Usage: ng-leak-names")] });
  });
});

describe("ng-leak-names and the hashes a build pins", () => {
  it("updates the Subresource Integrity hashes of the scripts it changes", () => {
    const html = (code: string) =>
      `<link rel="modulepreload" href="chunk.js" integrity="${sri("export{}")}"><script src="main.js" type="module" crossorigin="anonymous" integrity="${sri(code)}"></script>`;
    const { files, contents } = memory({
      "dist/index.html": html(CODE),
      "dist/main.js": CODE,
      "dist/main.js.map": JSON.stringify(map()),
      "dist/chunk.js": "export{}",
    });
    const result = run(["dist", "--quiet"], files);
    expect(result.code).toBe(0);
    expect(contents.get("dist/main.js")).toBe(RESTORED);
    // The new script's hash; the unchanged chunk's as it was.
    expect(contents.get("dist/index.html")).toBe(html(RESTORED));
    expect(result.log).toEqual(["ng-leak-names: restored 1 class name(s) in dist, and updated the hashes in dist/index.html."]);
  });

  it("updates the service worker's hashes of what it changes, index.html's included", () => {
    const html = (code: string) => `<script src="main.js" integrity="${sri(code)}"></script>`;
    const manifest = (code: string) =>
      JSON.stringify({
        configVersion: 1,
        hashTable: {
          "/app/index.html": digest("sha1", html(code), "hex"),
          "/app/main.js": digest("sha1", code, "hex"),
          "/app/styles.css": digest("sha1", "p{}", "hex"),
        },
      }, null, 2);
    const { files, contents } = memory({
      "dist/index.html": html(CODE),
      "dist/main.js": CODE,
      "dist/main.js.map": JSON.stringify(map()),
      "dist/styles.css": "p{}",
      "dist/ngsw.json": manifest(CODE),
    });
    expect(run(["dist", "--quiet"], files).code).toBe(0);
    expect(contents.get("dist/ngsw.json")).toBe(manifest(RESTORED));
  });

  it("leaves the build as it is when something else holds a hash of a script it would change", () => {
    // Webpack's runtime checks lazy chunks against hashes of its own (Angular
    // 16 with Subresource Integrity); a server bundle can embed index.html.
    const build = {
      "dist/main.js": CODE,
      "dist/main.js.map": JSON.stringify(map()),
      "dist/runtime.js": `var sriHashes={592:"${sri(CODE)}"};`,
    };
    const { files, contents } = memory(build);
    const result = run(["dist"], files);
    expect(result.code).toBe(0);
    expect(Object.fromEntries(contents)).toEqual(build);
    expect(result.warn).toEqual([
      expect.stringContaining("ng-leak-names: warning: left dist as it was: dist/runtime.js holds a hash of dist/main.js, which restoring class names would change"),
    ]);
  });

  it("leaves the build as it is when a server bundle embeds index.html and its hashes", () => {
    const html = `<script src="main.js" integrity="${sri(CODE)}"></script>`;
    const build = {
      "dist/browser/index.html": html,
      "dist/browser/main.js": CODE,
      "dist/browser/main.js.map": JSON.stringify(map()),
      "dist/server/index.server.html": html,
    };
    const { files, contents } = memory(build);
    expect(run(["dist"], files).code).toBe(0);
    expect(Object.fromEntries(contents)).toEqual(build);
  });
});

describe("ng-leak-names, when writing fails", () => {
  const build = () => ({
    "dist/main.js": CODE,
    "dist/main.js.map": JSON.stringify(map()),
    "dist/lazy.js": CODE,
    "dist/lazy.js.map": JSON.stringify(map()),
  });

  it("leaves the build as it was if it can't write a file, and exits with 1", () => {
    const { files, contents } = memory(build(), { write: (path) => path === `dist/lazy.js${TEMP_SUFFIX}` });
    const result = run(["dist"], files);
    expect(result.code).toBe(1);
    expect(Object.fromEntries(contents)).toEqual(build());
    expect(result.error).toEqual([expect.stringContaining("ng-leak-names: couldn't write the build: ENOSPC")]);
  });

  it("refuses a build a run was interrupted in while replacing its files", () => {
    const first = memory(build(), { rename: (to) => to === "dist/lazy.js" });
    expect(run(["dist"], first.files).code).toBe(1);
    // Half replaced: main.js is new, lazy.js isn't.
    expect(first.contents.get("dist/main.js")).toBe(RESTORED);
    expect(first.contents.get("dist/lazy.js")).toBe(CODE);
    expect(first.contents.has(`dist/${MARKER}`)).toBe(true);

    const again = memory(Object.fromEntries(first.contents));
    const result = run(["dist"], again.files);
    expect(result.code).toBe(1);
    expect(result.error).toEqual([expect.stringContaining("a previous run on dist was interrupted while replacing its files")]);
    expect(Object.fromEntries(again.contents)).toEqual(Object.fromEntries(first.contents));
  });

  it("removes what a run interrupted before replacing anything wrote, and goes on", () => {
    const { files, contents } = memory({
      ...build(),
      [`dist/main.js${TEMP_SUFFIX}`]: "half written",
      // Of a file this run has nothing to change in.
      "dist/polyfills.js": "x",
      [`dist/polyfills.js${TEMP_SUFFIX}`]: "half written",
    });
    expect(run(["dist", "--quiet"], files).code).toBe(0);
    expect([...contents.keys()].filter((file) => file.endsWith(TEMP_SUFFIX))).toEqual([]);
    expect(contents.get("dist/main.js")).toBe(RESTORED);
  });
});

