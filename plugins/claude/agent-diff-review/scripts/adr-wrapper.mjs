#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, "..");
const adr = resolveAdrPath();
const result = spawnSync(adr, process.argv.slice(2), {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: process.platform === "win32" && !isAbsolutePath(adr),
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);

function resolveAdrPath() {
  const configured = process.env.ADR_PATH?.trim();
  if (configured) {
    return configured;
  }

  const platform = platformKey();
  if (platform) {
    const executable = process.platform === "win32" ? "adr.exe" : "adr";
    const candidate = join(pluginRoot, "bin", platform, executable);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return "adr";
}

function isAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
}

function platformKey() {
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined;
  if (!arch) {
    return undefined;
  }

  switch (process.platform) {
    case "win32":
      return `win32-${arch}`;
    case "linux":
      return `linux-${arch}`;
    case "darwin":
      return `darwin-${arch}`;
    default:
      return undefined;
  }
}
