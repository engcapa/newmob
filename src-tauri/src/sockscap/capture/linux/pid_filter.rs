//! PID selection for Linux app-mode capture.

use std::collections::BTreeSet;

use crate::sockscap::config::AppSelector;
use crate::sockscap::paths::{paths_match_exe, normalize_exe_path};
use crate::sockscap::process::{self, ProcessInfo};

/// Whether a packet/process PID belongs to a resolved app-mode target set.
pub fn matches_target_pid(pid: u32, target_pids: &BTreeSet<u32>) -> bool {
    target_pids.contains(&pid)
}

/// Resolve each profile's executable selectors to currently-running PIDs.
///
/// An empty PID set is valid: the app watcher will move matching processes into
/// the profile's capture cgroup when they start later. When a process matches
/// multiple profiles, the first selector group wins, preserving profile
/// priority.
pub fn resolve_target_pid_groups(
    selector_groups: &[Vec<AppSelector>],
) -> Result<Vec<BTreeSet<u32>>, String> {
    let processes = process::list_processes()?;
    match_processes_to_groups(selector_groups, &processes)
}

fn match_processes_to_groups(
    selector_groups: &[Vec<AppSelector>],
    processes: &[ProcessInfo],
) -> Result<Vec<BTreeSet<u32>>, String> {
    let paths = selector_groups
        .iter()
        .map(|selectors| {
            let paths = selectors
                .iter()
                .map(|selector| selector.path.trim())
                .filter(|path| !path.is_empty())
                .collect::<Vec<_>>();
            if paths.is_empty() {
                Err("App mode requires at least one application path".to_string())
            } else {
                Ok(paths)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut groups = vec![BTreeSet::new(); selector_groups.len()];

    for process in processes {
        if process.path.is_empty() {
            continue;
        }
        if let Some(index) = paths.iter().position(|selectors| {
            selectors
                .iter()
                .any(|selector| selector_matches_process_path(&process.path, selector))
        }) {
            groups[index].insert(process.pid);
        }
    }

    Ok(groups)
}

/// Linux `/proc/<pid>/exe` resolves symbolic links, while a configured app
/// path may still use the distro's launcher symlink (for example `/usr/bin/*`).
/// Match both the existing cross-platform normalized spelling and canonical
/// filesystem paths so app-mode does not silently omit the selected process.
fn selector_matches_process_path(process_path: &str, selector: &str) -> bool {
    let process_norm = normalize_exe_path(process_path);
    let selector_norm = normalize_exe_path(selector);
    if process_norm.is_empty() || selector_norm.is_empty() {
        return false;
    }
    if paths_match_exe(process_path, selector) {
        return true;
    }
    // For symlink / absolute selectors (including launcher links like "grok"), try canonical path match.
    // This fixes cases where the configured "source" is a symlink but /proc/<pid>/exe resolves to the target.
    if selector.contains('/') || selector.contains('\\') || selector.starts_with('.') {
        match (
            std::fs::canonicalize(process_path),
            std::fs::canonicalize(selector),
        ) {
            (Ok(p), Ok(s)) => return p == s,
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_target_pid() {
        let targets = BTreeSet::from([1234, 5678]);
        assert!(matches_target_pid(1234, &targets));
        assert!(!matches_target_pid(9012, &targets));
    }

    #[test]
    fn follows_launcher_symlinks_when_matching_paths() {
        let executable = std::env::current_exe().unwrap();
        assert!(selector_matches_process_path(
            executable.to_str().unwrap(),
            "/proc/self/exe"
        ));
    }

    #[test]
    fn handles_symlink_selectors_correctly() {
        // A launcher symlink selector must match the process whose
        // /proc/<pid>/exe resolves to the symlink's canonical target.
        let target = std::env::current_exe().unwrap();
        // Use a private temp dir so the symlink path is unique per run and is
        // cleaned up unconditionally when `dir` drops (avoids the EEXIST that a
        // fixed, left-over path next to the test binary caused).
        let dir = tempfile::tempdir().unwrap();
        let symlink = dir.path().join("grok-symlink");
        std::os::unix::fs::symlink(&target, &symlink).unwrap();
        assert!(selector_matches_process_path(
            target.to_str().unwrap(),
            symlink.to_str().unwrap()
        ));
    }

    #[test]
    fn allows_start_before_selected_process_and_matches_it_later() {
        let selectors = vec![vec![AppSelector {
            path: "/opt/example/example".into(),
            bundle_id: String::new(),
            name: "Example".into(),
        }]];
        let initial_groups = match_processes_to_groups(&selectors, &[]).unwrap();
        assert_eq!(initial_groups, vec![BTreeSet::new()]);

        let processes = vec![ProcessInfo {
            pid: 42,
            name: "example".into(),
            path: "/opt/example/example".into(),
        }];
        let later_groups = match_processes_to_groups(&selectors, &processes).unwrap();
        assert_eq!(later_groups, vec![BTreeSet::from([42])]);
    }

    #[test]
    fn assigns_overlapping_processes_to_the_first_profile() {
        let selectors = vec![
            vec![AppSelector {
                path: "/opt/example/example".into(),
                bundle_id: String::new(),
                name: "Primary".into(),
            }],
            vec![AppSelector {
                path: "example".into(),
                bundle_id: String::new(),
                name: "Fallback".into(),
            }],
        ];
        let processes = vec![ProcessInfo {
            pid: 42,
            name: "example".into(),
            path: "/opt/example/example".into(),
        }];
        let groups = match_processes_to_groups(&selectors, &processes).unwrap();
        assert_eq!(groups[0], BTreeSet::from([42]));
        assert!(groups[1].is_empty());
    }
}
