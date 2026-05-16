# Release process

This project publishes GitHub Releases from version tags. Do not upload the
release files by hand unless the release workflow is unavailable. The normal
path is:

1. Bump versions in the repository.
2. Commit the version bump.
3. Push `main`.
4. Create and push a `vX.Y.Z` tag.
5. Let GitHub Actions build and upload all release assets.
6. Verify the Release assets.

## 1. Choose the next version

Use semantic versioning:

- Patch, for bug fixes and small improvements: `0.1.1 -> 0.1.2`.
- Minor, for new features: `0.1.1 -> 0.2.0`.
- Major, for breaking changes: `1.2.3 -> 2.0.0`.

Do not reuse an existing release tag. If `v0.1.1` already exists, publish the
next version instead of force-updating it.

## 2. Update version files

Update release/package versions in these files:

```text
package.json
package-lock.json
packages/opencode-plugin/package.json
packages/ui/package.json
packages/vscode-extension/package.json
crates/cli/Cargo.toml
crates/core/Cargo.toml
crates/git_patch/Cargo.toml
Cargo.lock
plugins/codex/agent-diff-review/.codex-plugin/plugin.json
plugins/claude/agent-diff-review/.claude-plugin/plugin.json
.claude-plugin/marketplace.json
docs/install.md
docs/distribution.md
```

Important: keep schema/data-format versions unchanged unless the data format
actually changes. Examples that are not package release versions:

```text
schemaVersion: '0.1.0'
SCHEMA_VERSION: "0.1.0"
schema_version: "0.1.0"
```

After editing `package.json` files, refresh the npm lockfile:

```bash
npm install --package-lock-only --ignore-scripts
```

If Cargo is available, refresh the Rust lockfile with:

```bash
cargo check
```

If Cargo is not available, update only the local package versions in
`Cargo.lock` and avoid changing third-party dependency entries.

## 3. Validate before tagging

Run:

```bash
npm run typecheck
cargo test
```

For a stronger local packaging check on the current platform:

```bash
npm run package:downloads
```

Expected output directory:

```text
dist/release
```

Typical generated assets:

```text
adr-v<version>-<platform>.zip
adr-v<version>-<platform>.tar.gz
agent-diff-review-vscode-<platform>-<version>.vsix
agent-diff-review-opencode-plugin-<version>.tgz
agent-diff-review-codex-v<version>-<platform>.zip
agent-diff-review-claude-v<version>-<platform>.zip
SHA256SUMS
```

## 4. Commit the release version bump

Check the diff:

```bash
git status --short
git diff --stat
git diff --check
```

Commit:

```bash
git add -A
git commit -m "Release vX.Y.Z"
```

Push `main`:

```bash
git push origin main
```

If SSH port 22 is blocked, use GitHub SSH over port 443:

```bash
git push ssh://git@ssh.github.com:443/Zer09f/agent-diff-review.git main
```

## 5. Create and push the release tag

Confirm the tag does not already exist:

```bash
git tag --list vX.Y.Z
git ls-remote --tags origin refs/tags/vX.Y.Z refs/tags/vX.Y.Z^{}
```

Create an annotated tag:

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
```

Push the tag:

```bash
git push origin vX.Y.Z
```

Or, with SSH over port 443:

```bash
git push ssh://git@ssh.github.com:443/Zer09f/agent-diff-review.git vX.Y.Z
```

Pushing the tag triggers `.github/workflows/release.yml`.

## 6. What GitHub Actions uploads

The release workflow builds:

- CLI archives for `win32-x64`, `linux-x64`, `darwin-x64`, and `darwin-arm64`.
- Platform-specific VS Code `.vsix` packages.
- Codex plugin zip packages.
- Claude Code plugin zip packages.
- OpenCode npm tarball.
- `SHA256SUMS` checksum files.

The workflow creates the GitHub Release only on tag pushes matching:

```text
v*.*.*
```

Manual `workflow_dispatch` runs build artifacts, but they do not create a
GitHub Release unless the run is for a tag ref.

## 7. Verify the release

Open:

```text
https://github.com/Zer09f/agent-diff-review/releases/tag/vX.Y.Z
```

Expand the Assets section and confirm the generated files are present. GitHub
always adds Source code archives automatically; those are not enough.

At minimum, verify these assets exist:

```text
adr-vX.Y.Z-win32-x64.zip
adr-vX.Y.Z-linux-x64.tar.gz
adr-vX.Y.Z-darwin-x64.tar.gz
adr-vX.Y.Z-darwin-arm64.tar.gz
agent-diff-review-vscode-win32-x64-X.Y.Z.vsix
agent-diff-review-vscode-linux-x64-X.Y.Z.vsix
agent-diff-review-vscode-darwin-x64-X.Y.Z.vsix
agent-diff-review-vscode-darwin-arm64-X.Y.Z.vsix
agent-diff-review-opencode-plugin-X.Y.Z.tgz
agent-diff-review-codex-vX.Y.Z-win32-x64.zip
agent-diff-review-claude-vX.Y.Z-win32-x64.zip
SHA256SUMS
```

If the normal Release page does not show assets immediately, check the expanded
assets URL:

```text
https://github.com/Zer09f/agent-diff-review/releases/expanded_assets/vX.Y.Z
```

## 8. If the release fails

Open the failed GitHub Actions run and check the failed job:

- CLI build failure usually means Rust or packaging failed for one platform.
- VSIX failure usually means the platform CLI archive could not be unpacked or
  the extension package command failed.
- Publish failure usually means `contents: write` permission is missing or the
  release asset upload failed.

Fix the workflow or code on `main`, commit and push it, then create the next
patch release. Prefer publishing a new tag over rewriting a release that users
may already have downloaded.

Only force-update a tag when the release was never successfully published and no
one has consumed it yet. Use `--force-with-lease`, not a blind force push.

## 9. Current caveats

The current workflow does not publish:

```text
win32-arm64
linux-arm64
```

Add runner/cross-compilation support before documenting those as supported
download platforms.
