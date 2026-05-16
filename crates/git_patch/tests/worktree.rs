use agent_diff_core::{DecisionSet, LineDecision, LineDecisionEntry, RowKind};
use agent_diff_git_patch::{
    apply_decisions, apply_snapshot_decisions, init_snapshot, scan_snapshot, scan_worktree, ApplyOptions,
    ScanOptions, SnapshotOptions,
};
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

#[test]
fn snapshot_reject_restores_uncommitted_user_baseline() {
    let dir = tempdir().expect("temp repo");
    init_repo(dir.path());
    fs::write(dir.path().join("app.ts"), "export const value = 1;\n").unwrap();
    git(dir.path(), ["add", "."]);
    git(dir.path(), ["commit", "-m", "initial"]);

    fs::write(dir.path().join("app.ts"), "export const value = 2;\n").unwrap();
    init_snapshot(&SnapshotOptions {
        workspace: dir.path().to_path_buf(),
        baseline: ".agent-diff-review/baseline.json".into(),
        force: false,
    })
    .unwrap();

    fs::write(dir.path().join("app.ts"), "export const value = 3;\n").unwrap();
    let session = scan_snapshot(&SnapshotOptions {
        workspace: dir.path().to_path_buf(),
        baseline: ".agent-diff-review/baseline.json".into(),
        force: false,
    })
    .unwrap();
    let file = session.files.iter().find(|file| file.path == "app.ts").unwrap();
    let decisions = reject_all_decisions(&session, file);

    apply_snapshot_decisions(
        &session,
        &decisions,
        &ApplyOptions {
            workspace: dir.path().to_path_buf(),
            dry_run: false,
        },
        &SnapshotOptions {
            workspace: dir.path().to_path_buf(),
            baseline: ".agent-diff-review/baseline.json".into(),
            force: false,
        },
    )
    .unwrap();

    let restored = fs::read_to_string(dir.path().join("app.ts")).unwrap();
    assert_eq!(restored.replace("\r\n", "\n"), "export const value = 2;\n");
}

#[test]
fn snapshot_accept_updates_next_reject_baseline() {
    let dir = tempdir().expect("temp repo");
    init_repo(dir.path());
    fs::write(dir.path().join("app.ts"), "one\n").unwrap();
    git(dir.path(), ["add", "."]);
    git(dir.path(), ["commit", "-m", "initial"]);

    init_snapshot(&SnapshotOptions {
        workspace: dir.path().to_path_buf(),
        baseline: ".agent-diff-review/baseline.json".into(),
        force: false,
    })
    .unwrap();

    fs::write(dir.path().join("app.ts"), "two\n").unwrap();
    let first = scan_snapshot(&SnapshotOptions {
        workspace: dir.path().to_path_buf(),
        baseline: ".agent-diff-review/baseline.json".into(),
        force: false,
    })
    .unwrap();
    apply_snapshot_decisions(
        &first,
        &DecisionSet {
            schema_version: "0.1.0".to_string(),
            session_worktree_hash: first.worktree_hash.clone(),
            decisions: Vec::new(),
        },
        &ApplyOptions {
            workspace: dir.path().to_path_buf(),
            dry_run: false,
        },
        &SnapshotOptions {
            workspace: dir.path().to_path_buf(),
            baseline: ".agent-diff-review/baseline.json".into(),
            force: false,
        },
    )
    .unwrap();

    fs::write(dir.path().join("app.ts"), "three\n").unwrap();
    let second = scan_snapshot(&SnapshotOptions {
        workspace: dir.path().to_path_buf(),
        baseline: ".agent-diff-review/baseline.json".into(),
        force: false,
    })
    .unwrap();
    let file = second.files.iter().find(|file| file.path == "app.ts").unwrap();
    let decisions = reject_all_decisions(&second, file);
    apply_snapshot_decisions(
        &second,
        &decisions,
        &ApplyOptions {
            workspace: dir.path().to_path_buf(),
            dry_run: false,
        },
        &SnapshotOptions {
            workspace: dir.path().to_path_buf(),
            baseline: ".agent-diff-review/baseline.json".into(),
            force: false,
        },
    )
    .unwrap();

    let restored = fs::read_to_string(dir.path().join("app.ts")).unwrap();
    assert_eq!(restored.replace("\r\n", "\n"), "two\n");
}

#[test]
fn snapshot_scan_does_not_require_git_repository() {
    let dir = tempdir().expect("workspace");
    fs::write(dir.path().join("app.ts"), "one\n").unwrap();
    init_snapshot(&SnapshotOptions {
        workspace: dir.path().to_path_buf(),
        baseline: ".agent-diff-review/baseline.json".into(),
        force: false,
    })
    .unwrap();

    fs::write(dir.path().join("app.ts"), "two\n").unwrap();
    let session = scan_snapshot(&SnapshotOptions {
        workspace: dir.path().to_path_buf(),
        baseline: ".agent-diff-review/baseline.json".into(),
        force: false,
    })
    .unwrap();

    assert_eq!(session.files.len(), 1);
    assert_eq!(session.files[0].path, "app.ts");
}

fn reject_all_decisions(session: &agent_diff_core::ReviewSession, file: &agent_diff_core::ChangedFile) -> DecisionSet {
    DecisionSet {
        schema_version: "0.1.0".to_string(),
        session_worktree_hash: session.worktree_hash.clone(),
        decisions: file
            .hunks
            .iter()
            .flat_map(|hunk| {
                hunk.rows
                    .iter()
                    .filter(|row| row.kind != RowKind::Context)
                    .map(move |row| LineDecisionEntry {
                        file_id: file.file_id.clone(),
                        hunk_id: hunk.hunk_id.clone(),
                        row_id: row.row_id.clone(),
                        decision: LineDecision::Reject,
                    })
            })
            .collect(),
    }
}

fn init_repo(path: &Path) {
    git(path, ["init"]);
    git(path, ["config", "user.email", "test@example.com"]);
    git(path, ["config", "user.name", "Test User"]);
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
