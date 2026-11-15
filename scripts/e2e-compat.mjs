// Runs the end-to-end suite once per Angular major, one after the other (each
// run starts its own dev servers).
//
//   node scripts/e2e-compat.mjs                  every compat/ngNN workspace
//   node scripts/e2e-compat.mjs 16 18            Angular 16 and 18 (22 = demo/)
//   node scripts/e2e-compat.mjs 16 --grep timer  extra arguments go to Playwright
//
// Install the apps first: `npm run compat:install` (and `npm run demo:install`).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { appDir, compatMajors, DEMO, ROOT, syncCompatApp, warnOnNodeMismatch } from "./compat.mjs";

const args = process.argv.slice(2);
const majors = [];
while (args.length > 0 && /^\d+$/.test(args[0])) majors.push(Number(args.shift()));
if (majors.length === 0) majors.push(...compatMajors());

const results = [];
for (const major of majors) {
  const dir = appDir(major);
  const rel = path.relative(ROOT, dir);
  console.log(`\n=== Angular ${major} (${rel})\n`);
  if (!existsSync(path.join(dir, "node_modules", "angular-memory-leak-detector"))) {
    const install = dir === DEMO ? "npm run demo:install" : `npm run compat:install -- ${major}`;
    console.error(`${rel} is not installed. Run \`${install}\` first.`);
    results.push({ major, ok: false });
    continue;
  }
  if (dir !== DEMO) syncCompatApp(major);
  warnOnNodeMismatch(dir);
  const run = spawnSync("npx", ["playwright", "test", ...args], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, E2E_ANGULAR: String(major) },
  });
  results.push({ major, ok: run.status === 0 });
}

console.log("\n=== Summary");
for (const { major, ok } of results) console.log(`Angular ${major}: ${ok ? "passed" : "FAILED"}`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
