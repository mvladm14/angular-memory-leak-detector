import { defineConfig, devices } from "@playwright/test";

// The demo app (demo/) served twice: zoneless (Angular's default since v21)
// and on zone.js. Run `npm run demo:install` first. The Angular CLI needs
// Node 22.22+ (see .nvmrc).
const servers = [
  { name: "zoneless", script: "start", port: 4300 },
  { name: "zone", script: "start:zone", port: 4301 },
];

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
  projects: servers.map(({ name, port }) => ({
    name,
    use: {
      ...devices["Desktop Chrome"],
      baseURL: `http://localhost:${port}`,
      launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
    },
  })),
  webServer: servers.map(({ script, port }) => ({
    command: `npm --prefix demo run ${script} -- --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  })),
});
