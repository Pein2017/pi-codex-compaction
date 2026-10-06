#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = "@narumitw/pi-codex-compact";
const manifest = JSON.parse(readFileSync(path.join(root, "packages/pi-codex-compact/package.json"), "utf8"));
const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
if (run("git", ["status", "--porcelain"]).trim())
  throw new Error("Commit the reviewed local release source before packaging.");
const sourceCommit = run("git", ["rev-parse", "HEAD"]).trim();
if (!/^\d+\.\d+\.\d+-coordexp\.\d+$/.test(manifest.version))
  throw new Error("Use an explicit coordexp prerelease version.");
const releases = path.join(root, ".local/releases");
const destination = path.join(releases, manifest.version);
if (existsSync(destination)) throw new Error(`Release already exists: ${destination}`);
mkdirSync(releases, { recursive: true });
const staging = mkdtempSync(path.join(releases, ".staging-"));
try {
  run("npm", ["--workspace", workspace, "run", "build"]);
  const [packed] = JSON.parse(run("npm", ["pack", "--workspace", workspace, "--json", "--pack-destination", staging]));
  const archive = path.join(staging, packed.filename);
  run("tar", ["-xzf", archive, "-C", staging]);
  // Install only runtime dependencies. Pi supplies peers through its resource loader.
  run(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"],
    path.join(staging, "package"),
  );
  if (run("git", ["rev-parse", "HEAD"]).trim() !== sourceCommit || run("git", ["status", "--porcelain"]).trim()) {
    throw new Error("Source changed during packaging; no release published.");
  }
  const receipt = {
    package: manifest.name,
    version: manifest.version,
    sourceCommit,
    upstreamCommit: run("git", ["merge-base", "HEAD", "upstream/main"]).trim(),
    archive: packed.filename,
    sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
    runtime: path.join(destination, "package"),
  };
  writeFileSync(path.join(staging, "release.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(staging, destination);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
