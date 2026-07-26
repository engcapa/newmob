//! Java debug adapter (M8 D2) — the first `DebugAdapter` and the ONLY
//! language-specific debug code. It drives jdtls + the java-debug bundle to
//! resolve a launch, then hands a TCP transport (java-debug listens on a port)
//! and the resolved `launch` arguments to the language-agnostic DAP kernel (D1).
//!
//! jdtls/java-debug commands used (via `LspManager::execute_java_command`):
//! - `vscode.java.resolveMainClass`   → `[{ mainClass, projectName, filePath }]`
//! - `vscode.java.resolveClasspath`   [mainClass, projectName] → `[[modulepaths],[classpaths]]`
//! - `vscode.java.resolveJavaExecutable` [mainClass, projectName] → java exe path
//! - `vscode.java.startDebugSession`  → port (number) the adapter listens on

use crate::dap::{DapLaunchPlan, DapTransport, DebugAdapter};
use crate::lsp::LspManager;
use serde_json::{Value, json};
use std::sync::Arc;

pub struct JavaDebugAdapter {
    lsp: Arc<LspManager>,
}

impl JavaDebugAdapter {
    pub fn new(lsp: Arc<LspManager>) -> Self {
        Self { lsp }
    }
}

/// Where the launch config addresses the jdtls session (a project file selects it).
struct SessionScope {
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
}

fn session_scope(cfg: &Value) -> Result<SessionScope, String> {
    let file_path = cfg
        .get("filePath")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("Java debug launch config needs a filePath to select the jdtls session")?
        .to_string();
    Ok(SessionScope {
        workspace_id: cfg
            .get("workspaceId")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_string(),
        root_path: cfg
            .get("rootPath")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string),
        file_path,
    })
}
/// A resolved main class candidate from `vscode.java.resolveMainClass`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MainClassCandidate {
    main_class: String,
    project_name: String,
}

