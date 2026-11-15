// Prints, as JSON, every app the end-to-end suite runs against: each compat
// workspace and the demo, oldest Angular first. The CI workflow builds its job
// matrix from it, so a new compat/ngNN is tested without editing the workflow.
// Each app must pin its Node version in an .nvmrc.
//
//   node scripts/e2e-matrix.mjs
//   [{"angular":16,"dir":"compat/ng16"}, …, {"angular":22,"dir":"demo"}]
import { existsSync } from "node:fs";
import path from "node:path";
import { appDir, compatMajors, demoMajor, ROOT } from "./compat.mjs";

const majors = [...compatMajors(), demoMajor()];
const apps = majors.map((angular) => ({
  angular,
  dir: path.relative(ROOT, appDir(angular)).split(path.sep).join("/"),
}));
// Each job runs on the Node its app pins.
const unpinned = apps.filter(({ dir }) => !existsSync(path.join(ROOT, dir, ".nvmrc")));
if (unpinned.length > 0) {
  throw new Error(`No .nvmrc in ${unpinned.map((a) => a.dir).join(", ")}: pin the Node version it runs on.`);
}
console.log(JSON.stringify(apps));
