import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const roots = ["app", "lib", "scripts", "components", "hooks", "public", "pi-workspace-manager"];
function collect(directory) {
  return readdirSync(path.join(cwd, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return collect(relative);
    return entry.isFile() && entry.name.endsWith(".test.mjs") ? [relative] : [];
  });
}
const files = roots.flatMap(collect).sort();
if (process.argv.includes("--list")) {
  console.log(JSON.stringify(files.map((file) => file.split(path.sep).join("/"))));
  process.exit(0);
}
if (files.length === 0) throw new Error("No test files found");
console.log(`Running ${files.length} test files`);
const result = spawnSync(process.execPath, [
  "--experimental-strip-types", "--test", "--test-force-exit", ...process.argv.slice(2), ...files,
], { cwd, stdio: "inherit", shell: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
