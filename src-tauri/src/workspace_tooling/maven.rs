use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MavenToolingRequest {
    pub workspace_root: String,
    pub trusted: bool,
    pub java_home: Option<String>,
    pub maven_executable: Option<String>,
    #[serde(default)]
    pub offline: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MavenToolingProvenance {
    pub tool_kind: String,
    pub tool_version: Option<String>,
    pub java_home: Option<String>,
    pub java_version: Option<String>,
    pub argv: Vec<String>,
    pub cwd: String,
    pub pom_hash: String,
    pub resolved_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MavenModuleStructure {
    pub id: String,
    pub name: String,
    pub root: String,
    pub pom_path: String,
    pub source_roots: Vec<String>,
    pub test_roots: Vec<String>,
    pub resource_roots: Vec<String>,
    pub output_dir: Option<String>,
    pub dependencies: Vec<String>,
    pub classpath: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MavenToolingResult {
    pub status: String, // "ready" | "untrusted" | "degraded" | "failed"
    pub modules: Vec<MavenModuleStructure>,
    pub provenance: Option<MavenToolingProvenance>,
    pub error_message: Option<String>,
}

#[tauri::command]
pub fn workspace_ingest_maven_project(
    request: MavenToolingRequest,
) -> Result<MavenToolingResult, String> {
    Ok(ingest_maven_tooling(&request))
}

pub fn ingest_maven_tooling(request: &MavenToolingRequest) -> MavenToolingResult {
    // 1. Trust boundary: untrusted workspaces spawn 0 processes and produce untrusted status.
    if !request.trusted {
        return MavenToolingResult {
            status: "untrusted".to_string(),
            modules: vec![],
            provenance: None,
            error_message: Some(
                "Workspace is untrusted; Maven tooling execution refused (process=0)".to_string(),
            ),
        };
    }

    let root_path = Path::new(&request.workspace_root);
    let root_pom = root_path.join("pom.xml");
    if !root_pom.exists() || !root_pom.is_file() {
        return MavenToolingResult {
            status: "failed".to_string(),
            modules: vec![],
            provenance: None,
            error_message: Some(format!("Root pom.xml not found at {}", root_pom.display())),
        };
    }

    let Ok(root_contents) = fs::read_to_string(&root_pom) else {
        return MavenToolingResult {
            status: "failed".to_string(),
            modules: vec![],
            provenance: None,
            error_message: Some(format!("Failed to read pom.xml at {}", root_pom.display())),
        };
    };

    if root_contents.trim().is_empty() {
        return MavenToolingResult {
            status: "failed".to_string(),
            modules: vec![],
            provenance: None,
            error_message: Some("pom.xml is empty or malformed".to_string()),
        };
    }

    let mut hasher = Sha256::new();
    hasher.update(root_contents.as_bytes());
    let pom_hash = hex::encode(hasher.finalize());

    // Resolve tool kind
    let (tool_kind, wrapper_path) =
        detect_maven_executable(root_path, request.maven_executable.as_deref());

    let mut argv = vec![wrapper_path.clone()];
    if request.offline {
        argv.push("--offline".to_string());
    }
    argv.push("help:effective-pom".to_string());

    let provenance = MavenToolingProvenance {
        tool_kind,
        tool_version: None,
        java_home: request.java_home.clone(),
        java_version: None,
        argv,
        cwd: request.workspace_root.clone(),
        pom_hash,
        resolved_at: chrono::Utc::now().to_rfc3339(),
    };

    // Recursively parse modules starting from root POM
    let mut modules = Vec::new();
    let mut visited_poms = Vec::new();
    let mut inherited_properties = HashMap::new();

    if let Err(err) = parse_pom_tree(
        &root_pom,
        root_path,
        &mut inherited_properties,
        &mut modules,
        &mut visited_poms,
    ) {
        return MavenToolingResult {
            status: "failed".to_string(),
            modules: vec![],
            provenance: Some(provenance),
            error_message: Some(err),
        };
    }

    if modules.is_empty() {
        return MavenToolingResult {
            status: "failed".to_string(),
            modules: vec![],
            provenance: Some(provenance),
            error_message: Some(
                "No valid Maven modules could be resolved from pom.xml".to_string(),
            ),
        };
    }

    MavenToolingResult {
        status: "ready".to_string(),
        modules,
        provenance: Some(provenance),
        error_message: None,
    }
}

fn detect_maven_executable(root: &Path, user_executable: Option<&str>) -> (String, String) {
    let mvnw_unix = root.join("mvnw");
    let mvnw_win = root.join("mvnw.cmd");

    if mvnw_unix.is_file() {
        ("mvnw".to_string(), mvnw_unix.to_string_lossy().to_string())
    } else if mvnw_win.is_file() {
        ("mvnw".to_string(), mvnw_win.to_string_lossy().to_string())
    } else if let Some(exe) = user_executable {
        ("mvn".to_string(), exe.to_string())
    } else {
        ("mvn".to_string(), "mvn".to_string())
    }
}

fn parse_pom_tree(
    pom_path: &Path,
    module_root: &Path,
    parent_properties: &mut HashMap<String, String>,
    modules: &mut Vec<MavenModuleStructure>,
    visited_poms: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let canonical = pom_path
        .canonicalize()
        .unwrap_or_else(|_| pom_path.to_path_buf());
    if visited_poms.contains(&canonical) {
        return Ok(()); // prevent cyclic references
    }
    visited_poms.push(canonical);

    let contents = fs::read_to_string(pom_path)
        .map_err(|e| format!("Failed to read {}: {}", pom_path.display(), e))?;

    let mut properties = parent_properties.clone();
    extract_properties(&contents, &mut properties);

    let group_id = extract_project_coordinate(&contents, "groupId")
        .or_else(|| extract_parent_tag_value(&contents, "groupId"))
        .or_else(|| parent_properties.get("project.groupId").cloned())
        .unwrap_or_else(|| "unspecified".to_string());
    properties.insert("project.groupId".to_string(), group_id.clone());

    let artifact_id = extract_project_coordinate(&contents, "artifactId").unwrap_or_else(|| {
        module_root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("module")
            .to_string()
    });
    properties.insert("project.artifactId".to_string(), artifact_id.clone());

    let version = extract_project_coordinate(&contents, "version")
        .or_else(|| extract_parent_tag_value(&contents, "version"))
        .or_else(|| parent_properties.get("project.version").cloned())
        .unwrap_or_else(|| "1.0.0".to_string());
    properties.insert("project.version".to_string(), version.clone());

    let module_id = format!("{}:{}", group_id, artifact_id);

    // Source directories
    let mut source_roots = Vec::new();
    let mut test_roots = Vec::new();
    let mut resource_roots = Vec::new();

    let main_java = module_root.join("src/main/java");
    if main_java.is_dir() {
        source_roots.push(main_java.to_string_lossy().to_string());
    }
    let main_kotlin = module_root.join("src/main/kotlin");
    if main_kotlin.is_dir() {
        source_roots.push(main_kotlin.to_string_lossy().to_string());
    }
    let main_scala = module_root.join("src/main/scala");
    if main_scala.is_dir() {
        source_roots.push(main_scala.to_string_lossy().to_string());
    }

    let test_java = module_root.join("src/test/java");
    if test_java.is_dir() {
        test_roots.push(test_java.to_string_lossy().to_string());
    }
    let test_kotlin = module_root.join("src/test/kotlin");
    if test_kotlin.is_dir() {
        test_roots.push(test_kotlin.to_string_lossy().to_string());
    }

    let main_resources = module_root.join("src/main/resources");
    if main_resources.is_dir() {
        resource_roots.push(main_resources.to_string_lossy().to_string());
    }

    let target_classes = module_root.join("target/classes");
    let output_dir = if target_classes.exists() || source_roots.len() > 0 {
        Some(target_classes.to_string_lossy().to_string())
    } else {
        None
    };

    // Dependencies
    let dependencies = extract_dependencies(&contents, &properties);
    let mut classpath = Vec::new();
    for dep in &dependencies {
        classpath.push(dep.clone());
    }

    let submodules = extract_submodules(&contents);

    modules.push(MavenModuleStructure {
        id: module_id,
        name: artifact_id,
        root: module_root.to_string_lossy().to_string(),
        pom_path: pom_path.to_string_lossy().to_string(),
        source_roots,
        test_roots,
        resource_roots,
        output_dir,
        dependencies,
        classpath,
    });

    // Parse submodules
    for sub in submodules {
        let sub_root = module_root.join(&sub);
        let sub_pom = sub_root.join("pom.xml");
        if sub_pom.is_file() {
            let mut sub_props = properties.clone();
            parse_pom_tree(&sub_pom, &sub_root, &mut sub_props, modules, visited_poms)?;
        }
    }

    Ok(())
}

fn extract_properties(contents: &str, properties: &mut HashMap<String, String>) {
    let Ok(block_regex) = Regex::new(r"(?s)<properties(?:\s[^>]*)?>(.*?)</properties>") else {
        return;
    };
    let Ok(prop_regex) = Regex::new(
        r"(?s)<([A-Za-z_][A-Za-z0-9_.-]*)(?:\s[^>]*)?>\s*([^<]+?)\s*</[A-Za-z_][A-Za-z0-9_.-]*>",
    ) else {
        return;
    };

    if let Some(captures) = block_regex.captures(contents) {
        if let Some(block) = captures.get(1) {
            for cap in prop_regex.captures_iter(block.as_str()) {
                if let (Some(k), Some(v)) = (cap.get(1), cap.get(2)) {
                    properties.insert(k.as_str().to_string(), v.as_str().trim().to_string());
                }
            }
        }
    }
}

fn extract_project_coordinate(contents: &str, tag: &str) -> Option<String> {
    let without_blocks = strip_blocks(
        contents,
        &[
            "parent",
            "dependencies",
            "build",
            "pluginManagement",
            "dependencyManagement",
        ],
    );
    extract_tag_value(&without_blocks, tag)
}

fn extract_parent_tag_value(contents: &str, tag: &str) -> Option<String> {
    let pattern = r"(?s)<parent(?:\s[^>]*)?>(.*?)</parent>";
    if let Ok(re) = Regex::new(pattern) {
        if let Some(captures) = re.captures(contents) {
            if let Some(parent_block) = captures.get(1) {
                return extract_tag_value(parent_block.as_str(), tag);
            }
        }
    }
    None
}

fn strip_blocks(contents: &str, tags: &[&str]) -> String {
    let mut result = contents.to_string();
    for tag in tags {
        let pattern = format!(
            r"(?s)<(?:[A-Za-z0-9_-]+:)?{}(?:\s[^>]*)?>.*?</(?:[A-Za-z0-9_-]+:)?{}>",
            regex::escape(tag),
            regex::escape(tag)
        );
        if let Ok(re) = Regex::new(&pattern) {
            result = re.replace_all(&result, "").to_string();
        }
    }
    result
}

fn extract_tag_value(contents: &str, tag: &str) -> Option<String> {
    let pattern = format!(
        r"(?s)<(?:[A-Za-z0-9_-]+:)?{}(?:\s[^>]*)?>\s*([^<]+?)\s*</(?:[A-Za-z0-9_-]+:)?{}>",
        regex::escape(tag),
        regex::escape(tag)
    );
    let regex = Regex::new(&pattern).ok()?;
    regex
        .captures(contents)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
}

fn extract_submodules(contents: &str) -> Vec<String> {
    let mut submodules = Vec::new();
    let Ok(modules_block_regex) = Regex::new(r"(?s)<modules(?:\s[^>]*)?>(.*?)</modules>") else {
        return submodules;
    };
    let Ok(module_regex) = Regex::new(r"(?s)<module(?:\s[^>]*)?>\s*([^<]+?)\s*</module>") else {
        return submodules;
    };

    if let Some(captures) = modules_block_regex.captures(contents) {
        if let Some(block) = captures.get(1) {
            for cap in module_regex.captures_iter(block.as_str()) {
                if let Some(m) = cap.get(1) {
                    let name = m.as_str().trim();
                    if !name.is_empty() {
                        submodules.push(name.to_string());
                    }
                }
            }
        }
    }

    submodules
}

fn extract_dependencies(contents: &str, properties: &HashMap<String, String>) -> Vec<String> {
    let mut dependencies = Vec::new();
    let Ok(dep_regex) = Regex::new(r"(?s)<dependency(?:\s[^>]*)?>(.*?)</dependency>") else {
        return dependencies;
    };

    for cap in dep_regex.captures_iter(contents) {
        if let Some(block) = cap.get(1) {
            let block_str = block.as_str();
            let gid = extract_tag_value(block_str, "groupId").unwrap_or_default();
            let aid = extract_tag_value(block_str, "artifactId").unwrap_or_default();
            let ver = extract_tag_value(block_str, "version")
                .map(|v| resolve_placeholders(&v, properties))
                .unwrap_or_else(|| "default".to_string());

            if !gid.is_empty() && !aid.is_empty() {
                dependencies.push(format!("{}:{}:{}", gid, aid, ver));
            }
        }
    }

    dependencies
}

fn resolve_placeholders(value: &str, properties: &HashMap<String, String>) -> String {
    let mut result = value.to_string();
    for (k, v) in properties {
        let placeholder = format!("${{{}}}", k);
        if result.contains(&placeholder) {
            result = result.replace(&placeholder, v);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_untrusted_workspace_spawns_zero_processes() {
        let temp = tempdir().unwrap();
        let req = MavenToolingRequest {
            workspace_root: temp.path().to_string_lossy().to_string(),
            trusted: false,
            java_home: None,
            maven_executable: None,
            offline: false,
        };

        let result = ingest_maven_tooling(&req);
        expect_untrusted(result);
    }

    fn expect_untrusted(res: MavenToolingResult) {
        assert_eq!(res.status, "untrusted");
        assert!(res.modules.is_empty());
        assert!(res.provenance.is_none());
        assert!(res.error_message.unwrap().contains("process=0"));
    }

    #[test]
    fn test_missing_pom_fails_closed() {
        let temp = tempdir().unwrap();
        let req = MavenToolingRequest {
            workspace_root: temp.path().to_string_lossy().to_string(),
            trusted: true,
            java_home: None,
            maven_executable: None,
            offline: false,
        };

        let result = ingest_maven_tooling(&req);
        assert_eq!(result.status, "failed");
        assert!(result.modules.is_empty());
        assert!(result.error_message.unwrap().contains("pom.xml not found"));
    }

    #[test]
    fn test_multi_module_maven_ingestion_with_provenance() {
        let temp = tempdir().unwrap();
        let root = temp.path();

        // Create mvnw wrapper
        fs::write(root.join("mvnw"), "#!/bin/sh\necho mvnw").unwrap();

        // Create root pom.xml
        let root_pom = r#"<project xmlns="http://maven.apache.org/POM/4.0.0">
            <modelVersion>4.0.0</modelVersion>
            <groupId>com.example</groupId>
            <artifactId>root-project</artifactId>
            <version>1.0.0-SNAPSHOT</version>
            <packaging>pom</packaging>
            <properties>
                <spring.version>3.2.0</spring.version>
            </properties>
            <modules>
                <module>core</module>
                <module>web</module>
            </modules>
        </project>"#;
        fs::write(root.join("pom.xml"), root_pom).unwrap();

        // Create core module
        let core_dir = root.join("core");
        fs::create_dir_all(core_dir.join("src/main/java/com/example")).unwrap();
        fs::create_dir_all(core_dir.join("src/test/java")).unwrap();
        let core_pom = r#"<project xmlns="http://maven.apache.org/POM/4.0.0">
            <modelVersion>4.0.0</modelVersion>
            <parent>
                <groupId>com.example</groupId>
                <artifactId>root-project</artifactId>
                <version>1.0.0-SNAPSHOT</version>
            </parent>
            <artifactId>core</artifactId>
            <dependencies>
                <dependency>
                    <groupId>org.springframework</groupId>
                    <artifactId>spring-core</artifactId>
                    <version>${spring.version}</version>
                </dependency>
            </dependencies>
        </project>"#;
        fs::write(core_dir.join("pom.xml"), core_pom).unwrap();

        // Create web module
        let web_dir = root.join("web");
        fs::create_dir_all(web_dir.join("src/main/java")).unwrap();
        let web_pom = r#"<project xmlns="http://maven.apache.org/POM/4.0.0">
            <modelVersion>4.0.0</modelVersion>
            <parent>
                <groupId>com.example</groupId>
                <artifactId>root-project</artifactId>
                <version>1.0.0-SNAPSHOT</version>
            </parent>
            <artifactId>web</artifactId>
            <dependencies>
                <dependency>
                    <groupId>com.example</groupId>
                    <artifactId>core</artifactId>
                    <version>${project.version}</version>
                </dependency>
            </dependencies>
        </project>"#;
        fs::write(web_dir.join("pom.xml"), web_pom).unwrap();

        let req = MavenToolingRequest {
            workspace_root: root.to_string_lossy().to_string(),
            trusted: true,
            java_home: Some("/opt/jdk21".to_string()),
            maven_executable: None,
            offline: true,
        };

        let result = ingest_maven_tooling(&req);
        assert_eq!(result.status, "ready");
        assert_eq!(result.modules.len(), 3); // root, core, web

        let prov = result.provenance.unwrap();
        assert_eq!(prov.tool_kind, "mvnw");
        assert_eq!(prov.java_home, Some("/opt/jdk21".to_string()));
        assert!(prov.argv.contains(&"--offline".to_string()));

        let core_mod = result.modules.iter().find(|m| m.name == "core").unwrap();
        assert_eq!(core_mod.id, "com.example:core");
        assert_eq!(core_mod.source_roots.len(), 1);
        assert_eq!(core_mod.test_roots.len(), 1);
        assert!(
            core_mod
                .dependencies
                .contains(&"org.springframework:spring-core:3.2.0".to_string())
        );

        let web_mod = result.modules.iter().find(|m| m.name == "web").unwrap();
        assert_eq!(web_mod.id, "com.example:web");
        assert!(
            web_mod
                .dependencies
                .contains(&"com.example:core:1.0.0-SNAPSHOT".to_string())
        );
    }
}
