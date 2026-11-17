// The `ng-leak-names` command (bin/ng-leak-names.mjs): gives the classes of a
// production build their names back, from its source maps, so that the
// detector's warnings and heap snapshots show `LeakyTimerComponent`, not `e`.
// Run on the output of `ng build`, before anything else uses it (uploading
// source maps, compressing, deploying):
//
//   ng build && npx ng-leak-names dist/my-app
//
// An extra layer, for builds that make source maps for their scripts anyway:
// without it, the detector names classes by their selectors. Hidden maps are
// enough (`"sourceMap": { "scripts": true, "hidden": true }`): no URL to them
// is in the code, so they needn't be deployed. They are updated along with
// the code, and must include the sources (`sourcesContent`, which the Angular
// CLI writes), where the class names are read from.
//
// Changing a script changes its hash, and a build can pin those:
//
// - Subresource Integrity: the `integrity` attributes of index.html. Updated.
// - The service worker's manifest, ngsw.json, which lists a SHA-1 of every
//   file it caches. Updated.
// - Anything else that holds a hash of a file this would change, such as the
//   hashes of lazy chunks webpack's runtime checks them against (Angular 16
//   with Subresource Integrity), or the server bundle of a server-rendered app,
//   which embeds index.html. Then the build is left as it is: changing it
//   would break it.
//
// Nothing is written until everything is known: new files are written next
// to the old ones, then moved over them, one by one. A run interrupted while
// moving them leaves a marker, and a later run refuses to touch a build that
// may be half changed.
//
// A build left as it is (no source maps, maps without their sources, hashes
// that can't be updated) gets a warning and exit code 0: the detector still
// works, on selector names. Exit code 1 means a usage error, a file that
// couldn't be processed, or a build an interrupted run may have half changed.
//
// The file system and console are passed in (the command gives Node's), so
// that this runs in unit tests too. See restore-names.ts for what changes in
// the code.

import { restoreClassNames, type SourceMap } from "./restore-names.js";

export type HashAlgorithm = "sha1" | "sha256" | "sha384" | "sha512";

/** What the command needs of the file system, paths included. */
export type Files = {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  /** The names in a directory. */
  list(dir: string): string[];
  read(path: string): string;
  write(path: string, text: string): void;
  /** Move a file over another, atomically. */
  rename(from: string, to: string): void;
  remove(path: string): void;
  join(...parts: string[]): string;
  dirname(path: string): string;
  /** `to` relative to `from`, with `/` between its parts. */
  relative(from: string, to: string): string;
  /** The path as shown to the user. */
  display(path: string): string;
  /** The hash of the text's UTF-8 bytes. */
  digest(algorithm: HashAlgorithm, text: string, encoding: "hex" | "base64"): string;
};

