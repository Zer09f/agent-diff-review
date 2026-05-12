use agent_diff_core::{
    analyze_session, stable_id, ChangeType, ChangedFile, DecisionSet, DiffHunk, DiffRow, Language,
    LineDecision, ReviewSession, RowKind,
};
use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use regex::Regex;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::NamedTempFile;

const SCHEMA_VERSION: &str = "0.1.0";

#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub workspace: PathBuf,
    pub base_ref: String,
}

#[derive(Debug, Clone)]
pub struct ApplyOptions {
    pub workspace: PathBuf,
    pub dry_run: bool,
}

#[derive(Debug, Clone)]
pub struct ApplySummary {
    pub dry_run: bool,
    pub files_checked: usize,
    pub files_changed: usize,
    pub rejected_rows: usize,
}

pub fn scan_worktree(options: &ScanOptions) -> Result<ReviewSession> {
    ensure_git_repo(&options.workspace)?;
    let root = git_root(&options.workspace)?;
    let base_ref = options.base_ref.clone();
    let head_ref = git_output(&root, ["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|_| "HEAD".to_string())
        .trim()
        .to_string();
    let diff = git_output(
        &root,
        [
            "diff",
            "--binary",
            "--find-renames",
            "--find-copies",
            "--unified=1000000",
            &base_ref,
            "--",
        ],
    )?;
    let untracked = untracked_files(&root)?;
    let mut files = parse_git_diff(&root, &options.base_ref, &diff)?;
    files.extend(scan_untracked_files(&root, &untracked)?);
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let worktree_hash = compute_worktree_hash(&files);
    let session = ReviewSession {
        schema_version: SCHEMA_VERSION.to_string(),
        workspace_root: root.to_string_lossy().to_string(),
        base_ref,
        head_ref,
        created_at: Utc::now().to_rfc3339(),
        worktree_hash,
        files,
        dependency_edges: Vec::new(),
        risk_markers: Vec::new(),
        test_impacts: Vec::new(),
    };
    Ok(analyze_session(session))
}

pub fn apply_decisions(session: &ReviewSession, decisions: &DecisionSet, options: &ApplyOptions) -> Result<ApplySummary> {
    if session.worktree_hash != decisions.session_worktree_hash {
        bail!(
            "decision set was created for worktree hash {}, but session hash is {}",
            decisions.session_worktree_hash,
            session.worktree_hash
        );
    }
    ensure_git_repo(&options.workspace)?;
    let root = git_root(&options.workspace)?;
    let current = scan_worktree(&ScanOptions {
        workspace: root.clone(),
        base_ref: session.base_ref.clone(),
    })?;
    if current.worktree_hash != session.worktree_hash {
        bail!(
            "worktree changed since scan: current hash {}, session hash {}",
            current.worktree_hash,
            session.worktree_hash
        );
    }

    let decision_map = build_decision_map(decisions);
    let mut files_changed = 0usize;
    let mut rejected_rows = 0usize;
    let mut outputs = Vec::new();

    for file in &session.files {
        if file.file_decision_only || file.binary {
            continue;
        }
        let after = file.after_content.as_deref().unwrap_or("");
        let mut rejected_for_file = 0usize;
        let merged = merge_content_with_decisions(file, &decision_map, &mut rejected_for_file)?;
        rejected_rows += rejected_for_file;
        if merged != after {
            files_changed += 1;
            outputs.push((file.path.clone(), after.to_string(), merged, file.change_type));
        }
    }

    if !outputs.is_empty() {
        let patch = build_apply_patch(&outputs)?;
        git_apply_patch(&root, &patch, true)?;
        if !options.dry_run {
            git_apply_patch(&root, &patch, false)?;
        }
    }

    Ok(ApplySummary {
        dry_run: options.dry_run,
        files_checked: session.files.len(),
        files_changed,
        rejected_rows,
    })
}

pub fn compute_worktree_hash(files: &[ChangedFile]) -> String {
    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(file.path.as_bytes());
        hasher.update([0]);
        hasher.update(format!("{:?}", file.change_type).as_bytes());
        hasher.update([0]);
        if let Some(before) = &file.before_content {
            hasher.update(before.as_bytes());
        }
        hasher.update([0]);
        if let Some(after) = &file.after_content {
            hasher.update(after.as_bytes());
        }
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn build_decision_map(decisions: &DecisionSet) -> HashMap<(&str, &str, &str), LineDecision> {
    decisions
        .decisions
        .iter()
        .map(|entry| {
            (
                (
                    entry.file_id.as_str(),
                    entry.hunk_id.as_str(),
                    entry.row_id.as_str(),
                ),
                entry.decision.clone(),
            )
        })
        .collect()
}

fn merge_content_with_decisions(
    file: &ChangedFile,
    decision_map: &HashMap<(&str, &str, &str), LineDecision>,
    rejected_rows: &mut usize,
) -> Result<String> {
    let mut out = Vec::new();
    let mut old_lines = split_preserve_none(file.before_content.as_deref().unwrap_or(""));
    let mut old_cursor = 1usize;

    for hunk in &file.hunks {
        while old_cursor < hunk.old_start && old_cursor <= old_lines.len() {
            out.push(old_lines[old_cursor - 1].clone());
            old_cursor += 1;
        }
        for row in &hunk.rows {
            let decision = decision_map
                .get(&(file.file_id.as_str(), hunk.hunk_id.as_str(), row.row_id.as_str()))
                .cloned()
                .unwrap_or(LineDecision::Accept);
            match row.kind {
                RowKind::Context => {
                    out.push(row.content.clone());
                    old_cursor += 1;
                }
                RowKind::Deleted => {
                    if decision == LineDecision::Reject {
                        *rejected_rows += 1;
                        out.push(row.content.clone());
                    }
                    old_cursor += 1;
                }
                RowKind::Added => {
                    if decision == LineDecision::Reject {
                        *rejected_rows += 1;
                    } else {
                        out.push(row.content.clone());
                    }
                }
            }
        }
    }
    while old_cursor <= old_lines.len() {
        out.push(old_lines[old_cursor - 1].clone());
        old_cursor += 1;
    }

    let after = file.after_content.as_deref().unwrap_or("");
    let reference = if after.is_empty() {
        file.before_content.as_deref().unwrap_or("")
    } else {
        after
    };
    Ok(join_lines_like(reference, out))
}

fn split_preserve_none(content: &str) -> Vec<String> {
    if content.is_empty() {
        Vec::new()
    } else {
        content.lines().map(|line| line.to_string()).collect()
    }
}

fn join_lines_like(reference: &str, lines: Vec<String>) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut out = lines.join("\n");
    if reference.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn build_apply_patch(outputs: &[(String, String, String, ChangeType)]) -> Result<String> {
    let mut patch = String::new();
    for (path, current, desired, change_type) in outputs {
        if current == desired {
            continue;
        }
        patch.push_str(&full_file_patch(path, current, desired, change_type));
    }
    if patch.is_empty() {
        bail!("no patch content generated");
    }
    Ok(patch)
}

fn full_file_patch(path: &str, current: &str, desired: &str, change_type: &ChangeType) -> String {
    let current_lines = patch_lines(current);
    let desired_lines = patch_lines(desired);
    let delete_file = desired.is_empty() && matches!(change_type, ChangeType::Added | ChangeType::Untracked);
    let add_file = current.is_empty() && matches!(change_type, ChangeType::Deleted);
    let mut out = String::new();
    out.push_str(&format!("diff --git a/{0} b/{0}\n", path));
    if delete_file {
        out.push_str("deleted file mode 100644\n");
        out.push_str(&format!("--- a/{path}\n+++ /dev/null\n"));
    } else if add_file {
        out.push_str("new file mode 100644\n");
        out.push_str(&format!("--- /dev/null\n+++ b/{path}\n"));
    } else {
        out.push_str(&format!("--- a/{path}\n+++ b/{path}\n"));
    }
    let old_start = if current_lines.lines.is_empty() { 0 } else { 1 };
    let new_start = if desired_lines.lines.is_empty() { 0 } else { 1 };
    out.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        old_start,
        current_lines.lines.len(),
        new_start,
        desired_lines.lines.len()
    ));
    for line in &current_lines.lines {
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    if !current_lines.ends_with_newline && !current_lines.lines.is_empty() {
        out.push_str("\\ No newline at end of file\n");
    }
    for line in &desired_lines.lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    if !desired_lines.ends_with_newline && !desired_lines.lines.is_empty() {
        out.push_str("\\ No newline at end of file\n");
    }
    out
}

struct PatchLines {
    lines: Vec<String>,
    ends_with_newline: bool,
}

fn patch_lines(content: &str) -> PatchLines {
    PatchLines {
        lines: if content.is_empty() {
            Vec::new()
        } else {
            content.lines().map(ToOwned::to_owned).collect()
        },
        ends_with_newline: content.ends_with('\n') || content.is_empty(),
    }
}

fn git_apply_patch(root: &Path, patch: &str, check: bool) -> Result<()> {
    let mut file = NamedTempFile::new().context("create temporary patch file")?;
    file.write_all(patch.as_bytes()).context("write temporary patch file")?;
    let mut command = Command::new("git");
    command.current_dir(root).arg("apply").arg("--whitespace=nowarn");
    if check {
        command.arg("--check");
    }
    command.arg(file.path());
    let output = command.output().context("run git apply")?;
    if !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

fn parse_git_diff(root: &Path, base_ref: &str, diff: &str) -> Result<Vec<ChangedFile>> {
    let mut files = Vec::new();
    let lines: Vec<&str> = diff.lines().collect();
    let mut i = 0usize;
    while i < lines.len() {
        if !lines[i].starts_with("diff --git ") {
            i += 1;
            continue;
        }
        let diff_header = lines[i].to_string();
        i += 1;
        let mut header_lines = Vec::new();
        while i < lines.len() && !lines[i].starts_with("@@ ") && !lines[i].starts_with("diff --git ") {
            header_lines.push(lines[i].to_string());
            i += 1;
        }
        let meta = parse_file_meta(&diff_header, &header_lines)?;
        let mut hunk_lines = Vec::new();
        while i < lines.len() && !lines[i].starts_with("diff --git ") {
            hunk_lines.push(lines[i].to_string());
            i += 1;
        }
        files.push(build_changed_file(root, base_ref, meta, &hunk_lines)?);
    }
    Ok(files)
}

#[derive(Debug)]
struct FileMeta {
    old_path: Option<String>,
    path: String,
    change_type: ChangeType,
    binary: bool,
}

fn parse_file_meta(diff_header: &str, header_lines: &[String]) -> Result<FileMeta> {
    let header_re = Regex::new(r"^diff --git a/(.*?) b/(.*?)$").expect("valid diff header regex");
    let captures = header_re
        .captures(diff_header)
        .ok_or_else(|| anyhow!("invalid diff header: {diff_header}"))?;
    let mut old_path = captures[1].to_string();
    let mut path = captures[2].to_string();
    let mut change_type = ChangeType::Modified;
    let mut binary = false;

    for line in header_lines {
        if line == "new file mode 100644" || line.starts_with("new file mode ") {
            change_type = ChangeType::Added;
        } else if line == "deleted file mode 100644" || line.starts_with("deleted file mode ") {
            change_type = ChangeType::Deleted;
        } else if let Some(rest) = line.strip_prefix("rename from ") {
            old_path = rest.to_string();
            change_type = ChangeType::Renamed;
        } else if let Some(rest) = line.strip_prefix("rename to ") {
            path = rest.to_string();
            change_type = ChangeType::Renamed;
        } else if line.starts_with("copy from ") {
            change_type = ChangeType::Copied;
        } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            binary = true;
        }
    }

    Ok(FileMeta {
        old_path: if old_path == path { None } else { Some(old_path) },
        path,
        change_type,
        binary,
    })
}

fn build_changed_file(root: &Path, base_ref: &str, meta: FileMeta, hunk_lines: &[String]) -> Result<ChangedFile> {
    let before_content = match meta.change_type {
        ChangeType::Added | ChangeType::Untracked => Some(String::new()),
        _ => read_git_file(root, base_ref, meta.old_path.as_deref().unwrap_or(&meta.path)).ok(),
    };
    let after_content = match meta.change_type {
        ChangeType::Deleted => Some(String::new()),
        _ => fs::read_to_string(root.join(&meta.path)).ok(),
    };
    let mut additions = 0usize;
    let mut deletions = 0usize;
    let file_id = stable_id(&[&meta.path, "file"]);
    let hunks = parse_hunks(&file_id, hunk_lines, &mut additions, &mut deletions)?;
    let language = agent_diff_core::analysis::classify_language(&meta.path);
    let file_decision_only = meta.binary || matches!(meta.change_type, ChangeType::Renamed | ChangeType::Copied);
    Ok(ChangedFile {
        file_id,
        path: meta.path,
        old_path: meta.old_path,
        change_type: meta.change_type,
        binary: meta.binary,
        file_decision_only,
        language,
        additions,
        deletions,
        before_content,
        after_content,
        hunks,
    })
}

fn parse_hunks(file_id: &str, lines: &[String], additions: &mut usize, deletions: &mut usize) -> Result<Vec<DiffHunk>> {
    let mut hunks = Vec::new();
    let hunk_re = Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$").expect("valid hunk regex");
    let mut i = 0usize;
    let mut hunk_index = 0usize;
    while i < lines.len() {
        let Some(captures) = hunk_re.captures(&lines[i]) else {
            i += 1;
            continue;
        };
        hunk_index += 1;
        let old_start = captures[1].parse::<usize>()?;
        let old_lines = captures.get(2).map(|m| m.as_str()).unwrap_or("1").parse::<usize>()?;
        let new_start = captures[3].parse::<usize>()?;
        let new_lines = captures.get(4).map(|m| m.as_str()).unwrap_or("1").parse::<usize>()?;
        let header = captures.get(5).map(|m| m.as_str()).unwrap_or("").to_string();
        let hunk_id = stable_id(&[file_id, &hunk_index.to_string(), &old_start.to_string(), &new_start.to_string()]);
        i += 1;

        let mut rows = Vec::new();
        let mut old_line = old_start;
        let mut new_line = new_start;
        let mut row_index = 0usize;
        while i < lines.len() && !lines[i].starts_with("@@ ") {
            let line = &lines[i];
            if line == "\\ No newline at end of file" {
                i += 1;
                continue;
            }
            row_index += 1;
            let (kind, content, old, new) = if let Some(content) = line.strip_prefix('+') {
                *additions += 1;
                let row = (RowKind::Added, content.to_string(), None, Some(new_line));
                new_line += 1;
                row
            } else if let Some(content) = line.strip_prefix('-') {
                *deletions += 1;
                let row = (RowKind::Deleted, content.to_string(), Some(old_line), None);
                old_line += 1;
                row
            } else {
                let content = line.strip_prefix(' ').unwrap_or(line).to_string();
                let row = (RowKind::Context, content, Some(old_line), Some(new_line));
                old_line += 1;
                new_line += 1;
                row
            };
            rows.push(DiffRow {
                row_id: stable_id(&[&hunk_id, &row_index.to_string(), &format!("{:?}", kind), &content]),
                kind,
                old_line: old,
                new_line: new,
                content,
                decision: LineDecision::Pending,
            });
            i += 1;
        }
        hunks.push(DiffHunk {
            hunk_id,
            old_start,
            old_lines,
            new_start,
            new_lines,
            header,
            rows,
        });
    }
    Ok(hunks)
}

fn scan_untracked_files(root: &Path, files: &[String]) -> Result<Vec<ChangedFile>> {
    let mut changed = Vec::new();
    for path in files {
        if path.starts_with(".agent-diff-review/") {
            continue;
        }
        let abs = root.join(path);
        if !abs.is_file() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&abs) else {
            let file_id = stable_id(&[path, "file"]);
            changed.push(ChangedFile {
                file_id,
                path: path.clone(),
                old_path: None,
                change_type: ChangeType::Untracked,
                binary: true,
                file_decision_only: true,
                language: Some(Language::Other),
                additions: 0,
                deletions: 0,
                before_content: Some(String::new()),
                after_content: None,
                hunks: Vec::new(),
            });
            continue;
        };
        let file_id = stable_id(&[path, "file"]);
        let hunk_id = stable_id(&[&file_id, "untracked"]);
        let mut rows = Vec::new();
        let mut additions = 0usize;
        for (index, line) in content.lines().enumerate() {
            additions += 1;
            rows.push(DiffRow {
                row_id: stable_id(&[&hunk_id, &index.to_string(), "Added", line]),
                kind: RowKind::Added,
                old_line: None,
                new_line: Some(index + 1),
                content: line.to_string(),
                decision: LineDecision::Pending,
            });
        }
        changed.push(ChangedFile {
            file_id,
            path: path.clone(),
            old_path: None,
            change_type: ChangeType::Untracked,
            binary: false,
            file_decision_only: false,
            language: agent_diff_core::analysis::classify_language(path),
            additions,
            deletions: 0,
            before_content: Some(String::new()),
            after_content: Some(content),
            hunks: vec![DiffHunk {
                hunk_id,
                old_start: 0,
                old_lines: 0,
                new_start: 1,
                new_lines: additions,
                header: "untracked file".to_string(),
                rows,
            }],
        });
    }
    Ok(changed)
}

fn untracked_files(root: &Path) -> Result<Vec<String>> {
    let output = git_output(root, ["ls-files", "--others", "--exclude-standard"])?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

fn ensure_git_repo(workspace: &Path) -> Result<()> {
    git_output(workspace, ["rev-parse", "--show-toplevel"])
        .map(|_| ())
        .context("agent-diff-review requires a Git repository")
}

fn git_root(workspace: &Path) -> Result<PathBuf> {
    let output = git_output(workspace, ["rev-parse", "--show-toplevel"])?;
    Ok(PathBuf::from(output.trim()))
}

fn read_git_file(root: &Path, rev: &str, path: &str) -> Result<String> {
    git_output(root, ["show", &format!("{rev}:{path}")])
}

fn git_output<const N: usize>(cwd: &Path, args: [&str; N]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("run git in {}", cwd.display()))?;
    if !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_file() -> ChangedFile {
        let file_id = stable_id(&["src/a.ts", "file"]);
        let hunk_id = stable_id(&[&file_id, "1", "1", "1"]);
        ChangedFile {
            file_id: file_id.clone(),
            path: "src/a.ts".to_string(),
            old_path: None,
            change_type: ChangeType::Modified,
            binary: false,
            file_decision_only: false,
            language: Some(Language::TypeScript),
            additions: 1,
            deletions: 1,
            before_content: Some("one\ntwo\nthree\n".to_string()),
            after_content: Some("one\nTWO\nthree\n".to_string()),
            hunks: vec![DiffHunk {
                hunk_id: hunk_id.clone(),
                old_start: 1,
                old_lines: 3,
                new_start: 1,
                new_lines: 3,
                header: String::new(),
                rows: vec![
                    DiffRow {
                        row_id: stable_id(&[&hunk_id, "1", "Context", "one"]),
                        kind: RowKind::Context,
                        old_line: Some(1),
                        new_line: Some(1),
                        content: "one".to_string(),
                        decision: LineDecision::Pending,
                    },
                    DiffRow {
                        row_id: stable_id(&[&hunk_id, "2", "Deleted", "two"]),
                        kind: RowKind::Deleted,
                        old_line: Some(2),
                        new_line: None,
                        content: "two".to_string(),
                        decision: LineDecision::Pending,
                    },
                    DiffRow {
                        row_id: stable_id(&[&hunk_id, "3", "Added", "TWO"]),
                        kind: RowKind::Added,
                        old_line: None,
                        new_line: Some(2),
                        content: "TWO".to_string(),
                        decision: LineDecision::Pending,
                    },
                    DiffRow {
                        row_id: stable_id(&[&hunk_id, "4", "Context", "three"]),
                        kind: RowKind::Context,
                        old_line: Some(3),
                        new_line: Some(3),
                        content: "three".to_string(),
                        decision: LineDecision::Pending,
                    },
                ],
            }],
        }
    }

    #[test]
    fn reject_added_line_restores_old_side_when_deleted_row_rejected_too() {
        let file = sample_file();
        let hunk = &file.hunks[0];
        let mut map = HashMap::new();
        map.insert(
            (file.file_id.as_str(), hunk.hunk_id.as_str(), hunk.rows[1].row_id.as_str()),
            LineDecision::Reject,
        );
        map.insert(
            (file.file_id.as_str(), hunk.hunk_id.as_str(), hunk.rows[2].row_id.as_str()),
            LineDecision::Reject,
        );
        let mut rejected = 0;
        let merged = merge_content_with_decisions(&file, &map, &mut rejected).unwrap();
        assert_eq!(merged, "one\ntwo\nthree\n");
        assert_eq!(rejected, 2);
    }

    #[test]
    fn pending_rows_accept_current_worktree() {
        let file = sample_file();
        let map = HashMap::new();
        let mut rejected = 0;
        let merged = merge_content_with_decisions(&file, &map, &mut rejected).unwrap();
        assert_eq!(merged, "one\nTWO\nthree\n");
        assert_eq!(rejected, 0);
    }
}
