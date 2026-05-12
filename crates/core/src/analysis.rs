use crate::model::*;
use regex::Regex;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub fn analyze_session(mut session: ReviewSession) -> ReviewSession {
    let known_files = collect_known_files(&session);
    session.dependency_edges = dependency_edges(&session, &known_files);
    session.test_impacts = test_impacts(&session);
    session.risk_markers = risk_markers(&session);
    session
}

pub fn classify_language(path: &str) -> Option<Language> {
    let path = path.to_ascii_lowercase();
    if path.ends_with(".ts") || path.ends_with(".tsx") || path.ends_with(".mts") || path.ends_with(".cts") {
        Some(Language::TypeScript)
    } else if path.ends_with(".js")
        || path.ends_with(".jsx")
        || path.ends_with(".mjs")
        || path.ends_with(".cjs")
    {
        Some(Language::JavaScript)
    } else if path.ends_with(".java") {
        Some(Language::Java)
    } else {
        Some(Language::Other)
    }
}

pub fn classify_file_kind(path: &str) -> &'static str {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    if is_test_path(path) {
        "test"
    } else if lower.ends_with(".json")
        || lower.ends_with(".toml")
        || lower.ends_with(".yaml")
        || lower.ends_with(".yml")
        || lower.ends_with(".ini")
        || lower.ends_with(".env")
        || lower.contains("/.github/")
    {
        "config"
    } else if lower.ends_with(".lock")
        || lower.ends_with("package-lock.json")
        || lower.ends_with("pnpm-lock.yaml")
        || lower.ends_with("yarn.lock")
        || lower.ends_with("cargo.lock")
    {
        "lockfile"
    } else {
        "source"
    }
}

pub fn is_test_path(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    lower.contains("/test/")
        || lower.contains("/tests/")
        || lower.contains("/__tests__/")
        || lower.ends_with("_test.go")
        || lower.ends_with("test.java")
        || lower.ends_with("tests.java")
        || lower.ends_with(".test.ts")
        || lower.ends_with(".test.tsx")
        || lower.ends_with(".spec.ts")
        || lower.ends_with(".spec.tsx")
        || lower.ends_with(".test.js")
        || lower.ends_with(".spec.js")
        || lower.ends_with(".test.jsx")
        || lower.ends_with(".spec.jsx")
}

pub fn stable_id(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())[..16].to_string()
}

fn collect_known_files(session: &ReviewSession) -> Vec<String> {
    let mut files: BTreeSet<String> = session.files.iter().map(|f| normalize_path(&f.path)).collect();
    let root = PathBuf::from(&session.workspace_root);
    if root.exists() {
        for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let rel = path
                .strip_prefix(Path::new(&session.workspace_root))
                .ok()
                .map(to_slash_path)
                .unwrap_or_else(|| to_slash_path(path));
            if !is_ignored_known_file(&rel) {
                files.insert(rel);
            }
        }
    }
    files.into_iter().collect()
}

fn is_ignored_known_file(path: &str) -> bool {
    path.starts_with(".git/")
        || path.starts_with("target/")
        || path.starts_with("node_modules/")
        || path.starts_with(".agent-diff-review/")
        || path.contains("/target/")
        || path.contains("/node_modules/")
}

fn dependency_edges(session: &ReviewSession, known_files: &[String]) -> Vec<DependencyEdge> {
    let mut edges = BTreeMap::<(String, String, DependencyKind), DependencyEdge>::new();
    for file in &session.files {
        let Some(content) = file.after_content.as_deref().or(file.before_content.as_deref()) else {
            continue;
        };
        match file.language {
            Some(Language::TypeScript) | Some(Language::JavaScript) => {
                for import_path in extract_ts_imports(content) {
                    if let Some(target) = resolve_ts_import(&file.path, &import_path, known_files) {
                        insert_edge(&mut edges, &file.path, &target, DependencyKind::Import, DependencyConfidence::High);
                    }
                }
            }
            Some(Language::Java) => {
                for import_path in extract_java_imports(content) {
                    if let Some(target) = resolve_java_import(&import_path, known_files) {
                        insert_edge(&mut edges, &file.path, &target, DependencyKind::Package, DependencyConfidence::Medium);
                    }
                }
            }
            _ => {}
        }
    }
    edges.into_values().collect()
}

