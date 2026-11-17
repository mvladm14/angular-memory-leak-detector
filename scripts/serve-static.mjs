// Serves an app built with `ng build`, for the end-to-end suite's production
// projects (playwright.config.ts): its files, and its index.html for any other
// path, as a production server does for an app with a router. Not the dev
// server: on some Angular versions (17) `ng serve` keeps `ngDevMode` on and
// Angular's own code unminified, even for an optimized configuration.
//
//   node scripts/serve-static.mjs <dir> --port <port>
//
// The application builder (Angular 17 and later) writes the app to
// `<dir>/browser`, the browser builder (16) to `<dir>`: either is served.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const port = Number(portAt >= 0 ? args[portAt + 1] : 4200);
const dir = args.find((arg, i) => !arg.startsWith("--") && i !== portAt + 1);
if (!dir || !Number.isInteger(port)) {
  console.error("Usage: node scripts/serve-static.mjs <dir> --port <port>");
  process.exit(1);
}
const built = path.resolve(dir);
const root = existsSync(path.join(built, "browser", "index.html")) ? path.join(built, "browser") : built;
if (!existsSync(path.join(root, "index.html"))) {
  console.error(`No index.html in ${root}: build the app first.`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  let file = path.join(root, decodeURIComponent(pathname));
  const inside = file === root || file.startsWith(root + path.sep);
  if (!inside || !existsSync(file) || statSync(file).isDirectory()) file = path.join(root, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`Serving ${path.relative(process.cwd(), root) || "."} at http://localhost:${port}`));
