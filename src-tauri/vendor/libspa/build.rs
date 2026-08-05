use std::path::PathBuf;

fn main() {
    // FIXME: It would be nice to run this only when tests are run.
    println!("cargo:rerun-if-changed=tests/pod.c");

    let libs = system_deps::Config::new()
        .probe()
        .expect("Cannot find libspa");
    let libspa = libs.get_by_name("libspa").unwrap();

    println!("cargo:rustc-check-cfg=cfg(libspa_video_info_raw_has_flags)");
    if video_info_raw_has_flags(&libspa.include_paths) {
        println!("cargo:rustc-cfg=libspa_video_info_raw_has_flags");
    }

    cc::Build::new()
        .file("tests/pod.c")
        .shared_flag(true)
        .flag("-Wno-missing-field-initializers")
        .includes(&libspa.include_paths)
        .compile("pod");
}

fn video_info_raw_has_flags(include_paths: &[PathBuf]) -> bool {
    for include_path in include_paths {
        let header = include_path.join("spa/param/video/raw.h");
        let Ok(source) = std::fs::read_to_string(&header) else {
            continue;
        };
        println!("cargo:rerun-if-changed={}", header.display());
        return raw_video_info_body(&source).is_some_and(|body| {
            body.lines().any(|line| {
                let mut words = line
                    .split(|value: char| value.is_whitespace() || value == ';')
                    .filter(|value| !value.is_empty());
                words.next() == Some("uint32_t") && words.next() == Some("flags")
            })
        });
    }

    panic!(
        "Cannot inspect spa/param/video/raw.h in libspa include paths: {}",
        include_paths
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
}

fn raw_video_info_body(source: &str) -> Option<&str> {
    let start = source.find("struct spa_video_info_raw")?;
    let body = &source[start..];
    Some(&body[..body.find("};")?])
}
