//! Verifies the ASR/LLM compile-time isolation rule (enforced in build.rs).
//!
//! This test only checks that the source files themselves do not contain the
//! forbidden imports. The actual hard-fail happens in build.rs at compile
//! time — this test gives a clear failure surface during cargo test runs.

use std::fs;
use std::path::Path;

fn scan(dir: &Path, needles: &[&str]) -> Vec<String> {
    let mut hits = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return hits,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            hits.extend(scan(&path, needles));
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        for (i, line) in contents.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || trimmed.starts_with("*") {
                continue;
            }
            for n in needles {
                if line.contains(n) {
                    hits.push(format!("{}:{}: {}", path.display(), i + 1, line.trim()));
                }
            }
        }
    }
    hits
}

#[test]
fn asr_module_does_not_import_llm() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let asr_dir = Path::new(manifest_dir).join("src/asr");
    if !asr_dir.exists() {
        return;
    }
    let hits = scan(&asr_dir, &["crate::llm", "use crate::llm"]);
    assert!(
        hits.is_empty(),
        "asr module must not import llm directly:\n{}",
        hits.join("\n")
    );
}

#[test]
fn llm_module_does_not_import_asr() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let llm_dir = Path::new(manifest_dir).join("src/llm");
    if !llm_dir.exists() {
        return;
    }
    let hits = scan(&llm_dir, &["crate::asr", "use crate::asr"]);
    assert!(
        hits.is_empty(),
        "llm module must not import asr directly:\n{}",
        hits.join("\n")
    );
}
