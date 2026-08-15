//! Bounded, provider-neutral test result ingestion for the Code Workspace.
//!
//! Build tools remain responsible for executing tests. This module only reads
//! JUnit-style XML result files after a run and converts them into a stable
//! result tree that the frontend can render and navigate. It deliberately
//! avoids treating terminal text as a test protocol.

use quick_xml::Reader;
use quick_xml::events::Event;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_RESULT_FILES: usize = 256;
const MAX_RESULT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TEST_CASES: usize = 50_000;
const MAX_TEXT_LENGTH: usize = 32 * 1024;
const MAX_SCAN_DEPTH: usize = 24;
const MAX_SCAN_DIRS: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredTestResult {
    pub id: String,
    pub selector: String,
    pub name: String,
    pub class_name: String,
    pub status: TestResultStatus,
    pub duration_ms: Option<u64>,
    pub message: Option<String>,
    pub details: Option<String>,
    pub file_path: Option<String>,
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TestResultStatus {
    Passed,
    Failed,
    Skipped,
    Error,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredTestSummary {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub errors: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredTestResults {
    pub schema: String,
    pub version: u32,
    pub source: String,
    pub generated_at: u64,
    pub results: Vec<StructuredTestResult>,
    pub summary: StructuredTestSummary,
    pub diagnostics: Vec<String>,
}

fn bounded(value: &str) -> String {
    value.trim().chars().take(MAX_TEXT_LENGTH).collect()
}

fn attr<'a>(event: &'a quick_xml::events::BytesStart<'a>, key: &[u8]) -> Option<String> {
    event
        .attributes()
        .flatten()
        .find(|candidate| candidate.key.as_ref() == key)
        .and_then(|candidate| {
            candidate
                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .ok()
        })
        .map(|value| bounded(&value))
        .filter(|value| !value.is_empty())
}

fn test_selector(class_name: &str, name: &str) -> String {
    if class_name.is_empty() {
        name.to_string()
    } else {
        format!("{class_name}#{name}")
    }
}

fn result_id(
    path_hint: Option<&str>,
    selector: &str,
    counts: &mut HashMap<String, usize>,
) -> String {
    let base = path_hint
        .filter(|path| !path.is_empty())
        .map(|path| format!("{path}::{selector}"))
        .unwrap_or_else(|| selector.to_string());
    let count = counts.entry(base.clone()).or_insert(0);
    *count += 1;
    if *count == 1 {
        base
    } else {
        format!("{base}::{}", *count)
    }
}

fn duration_ms(value: Option<&str>) -> Option<u64> {
    value
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(|seconds| (seconds * 1000.0).round() as u64)
}

fn parse_xml(
    source: &str,
    path_hint: Option<&str>,
    output: &mut Vec<StructuredTestResult>,
) -> Result<(), String> {
    let mut reader = Reader::from_str(source);
    reader.config_mut().trim_text(false);
    let mut current: Option<StructuredTestResult> = None;
    let mut text_target: Option<(&'static str, usize)> = None;
    let mut text = String::new();
    let mut depth = 0usize;
    let mut result_id_counts = HashMap::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if event.name().as_ref() == b"testcase" => {
                if current.is_some() {
                    return Err("invalid JUnit XML: nested testcase".into());
                }
                depth += 1;
                if output.len() >= MAX_TEST_CASES {
                    return Err(format!(
                        "test result case limit exceeded ({MAX_TEST_CASES})"
                    ));
                }
                let class_name = attr(&event, b"classname").unwrap_or_default();
                let name = attr(&event, b"name").unwrap_or_else(|| "unnamed test".into());
                let selector = test_selector(&class_name, &name);
                let id = result_id(path_hint, &selector, &mut result_id_counts);
                current = Some(StructuredTestResult {
                    id,
                    selector,
                    name,
                    class_name,
                    status: TestResultStatus::Passed,
                    duration_ms: duration_ms(attr(&event, b"time").as_deref()),
                    message: None,
                    details: None,
                    file_path: attr(&event, b"file"),
                    line: attr(&event, b"line").and_then(|line| line.parse::<u32>().ok()),
                });
            }
            Ok(Event::Empty(event)) if event.name().as_ref() == b"testcase" => {
                if output.len() >= MAX_TEST_CASES {
                    return Err(format!(
                        "test result case limit exceeded ({MAX_TEST_CASES})"
                    ));
                }
                let class_name = attr(&event, b"classname").unwrap_or_default();
                let name = attr(&event, b"name").unwrap_or_else(|| "unnamed test".into());
                let selector = test_selector(&class_name, &name);
                let id = result_id(path_hint, &selector, &mut result_id_counts);
                output.push(StructuredTestResult {
                    id,
                    selector,
                    name,
                    class_name,
                    status: TestResultStatus::Passed,
                    duration_ms: duration_ms(attr(&event, b"time").as_deref()),
                    message: None,
                    details: None,
                    file_path: attr(&event, b"file"),
                    line: attr(&event, b"line").and_then(|line| line.parse::<u32>().ok()),
                });
            }
            Ok(Event::Start(event)) if current.is_some() => {
                depth += 1;
                let kind = event.name().as_ref().to_vec();
                let target = match kind.as_slice() {
                    b"failure" => {
                        current.as_mut().unwrap().status = TestResultStatus::Failed;
                        current.as_mut().unwrap().message = attr(&event, b"message");
                        Some("failure")
                    }
                    b"error" => {
                        current.as_mut().unwrap().status = TestResultStatus::Error;
                        current.as_mut().unwrap().message = attr(&event, b"message");
                        Some("error")
                    }
                    b"skipped" => {
                        current.as_mut().unwrap().status = TestResultStatus::Skipped;
                        current.as_mut().unwrap().message = attr(&event, b"message");
                        Some("skipped")
                    }
                    b"system-out" => Some("system-out"),
                    b"system-err" => Some("system-err"),
                    _ => None,
                };
                if let Some(target) = target {
                    text_target = Some((target, depth));
                    text.clear();
                }
            }
            Ok(Event::Empty(event)) if current.is_some() => match event.name().as_ref() {
                b"failure" => {
                    current.as_mut().unwrap().status = TestResultStatus::Failed;
                    current.as_mut().unwrap().message = attr(&event, b"message");
                }
                b"error" => {
                    current.as_mut().unwrap().status = TestResultStatus::Error;
                    current.as_mut().unwrap().message = attr(&event, b"message");
                }
                b"skipped" => {
                    current.as_mut().unwrap().status = TestResultStatus::Skipped;
                    current.as_mut().unwrap().message = attr(&event, b"message");
                }
                _ => {}
            },
            Ok(Event::Text(value)) if text_target.is_some() => {
                if text.len() < MAX_TEXT_LENGTH {
                    let decoded = value.decode().unwrap_or_default();
                    let unescaped = quick_xml::escape::unescape(&decoded)
                        .map(|value| value.into_owned())
                        .unwrap_or_else(|_| decoded.to_string());
                    text.push_str(
                        &unescaped
                            .chars()
                            .take(MAX_TEXT_LENGTH - text.len())
                            .collect::<String>(),
                    );
                }
            }
            Ok(Event::CData(value)) if text_target.is_some() => {
                if text.len() < MAX_TEXT_LENGTH {
                    text.push_str(
                        &value
                            .decode()
                            .unwrap_or_default()
                            .chars()
                            .take(MAX_TEXT_LENGTH - text.len())
                            .collect::<String>(),
                    );
                }
            }
            Ok(Event::GeneralRef(value)) if text_target.is_some() => {
                if text.len() < MAX_TEXT_LENGTH {
                    let decoded = value.decode().unwrap_or_default();
                    let reference = format!("&{decoded};");
                    let unescaped = quick_xml::escape::unescape(&reference)
                        .map(|value| value.into_owned())
                        .unwrap_or(reference);
                    text.push_str(
                        &unescaped
                            .chars()
                            .take(MAX_TEXT_LENGTH - text.len())
                            .collect::<String>(),
                    );
                }
            }
            Ok(Event::End(event)) if event.name().as_ref() == b"testcase" => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| "invalid JUnit XML nesting".to_string())?;
                if let Some(mut result) = current.take() {
                    if !text.trim().is_empty() && result.details.is_none() {
                        result.details = Some(bounded(&text));
                    }
                    output.push(result);
                }
                text_target = None;
                text.clear();
            }
            Ok(Event::End(_)) => {
                let ending_depth = depth;
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| "invalid JUnit XML nesting".to_string())?;
                if text_target.is_some_and(|(_, target_depth)| target_depth == ending_depth) {
                    let (target, _) = text_target.take().unwrap();
                    if !text.trim().is_empty()
                        && (target == "failure"
                            || target == "error"
                            || target == "skipped"
                            || target == "system-out"
                            || target == "system-err")
                    {
                        if let Some(result) = current.as_mut() {
                            let content = bounded(&text);
                            if target == "failure" || target == "error" {
                                result.details = Some(content);
                            } else if target == "skipped" && result.message.is_none() {
                                result.message = Some(content);
                            } else if result.details.is_none() {
                                result.details = Some(content);
                            }
                        }
                    }
                    text.clear();
                }
            }
            Ok(Event::Start(_)) => depth += 1,
            Ok(Event::Eof) if depth == 0 && current.is_none() => break,
            Ok(Event::Eof) => return Err("invalid JUnit XML: unexpected end of file".into()),
            Err(error) => return Err(format!("invalid JUnit XML: {error}")),
            _ => {}
        }
    }
    Ok(())
}

