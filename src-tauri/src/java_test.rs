//! Java test discovery (M8 E) via jdtls + the java-test bundle.
//!
//! `vscode.java.test.findTestTypesAndMethods [uri]` returns a tree of test items
//! (classes → methods). We parse it into a language-agnostic-ish `JavaTestItem`
//! tree the frontend renders; running is done through the integrated terminal
//! (reusing the task runner) this iteration. Structured pass/fail results and
//! debug-test (via the D2 DAP path) are a follow-up — that needs the JUnit
//! result socket protocol, which is entirely real-device.

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

/// A discovered test node (class or method), mirroring java-test's tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaTestItem {
    /// Display name (short label, e.g. the method or class simple name).
    pub name: String,
    /// Fully-qualified identifier (class FQN, or `Class#method`) — stable id.
    pub full_name: String,
    /// `"class"` | `"method"` | `"other"` (folders/packages/roots).
    pub kind: String,
    /// Owning file URI, when the item reports one.
    pub uri: Option<String>,
    /// Raw DAP-free source range (`{ start, end }`) for gutter/jump, when present.
    pub range: Option<Value>,
    pub children: Vec<JavaTestItem>,
}

/// Map java-test's numeric `testLevel` to our coarse kind. java-test levels:
/// root/folder/package are containers, class=type, method is a leaf test.
fn kind_from_level(level: Option<i64>, has_children: bool) -> &'static str {
    match level {
        // Known java-test TestLevel values (Class=4-ish, Method=5-ish across
        // versions); fall back to structure when the level is absent/unknown.
        Some(l) if l >= 5 => "method",
        Some(4) => "class",
        Some(_) => "other",
        None => {
            if has_children {
                "class"
            } else {
                "method"
            }
        }
    }
}
/// Parse one java-test node. Field names vary slightly across java-test
/// versions, so accept the common aliases (`fullName`/`jdtHandler`/`id`,
/// `displayName`/`label`/`name`, `testLevel`/`level`, `children`/`tests`).
fn parse_test_item(value: &Value) -> Option<JavaTestItem> {
    let full_name = value
        .get("fullName")
        .or_else(|| value.get("jdtHandler"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_string();
    let name = value
        .get("displayName")
        .or_else(|| value.get("label"))
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        // Fall back to the last segment of the fully-qualified name.
        .unwrap_or_else(|| {
            full_name
                .rsplit(['#', '.'])
                .next()
                .unwrap_or(&full_name)
                .to_string()
        });
    let children_raw = value
        .get("children")
        .or_else(|| value.get("tests"))
        .and_then(Value::as_array);
    let children: Vec<JavaTestItem> = children_raw
        .map(|items| items.iter().filter_map(parse_test_item).collect())
        .unwrap_or_default();
    let level = value
        .get("testLevel")
        .or_else(|| value.get("level"))
        .and_then(Value::as_i64);
    Some(JavaTestItem {
        name,
        kind: kind_from_level(level, !children.is_empty()).to_string(),
        uri: value
            .get("uri")
            .or_else(|| value.get("location").and_then(|l| l.get("uri")))
            .and_then(Value::as_str)
            .map(str::to_string),
        range: value
            .get("range")
            .cloned()
            .or_else(|| value.get("location").and_then(|l| l.get("range")).cloned()),
        full_name,
        children,
    })
}

/// Parse the full `findTestTypesAndMethods` response (an array of test items).
fn parse_test_items(value: &Value) -> Vec<JavaTestItem> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_test_item).collect())
        .unwrap_or_default()
}

/// Discover the test classes/methods in a Java file via the java-test bundle
/// (M8 E). Returns an empty list when the file has no tests; errors when no
/// jdtls session is active or the java-test bundle is not loaded.
#[tauri::command]
pub async fn java_test_discover(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
) -> Result<Vec<JavaTestItem>, String> {
    // The java-test command keys on the file's own URI; derive it from the path
    // (same file: URI the language server sees) so the frontend need not build it.
    let uri = crate::java_test::file_uri(root_path.as_deref(), &file_path)?;
    let result = state
        .lsp
        .execute_java_command(
            workspace_id,
            root_path,
            file_path,
            "vscode.java.test.findTestTypesAndMethods",
            vec![Value::String(uri)],
        )
        .await?;
    Ok(parse_test_items(&result))
}

/// Build the `file:` URI for a (possibly root-relative) path.
fn file_uri(root_path: Option<&str>, file_path: &str) -> Result<String, String> {
    use std::path::{Path, PathBuf};
    let path = Path::new(file_path);
    let absolute: PathBuf = if path.is_absolute() {
        path.to_path_buf()
    } else if let Some(root) = root_path.map(str::trim).filter(|r| !r.is_empty()) {
        Path::new(root).join(path)
    } else {
        path.to_path_buf()
    };
    url::Url::from_file_path(&absolute)
        .map(|url| url.to_string())
        .map_err(|_| format!("Cannot build file URI for {}", absolute.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_class_with_method_children() {
        let value = json!([
            {
                "fullName": "com.example.CalcTest",
                "displayName": "CalcTest",
                "testLevel": 4,
                "uri": "file:///repo/src/test/CalcTest.java",
                "children": [
                    { "fullName": "com.example.CalcTest#adds", "displayName": "adds", "testLevel": 5 },
                    { "fullName": "com.example.CalcTest#subtracts", "displayName": "subtracts", "testLevel": 5 }
                ]
            }
        ]);
        let items = parse_test_items(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, "class");
        assert_eq!(items[0].name, "CalcTest");
        assert_eq!(items[0].uri.as_deref(), Some("file:///repo/src/test/CalcTest.java"));
        assert_eq!(items[0].children.len(), 2);
        assert_eq!(items[0].children[0].kind, "method");
        assert_eq!(items[0].children[0].full_name, "com.example.CalcTest#adds");
    }

    #[test]
    fn infers_kind_from_structure_when_level_absent() {
        let value = json!([
            {
                "id": "com.example.FooTest",
                "children": [ { "id": "com.example.FooTest#bar" } ]
            }
        ]);
        let items = parse_test_items(&value);
        assert_eq!(items[0].kind, "class"); // has children
        assert_eq!(items[0].name, "FooTest"); // derived from fullName tail
        assert_eq!(items[0].children[0].kind, "method"); // leaf
        assert_eq!(items[0].children[0].name, "bar");
    }

    #[test]
    fn tolerates_empty_and_malformed() {
        assert!(parse_test_items(&Value::Null).is_empty());
        assert!(parse_test_items(&json!([])).is_empty());
        // Items without any id/fullName are skipped.
        assert!(parse_test_items(&json!([{ "displayName": "x" }])).is_empty());
    }

    #[test]
    fn reads_location_aliases_for_uri_and_range() {
        let value = json!([
            {
                "fullName": "T",
                "location": { "uri": "file:///T.java", "range": { "start": { "line": 3 } } }
            }
        ]);
        let items = parse_test_items(&value);
        assert_eq!(items[0].uri.as_deref(), Some("file:///T.java"));
        assert_eq!(items[0].range.as_ref().unwrap()["start"]["line"], 3);
    }
}

