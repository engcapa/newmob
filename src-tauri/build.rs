use std::fs;
use std::path::Path;

fn main() {
    enforce_asr_llm_isolation();
    compile_hbase_protos();
    configure_macos_rpath();
    tauri_build::build();
}

/// On macOS, add an `@executable_path/../Frameworks` rpath so the krb5 dylibs
/// bundled into `Taomni.app/Contents/Frameworks` resolve at runtime. The default
/// `hbase-kerberos` feature links libgssapi against Homebrew's keg-only krb5,
/// whose absolute path is otherwise baked into the binary; scripts/bundle-krb5-macos.sh
/// rewrites those load commands to `@rpath/...`, and this rpath is where dyld
/// finds them inside the bundle.
fn configure_macos_rpath() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,@executable_path/../Frameworks");
    }
}

/// Compile the vendored HBase 2.6.x protobuf definitions into Rust types for
/// the native RPC client (src/hbase/native). The generated module is written to
/// `OUT_DIR/hbase.pb.rs` (package `hbase.pb`) and included via
/// `src/hbase/native/proto.rs`. The shaded `google.protobuf.Any` lives under the
/// vendor path `proto/org/apache/hbase/thirdparty/...` that HBase's protos import.
fn compile_hbase_protos() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let proto_root = Path::new(&manifest_dir).join("proto");
    if !proto_root.exists() {
        return;
    }
    println!("cargo:rerun-if-changed=proto");

    let mut protos: Vec<std::path::PathBuf> = Vec::new();
    collect_protos(&proto_root, &mut protos);
    if protos.is_empty() {
        return;
    }

    let mut config = prost_build::Config::new();
    config
        .compile_protos(&protos, &[proto_root.as_path()])
        .expect("failed to compile vendored HBase protobuf definitions");
}

fn collect_protos(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_protos(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("proto") {
            out.push(path);
        }
    }
}

/// Compile-time guardrail: asr/* must not import llm/* and vice versa.
/// The two modules must only meet via dispatch layers (voice/intent_dispatcher,
/// chat::, agent::). Violations cause a build failure.
fn enforce_asr_llm_isolation() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let asr_dir = Path::new(&manifest_dir).join("src/asr");
    let llm_dir = Path::new(&manifest_dir).join("src/llm");

    println!("cargo:rerun-if-changed=src/asr");
    println!("cargo:rerun-if-changed=src/llm");

    // ASR side: forbid `crate::llm` references.
    if asr_dir.exists() {
        scan_for_forbidden(&asr_dir, &["crate::llm", "use crate::llm"], "src/asr");
    }
    // LLM side: forbid `crate::asr` references.
    if llm_dir.exists() {
        scan_for_forbidden(&llm_dir, &["crate::asr", "use crate::asr"], "src/llm");
    }
}

fn scan_for_forbidden(dir: &Path, needles: &[&str], dir_label: &str) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_for_forbidden(&path, needles, dir_label);
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str());
        if ext != Some("rs") {
            continue;
        }
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        for line in contents.lines() {
            // Skip comments / docs (line starts with // or */ etc.).
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || trimmed.starts_with("*") {
                continue;
            }
            for n in needles {
                if line.contains(n) {
                    let rel = path
                        .strip_prefix(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default())
                        .unwrap_or(&path);
                    panic!(
                        "ASR/LLM isolation violation: {} contains forbidden import `{}`. \n\
                         The {} module must not import the other side directly. \n\
                         Use the dispatch layer (voice/intent_dispatcher, chat::, agent::) instead.",
                        rel.display(),
                        n,
                        dir_label
                    );
                }
            }
        }
    }
}