fn collect_report_xml(current: &Path, depth: usize, scanned: &mut usize, files: &mut Vec<PathBuf>) {
    if files.len() >= MAX_RESULT_FILES || depth > MAX_SCAN_DEPTH || *scanned >= MAX_SCAN_DIRS {
        return;
    }
    *scanned += 1;
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        if files.len() >= MAX_RESULT_FILES || *scanned >= MAX_SCAN_DIRS {
            return;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() && !meta.file_type().is_symlink() {
            collect_report_xml(&path, depth + 1, scanned, files);
        } else if meta.is_file()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("xml"))
        {
            files.push(path);
        }
    }
}

fn collect_xml_files(current: &Path, depth: usize, scanned: &mut usize, files: &mut Vec<PathBuf>) {
    if files.len() >= MAX_RESULT_FILES || depth > MAX_SCAN_DEPTH || *scanned >= MAX_SCAN_DIRS {
        return;
    }
    *scanned += 1;
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        if files.len() >= MAX_RESULT_FILES || *scanned >= MAX_SCAN_DIRS {
            return;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if name == "target" {
            collect_report_xml(&path.join("surefire-reports"), depth + 1, scanned, files);
            collect_report_xml(&path.join("failsafe-reports"), depth + 1, scanned, files);
            continue;
        }
        if name == "build" {
            collect_report_xml(&path.join("test-results"), depth + 1, scanned, files);
            continue;
        }
        if matches!(
            name,
            ".git"
                | ".hg"
                | ".svn"
                | "node_modules"
                | "dist"
                | ".next"
                | ".cache"
                | ".venv"
                | "venv"
        ) {
            continue;
        }
        collect_xml_files(&path, depth + 1, scanned, files);
    }
}

