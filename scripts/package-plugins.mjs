import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const version = JSON.parse(await readJson(join(root, "package.json"))).version;
const dist = join(root, "dist", "release");
const platform = parsePlatform(process.argv.slice(2)) ?? currentPlatform();

packageDirectory("codex", join(root, "plugins", "codex", "agent-diff-review"));
packageDirectory("claude", join(root, "plugins", "claude", "agent-diff-review"));

async function readJson(path) {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

function packageDirectory(kind, sourceDir) {
  if (!existsSync(sourceDir)) {
    throw new Error(`Missing plugin directory: ${sourceDir}`);
  }

  const staging = join(dist, `agent-diff-review-${kind}-v${version}-${platform}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(sourceDir, staging, { recursive: true });

  const archive = join(dist, `${basename(staging)}.zip`);
  if (process.platform === "win32") {
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${staging}\\*' -DestinationPath '${archive}' -Force`,
    ], { cwd: root, stdio: "inherit" });
  } else {
    execFileSync("zip", ["-qr", archive, "."], { cwd: staging, stdio: "inherit" });
  }

  console.log(`Packaged ${kind} plugin -> ${archive}`);
  rmSync(staging, { recursive: true, force: true });
}

function parsePlatform(args) {
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
