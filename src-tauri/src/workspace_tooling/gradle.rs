use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradleToolingRequest {
    pub workspace_root: String,
    pub trusted: bool,
    pub java_home: Option<String>,
    pub gradle_executable: Option<String>,
    #[serde(default)]
    pub offline: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GradleToolingProvenance {
    pub tool_kind: String,
    pub tool_version: Option<String>,
    pub java_home: Option<String>,
    pub java_version: Option<String>,
    pub argv: Vec<String>,
    pub cwd: String,
    pub settings_hash: String,
    pub resolved_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GradleModuleStructure {
    pub id: String,
    pub name: String,
    pub root: String,
    pub build_file: String,
    pub source_roots: Vec<String>,
    pub test_roots: Vec<String>,
    pub resource_roots: Vec<String>,
    pub output_dir: Option<String>,
    pub dependencies: Vec<String>,
    pub classpath: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GradleToolingResult {
    pub status: String, // "ready" | "untrusted" | "degraded" | "failed"
    pub modules: Vec<GradleModuleStructure>,
    pub provenance: Option<GradleToolingProvenance>,
    pub error_message: Option<String>,
}

#[tauri::command]
pub fn workspace_ingest_gradle_project(
    request: GradleToolingRequest,
) -> Result<GradleToolingResult, String> {
    Ok(ingest_gradle_tooling(&request))
}

pub fn ingest_gradle_tooling(request: &GradleToolingRequest) -> GradleToolingResult {
    // 1. Trust boundary: untrusted workspaces spawn 0 processes and produce untrusted status.
    if !request.trusted {
        return GradleToolingResult {
            status: "untrusted".to_string(),
            modules: vec![],
            provenance: None,
            error_message: Some(
                "Workspace is untrusted; Gradle tooling execution refused (process=0)".to_string(),
            ),
        };
    }

    let root_path = Path::new(&request.workspace_root);
    let settings_groovy = root_path.join("settings.gradle");
    let settings_kotlin = root_path.join("settings.gradle.kts");
    let build_groovy = root_path.join("build.gradle");
    let build_kotlin = root_path.join("build.gradle.kts");

    let settings_file = if settings_groovy.is_file() {
        Some(settings_groovy)
    } else if settings_kotlin.is_file() {
        Some(settings_kotlin)
    } else {
        None
    };

    let has_build_file = build_groovy.is_file() || build_kotlin.is_file();

    if settings_file.is_none() && !has_build_file {
        return GradleToolingResult {
            status: "failed".to_string(),
            modules: vec![],
            provenance: None,
            error_message: Some(format!(
                "No Gradle build scripts (settings.gradle, build.gradle) found at {}",
                root_path.display()
            )),
        };
    }

    // Compute settings/build file hash
    let hash_source_path = settings_file.as_ref().unwrap_or(if build_groovy.is_file() {
        &build_groovy
    } else {
        &build_kotlin
    });
    let Ok(hash_source_contents) = fs::read_to_string(hash_source_path) else {
        return GradleToolingResult {
            status: "failed".to_string(),
            modules: vec![],
            provenance: None,
            error_message: Some(format!(
                "Failed to read Gradle file at {}",
                hash_source_path.display()
            )),
        };
    };

    let mut hasher = Sha256::new();
    hasher.update(hash_source_contents.as_bytes());
    let settings_hash = hex::encode(hasher.finalize());

    // Resolve tool kind
    let (tool_kind, wrapper_path) =
        detect_gradle_executable(root_path, request.gradle_executable.as_deref());

    let mut argv = vec![wrapper_path.clone()];
    if request.offline {
        argv.push("--offline".to_string());
    }
    argv.push("projects".to_string());

    let provenance = GradleToolingProvenance {
        tool_kind,
        tool_version: None,
        java_home: request.java_home.clone(),
        java_version: None,
        argv,
        cwd: request.workspace_root.clone(),
        settings_hash,
        resolved_at: chrono::Utc::now().to_rfc3339(),
    };

    let mut modules = Vec::new();

    // 1. Root project module
    let root_build_file = if build_groovy.is_file() {
        build_groovy.to_string_lossy().to_string()
    } else if build_kotlin.is_file() {
        build_kotlin.to_string_lossy().to_string()
    } else {
        "".to_string()
    };

    let root_project_name = extract_root_project_name(&hash_source_contents).unwrap_or_else(|| {
        root_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("root")
            .to_string()
    });

    let root_module = parse_gradle_module(
        ":",
        &root_project_name,
        root_path,
        if root_build_file.is_empty() {
            None
        } else {
            Some(Path::new(&root_build_file))
        },
    );
    modules.push(root_module);

    // 2. Subprojects from settings.gradle(.kts)
    if let Some(settings_p) = &settings_file {
        if let Ok(settings_text) = fs::read_to_string(settings_p) {
            let included = extract_included_projects(&settings_text);
            for project_path in included {
                let module_rel_dir = project_path.trim_start_matches(':').replace(':', "/");
                let sub_dir = root_path.join(&module_rel_dir);
                let sub_name = project_path
                    .split(':')
                    .filter(|s| !s.is_empty())
                    .last()
                    .unwrap_or(&project_path)
                    .to_string();

                let sub_build_groovy = sub_dir.join("build.gradle");
                let sub_build_kotlin = sub_dir.join("build.gradle.kts");
                let sub_build_file = if sub_build_groovy.is_file() {
                    Some(sub_build_groovy)
                } else if sub_build_kotlin.is_file() {
                    Some(sub_build_kotlin)
                } else {
                    None
                };

                let sub_module = parse_gradle_module(
                    &project_path,
                    &sub_name,
                    &sub_dir,
                    sub_build_file.as_deref(),
                );
                modules.push(sub_module);
            }
        }
    }

    GradleToolingResult {
        status: "ready".to_string(),
        modules,
        provenance: Some(provenance),
        error_message: None,
    }
}

fn detect_gradle_executable(root: &Path, user_executable: Option<&str>) -> (String, String) {
    let gradlew_unix = root.join("gradlew");
    let gradlew_win = root.join("gradlew.bat");

    if gradlew_unix.is_file() {
        (
            "gradlew".to_string(),
            gradlew_unix.to_string_lossy().to_string(),
        )
    } else if gradlew_win.is_file() {
        (
            "gradlew".to_string(),
            gradlew_win.to_string_lossy().to_string(),
        )
    } else if let Some(exe) = user_executable {
        ("gradle".to_string(), exe.to_string())
    } else {
        ("gradle".to_string(), "gradle".to_string())
    }
}

fn extract_root_project_name(contents: &str) -> Option<String> {
    let pattern = r#"(?m)rootProject\.name\s*=\s*['"]([^'"]+)['"]"#;
    let regex = Regex::new(pattern).ok()?;
    regex
        .captures(contents)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn extract_included_projects(contents: &str) -> Vec<String> {
    let mut projects = Vec::new();
    let Ok(include_regex) =
        Regex::new(r#"(?m)include(?:\s+|\s*\(\s*)(['"][^'"]+['"](?:\s*,\s*['"][^'"]+['"])*)"#)
    else {
        return projects;
    };
    let Ok(item_regex) = Regex::new(r#"['"]([^'"]+)['"]"#) else {
        return projects;
    };

    for cap in include_regex.captures_iter(contents) {
        if let Some(list_match) = cap.get(1) {
            for item_cap in item_regex.captures_iter(list_match.as_str()) {
                if let Some(proj) = item_cap.get(1) {
                    let mut p = proj.as_str().trim().to_string();
                    if !p.starts_with(':') {
                        p = format!(":{}", p);
                    }
                    if !projects.contains(&p) {
                        projects.push(p);
                    }
                }
            }
        }
    }

    projects
}

fn parse_gradle_module(
    project_id: &str,
    project_name: &str,
    module_dir: &Path,
    build_file: Option<&Path>,
) -> GradleModuleStructure {
    let mut source_roots = Vec::new();
    let mut test_roots = Vec::new();
    let mut resource_roots = Vec::new();

    let main_java = module_dir.join("src/main/java");
    if main_java.is_dir() {
        source_roots.push(main_java.to_string_lossy().to_string());
    }
    let main_kotlin = module_dir.join("src/main/kotlin");
    if main_kotlin.is_dir() {
        source_roots.push(main_kotlin.to_string_lossy().to_string());
    }
    let main_groovy = module_dir.join("src/main/groovy");
    if main_groovy.is_dir() {
        source_roots.push(main_groovy.to_string_lossy().to_string());
    }
    let main_scala = module_dir.join("src/main/scala");
    if main_scala.is_dir() {
        source_roots.push(main_scala.to_string_lossy().to_string());
    }

    let test_java = module_dir.join("src/test/java");
    if test_java.is_dir() {
        test_roots.push(test_java.to_string_lossy().to_string());
    }
    let test_kotlin = module_dir.join("src/test/kotlin");
    if test_kotlin.is_dir() {
        test_roots.push(test_kotlin.to_string_lossy().to_string());
    }
    let test_groovy = module_dir.join("src/test/groovy");
    if test_groovy.is_dir() {
        test_roots.push(test_groovy.to_string_lossy().to_string());
    }

    let main_resources = module_dir.join("src/main/resources");
    if main_resources.is_dir() {
        resource_roots.push(main_resources.to_string_lossy().to_string());
    }

    let output_dir = Some(
        module_dir
            .join("build/classes/java/main")
            .to_string_lossy()
            .to_string(),
    );

    let mut dependencies = Vec::new();
    let mut classpath = Vec::new();

    if let Some(bf) = build_file {
        if let Ok(contents) = fs::read_to_string(bf) {
            dependencies = extract_gradle_dependencies(&contents);
            for dep in &dependencies {
                classpath.push(dep.clone());
            }
        }
    }

    GradleModuleStructure {
        id: project_id.to_string(),
        name: project_name.to_string(),
        root: module_dir.to_string_lossy().to_string(),
        build_file: build_file
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        source_roots,
        test_roots,
        resource_roots,
        output_dir,
        dependencies,
        classpath,
    }
}

fn extract_gradle_dependencies(contents: &str) -> Vec<String> {
    let mut dependencies = Vec::new();
    let Ok(dep_regex) = Regex::new(
        r#"(?m)(?:implementation|api|compileOnly|testImplementation|runtimeOnly)\s*(?:\(|\s+)\s*(?:project\s*\(\s*['"]([^'"]+)['"]\s*\)|['"]([^'"]+)['"])"#,
    ) else {
        return dependencies;
    };

    for cap in dep_regex.captures_iter(contents) {
        if let Some(proj) = cap.get(1) {
            dependencies.push(format!("project({})", proj.as_str()));
        } else if let Some(coord) = cap.get(2) {
            dependencies.push(coord.as_str().to_string());
        }
    }

    dependencies
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_untrusted_workspace_spawns_zero_processes() {
        let temp = tempdir().unwrap();
        let req = GradleToolingRequest {
            workspace_root: temp.path().to_string_lossy().to_string(),
            trusted: false,
            java_home: None,
            gradle_executable: None,
            offline: false,
        };

        let result = ingest_gradle_tooling(&req);
        assert_eq!(result.status, "untrusted");
        assert!(result.modules.is_empty());
        assert!(result.provenance.is_none());
        assert!(result.error_message.unwrap().contains("process=0"));
    }

    #[test]
    fn test_missing_gradle_build_scripts_fails_closed() {
        let temp = tempdir().unwrap();
        let req = GradleToolingRequest {
            workspace_root: temp.path().to_string_lossy().to_string(),
            trusted: true,
            java_home: None,
            gradle_executable: None,
            offline: false,
        };

        let result = ingest_gradle_tooling(&req);
        assert_eq!(result.status, "failed");
        assert!(result.modules.is_empty());
        assert!(
            result
                .error_message
                .unwrap()
                .contains("No Gradle build scripts")
        );
    }

    #[test]
    fn test_multi_module_gradle_ingestion_with_provenance() {
        let temp = tempdir().unwrap();
        let root = temp.path();

        // Create gradlew wrapper
        fs::write(root.join("gradlew"), "#!/bin/sh\necho gradlew").unwrap();

        // Create settings.gradle
        let settings = r#"
rootProject.name = 'my-multiproject'
include ':app', ':core:domain', ':core:data'
"#;
        fs::write(root.join("settings.gradle"), settings).unwrap();

        // Create root build.gradle
        fs::write(root.join("build.gradle"), "// root build").unwrap();

        // Create :app module
        let app_dir = root.join("app");
        fs::create_dir_all(app_dir.join("src/main/java/com/example")).unwrap();
        fs::create_dir_all(app_dir.join("src/test/java")).unwrap();
        let app_build = r#"
plugins {
    id 'java'
}
dependencies {
    implementation project(':core:domain')
    implementation 'org.slf4j:slf4j-api:2.0.7'
    testImplementation 'org.junit.jupiter:junit-jupiter:5.9.3'
}
"#;
        fs::write(app_dir.join("build.gradle"), app_build).unwrap();

        // Create :core:domain module
        let domain_dir = root.join("core/domain");
        fs::create_dir_all(domain_dir.join("src/main/kotlin")).unwrap();
        fs::write(domain_dir.join("build.gradle.kts"), "// domain build").unwrap();

        let req = GradleToolingRequest {
            workspace_root: root.to_string_lossy().to_string(),
            trusted: true,
            java_home: Some("/opt/jdk21".to_string()),
            gradle_executable: None,
            offline: true,
        };

        let result = ingest_gradle_tooling(&req);
        assert_eq!(result.status, "ready");
        assert_eq!(result.modules.len(), 4); // :, :app, :core:domain, :core:data

        let prov = result.provenance.unwrap();
        assert_eq!(prov.tool_kind, "gradlew");
        assert_eq!(prov.java_home, Some("/opt/jdk21".to_string()));
        assert!(prov.argv.contains(&"--offline".to_string()));

        let root_mod = result.modules.iter().find(|m| m.id == ":").unwrap();
        assert_eq!(root_mod.name, "my-multiproject");

        let app_mod = result.modules.iter().find(|m| m.id == ":app").unwrap();
        assert_eq!(app_mod.source_roots.len(), 1);
        assert_eq!(app_mod.test_roots.len(), 1);
        assert!(
            app_mod
                .dependencies
                .contains(&"project(:core:domain)".to_string())
        );
        assert!(
            app_mod
                .dependencies
                .contains(&"org.slf4j:slf4j-api:2.0.7".to_string())
        );

        let domain_mod = result
            .modules
            .iter()
            .find(|m| m.id == ":core:domain")
            .unwrap();
        assert_eq!(domain_mod.source_roots.len(), 1);
    }
}