export type Output = {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export const USAGE = `Usage: ng-leak-names <build directory>... [--quiet]

Gives the classes of a minified build their names back, from its source maps,
for angular-memory-leak-detector's warnings and for heap snapshots. Builds
without source maps are left as they are: the detector names their classes
by their selectors.`;

/** Left in a build directory while files are moved into place: its presence means a run was interrupted. */
export const MARKER = ".ng-leak-names-incomplete";
/** Appended to a file's path for its new content, until it is moved into place. */
export const TEMP_SUFFIX = ".ng-leak-names-tmp";

/** Files a hash of another file can be in. */
const TEXT_FILE = /\.(?:m?js|cjs|html?|json|txt|css|webmanifest|xml|svg)$/i;

/**
 * Run the command with its arguments. `check` throws if code doesn't parse
 * (the command uses the app's esbuild, if it finds it). Returns the exit code.
 */
export function ngLeakNames(
  args: readonly string[],
  files: Files,
  out: Output,
  check: ((code: string) => void) | null = null,
): number {
  const quiet = args.includes("--quiet");
  const dirs = args.filter((arg) => !arg.startsWith("--"));
  if (args.includes("--help")) {
    out.log(USAGE);
    return 0;
  }
  if (dirs.length === 0) {
    out.error(USAGE);
    return 1;
  }
  for (const dir of dirs) {
    if (!files.exists(dir) || !files.isDirectory(dir)) {
      out.error(`ng-leak-names: ${dir} is not a directory.`);
      return 1;
    }
    if (files.exists(files.join(dir, MARKER))) {
      out.error(
        `ng-leak-names: a previous run on ${dir} was interrupted while replacing its files, so the build may be half changed. Build it again, then run ng-leak-names on the new build.`,
      );
      return 1;
    }
  }
  const where = dirs.join(", ");
  const all = dirs.flatMap((dir) => filesIn(dir, files));
  // New files of a run interrupted before it replaced any: the build is as it was.
  for (const file of all.filter((f) => f.endsWith(TEMP_SUFFIX))) files.remove(file);
  const buildFiles = all.filter((f) => !f.endsWith(TEMP_SUFFIX));

  // 1. The new scripts and source maps, in memory.
  /** Path to new content. */
  const changes = new Map<string, string>();
  const scripts = buildFiles.filter((file) => /\.m?js$/.test(file));
  let withMaps = 0;
  let classes = 0;
  let failed = 0;
  const withoutSources: string[] = [];
  const restoredIn: string[] = [];
  for (const file of scripts) {
    const code = files.read(file);
    const mapFile = mapOf(file, code, files);
    if (!mapFile) continue;
    withMaps++;
    try {
      const map = JSON.parse(files.read(mapFile)) as SourceMap;
      if (!map.sourcesContent?.some((content) => typeof content === "string")) {
        withoutSources.push(files.display(mapFile));
        continue;
      }
      const result = restoreClassNames(code, map);
      if (result.restored.length === 0) continue;
      check?.(result.code);
      changes.set(file, result.code);
      changes.set(mapFile, JSON.stringify(result.map));
      classes += result.restored.length;
      restoredIn.push(`${files.display(file)}: ${result.restored.length} class name(s) restored`);
    } catch (error) {
      failed++;
      out.error(`ng-leak-names: left ${files.display(file)} as it was: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (withMaps === 0) {
    out.warn(
      `ng-leak-names: warning: no source maps next to the ${scripts.length} script(s) in ${where}, so no class names to restore: the detector names classes by their selectors. To restore them, build with source maps for scripts, e.g. "sourceMap": { "scripts": true, "hidden": true } in angular.json.`,
    );
    return 0;
  }
  if (withoutSources.length > 0) {
    out.warn(
      `ng-leak-names: warning: ${withoutSources.length} source map(s) without the sources (sourcesContent) class names are read from, so their scripts' classes keep minified names: ${withoutSources.join(", ")}.`,
    );
  }
  if (changes.size === 0) {
    out.log(`ng-leak-names: restored 0 class name(s) in ${where}.`);
    return failed ? 1 : 0;
  }

  // 2. The hashes of what changed that the build pins, where they can be updated.
  const read = (file: string) => changes.get(file) ?? files.read(file);
  for (const html of buildFiles.filter((file) => /\.html?$/i.test(file))) {
    const updated = updateIntegrity(read(html), html, changes, files);
    if (updated !== null) changes.set(html, updated);
  }
  for (const manifest of buildFiles.filter((file) => file.endsWith("ngsw.json"))) {
    const updated = updateServiceWorkerHashes(read(manifest), manifest, changes, files);
    if (updated !== null) changes.set(manifest, updated);
  }

  // 3. Anything else that still holds a hash of what a changed file was
  // would break once it changes: then leave the build as it is.
  const pinned = pinnedElsewhere(buildFiles, changes, read, files);
  if (pinned) {
    out.warn(
      `ng-leak-names: warning: left ${where} as it was: ${files.display(pinned.by)} holds a hash of ${files.display(pinned.of)}, which restoring class names would change, and ng-leak-names can't update it (e.g. webpack's hashes of lazy chunks with Subresource Integrity, or a server bundle that embeds index.html). The detector names classes by their selectors.`,
    );
    return failed ? 1 : 0;
  }

  // 4. Write it all, then move it into place.
  try {
    commit(dirs, changes, files);
  } catch (error) {
    out.error(`ng-leak-names: couldn't write the build: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!quiet) restoredIn.forEach((line) => out.log(line));
  const updated = [...changes.keys()].filter((file) => /\.html?$|ngsw\.json$/i.test(file)).map(files.display);
  out.log(
    `ng-leak-names: restored ${classes} class name(s) in ${where}${updated.length ? `, and updated the hashes in ${updated.join(", ")}` : ""}${failed ? `; ${failed} file(s) left as they were` : ""}.`,
  );
  return failed ? 1 : 0;
}

/**
 * Write every change next to its file, then move each over its file, with a
 * marker in each directory while they are being moved. A failure while
 * writing leaves the build as it was.
 */
function commit(dirs: readonly string[], changes: ReadonlyMap<string, string>, files: Files): void {
  const written: string[] = [];
  try {
    for (const [file, content] of changes) {
      files.write(file + TEMP_SUFFIX, content);
      written.push(file + TEMP_SUFFIX);
    }
  } catch (error) {
    for (const temp of written) {
      try {
        files.remove(temp);
      } catch {
        // Left for the next run to remove.
      }
    }
    throw error;
  }
  const markers = dirs.map((dir) => files.join(dir, MARKER));
  for (const marker of markers) files.write(marker, [...changes.keys()].join("\n"));
  for (const file of changes.keys()) files.rename(file + TEMP_SUFFIX, file);
  for (const marker of markers) files.remove(marker);
}

/** Every file under `dir`. */
function filesIn(dir: string, files: Files): string[] {
  return files.list(dir).flatMap((name) => {
    const file = files.join(dir, name);
    if (files.isDirectory(file)) return filesIn(file, files);
    return name === MARKER ? [] : [file];
  });
}

/** The script's source map: the file its `sourceMappingURL` names, or else `<script>.map`. */
function mapOf(file: string, code: string, files: Files): string | null {
  const url = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(code)?.[1];
  const candidates = [url && !url.startsWith("data:") ? files.join(files.dirname(file), url) : null, `${file}.map`];
  return candidates.find((candidate): candidate is string => !!candidate && files.exists(candidate)) ?? null;
}

/** The file a URL in an HTML file points to, if it is one of the build's: relative, or from the root. */
function fileAt(url: string, html: string, files: Files): string | null {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) return null;
  const path = url.replace(/[?#].*$/, "").replace(/^\/+/, "");
  return path ? files.join(files.dirname(html), decodeURI(path)) : null;
}

/**
 * The HTML with the `integrity` attribute of each `<script>` or `<link>` of a
 * changed file recomputed, with the same algorithms; `null` if none.
 */
function updateIntegrity(html: string, path: string, changes: ReadonlyMap<string, string>, files: Files): string | null {
  let changed = false;
  const updated = html.replace(/<(?:script|link)\b[^>]*>/gi, (tag) => {
    const url = /\s(?:src|href)\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    const file = url === undefined ? null : fileAt(url, path, files);
    const content = file === null ? undefined : changes.get(file);
    if (content === undefined) return tag;
    return tag.replace(/(\sintegrity\s*=\s*)(["'])(.*?)\2/i, (_, attr: string, quote: string, value: string) => {
      const hashes = value
        .split(/\s+/)
        .filter(Boolean)
        .map((hash) => {
          const algorithm = /^(sha256|sha384|sha512)-/.exec(hash)?.[1] as HashAlgorithm | undefined;
          return algorithm ? `${algorithm}-${files.digest(algorithm, content, "base64")}` : hash;
        })
        .join(" ");
      changed ||= hashes !== value;
      return `${attr}${quote}${hashes}${quote}`;
    });
  });
  return changed ? updated : null;
}

/**
 * The service worker's manifest with the SHA-1 of each changed file in its
 * `hashTable` recomputed; `null` if none. Its keys are URLs from the app's
 * base href: `/main-X.js`, `/app/main-X.js`.
 */
function updateServiceWorkerHashes(json: string, path: string, changes: ReadonlyMap<string, string>, files: Files): string | null {
  let manifest: { hashTable?: Record<string, string> };
  try {
    manifest = JSON.parse(json) as typeof manifest;
  } catch {
    return null;
  }
  const table = manifest.hashTable;
  if (!table || typeof table !== "object") return null;
  const root = files.dirname(path);
  let changed = false;
  for (const [file, content] of changes) {
    if (file.endsWith(".map")) continue;
    const url = `/${files.relative(root, file)}`;
    for (const key of Object.keys(table)) {
      if (key === url || key.endsWith(url)) {
        table[key] = files.digest("sha1", content, "hex");
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(manifest, null, 2) : null;
}

/**
 * A file that holds a hash of what a changed file was (in any form a build
 * writes one: SHA-1 or SHA-256 in hex, SHA-256, 384 or 512 in base64), once
 * the hashes above are updated; `null` if none does.
 */
function pinnedElsewhere(
  buildFiles: readonly string[],
  changes: ReadonlyMap<string, string>,
  read: (file: string) => string,
  files: Files,
): { by: string; of: string } | null {
  const pins: Array<{ hash: string; of: string }> = [];
  for (const file of changes.keys()) {
    if (file.endsWith(".map")) continue;
    const before = files.read(file);
    pins.push(
      { hash: files.digest("sha1", before, "hex"), of: file },
      { hash: files.digest("sha256", before, "hex"), of: file },
      ...(["sha256", "sha384", "sha512"] as const).map((algorithm) => ({
        hash: files.digest(algorithm, before, "base64"),
        of: file,
      })),
    );
  }
  for (const file of buildFiles) {
    if (!TEXT_FILE.test(file)) continue;
    const text = read(file);
    const pin = pins.find(({ hash }) => text.includes(hash));
    if (pin) return { by: file, of: pin.of };
  }
  return null;
}