pub fn parse_junit_xml(
    source: &str,
    path_hint: Option<&str>,
) -> Result<Vec<StructuredTestResult>, String> {
    let mut results = Vec::new();
    parse_xml(source, path_hint, &mut results)?;
    Ok(results)
}

pub fn read_junit_results(
    root: &Path,
    not_before_ms: Option<u64>,
) -> Result<StructuredTestResults, String> {
    let mut files = Vec::new();
    let mut scanned = 0;
    collect_xml_files(root, 0, &mut scanned, &mut files);
    files.sort();
    let mut results = Vec::new();
    let mut diagnostics = Vec::new();
    for path in &files {
        let Ok(meta) = fs::metadata(&path) else {
            diagnostics.push(format!(
                "Skipped result file that disappeared during scan: {}",
                path.display()
            ));
            continue;
        };
        if let Some(not_before_ms) = not_before_ms {
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64);
            if modified_ms.is_some_and(|modified_ms| modified_ms < not_before_ms) {
                diagnostics.push(format!("Skipped stale result file {}", path.display()));
                continue;
            }
        }
        if meta.len() > MAX_RESULT_BYTES {
            diagnostics.push(format!("Skipped oversized result file {}", path.display()));
            continue;
        }
        let Ok(xml) = fs::read_to_string(&path) else {
            diagnostics.push(format!("Skipped unreadable result file {}", path.display()));
            continue;
        };
        let hint = path
            .strip_prefix(root)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        if let Err(error) = parse_xml(&xml, hint.as_deref(), &mut results) {
            diagnostics.push(format!("{}: {error}", path.display()));
        }
    }
    let mut summary = StructuredTestSummary {
        total: results.len(),
        passed: 0,
        failed: 0,
        skipped: 0,
        errors: 0,
        duration_ms: 0,
    };
    for result in &results {
        summary.duration_ms = summary
            .duration_ms
            .saturating_add(result.duration_ms.unwrap_or(0));
        match result.status {
            TestResultStatus::Passed => summary.passed += 1,
            TestResultStatus::Failed => summary.failed += 1,
            TestResultStatus::Skipped => summary.skipped += 1,
            TestResultStatus::Error => summary.errors += 1,
            TestResultStatus::Unknown => {}
        }
    }
    if files.is_empty() {
        diagnostics.push("No JUnit result files found under target/surefire-reports, target/failsafe-reports, or build/test-results".into());
    }
    Ok(StructuredTestResults {
        schema: "taomni.codeWorkspace.testResults".into(),
        version: 1,
        source: "junit-xml".into(),
        generated_at: chrono::Utc::now().timestamp_millis().max(0) as u64,
        results,
        summary,
        diagnostics,
    })
}

