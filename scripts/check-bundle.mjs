// Checks that a production build of each app contains none of the detector's
// code, as the README promises, and that a development build does contain it,
// so the check can't pass by looking for the wrong thing. And that a
// production build made with `provideProductionMemoryLeakDetector` (the
// apps' `production-detector` configuration) does contain it.
//
//   node scripts/check-bundle.mjs          every app: compat/ngNN and demo/
//   node scripts/check-bundle.mjs 16 22    Angular 16 and 22 only
//
// Install the apps first: `npm run compat:install` and `npm run demo:install`.
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDir, compatMajors, demoMajor, ROOT, warnOnNodeMismatch } from "./compat.mjs";

/**
 * What only the detector's code contains, and what minifiers keep: property
 * names and strings. At least one for each module that holds state. None of
 * them may be something the apps' own code uses.
 */
const FINGERPRINTS = {
  "[ng-leak]": /\[ng-leak\]/g, // console output: detector.ts, sweep.ts, subscribers.ts
  sweepIntervalMs: /\bsweepIntervalMs\b/g, // default options: config.ts
  destroyedAt: /\bdestroyedAt\b/g, // tracked instances: lifecycle.ts, sweep.ts
  lastWarnedAt: /\blastWarnedAt\b/g, // per-component stats: store.ts
  born: /\bborn\b/g, // the witness stock: witness.ts
  heldByRouter: /\bheldByRouter\b/g, // pages the router keeps: router.ts
  companions: /\bcompanions\b/g, // directives and services on a component's host: discovery.ts, router.ts
  trackDirectives: /\btrackDirectives\b/g, // what is tracked besides components: config.ts, discovery.ts
  "production build": /classes named by selector/g, // the banner in a production build: detector.ts
};

const args = process.argv.slice(2);
const majors = args.length > 0 ? args.map(Number) : [...compatMajors(), demoMajor()];

function javascriptIn(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return javascriptIn(file);
    return name.endsWith(".js") || name.endsWith(".mjs") ? [readFileSync(file, "utf8")] : [];
  });
}

function fingerprintsIn(app, configuration, out) {
  execSync(`npx ng build --configuration ${configuration} --output-path "${out}" --progress=false`, {
    cwd: app,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const code = javascriptIn(out).join("\n");
  return Object.fromEntries(
    Object.entries(FINGERPRINTS).map(([name, pattern]) => [name, code.match(pattern)?.length ?? 0]),
  );
}

let ok = true;
for (const major of majors) {
  const app = appDir(major);
  const out = mkdtempSync(path.join(os.tmpdir(), "bundle-check-"));
  try {
    console.log(`\n=== Angular ${major} (${path.relative(ROOT, app)})`);
    warnOnNodeMismatch(app);
    const dev = fingerprintsIn(app, "development", path.join(out, "development"));
    const prod = fingerprintsIn(app, "production", path.join(out, "production"));
    const opted = fingerprintsIn(app, "production-detector", path.join(out, "production-detector"));
    for (const name of Object.keys(FINGERPRINTS)) {
      const problem =
        dev[name] === 0 ? "  <- missing from the development build: stale fingerprint"
        : prod[name] > 0 ? "  <- detector code in the production build"
        : opted[name] === 0 ? "  <- missing from the production build with provideProductionMemoryLeakDetector"
        : "";
      if (problem) ok = false;
      console.log(
        `${name.padEnd(16)} development: ${String(dev[name]).padStart(3)}  production: ${String(prod[name]).padStart(3)}` +
          `  production-detector: ${String(opted[name]).padStart(3)}${problem}`,
      );
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

console.log(
  ok
    ? "\nNo detector code in any production build, except with provideProductionMemoryLeakDetector."
    : "\nFAILED",
);
process.exitCode = ok ? 0 : 1;
