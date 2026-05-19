import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = join(__dirname, "..");
const rootDir = resolve(extDir, "..", "..");
const staging = join(extDir, ".staging");
const target = parseTarget(process.argv.slice(2));

rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, "dist"), { recursive: true });

cpSync(join(extDir, "package.json"), join(staging, "package.json"));
cpSync(join(extDir, "dist", "extension.js"), join(staging, "dist", "extension.js"));
writeFileSync(join(staging, ".vscodeignore"), ".staging/**\n");
copyIfExists(join(extDir, "README.md"), join(staging, "README.md"));
copyIfExists(join(extDir, "..", "..", "LICENSE"), join(staging, "LICENSE"));
if (existsSync(join(extDir, "bin"))) {
  cpSync(join(extDir, "bin"), join(staging, "bin"), { recursive: true });
}
if (target) {
  const executable = target.startsWith("win32") ? "adr.exe" : "adr";
  const bundledAdr = join(staging, "bin", target, executable);
  if (!existsSync(bundledAdr)) {
    throw new Error(
      `Missing bundled ${executable} for ${target}. Run scripts/sync-binaries.mjs --platform ${target} before packaging.`
    );
  }
}

const packageArgs = ["vsce", "package"];
if (target) {
  packageArgs.push("--target", target);
}
packageArgs.push("--allow-missing-repository", "--skip-license");
const vsce = join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
execFileSync(vsce, packageArgs.slice(1), {
  cwd: staging,
  stdio: "inherit",
  shell: process.platform === "win32",
});

const { version } = JSON.parse(
  await import("node:fs").then((m) => m.readFileSync(join(extDir, "package.json"), "utf8"))
);
const generatedVsix = readdirSync(staging).find((file) => file.endsWith(".vsix"));
if (!generatedVsix) {
  throw new Error("vsce did not generate a .vsix file");
}
const vsix = target
  ? `agent-diff-review-vscode-${target}-${version}.vsix`
  : `agent-diff-review-vscode-${version}.vsix`;
cpSync(join(staging, generatedVsix), join(extDir, vsix));
rmSync(staging, { recursive: true, force: true });
console.log(`\nPackaged: ${vsix}`);

function parseTarget(args) {
  const index = args.indexOf("--target");
  if (index !== -1) {
    return args[index + 1];
  }
  return args.find((arg) => /^(win32|linux|darwin)-(x64|arm64)$/.test(arg));
}

function copyIfExists(source, destination) {
  if (existsSync(source)) {
    cpSync(source, destination, { recursive: true });
  }
}
