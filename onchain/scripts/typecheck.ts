import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const tsconfig = join(root, "tsconfig.json");
const requireTsc = process.env.REQUIRE_TSC === "1";

function filesUnder(directory: string): string[] {
  const absolute = join(root, directory);
  try {
    return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return filesUnder(path);
      return entry.isFile() && path.endsWith(".ts") ? [path] : [];
    });
  } catch {
    return [];
  }
}

function run(command: string, args: string[]): number | null {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error?.code === "ENOENT") return null;
  return result.status ?? 1;
}

const semantic = run(process.env.TSC ?? "tsc", ["--noEmit", "-p", tsconfig]);
if (semantic === 0) {
  console.log("onchain typecheck: tsc semantic check passed");
  process.exit(0);
}
if (semantic !== null) process.exit(semantic);

const files = [...filesUnder("src"), ...filesUnder("test"), ...filesUnder("scripts")];
for (const file of files) {
  const result = run(process.execPath, ["--experimental-strip-types", "--check", file]);
  if (result !== 0) process.exit(result ?? 1);
}
if (requireTsc) {
  console.error("onchain typecheck: tsc is unavailable (REQUIRE_TSC=1)");
  process.exit(2);
}
console.error(`onchain typecheck: TYPECHECK_UNVERIFIED (tsc unavailable; syntax checked ${files.length} files)`);
