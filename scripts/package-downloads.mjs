import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = join(root, "dist", "release");
const target = parseTarget(process.argv.slice(2)) ?? process.env.ADR_TARGET_PLATFORM ?? currentPlatform();

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

run("node", ["scripts/build-release.mjs", "--platform", target, "--no-clean"]);
run("npm", ["run", "build"]);
removeFilesWithExtension(join(root, "packages", "vscode-extension"), ".vsix");
run("npm", ["run", "package", "--workspace", "packages/vscode-extension", "--", "--target", target]);

const vsix = findFile(join(root, "packages", "vscode-extension"), ".vsix");
cpSync(vsix.path, join(dist, vsix.name));
rmSync(vsix.path, { force: true });

run("npm", ["pack", "--workspace", "packages/opencode-plugin", "--pack-destination", dist]);

writeCombinedChecksums(target);
cleanupGeneratedBins();
console.log(`Download-ready artifacts are in ${dist}`);

function run(command, args) {
  execFileSync(process.platform === "win32" && command === "npm" ? "npm.cmd" : command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32" && command === "npm",
  });
}

function findFile(directory, extension) {
  const name = readdirSync(directory).find((file) => file.endsWith(extension));
  if (!name) {
    throw new Error(`No ${extension} file found in ${directory}`);
  }
  return { name, path: join(directory, name) };
}

function writeCombinedChecksums(platform) {
  const lines = [];
  for (const entry of readdirSync(dist)) {
    const path = join(dist, entry);
    if (!existsSync(path)) {
      continue;
    }
    if (!/\.(zip|tgz|vsix|tar\.gz)$/.test(entry)) {
      continue;
    }
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    lines.push(`${hash}  ${entry}`);
  }
  const content = `${lines.sort().join("\n")}\n`;
  writeFileSync(join(dist, "SHA256SUMS"), content);
  writeFileSync(join(dist, `SHA256SUMS-${platform}`), content);
}

function removeFilesWithExtension(directory, extension) {
  for (const file of readdirSync(directory)) {
    if (file.endsWith(extension)) {
      rmSync(join(directory, file), { force: true });
    }
  }
}

function cleanupGeneratedBins() {
  const generatedDirs = [
    join(root, "packages", "vscode-extension", "bin"),
    join(root, "packages", "opencode-plugin", "bin"),
    join(root, "plugins", "codex", "agent-diff-review", "bin"),
    join(root, "plugins", "claude", "agent-diff-review", "bin"),
  ];
  for (const dir of generatedDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseTarget(args) {
  const index = args.indexOf("--platform");
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
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
