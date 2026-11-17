#!/usr/bin/env node
// ng-leak-names: give the classes of a production build their names back,
// from its source maps. See src/cli/ng-leak-names.ts.
//
//   ng build && npx ng-leak-names dist/my-app
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ngLeakNames } from "../dist/cli/ng-leak-names.js";

/** Node's file system and paths, as the command needs them. */
const files = {
  exists: (file) => existsSync(file),
  isDirectory: (file) => statSync(file).isDirectory(),
  list: (dir) => readdirSync(dir),
  read: (file) => readFileSync(file, "utf8"),
  write: (file, text) => writeFileSync(file, text),
  // Atomic on the same file system, as the new file is next to the old one.
  rename: (from, to) => renameSync(from, to),
  remove: (file) => rmSync(file, { force: true }),
  join: (...parts) => path.join(...parts),
  dirname: (file) => path.dirname(file),
  relative: (from, to) => path.relative(from, to).split(path.sep).join("/"),
  display: (file) => path.relative(process.cwd(), file) || file,
  digest: (algorithm, text, encoding) => createHash(algorithm).update(text, "utf8").digest(encoding),
};

/**
 * A check that the new code still parses, with the esbuild the app builds
 * with (the Angular CLI's), if it can be found. The change is small and
 * confirmed by the source map; this is a second safety net.
 */
function syntaxChecker() {
  try {
    const esbuild = createRequire(path.join(process.cwd(), "package.json"))("esbuild");
    return (code) => {
      esbuild.transformSync(code, { loader: "js" });
    };
  } catch {
    return null;
  }
}

process.exitCode = ngLeakNames(process.argv.slice(2), files, console, syntaxChecker());
