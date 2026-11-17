import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// The app under test, chosen by E2E_ANGULAR (an Angular major):
//
// - unset, or the demo's major: the demo app (demo/), served zoneless
//   (Angular's default since v21) and on zone.js;
// - an older major: the compat workspace compat/ngNN, the same app written in
//   syntax every Angular from 16 on understands. Served on zone.js, and also
//   zoneless where that major has a `start:zoneless` script (18 and later).
//
// Each app is also built for production twice, with its `production-detector`
// configuration (optimized and minified, `ngDevMode` off, hidden source maps)
// and the detector that runs in production,
// `provideProductionMemoryLeakDetector`: zoneless for the demo, on zone.js
// for the compat workspaces. Each build is served as is
// (scripts/serve-static.mjs), not by the dev server.
//
// - `production-minified` (`start:production-minified`): as built, with
//   minified class names, which the detector names by selector by default;
// - `production` (`start:production`): with the class names `ng-leak-names`
//   restores from the source maps after the build, the extra layer.
//
// Install first: `npm run demo:install` or `npm run compat:install`.
// `npm run e2e:compat` runs the suite once per major. Each app pins the Node
// it runs on in its .nvmrc (the demo's Angular CLI needs Node 22.22+).

type Mode = "zone" | "zoneless" | "production" | "production-minified";
/** `zone`: whether the app runs on zone.js there. */
type Server = { mode: Mode; script: string; port: number; zone: boolean };

// Relative to this file, like the web servers' commands.
const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const manifest = (dir: string) =>
  JSON.parse(readFileSync(here(`${dir}/package.json`), "utf8")) as {
    dependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
const majorOf = (dir: string) => Number(/\d+/.exec(manifest(dir).dependencies["@angular/core"] ?? "")?.[0]);

const demoMajor = majorOf("demo");
const angular = Number(process.env.E2E_ANGULAR || demoMajor);

function target(): { dir: string; servers: Server[] } {
  if (angular === demoMajor) {
    return {
      dir: "demo",
      servers: [
        { mode: "zoneless", script: "start", port: 4300, zone: false },
        { mode: "zone", script: "start:zone", port: 4301, zone: true },
        { mode: "production", script: "start:production", port: 4302, zone: false },
        { mode: "production-minified", script: "start:production-minified", port: 4303, zone: false },
      ],
    };
  }
  const dir = `compat/ng${angular}`;
  if (!existsSync(here(`${dir}/package.json`))) {
    throw new Error(`E2E_ANGULAR=${process.env.E2E_ANGULAR}: no demo or ${dir} for that Angular major.`);
  }
  // A port per major and mode, so that a server left running for one major is
  // never reused for another.
  const port = 5000 + angular * 10;
  const servers: Server[] = [{ mode: "zone", script: "start", port, zone: true }];
  const { scripts } = manifest(dir);
  if (scripts["start:zoneless"]) servers.push({ mode: "zoneless", script: "start:zoneless", port: port + 1, zone: false });
  if (scripts["start:production"]) servers.push({ mode: "production", script: "start:production", port: port + 2, zone: true });
  if (scripts["start:production-minified"]) {
    servers.push({ mode: "production-minified", script: "start:production-minified", port: port + 3, zone: true });
  }
  return { dir, servers };
}

const { dir, servers } = target();

export default defineConfig({
  testDir: "./e2e",
  // Garbage collection takes a few rounds; give each spec room to poll.
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  // No --expose-gc: collections are triggered the way DevTools' "Collect
  // garbage" button does it, over the DevTools protocol.
  projects: servers.map(({ mode, port, zone }) => ({
    name: `ng${angular}-${mode}`,
    // Read by the spec: the Angular major the app must be on, whether it
    // runs on zone.js, whether it is a production build, and whether its
    // class names are minified.
    metadata: {
      angular,
      zone,
      production: mode.startsWith("production"),
      minifiedNames: mode === "production-minified",
    },
    use: {
      ...devices["Desktop Chrome"],
      baseURL: `http://localhost:${port}`,
      launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
    },
  })),
  webServer: servers.map(({ script, port }) => ({
    command: `npm --prefix ${dir} run ${script} -- --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  })),
});