/// Parse `vscode.java.resolveMainClass` output (`[{ mainClass, projectName }]`).
fn parse_main_classes(value: &Value) -> Vec<MainClassCandidate> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let main_class = item.get("mainClass").and_then(Value::as_str)?;
                    if main_class.is_empty() {
                        return None;
                    }
                    Some(MainClassCandidate {
                        main_class: main_class.to_string(),
                        project_name: item
                            .get("projectName")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Parse `vscode.java.resolveClasspath` output — a `[[modulepaths],[classpaths]]`
/// pair — into `(modulepaths, classpaths)`.
fn parse_classpath(value: &Value) -> (Vec<String>, Vec<String>) {
    let as_strings = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|entry| entry.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let outer = value.as_array();
    let modulepaths = as_strings(outer.and_then(|o| o.first()));
    let classpaths = as_strings(outer.and_then(|o| o.get(1)));
    (modulepaths, classpaths)
}

/// Extract the port from `vscode.java.startDebugSession` (a bare number, or an
/// object with a `port` field depending on the java-debug version).
fn parse_debug_port(value: &Value) -> Option<u16> {
    if let Some(port) = value.as_u64() {
        return u16::try_from(port).ok();
    }
    value
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
}

/// Assemble the java-debug `launch` request arguments from the resolved pieces
/// plus optional overrides in the launch config (`args`/`vmArgs`/`cwd`/`env`/
/// `console`/`noDebug`). Pure — unit-tested.
fn build_launch_arguments(
    cfg: &Value,
    main_class: &str,
    project_name: &str,
    modulepaths: &[String],
    classpaths: &[String],
    java_exec: Option<&str>,
) -> Value {
    let mut args = json!({
        "type": "java",
        "name": format!("Debug {main_class}"),
        "request": "launch",
        "mainClass": main_class,
        "projectName": project_name,
        "modulePaths": modulepaths,
        "classPaths": classpaths,
        "console": cfg.get("console").and_then(Value::as_str).unwrap_or("integratedTerminal"),
    });
    // Optional passthroughs from the caller.
    for key in ["args", "vmArgs", "cwd", "env", "noDebug", "stepFilters"] {
        if let Some(value) = cfg.get(key) {
            args[key] = value.clone();
        }
    }
    if let Some(java_exec) = java_exec.filter(|s| !s.is_empty()) {
        args["javaExec"] = json!(java_exec);
    }
    args
}
#[async_trait::async_trait]
impl DebugAdapter for JavaDebugAdapter {
    fn id(&self) -> &str {
        "java"
    }

    async fn resolve(&self, launch_config: &Value) -> Result<DapLaunchPlan, String> {
        let scope = session_scope(launch_config)?;
        let run = |command: &'static str, arguments: Vec<Value>| {
            let lsp = self.lsp.clone();
            let workspace_id = scope.workspace_id.clone();
            let root_path = scope.root_path.clone();
            let file_path = scope.file_path.clone();
            async move {
                lsp.execute_java_command(workspace_id, root_path, file_path, command, arguments)
                    .await
            }
        };

        // 1) Main class: honor an explicit one, else resolve the workspace's mains.
        let (main_class, project_name) = match (
            launch_config.get("mainClass").and_then(Value::as_str),
            launch_config.get("projectName").and_then(Value::as_str),
        ) {
            (Some(main_class), project_name) if !main_class.is_empty() => {
                (main_class.to_string(), project_name.unwrap_or("").to_string())
            }
            _ => {
                let resolved = run("vscode.java.resolveMainClass", vec![]).await?;
                let candidate = parse_main_classes(&resolved)
                    .into_iter()
                    .next()
                    .ok_or("No runnable main class found in this Java project")?;
                (candidate.main_class, candidate.project_name)
            }
        };

        // 2) Classpath + java executable. When the caller already resolved the
        //    classpath (debug-test passes java-test's JUnit launch config), skip
        //    jdtls resolution and use the provided paths.
        let preset_classpaths = launch_config
            .get("classPaths")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>())
            .filter(|paths| !paths.is_empty());
        let (modulepaths, classpaths) = if let Some(classpaths) = preset_classpaths {
            let modulepaths = launch_config
                .get("modulePaths")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            (modulepaths, classpaths)
        } else {
            let cp_args = vec![json!(main_class), json!(project_name)];
            let classpath = run("vscode.java.resolveClasspath", cp_args).await?;
            parse_classpath(&classpath)
        };
        let java_exec = run(
            "vscode.java.resolveJavaExecutable",
            vec![json!(main_class), json!(project_name)],
        )
        .await
        .ok()
        .and_then(|v| v.as_str().map(str::to_string));

        // 3) Ask java-debug to start listening; it returns the port we connect to.
        let port_value = run("vscode.java.startDebugSession", vec![]).await?;
        let port = parse_debug_port(&port_value)
            .ok_or("java-debug did not return a debug session port")?;

        let arguments = build_launch_arguments(
            launch_config,
            &main_class,
            &project_name,
            &modulepaths,
            &classpaths,
            java_exec.as_deref(),
        );
        Ok(DapLaunchPlan {
            transport: DapTransport::Tcp {
                host: "127.0.0.1".into(),
                port,
            },
            request: "launch".into(),
            arguments,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_main_class_candidates_and_skips_empty() {
        let value = json!([
            { "mainClass": "com.example.App", "projectName": "demo", "filePath": "/x/App.java" },
            { "mainClass": "", "projectName": "demo" },
            { "projectName": "demo" },
        ]);
        let mains = parse_main_classes(&value);
        assert_eq!(mains.len(), 1);
        assert_eq!(mains[0].main_class, "com.example.App");
        assert_eq!(mains[0].project_name, "demo");
        assert!(parse_main_classes(&Value::Null).is_empty());
    }

    #[test]
    fn parses_modulepaths_and_classpaths_pair() {
        let value = json!([["/mods/a.jar"], ["/cp/b.jar", "/cp/c.jar"]]);
        let (modulepaths, classpaths) = parse_classpath(&value);
        assert_eq!(modulepaths, vec!["/mods/a.jar"]);
        assert_eq!(classpaths, vec!["/cp/b.jar", "/cp/c.jar"]);
        // Tolerates a missing modulepaths slot.
        let (mp, cp) = parse_classpath(&json!([[], ["/only/cp.jar"]]));
        assert!(mp.is_empty());
        assert_eq!(cp, vec!["/only/cp.jar"]);
    }

    #[test]
    fn parses_debug_port_from_number_or_object() {
        assert_eq!(parse_debug_port(&json!(51234)), Some(51234));
        assert_eq!(parse_debug_port(&json!({ "port": 6006 })), Some(6006));
        assert_eq!(parse_debug_port(&json!("nope")), None);
        assert_eq!(parse_debug_port(&json!(70000)), None); // out of u16 range
    }

    #[test]
    fn builds_launch_arguments_with_resolved_and_override_fields() {
        let cfg = json!({
            "filePath": "/repo/src/App.java",
            "args": "--flag",
            "vmArgs": "-Xmx1g",
            "cwd": "/repo",
        });
        let args = build_launch_arguments(
            &cfg,
            "com.example.App",
            "demo",
            &["/mods/a.jar".into()],
            &["/cp/b.jar".into()],
            Some("/jdk/bin/java"),
        );
        assert_eq!(args["request"], "launch");
        assert_eq!(args["mainClass"], "com.example.App");
        assert_eq!(args["projectName"], "demo");
        assert_eq!(args["classPaths"], json!(["/cp/b.jar"]));
        assert_eq!(args["modulePaths"], json!(["/mods/a.jar"]));
        assert_eq!(args["args"], "--flag");
        assert_eq!(args["vmArgs"], "-Xmx1g");
        assert_eq!(args["cwd"], "/repo");
        assert_eq!(args["javaExec"], "/jdk/bin/java");
        // Default console when unset.
        assert_eq!(args["console"], "integratedTerminal");
    }

    #[test]
    fn session_scope_requires_file_path() {
        assert!(session_scope(&json!({ "workspaceId": "w" })).is_err());
        let scope = session_scope(&json!({
            "workspaceId": "w", "rootPath": "/r", "filePath": "/r/App.java"
        }))
        .unwrap();
        assert_eq!(scope.workspace_id, "w");
        assert_eq!(scope.root_path.as_deref(), Some("/r"));
        assert_eq!(scope.file_path, "/r/App.java");
    }
}