/// Read the latest bounded JUnit-style reports produced below one workspace
/// root. Build tools still own execution; this command only ingests reports.
#[tauri::command]
pub fn workspace_test_results(
    repo_root: String,
    not_before_ms: Option<u64>,
) -> Result<StructuredTestResults, String> {
    let root = fs::canonicalize(&repo_root)
        .map_err(|error| format!("canonicalize test result root {repo_root}: {error}"))?;
    if !root.is_dir() {
        return Err(format!(
            "Test result root is not a directory: {}",
            root.display()
        ));
    }
    read_junit_results(&root, not_before_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_statuses_and_bounded_details() {
        let xml = r#"<testsuite><testcase classname="CalcTest" name="adds" time="0.012"/><testcase classname="CalcTest" name="fails" line="8"><failure message="expected 2">stack trace</failure></testcase><testcase classname="CalcTest" name="skips"><skipped message="disabled"/></testcase></testsuite>"#;
        let results = parse_junit_xml(xml, Some("target/surefire-reports/TEST.xml")).unwrap();
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].status, TestResultStatus::Passed);
        assert_eq!(results[0].duration_ms, Some(12));
        assert_eq!(results[1].status, TestResultStatus::Failed);
        assert_eq!(results[1].selector, "CalcTest#fails");
        assert_eq!(results[1].details.as_deref(), Some("stack trace"));
        assert_eq!(results[2].status, TestResultStatus::Skipped);
    }

    #[test]
    fn keeps_selector_stable_and_ids_unique_for_duplicate_cases() {
        let xml = r#"<testsuite><testcase classname="CalcTest" name="same"/><testcase classname="CalcTest" name="same"/></testsuite>"#;
        let results = parse_junit_xml(xml, Some("module-a/TEST.xml")).unwrap();
        assert_eq!(
            results
                .iter()
                .map(|result| result.selector.as_str())
                .collect::<Vec<_>>(),
            ["CalcTest#same", "CalcTest#same",]
        );
        assert_eq!(results[0].id, "module-a/TEST.xml::CalcTest#same");
        assert_eq!(results[1].id, "module-a/TEST.xml::CalcTest#same::2");
    }

    #[test]
    fn preserves_nested_failure_text_and_decodes_entities() {
        let xml = r#"<testsuite><testcase classname="CalcTest" name="fails"><failure message="expected &lt;2&gt;">first &amp; <frame>second</frame><![CDATA[ third ]]></failure><system-out>ignored output</system-out></testcase></testsuite>"#;
        let results = parse_junit_xml(xml, None).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].message.as_deref(), Some("expected <2>"));
        assert_eq!(results[0].details.as_deref(), Some("first & second third"));
    }

    #[test]
    fn scans_only_known_report_directories_and_filters_stale_files() {
        let root = tempfile::tempdir().unwrap();
        let known = root.path().join("target/surefire-reports");
        let gradle = root.path().join("module/build/test-results/test");
        let ignored = root.path().join("reports");
        fs::create_dir_all(&known).unwrap();
        fs::create_dir_all(&gradle).unwrap();
        fs::create_dir_all(&ignored).unwrap();
        let xml = r#"<testsuite><testcase classname="CalcTest" name="ok"/></testsuite>"#;
        fs::write(known.join("TEST-known.xml"), xml).unwrap();
        fs::write(gradle.join("TEST-gradle.xml"), xml).unwrap();
        fs::write(ignored.join("not-a-provider.xml"), xml).unwrap();

        let all = read_junit_results(root.path(), Some(0)).unwrap();
        assert_eq!(all.results.len(), 2);
        assert!(
            all.results
                .iter()
                .all(|result| result.id.contains("target/") || result.id.contains("module/"))
        );

        let future = chrono::Utc::now().timestamp_millis().max(0) as u64 + 60_000;
        let stale = read_junit_results(root.path(), Some(future)).unwrap();
        assert!(stale.results.is_empty());
        assert!(
            stale
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.contains("Skipped stale result file"))
        );
    }

    #[test]
    fn rejects_malformed_xml_and_case_floods() {
        assert!(parse_junit_xml("<testsuite>", None).is_err());
        let many = (0..=MAX_TEST_CASES)
            .map(|i| format!("<testcase name=\"{i}\"/>"))
            .collect::<String>();
        assert!(parse_junit_xml(&format!("<testsuite>{many}</testsuite>"), None).is_err());
    }
}
