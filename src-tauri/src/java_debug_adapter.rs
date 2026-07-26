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
    file_path: Option<String>,
}

/// Parse `vscode.java.resolveMainClass` output (`[{ mainClass, projectName, filePath }]`).
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
                        file_path: item
                            .get("filePath")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Normalize a path for comparison: forward slashes + lowercase (Windows
/// paths from jdtls and from the frontend differ in slash direction and
/// drive-letter case).
fn comparable_path(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// Pick the main class to launch: the candidate declared in the active file
/// ("debug the file I'm looking at", like IDEA's run gutter), else the first.
/// jdtls returns the whole workspace's mains in arbitrary order, so taking the
/// first blindly can launch a different class than the one on screen.
fn pick_main_class(
    candidates: Vec<MainClassCandidate>,
    target_file: &str,
) -> Option<MainClassCandidate> {
    let target = comparable_path(target_file);
    candidates
        .iter()
        .find(|c| c.file_path.as_deref().is_some_and(|p| comparable_path(p) == target))
        .cloned()
        .or_else(|| candidates.into_iter().next())
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

/// IDEA-like stepping defaults: step-into skips JDK internals, synthetic/bridge
/// methods, and static initializers ("$JDK" is java-debug's magic token for the
/// JDK class set).
fn default_step_filters() -> Value {
    json!({
        "skipClasses": ["$JDK"],
        "skipSynthetics": true,
        "skipStaticInitializers": true,
        "skipConstructors": false,
    })
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
        // internalConsole: java-debug launches the debuggee itself and streams
        // stdout/stderr via `output` events. We do NOT use integratedTerminal
        // because that requires answering the `runInTerminal` reverse request,
        // which the DAP kernel does not implement (see initialize capabilities).
        "console": cfg.get("console").and_then(Value::as_str).unwrap_or("internalConsole"),
    });
    // Optional passthroughs from the caller.
    for key in [
        "args",
        "vmArgs",
        "cwd",
        "env",
        "noDebug",
        "stepFilters",
        "stopOnEntry",
        "sourcePaths",
        "encoding",
        "shortenCommandLine",
    ] {
        if let Some(value) = cfg.get(key) {
            args[key] = value.clone();
        }
    }
    if args.get("stepFilters").is_none() {
        args["stepFilters"] = default_step_filters();
    }
    // A resolved Maven/Gradle classpath easily exceeds the OS command-line limit
    // (32 KB on Windows → "CreateProcess error=206"). java-debug defaults to no
    // shortening; "auto" makes it fall back to an @argfile / jar manifest only
    // when needed — the same thing IDEA's "shorten command line" does.
    if args.get("shortenCommandLine").is_none() {
        args["shortenCommandLine"] = json!("auto");
    }
    if let Some(java_exec) = java_exec.filter(|s| !s.is_empty()) {
        args["javaExec"] = json!(java_exec);
    }
    args
}

/// Assemble java-debug `attach` arguments (IDEA's "Remote JVM Debug"): connect
/// to a JVM already running with `-agentlib:jdwp=...,server=y,address=<port>`.
/// No main class or classpath resolution is involved — the debuggee exists — but
/// `projectName` still scopes source lookup so breakpoints bind to workspace
/// sources. Pure — unit-tested.
fn build_attach_arguments(cfg: &Value) -> Result<Value, String> {
    let port = cfg
        .get("port")
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
        .filter(|p| *p > 0 && *p <= u16::MAX as u64)
        .ok_or("Java attach needs a debug `port` (the JVM's jdwp address)")?;
    let host = cfg
        .get("hostName")
        .or_else(|| cfg.get("host"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("localhost");
    let mut args = json!({
        "type": "java",
        "name": format!("Attach {host}:{port}"),
        "request": "attach",
        "hostName": host,
        "port": port,
    });
    for key in ["projectName", "sourcePaths", "timeout", "stepFilters", "processId"] {
        if let Some(value) = cfg.get(key) {
            args[key] = value.clone();
        }
    }
    if args.get("stepFilters").is_none() {
        args["stepFilters"] = default_step_filters();
    }
    Ok(args)
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

        // 0) Attach (IDEA "Remote JVM Debug"): the debuggee already runs, so no
        //    main class / classpath / JVM resolution — only the adapter port.
        if launch_config.get("request").and_then(Value::as_str) == Some("attach") {
            let arguments = build_attach_arguments(launch_config)?;
            let port_value = run("vscode.java.startDebugSession", vec![]).await?;
            let port = parse_debug_port(&port_value)
                .ok_or("java-debug did not return a debug session port")?;
            return Ok(DapLaunchPlan {
                transport: DapTransport::Tcp { host: "127.0.0.1".into(), port },
                request: "attach".into(),
                arguments,
            });
        }

        // 1) Main class: honor an explicit one, else resolve the workspace's mains.
        let explicit_main = launch_config
            .get("mainClass")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let explicit_project = launch_config
            .get("projectName")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let (main_class, project_name) = match (explicit_main, explicit_project) {
            (Some(main_class), Some(project_name)) => {
                (main_class.to_string(), project_name.to_string())
            }
            // An explicit main class without a project: classpath resolution needs
            // the owning project, so look it up among the workspace's mains rather
            // than sending an empty projectName (which resolves the wrong module in
            // multi-module builds).
            (Some(main_class), None) => {
                let resolved = run("vscode.java.resolveMainClass", vec![]).await.unwrap_or(Value::Null);
                let project = parse_main_classes(&resolved)
                    .into_iter()
                    .find(|c| c.main_class == main_class)
                    .map(|c| c.project_name)
                    .unwrap_or_default();
                (main_class.to_string(), project)
            }
            _ => {
                let resolved = run("vscode.java.resolveMainClass", vec![]).await?;
                let candidate = pick_main_class(parse_main_classes(&resolved), &scope.file_path)
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
        assert_eq!(mains[0].file_path.as_deref(), Some("/x/App.java"));
        assert!(parse_main_classes(&Value::Null).is_empty());
    }

    #[test]
    fn picks_the_main_class_declared_in_the_active_file() {
        let candidates = vec![
            MainClassCandidate {
                main_class: "com.example.Other".into(),
                project_name: "demo".into(),
                file_path: Some("D:\\repo\\src\\Other.java".into()),
            },
            MainClassCandidate {
                main_class: "com.example.App".into(),
                project_name: "demo".into(),
                file_path: Some("D:\\repo\\src\\App.java".into()),
            },
        ];
        // Slash direction + drive-letter case differences must not break matching.
        let picked = pick_main_class(candidates.clone(), "d:/repo/src/App.java").unwrap();
        assert_eq!(picked.main_class, "com.example.App");
        // No file match: fall back to the first candidate.
        let fallback = pick_main_class(candidates, "/elsewhere/Main.java").unwrap();
        assert_eq!(fallback.main_class, "com.example.Other");
        assert!(pick_main_class(vec![], "/x.java").is_none());
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
        // Default console when unset: internalConsole (the kernel does not
        // implement the `runInTerminal` reverse request).
        assert_eq!(args["console"], "internalConsole");
        // Long classpaths must not blow the OS command-line limit.
        assert_eq!(args["shortenCommandLine"], "auto");
    }

    #[test]
    fn honors_an_explicit_shorten_command_line_and_extra_passthroughs() {
        let cfg = json!({
            "shortenCommandLine": "argfile",
            "stopOnEntry": true,
            "sourcePaths": ["/repo/src/main/java"],
            "encoding": "UTF-8",
        });
        let args = build_launch_arguments(&cfg, "App", "demo", &[], &[], None);
        assert_eq!(args["shortenCommandLine"], "argfile");
        assert_eq!(args["stopOnEntry"], json!(true));
        assert_eq!(args["sourcePaths"], json!(["/repo/src/main/java"]));
        assert_eq!(args["encoding"], "UTF-8");
    }

    #[test]
    fn builds_attach_arguments_for_a_remote_jvm() {
        let args = build_attach_arguments(&json!({
            "hostName": "10.0.0.7", "port": 5005, "projectName": "demo",
        }))
        .unwrap();
        assert_eq!(args["request"], "attach");
        assert_eq!(args["hostName"], "10.0.0.7");
        assert_eq!(args["port"], 5005);
        assert_eq!(args["projectName"], "demo");
        assert_eq!(args["stepFilters"]["skipSynthetics"], json!(true));
        // The host defaults to localhost, and a string port is accepted.
        let local = build_attach_arguments(&json!({ "port": "5005" })).unwrap();
        assert_eq!(local["hostName"], "localhost");
        assert_eq!(local["port"], 5005);
        // A missing / unusable port is a clear error, not a bad attach.
        assert!(build_attach_arguments(&json!({ "hostName": "h" })).is_err());
        assert!(build_attach_arguments(&json!({ "port": 0 })).is_err());
        assert!(build_attach_arguments(&json!({ "port": 99999 })).is_err());
    }

    #[test]
    fn defaults_idea_like_step_filters_and_honors_overrides() {
        let args = build_launch_arguments(&json!({}), "App", "demo", &[], &[], None);
        assert_eq!(args["stepFilters"]["skipClasses"], json!(["$JDK"]));
        assert_eq!(args["stepFilters"]["skipSynthetics"], json!(true));
        assert_eq!(args["stepFilters"]["skipStaticInitializers"], json!(true));
        assert_eq!(args["stepFilters"]["skipConstructors"], json!(false));

        let cfg = json!({ "stepFilters": { "skipClasses": [], "skipSynthetics": false } });
        let overridden = build_launch_arguments(&cfg, "App", "demo", &[], &[], None);
        assert_eq!(overridden["stepFilters"], cfg["stepFilters"]);
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
