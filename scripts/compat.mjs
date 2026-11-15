// The compat workspaces: compat/ngNN, one per Angular major older than the
// demo's. Each is a complete Angular workspace (package.json, lockfile,
// angular.json and tsconfig.json as `ng new` made them for that major) except
// for its sources: those are copied from compat/app, so that every major runs
// the very same app.
//
// Each workspace also pins the exact Node version its toolchain is known to
// work on (.nvmrc). Those toolchains are frozen, so the Node that builds them
// changes only on purpose, not with the demo's Node or with a new release.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEMO = path.join(ROOT, "demo");
const COMPAT = path.join(ROOT, "compat");
const APP = path.join(COMPAT, "app");

/** The Angular majors that have a compat workspace, oldest first. */
export function compatMajors() {
  return readdirSync(COMPAT)
    .map((name) => /^ng(\d+)$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
}

/** The Angular major the demo app is on, from its package.json. */
export function demoMajor() {
  const pkg = JSON.parse(readFileSync(path.join(DEMO, "package.json"), "utf8"));
  return Number(/\d+/.exec(pkg.dependencies["@angular/core"])[0]);
}

/** The app directory for an Angular major: the demo, or a compat workspace. */
export function appDir(major) {
  if (major === demoMajor()) return DEMO;
  const dir = path.join(COMPAT, `ng${major}`);
  if (!existsSync(dir)) {
    const known = [...compatMajors(), demoMajor()].join(", ");
    throw new Error(`No app for Angular ${major}. Available: ${known}.`);
  }
  return dir;
}

/**
 * Make `<workspace>/src` an exact copy of compat/app. Only files whose content
 * changed are written, so a dev server already running there rebuilds only
 * when the app really changed.
 */
export function syncCompatApp(major) {
  mirror(APP, path.join(appDir(major), "src"));
}

function mirror(from, to) {
  mkdirSync(to, { recursive: true });
  const wanted = new Set(readdirSync(from));
  for (const name of readdirSync(to)) {
    if (!wanted.has(name)) rmSync(path.join(to, name), { recursive: true, force: true });
  }
  for (const name of wanted) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (statSync(src).isDirectory()) {
      if (existsSync(dest) && !statSync(dest).isDirectory()) rmSync(dest, { force: true });
      mirror(src, dest);
      continue;
    }
    if (existsSync(dest) && statSync(dest).isDirectory()) rmSync(dest, { recursive: true, force: true });
    const content = readFileSync(src);
    if (!existsSync(dest) || !readFileSync(dest).equals(content)) writeFileSync(dest, content);
  }
}

/**
 * Warn when the running Node isn't the one `dir` pins in its `.nvmrc` (CI
 * uses that one). A warning only: a close version usually works.
 */
export function warnOnNodeMismatch(dir) {
  const file = path.join(dir, ".nvmrc");
  if (!existsSync(file)) return;
  const wanted = readFileSync(file, "utf8").trim().replace(/^v/, "");
  const running = process.versions.node;
  if (nodeMatches(wanted, running)) return;
  const rel = path.relative(ROOT, dir);
  console.warn(
    `Warning: ${rel} pins Node ${wanted} (${rel}/.nvmrc), and this is Node ${running}: ` +
      `results may differ from CI's. Run \`nvm install && nvm use\` in ${rel} to match.`,
  );
}

/** `24` matches any 24.x.y, `24.21` any 24.21.y, `24.21.0` only itself. */
export function nodeMatches(wanted, running) {
  const have = running.split(".");
  return wanted.split(".").every((part, i) => part === have[i]);
}