fn insert_edge(
    edges: &mut BTreeMap<(String, String, DependencyKind), DependencyEdge>,
    from: &str,
    to: &str,
    kind: DependencyKind,
    confidence: DependencyConfidence,
) {
    if normalize_path(from) == normalize_path(to) {
        return;
    }
    let key = (normalize_path(from), normalize_path(to), kind.clone());
    edges.entry(key).or_insert_with(|| DependencyEdge {
        from: normalize_path(from),
        to: normalize_path(to),
        kind,
        confidence,
    });
}

fn extract_ts_imports(content: &str) -> Vec<String> {
    let mut imports = Vec::new();
    let re = Regex::new(r#"(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)"#)
        .expect("valid TS import regex");
    for captures in re.captures_iter(content) {
        if let Some(value) = captures.get(1).or_else(|| captures.get(2)) {
            imports.push(value.as_str().to_string());
        }
    }
    imports
}

fn extract_java_imports(content: &str) -> Vec<String> {
    let mut imports = Vec::new();
    let re = Regex::new(r"(?m)^\s*import\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_$.]*);")
        .expect("valid Java import regex");
    for captures in re.captures_iter(content) {
        imports.push(captures[1].to_string());
    }
    imports
}

fn resolve_ts_import(from: &str, import_path: &str, known_files: &[String]) -> Option<String> {
    if !import_path.starts_with('.') {
        return None;
    }
    let from_dir = Path::new(from).parent().unwrap_or_else(|| Path::new(""));
    let base = normalize_path(&to_slash_path(&from_dir.join(import_path)));
    let candidates = [
        base.clone(),
        format!("{base}.ts"),
        format!("{base}.tsx"),
        format!("{base}.js"),
        format!("{base}.jsx"),
        format!("{base}/index.ts"),
        format!("{base}/index.tsx"),
        format!("{base}/index.js"),
        format!("{base}/index.jsx"),
    ];
    candidates
        .into_iter()
        .find(|candidate| known_files.iter().any(|path| normalize_path(path) == normalize_path(candidate)))
}

fn resolve_java_import(import_path: &str, known_files: &[String]) -> Option<String> {
    let suffix = format!("{}.java", import_path.replace('.', "/"));
    known_files
        .iter()
        .find(|path| normalize_path(path).ends_with(&suffix))
        .cloned()
}

fn test_impacts(session: &ReviewSession) -> Vec<TestImpact> {
    let mut impacts = Vec::new();
    let tests: Vec<&ChangedFile> = session.files.iter().filter(|file| is_test_path(&file.path)).collect();
    for test in &tests {
        let kind = match test.change_type {
            ChangeType::Added | ChangeType::Untracked => TestImpactKind::TestAdded,
            ChangeType::Deleted => TestImpactKind::TestDeleted,
            _ => TestImpactKind::TestModified,
        };
        impacts.push(TestImpact {
            source_file_id: None,
            test_file_id: test.file_id.clone(),
            kind,
            confidence: DependencyConfidence::High,
            message: format!("Test file changed: {}", test.path),
        });
    }

    for source in session.files.iter().filter(|file| !is_test_path(&file.path)) {
        let source_stem = stem_for_test_matching(&source.path);
        for test in &tests {
            if normalize_path(&test.path).to_ascii_lowercase().contains(&source_stem) {
                impacts.push(TestImpact {
                    source_file_id: Some(source.file_id.clone()),
                    test_file_id: test.file_id.clone(),
                    kind: TestImpactKind::RelatedTestChanged,
                    confidence: DependencyConfidence::Medium,
                    message: format!("{} appears related to changed test {}", source.path, test.path),
                });
            }
        }
    }
    impacts
}

fn risk_markers(session: &ReviewSession) -> Vec<RiskMarker> {
    let fan_in = fan_in_counts(&session.dependency_edges);
    let mut markers = Vec::new();
    for file in &session.files {
        let kind = classify_file_kind(&file.path);
        if kind == "config" {
            markers.push(file_risk(file, RiskLevel::Medium, RiskCategory::Config, "Configuration file changed"));
        }
        if kind == "lockfile" {
            markers.push(file_risk(file, RiskLevel::High, RiskCategory::Lockfile, "Lockfile or dependency pin changed"));
        }
        if is_auth_path(&file.path) {
            markers.push(file_risk(file, RiskLevel::High, RiskCategory::Auth, "Authentication or authorization path changed"));
        }
        if file.deletions >= 50 || file.deletions > file.additions.saturating_mul(3).max(10) {
            markers.push(file_risk(file, RiskLevel::High, RiskCategory::LargeDeletion, "Large deletion detected"));
        }
        if is_test_path(&file.path) && matches!(file.change_type, ChangeType::Deleted) {
            markers.push(file_risk(file, RiskLevel::High, RiskCategory::TestDeletion, "Test file deleted"));
        }
        if file.file_decision_only {
            markers.push(file_risk(file, RiskLevel::Medium, RiskCategory::FileDecisionOnly, "Only file-level decisions are supported for this change"));
        }
        if fan_in.get(&normalize_path(&file.path)).copied().unwrap_or(0) >= 3 {
            markers.push(file_risk(file, RiskLevel::Medium, RiskCategory::FanIn, "File is imported by multiple changed files"));
        }
        markers.extend(public_api_risks(file));
        markers.extend(auth_row_risks(file));
    }
    markers
}

fn fan_in_counts(edges: &[DependencyEdge]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for edge in edges {
        *counts.entry(normalize_path(&edge.to)).or_insert(0) += 1;
    }
    counts
}

fn file_risk(file: &ChangedFile, level: RiskLevel, category: RiskCategory, message: &str) -> RiskMarker {
    RiskMarker {
        risk_id: stable_id(&[&file.file_id, message]),
        file_id: file.file_id.clone(),
        hunk_id: None,
        row_id: None,
        level,
        category,
        message: message.to_string(),
    }
}

fn public_api_risks(file: &ChangedFile) -> Vec<RiskMarker> {
    let mut risks = Vec::new();
    let api_re = Regex::new(
        r"\b(pub\s+fn|pub\s+struct|pub\s+enum|export\s+(function|class|interface|type|const)|public\s+(class|interface|record|enum|static|final|void|[A-Z]))",
    )
    .expect("valid public API regex");
    for hunk in &file.hunks {
        for row in &hunk.rows {
            if matches!(row.kind, RowKind::Added | RowKind::Deleted) && api_re.is_match(&row.content) {
                risks.push(RiskMarker {
                    risk_id: stable_id(&[&file.file_id, &hunk.hunk_id, &row.row_id, "public-api"]),
                    file_id: file.file_id.clone(),
                    hunk_id: Some(hunk.hunk_id.clone()),
                    row_id: Some(row.row_id.clone()),
                    level: RiskLevel::Medium,
                    category: RiskCategory::PublicApi,
                    message: "Public API surface changed".to_string(),
                });
            }
        }
    }
    risks
}

fn auth_row_risks(file: &ChangedFile) -> Vec<RiskMarker> {
    let mut risks = Vec::new();
    let lower_path = file.path.to_ascii_lowercase();
    if is_auth_path(&lower_path) {
        return risks;
    }
    let auth_re = Regex::new(r"(?i)\b(auth|token|jwt|permission|role|policy|password|secret)\b")
        .expect("valid auth regex");
    for hunk in &file.hunks {
        for row in &hunk.rows {
            if matches!(row.kind, RowKind::Added | RowKind::Deleted) && auth_re.is_match(&row.content) {
                risks.push(RiskMarker {
                    risk_id: stable_id(&[&file.file_id, &hunk.hunk_id, &row.row_id, "auth-row"]),
                    file_id: file.file_id.clone(),
                    hunk_id: Some(hunk.hunk_id.clone()),
                    row_id: Some(row.row_id.clone()),
                    level: RiskLevel::High,
                    category: RiskCategory::Auth,
                    message: "Security-sensitive code changed".to_string(),
                });
            }
        }
    }
    risks
}

fn is_auth_path(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    lower.contains("auth")
        || lower.contains("permission")
        || lower.contains("security")
        || lower.contains("policy")
        || lower.contains("jwt")
        || lower.contains("token")
}

fn stem_for_test_matching(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(path)
        .replace(".test", "")
        .replace(".spec", "")
        .to_ascii_lowercase()
}

pub fn normalize_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn to_slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_test_paths() {
        assert!(is_test_path("src/foo.test.ts"));
        assert!(is_test_path("src/test/java/FooTest.java"));
        assert!(!is_test_path("src/Foo.java"));
    }

    #[test]
    fn extracts_ts_imports() {
        let imports = extract_ts_imports("import x from './x';\nconst y = require(\"./y\");");
        assert_eq!(imports, vec!["./x", "./y"]);
    }

    #[test]
    fn extracts_java_imports() {
        let imports = extract_java_imports("package a;\nimport java.util.List;\nimport com.acme.Foo;");
        assert_eq!(imports, vec!["java.util.List", "com.acme.Foo"]);
    }
}
