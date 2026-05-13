import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const targets = [
  "win32-x64",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
];

const args = parseArgs(process.argv.slice(2));
const platform = args.platform ?? currentPlatform();
if (!targets.includes(platform)) {
  throw new Error(`Unsupported platform "${platform}". Expected one of: ${targets.join(", ")}`);
}

const executable = platform.startsWith("win32") ? "adr.exe" : "adr";
const source = args.source ? resolve(root, args.source) : defaultCargoBinary(executable);
if (!existsSync(source)) {
  throw new Error(
    `Missing adr binary at ${source}. Run "cargo build --release" first or pass --source <path>.`
  );
}

const destinations = [
  join(root, "packages", "vscode-extension", "bin", platform, executable),
  join(root, "packages", "opencode-plugin", "bin", platform, executable),
  join(root, "plugins", "codex", "agent-diff-review", "bin", platform, executable),
  join(root, "plugins", "claude", "agent-diff-review", "bin", platform, executable),
];

for (const destination of destinations) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (!platform.startsWith("win32")) {
    chmodSync(destination, 0o755);
  }
  console.log(`Copied ${basename(source)} -> ${destination}`);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--platform") {
      parsed.platform = values[++index];
    } else if (value === "--source") {
      parsed.source = values[++index];
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

function defaultCargoBinary(executable) {
  return join(root, "target", "release", executable);
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
