import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = join(__dirname, "..");
const staging = join(extDir, ".staging");

rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, "dist"), { recursive: true });

cpSync(join(extDir, "package.json"), join(staging, "package.json"));
cpSync(join(extDir, "readme.md"), join(staging, "readme.md"));
cpSync(join(extDir, "dist", "extension.js"), join(staging, "dist", "extension.js"));

execSync("npx vsce package --allow-missing-repository --skip-license", {
  cwd: staging,
  stdio: "inherit",
});

const { version } = JSON.parse(
  await import("node:fs").then((m) => m.readFileSync(join(extDir, "package.json"), "utf8"))
);
const vsix = `agent-diff-review-vscode-${version}.vsix`;
cpSync(join(staging, vsix), join(extDir, vsix));
rmSync(staging, { recursive: true, force: true });
console.log(`\nPackaged: ${vsix}`);
