import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = join(root, "dist", "release");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const args = parseArgs(process.argv.slice(2));
const target = args.platform ?? process.env.ADR_TARGET_PLATFORM ?? currentPlatform();
const executable = target.startsWith("win32") ? "adr.exe" : "adr";
const cargoTarget = args.cargoTarget ?? process.env.ADR_CARGO_TARGET ?? cargoTargetForPlatform(target);
const cargoBinary = cargoTarget
  ? join(root, "target", cargoTarget, "release", executable)
  : join(root, "target", "release", executable);

if (!args.noClean) {
  rmSync(dist, { recursive: true, force: true });
}
mkdirSync(dist, { recursive: true });

const cargoArgs = ["build", "--release", "-p", "adr"];
if (cargoTarget) {
  cargoArgs.push("--target", cargoTarget);
}
execFileSync("cargo", cargoArgs, { cwd: root, stdio: "inherit" });

if (!existsSync(cargoBinary)) {
  throw new Error(`Expected built binary at ${cargoBinary}`);
}

const cliDir = join(dist, `agent-diff-review-v${version}-${target}`);
mkdirSync(cliDir, { recursive: true });
copyFileSync(cargoBinary, join(cliDir, executable));
if (!target.startsWith("win32")) {
  execFileSync("chmod", ["755", join(cliDir, executable)], { cwd: root });
}
copyFileSync(join(root, "README.md"), join(cliDir, "README.md"));
copyFileSync(join(root, "LICENSE"), join(cliDir, "LICENSE"));

if (target.startsWith("win32")) {
  const archive = join(dist, `adr-v${version}-${target}.zip`);
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${cliDir}\\*' -DestinationPath '${archive}' -Force`,
  ], { cwd: root, stdio: "inherit" });
} else {
  execFileSync("tar", ["-czf", join(dist, `adr-v${version}-${target}.tar.gz`), "-C", dist, basename(cliDir)], {
    cwd: root,
    stdio: "inherit",
  });
}
rmSync(cliDir, { recursive: true, force: true });

execFileSync("node", ["scripts/sync-binaries.mjs", "--platform", target, "--source", cargoBinary], {
  cwd: root,
  stdio: "inherit",
});
execFileSync("node", ["scripts/package-plugins.mjs", "--platform", target], {
  cwd: root,
  stdio: "inherit",
});

writeChecksums(dist, target);
console.log(`Release artifacts staged in ${dist}`);

function writeChecksums(directory, platform) {
  const lines = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
  if (!entry.endsWith(".zip") && !entry.endsWith(".tar.gz") && !entry.endsWith(".vsix")) {
      continue;
    }

    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    lines.push(`${hash}  ${entry}`);
  }
  const content = `${lines.sort().join("\n")}\n`;
  writeFileSync(join(directory, "SHA256SUMS"), content);
  writeFileSync(join(directory, `SHA256SUMS-${platform}`), content);
}

function parseArgs(values) {
  const parsed = { noClean: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--platform") {
      parsed.platform = values[++index];
    } else if (value === "--cargo-target") {
      parsed.cargoTarget = values[++index];
    } else if (value === "--no-clean") {
      parsed.noClean = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

function cargoTargetForPlatform(platform) {
  switch (platform) {
    case "win32-x64":
      return "x86_64-pc-windows-msvc";
    case "win32-arm64":
      return "aarch64-pc-windows-msvc";
    case "linux-x64":
      return "x86_64-unknown-linux-gnu";
    case "linux-arm64":
      return "aarch64-unknown-linux-gnu";
    case "darwin-x64":
      return "x86_64-apple-darwin";
    case "darwin-arm64":
      return "aarch64-apple-darwin";
    default:
      throw new Error(`Unsupported release platform: ${platform}`);
  }
}

function currentPlatform() {
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined;
  if (!arch) {
    throw new Error(`Unsupported architecture: ${process.arch}`);
  }

  switch (process.platform) {
    case "win32":
      return `win32-${arch}`;
    case "linux":
      return `linux-${arch}`;
    case "darwin":
      return `darwin-${arch}`;
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}
