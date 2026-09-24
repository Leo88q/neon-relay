#!/usr/bin/env node
/**
 * Type gate for the dependency-free Node service.
 *
 * CI/release images should provide TypeScript and run the real compiler. The
 * repository intentionally does not vendor node_modules, so a developer
 * checkout without `tsc` gets an explicit syntax-only result instead of a
 * fabricated type-check claim. Set REQUIRE_TSC=1 to make that condition fail.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execPath } from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const compiler = spawnSync("tsc", ["--noEmit", "-p", "tsconfig.json"], { stdio: "inherit" });
if (!compiler.error) process.exit(compiler.status ?? 1);
if ((compiler.error as NodeJS.ErrnoException).code !== "ENOENT") {
  console.error(`tsc failed to start: ${(compiler.error as Error).message}`);
  process.exit(2);
}

const files: string[] = [];
const visit = (directory: string): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
};
for (const directory of ["src", "test", "scripts"]) visit(join(root, directory));
for (const file of files) {
  const check = spawnSync(execPath, ["--experimental-strip-types", "--check", file], { stdio: "inherit" });
  if (check.status !== 0) process.exit(check.status ?? 2);
}
console.error("TYPECHECK_UNVERIFIED: tsc is unavailable; Node syntax checks passed");
if (process.env.REQUIRE_TSC === "1") process.exit(2);
