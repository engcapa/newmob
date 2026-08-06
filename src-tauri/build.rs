use std::fs;
use std::path::Path;

fn main() {
    enforce_asr_llm_isolation();
    compile_hbase_protos();
    compile_linux_sockscap_launcher();
    configure_macos_rpath();
    let embed_manifest_ourselves = configure_windows_manifest();
    build_tauri(embed_manifest_ourselves);
}

/// Build the tiny launcher used by Linux's unprivileged "launch from
/// SocksCap" backend. It enters ptrace supervision, installs a seccomp filter
/// for socket(2)/connect(2), and then execs the requested desktop or TUI
/// application.
fn compile_linux_sockscap_launcher() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let source = Path::new(&manifest_dir).join("src/sockscap/capture/linux/trace_launcher.c");
    let output = Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR"))
        .join("taomni-sockscap-trace-launcher");
    println!("cargo:rerun-if-changed={}", source.display());

    let compiler = cc::Build::new().get_compiler();
    let mut command = compiler.to_command();
    command.args([
        "-fPIE",
        "-pie",
        "-O2",
        "-fvisibility=hidden",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Wl,-z,relro",
        "-Wl,-z,now",
        "-Wl,-z,noexecstack",
    ]);
    command.arg(&source).arg("-o").arg(&output);
    let status = command
        .status()
        .unwrap_or_else(|error| panic!("compile Linux SocksCap trace launcher: {error}"));
    assert!(
        status.success(),
        "Linux SocksCap trace launcher compiler failed"
    );
}

/// Run tauri-build, opting out of its Windows manifest embedding when
/// `configure_windows_manifest` has taken that job over (see its docs).
fn build_tauri(embed_manifest_ourselves: bool) {
    if !embed_manifest_ourselves {
        tauri_build::build();
        return;
    }
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

/// Embed the ComCtl32 v6 side-by-side manifest into *every* linked target on
/// windows-msvc, and report whether we did (so tauri-build can be told to skip
/// its own manifest embedding and avoid a duplicate resource).
///
/// `tauri-plugin-dialog` depends on `rfd` with its `common-controls-v6`
/// feature, so this crate statically imports `TaskDialogIndirect` from
/// ComCtl32. That symbol exists only in the ComCtl32 v6 WinSxS assembly — the
/// v5.82 stub in System32 does not export it — so any binary importing it must
/// declare the v6 dependency in its manifest, or the Windows loader aborts the
/// process at startup with 0xC0000139 (STATUS_ENTRYPOINT_NOT_FOUND).
///
/// tauri-build embeds that manifest through `cargo:rustc-link-arg-bins`, which
/// reaches bin targets only, so `cargo test --lib` produced a harness binary
/// with no manifest that died before running a single test. Cargo has no
/// "everything except bins" link-arg scope: `cargo:rustc-link-arg-tests`
/// applies to `tests/` integration targets and *not* to the `--lib` unittest
/// harness (verified empirically), and the unscoped `cargo:rustc-link-arg`
/// collides with tauri-winres' manifest resource (`CVT1100: duplicate
/// resource, type:MANIFEST` → `LNK1123`).
///
/// So we take ownership: tauri-build embeds nothing, and the unscoped link-arg
/// gives bins, the cdylib, and the test harness exactly one manifest from one
/// source. `windows-app-manifest.xml` mirrors tauri-build's default byte for
/// byte, so the shipped binaries are unchanged.
fn configure_windows_manifest() -> bool {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return false;
    }
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let manifest = Path::new(&manifest_dir).join("windows-app-manifest.xml");
    if !manifest.exists() {
        // Fall back to tauri-build's own manifest rather than shipping without one.
        return false;
    }
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    true
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
