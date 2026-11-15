// Builds and packs the detector, then installs the TARBALL into the apps the
// end-to-end suite runs against — the way users get it, and the only way each
// app gets a single copy of @angular/core (a `file:..` link would resolve the
// root's own copy).
//
//   node scripts/install-demo.mjs              demo/ (npm run demo:install)
//   node scripts/install-demo.mjs --compat     every compat/ngNN workspace
//   node scripts/install-demo.mjs 16 18        compat/ng16 and compat/ng18
//
// `--tarball <file>` installs a tarball packed beforehand instead of building
// one: CI packs the detector once and tests that same tarball everywhere.
import { execSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { appDir, compatMajors, DEMO, ROOT, syncCompatApp, warnOnNodeMismatch } from "./compat.mjs";

const args = process.argv.slice(2);
const majors = args.filter((arg) => /^\d+$/.test(arg)).map(Number);
const dirs =
  majors.length > 0
    ? majors.map(appDir)
    : args.includes("--compat")
      ? compatMajors().map(appDir)
      : [DEMO];

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });
const tarballs = () => readdirSync(ROOT).filter((f) => /^angular-memory-leak-detector-.*\.tgz$/.test(f));

/** The tarball to install: the one given with --tarball, or one built now. */
function tarball() {
  const at = args.indexOf("--tarball");
  if (at >= 0) {
    const given = args[at + 1] && path.resolve(args[at + 1]);
    if (!given || !existsSync(given)) throw new Error(`--tarball: no file at ${args[at + 1] ?? "(missing)"}`);
    return given;
  }
  sh("npm run build", ROOT);
  for (const f of tarballs()) rmSync(path.join(ROOT, f));
  sh("npm pack", ROOT);
  const [tgz] = tarballs();
  if (!tgz) throw new Error("npm pack produced no tarball");
  return path.join(ROOT, tgz);
}
const tgz = tarball();

// In CI, install exactly the lockfile, and fail if it is out of date.
const install = process.env.CI ? "npm ci" : "npm install";

for (const dir of dirs) {
  console.log(`\n> ${path.relative(ROOT, dir)}`);
  warnOnNodeMismatch(dir);
  if (dir !== DEMO) syncCompatApp(Number(/ng(\d+)$/.exec(dir)[1]));
  sh(install, dir);
  sh(`npm install --no-save "${tgz}"`, dir);
  // The Angular CLI caches built dependencies by package version, and the
  // tarball's version doesn't change between installs: drop the cache, or
  // the app may keep running the previous build of the detector.
  rmSync(path.join(dir, ".angular", "cache"), { recursive: true, force: true });
}
