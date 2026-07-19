#!/usr/bin/env bun
/**
 * Creates a `claudindev` symlink pointing at this repo's bin/claudin, so the
 * latest local `bun run build` output is always runnable alongside the stable
 * globally-installed `claudin` release.
 *
 * Usage: bun run link:dev
 */
import { existsSync, mkdirSync, symlinkSync, unlinkSync, chmodSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const repoRoot = resolve(import.meta.dir, "..");
const target = join(repoRoot, "bin", "claudin");

if (!existsSync(target)) {
  console.error(`error: ${target} not found — run from a claudin checkout.`);
  process.exit(1);
}

// Pick a bin dir that is likely already on PATH; prefer an existing one.
const candidates = [
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".local", "bin"),
  "/usr/local/bin",
];
const linkDir = candidates.find((d) => existsSync(d)) ?? candidates[1];
mkdirSync(linkDir, { recursive: true });

const link = join(linkDir, "claudindev");
try {
  unlinkSync(link);
} catch {}
chmodSync(target, 0o755);
symlinkSync(target, link);

console.log(`linked: ${link} -> ${target}`);

const pathDirs = (process.env.PATH ?? "").split(":");
if (!pathDirs.includes(linkDir)) {
  console.log(`\nnote: ${linkDir} is not on your PATH. Add it, e.g.:`);
  console.log(`  export PATH="${linkDir}:$PATH"`);
}
console.log(`\nclaudindev now runs the latest local build. Run \`bun run build\` after source changes.`);
