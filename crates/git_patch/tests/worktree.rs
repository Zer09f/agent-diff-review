use agent_diff_core::{DecisionSet, LineDecision, LineDecisionEntry, RowKind};
use agent_diff_git_patch::{apply_decisions, scan_worktree, ApplyOptions, ScanOptions};
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::tempdir;

#[test]
fn scan_and_reject_added_line_in_temp_repo() {
    let dir = tempdir().expect("temp repo");
    git(dir.path(), ["init"]);
    git(dir.path(), ["config", "user.email", "test@example.com"]);
    git(dir.path(), ["config", "user.name", "Test User"]);
    fs::write(dir.path().join("app.ts"), "export const value = 1;\n").unwrap();
    git(dir.path(), ["add", "."]);
    git(dir.path(), ["commit", "-m", "initial"]);

    fs::write(
        dir.path().join("app.ts"),
        "export const value = 1;\nexport const generated = true;\n",
    )
    .unwrap();

    let session = scan_worktree(&ScanOptions {
        workspace: dir.path().to_path_buf(),
        base_ref: "HEAD".to_string(),
    })
    .unwrap();
    let file = session.files.iter().find(|file| file.path == "app.ts").unwrap();
    let hunk = &file.hunks[0];
    let added = hunk.rows.iter().find(|row| row.kind == RowKind::Added).unwrap();
    let decisions = DecisionSet {
        schema_version: "0.1.0".to_string(),
        session_worktree_hash: session.worktree_hash.clone(),
        decisions: vec![LineDecisionEntry {
            file_id: file.file_id.clone(),
            hunk_id: hunk.hunk_id.clone(),
            row_id: added.row_id.clone(),
            decision: LineDecision::Reject,
        }],
    };

    let dry_run = apply_decisions(
        &session,
        &decisions,
        &ApplyOptions {
            workspace: dir.path().to_path_buf(),
            dry_run: true,
        },
    )
    .unwrap();
    assert_eq!(dry_run.rejected_rows, 1);
    assert!(fs::read_to_string(dir.path().join("app.ts")).unwrap().contains("generated"));

    apply_decisions(
        &session,
        &decisions,
        &ApplyOptions {
            workspace: dir.path().to_path_buf(),
            dry_run: false,
        },
    )
    .unwrap();
    let restored = fs::read_to_string(dir.path().join("app.ts")).unwrap();
    assert_eq!(restored.replace("\r\n", "\n"), "export const value = 1;\n");
}

fn git<const N: usize>(cwd: &Path, args: [&str; N]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
