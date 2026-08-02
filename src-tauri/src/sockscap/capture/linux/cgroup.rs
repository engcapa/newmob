//! cgroup v2 ownership for the Linux transparent-capture rules.
//!
//! nftables can match a socket's cgroup v2 path, which gives us a stable process
//! filter without relying on a race-prone `/proc` lookup for every packet. The
//! session records every move so teardown can put processes back where they
//! started.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::sockscap::capture::linux::exec::{is_effective_root, run_command_elevated};

const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const SESSION_PREFIX: &str = "taomni-sockscap-";

#[derive(Debug)]
struct CgroupMove {
    original_dir: PathBuf,
    managed_dir: PathBuf,
}

/// A cgroup v2 socket match suitable for nftables'
/// `socket cgroupv2 level N "path"` expression.
///
/// `meta cgroup` must not be used here: it reads the cgroup v1
/// `net_cls.classid`, which is zero on a unified cgroup v2 host. Supplying a
/// cgroup v2 directory inode to that expression silently disables the match
/// and, in global mode, recursively redirects the relay's own connections.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CgroupV2Match {
    relative_path: String,
    level: u32,
}

impl CgroupV2Match {
    pub(crate) fn from_relative_path(relative_path: &str) -> Result<Self, String> {
        let relative_path = relative_path.trim_matches('/');
        if relative_path.is_empty() {
            return Err("cgroup v2 match path must not be empty".into());
        }
        if !relative_path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
        {
            return Err(format!(
                "cgroup v2 match path contains unsupported characters: {relative_path:?}"
            ));
        }
        let path = Path::new(relative_path);
        if path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(format!("invalid cgroup v2 match path: {relative_path:?}"));
        }
        let level = u32::try_from(path.components().count())
            .map_err(|_| "cgroup v2 path is too deep".to_string())?;
        Ok(Self {
            relative_path: relative_path.to_string(),
            level,
        })
    }

    fn from_managed_dir(path: &Path) -> Result<Self, String> {
        let relative = path
            .strip_prefix(CGROUP_ROOT)
            .map_err(|_| format!("{} is outside {CGROUP_ROOT}", path.display()))?
            .to_str()
            .ok_or_else(|| format!("cgroup path is not valid UTF-8: {}", path.display()))?;
        Self::from_relative_path(relative)
    }

    pub(crate) fn nft_expression(&self) -> String {
        format!(
            "socket cgroupv2 level {} \"{}\"",
            self.level, self.relative_path
        )
    }
}

/// The cgroups created for one running SocksCap session.
///
/// In global mode, Taomni itself is moved to a bypass cgroup while all other
/// local TCP traffic is redirected. In app mode, only selected target PIDs are
/// moved into capture cgroups; children inherit their parent's cgroup. Mixed
/// mode combines both arrangements so higher-priority apps can use dedicated
/// relays before the final global catch-all relay.
#[derive(Debug)]
pub struct CgroupSession {
    root: PathBuf,
    self_pid: u32,
    moves: Vec<CgroupMove>,
    bypass_match: Option<CgroupV2Match>,
    capture_matches: Vec<CgroupV2Match>,
    app_group_dirs: Vec<PathBuf>,
    next_move_id: u64,
}

impl CgroupSession {
    pub fn preflight() -> Result<(), String> {
        let root = Path::new(CGROUP_ROOT);
        if !root.join("cgroup.controllers").is_file() {
            return Err(
                "Linux SocksCap requires a mounted cgroup v2 hierarchy at /sys/fs/cgroup".into(),
            );
        }
        Ok(())
    }

    pub fn prepare_global(self_pid: u32, sudo_password: Option<&str>) -> Result<Self, String> {
        let mut session = Self::create(self_pid, sudo_password)?;
        let setup = session
            .move_pid(self_pid, session.root.join("bypass"), sudo_password)
            .map(|cgroup_match| session.bypass_match = Some(cgroup_match));
        session.finish_setup(setup, sudo_password)
    }

    pub fn prepare_apps(
        target_pid_groups: &[BTreeSet<u32>],
        self_pid: u32,
        sudo_password: Option<&str>,
    ) -> Result<Self, String> {
        if target_pid_groups.is_empty() {
            return Err("App mode requires at least one active application profile".into());
        }
        let mut session = Self::create(self_pid, sudo_password)?;
        let setup = session.setup_app_groups(target_pid_groups, sudo_password);
        session.finish_setup(setup, sudo_password)
    }

    pub fn prepare_mixed(
        target_pid_groups: &[BTreeSet<u32>],
        self_pid: u32,
        sudo_password: Option<&str>,
    ) -> Result<Self, String> {
        if target_pid_groups.is_empty() {
            return Err("Mixed mode requires at least one application profile".into());
        }
        let mut session = Self::create(self_pid, sudo_password)?;
        let setup = session
            .move_pid(self_pid, session.root.join("bypass"), sudo_password)
            .map(|cgroup_match| session.bypass_match = Some(cgroup_match))
            .and_then(|()| session.setup_app_groups(target_pid_groups, sudo_password));
        session.finish_setup(setup, sudo_password)
    }

    fn create(self_pid: u32, sudo_password: Option<&str>) -> Result<Self, String> {
        Self::preflight()?;
        let root = Path::new(CGROUP_ROOT).join(format!("{SESSION_PREFIX}{self_pid}"));
        if root.exists() {
            return Err(format!(
                "an existing Linux SocksCap cgroup exists at {}; run Recover before starting again",
                root.display()
            ));
        }

        create_cgroup_dir(&root, sudo_password)?;
        Ok(Self {
            root,
            self_pid,
            moves: Vec::new(),
            bypass_match: None,
            capture_matches: Vec::new(),
            app_group_dirs: Vec::new(),
            next_move_id: 0,
        })
    }

    fn setup_app_groups(
        &mut self,
        target_pid_groups: &[BTreeSet<u32>],
        sudo_password: Option<&str>,
    ) -> Result<(), String> {
        for (index, _) in target_pid_groups.iter().enumerate() {
            let group_dir = self.root.join(format!("capture-profile-{index}"));
            create_cgroup_dir(&group_dir, sudo_password)?;
            self.capture_matches
                .push(CgroupV2Match::from_managed_dir(&group_dir)?);
            self.app_group_dirs.push(group_dir);
        }
        for (index, pids) in target_pid_groups.iter().enumerate() {
            for pid in pids {
                self.move_app_pid(index, *pid, sudo_password)?;
            }
        }
        Ok(())
    }

    fn finish_setup(
        mut self,
        setup: Result<(), String>,
        sudo_password: Option<&str>,
    ) -> Result<Self, String> {
        if let Err(error) = setup {
            let cleanup_error = self.cleanup(sudo_password).err();
            Err(match cleanup_error {
                Some(cleanup_error) => format!("{error}; cleanup also failed: {cleanup_error}"),
                None => error,
            })
        } else {
            Ok(self)
        }
    }

    pub fn bypass_match(&self) -> Option<CgroupV2Match> {
        self.bypass_match.clone()
    }

    pub fn capture_matches(&self) -> &[CgroupV2Match] {
        &self.capture_matches
    }

    /// Move a newly-discovered app PID into its profile's stable capture
    /// subtree. nftables matches the parent profile cgroup, so descendants
    /// created after Start are covered without rewriting live rules.
    pub fn move_app_pid(
        &mut self,
        profile_index: usize,
        pid: u32,
        sudo_password: Option<&str>,
    ) -> Result<bool, String> {
        let group_dir = self
            .app_group_dirs
            .get(profile_index)
            .cloned()
            .ok_or_else(|| format!("unknown Linux app capture profile index {profile_index}"))?;
        if pid == self.self_pid {
            return Err(
                "Taomni itself cannot be selected for Linux app capture; it must remain outside the redirect cgroup"
                    .into(),
            );
        }
        if cgroup_dir_for_pid(pid)?.starts_with(&group_dir) {
            return Ok(false);
        }
        self.next_move_id += 1;
        let managed_dir = group_dir.join(format!("process-{}-{pid}", self.next_move_id));
        self.move_pid(pid, managed_dir, sudo_password)?;
        Ok(true)
    }

    /// Restore moved processes and remove the session's empty cgroup tree.
    pub fn cleanup(&mut self, sudo_password: Option<&str>) -> Result<(), String> {
        let mut errors = Vec::new();

        for moved in self.moves.iter().rev() {
            if let Err(error) = restore_managed_processes(moved, sudo_password) {
                errors.push(error);
            }
        }

        for moved in self.moves.iter().rev() {
            if let Err(error) = fs::remove_dir(&moved.managed_dir) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    let mdir_str = moved.managed_dir.display().to_string();
                    match run_command_elevated("rmdir", &[&mdir_str], None, sudo_password) {
                        Ok(output) if output.status.success() => {}
                        Ok(output) => errors.push(format!(
                            "remove {}: {error}; elevated rmdir failed: {}",
                            moved.managed_dir.display(),
                            command_error(&output)
                        )),
                        Err(elevated_error) => errors.push(format!(
                            "remove {}: {error}; elevated rmdir failed: {elevated_error}",
                            moved.managed_dir.display()
                        )),
                    }
                }
            }
        }
        for group_dir in self.app_group_dirs.iter().rev() {
            if let Err(error) = remove_cgroup_dir(group_dir, sudo_password) {
                errors.push(error);
            }
        }
        if let Err(error) = fs::remove_dir(&self.root) {
            if error.kind() != std::io::ErrorKind::NotFound {
                let root_str = self.root.display().to_string();
                match run_command_elevated("rmdir", &[&root_str], None, sudo_password) {
                    Ok(output) if output.status.success() => {}
                    Ok(output) => errors.push(format!(
                        "remove {}: {error}; elevated rmdir failed: {}",
                        self.root.display(),
                        command_error(&output)
                    )),
                    Err(elevated_error) => errors.push(format!(
                        "remove {}: {error}; elevated rmdir failed: {elevated_error}",
                        self.root.display()
                    )),
                }
            }
        }

        self.moves.clear();
        self.capture_matches.clear();
        self.app_group_dirs.clear();
        self.bypass_match = None;

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    fn move_pid(
        &mut self,
        pid: u32,
        managed_dir: PathBuf,
        sudo_password: Option<&str>,
    ) -> Result<CgroupV2Match, String> {
        let original_dir = cgroup_dir_for_pid(pid)?;
        create_cgroup_dir(&managed_dir, sudo_password)?;
        // Build the nftables cgroup v2 path before moving the process. If this
        // fails, the new cgroup is still empty and session rollback can remove
        // it without leaving a PID stranded in an untracked cgroup.
        let cgroup_match = match CgroupV2Match::from_managed_dir(&managed_dir) {
            Ok(cgroup_match) => cgroup_match,
            Err(error) => {
                let cleanup_error = fs::remove_dir(&managed_dir).err();
                return Err(match cleanup_error {
                    Some(cleanup_error) => {
                        format!("{error}; remove {}: {cleanup_error}", managed_dir.display())
                    }
                    None => error,
                });
            }
        };
        let cgroup_procs = managed_dir.join("cgroup.procs");
        let managed_display = managed_dir.display().to_string();
        self.moves.push(CgroupMove {
            original_dir,
            managed_dir: managed_dir.clone(),
        });

        // Write the PID with elevation when the desktop process does not have
        // delegated cgroup permissions. `run_command_elevated` authenticates
        // sudo separately, so tee receives only this PID and can never echo a
        // password into the application status.
        let contents = format!("{pid}\n");
        let proc_str = cgroup_procs.display().to_string();
        let res = run_command_elevated("tee", &[&proc_str], Some(&contents), sudo_password)?;
        if !res.status.success() {
            return Err(format!(
                "move PID {pid} into {managed_display}: {}. Linux capture needs root or delegated cgroup permissions",
                command_error(&res)
            ));
        }

        let actual_dir = cgroup_dir_for_pid(pid)?;
        if actual_dir != managed_dir {
            return Err(format!(
                "move PID {pid} verification failed: expected {}, found {}",
                managed_dir.display(),
                actual_dir.display()
            ));
        }

        Ok(cgroup_match)
    }
}

fn create_cgroup_dir(path: &Path, sudo_password: Option<&str>) -> Result<(), String> {
    if let Err(error) = fs::create_dir(path) {
        if !is_effective_root() && sudo_password.is_none() {
            return Err(format!(
                "create {}: {error}. Linux capture must run with permission to manage cgroup v2",
                path.display()
            ));
        }
        let path_string = path.display().to_string();
        // Keep cgroup ownership with root. Each mutation is elevated instead
        // of making kernel control files writable by the desktop process.
        let output = run_command_elevated("mkdir", &["-p", &path_string], None, sudo_password)?;
        if !output.status.success() {
            return Err(format!(
                "create {path_string}: {error}; elevated mkdir failed: {}",
                command_error(&output)
            ));
        }
    }
    Ok(())
}

fn remove_cgroup_dir(path: &Path, sudo_password: Option<&str>) -> Result<(), String> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            if !is_effective_root() && sudo_password.is_none() {
                return Err(format!(
                    "remove {}: {error}. Linux cgroup cleanup requires root or delegated cgroup v2 permissions",
                    path.display()
                ));
            }
            let path_string = path.display().to_string();
            match run_command_elevated("rmdir", &[&path_string], None, sudo_password) {
                Ok(output) if output.status.success() => Ok(()),
                Ok(output) => Err(format!(
                    "remove {}: {error}; elevated rmdir failed: {}",
                    path.display(),
                    command_error(&output)
                )),
                Err(elevated_error) => Err(format!(
                    "remove {}: {error}; elevated rmdir failed: {elevated_error}",
                    path.display()
                )),
            }
        }
    }
}

/// Return all direct process IDs currently assigned to a cgroup.
///
/// A selected process can fork while capture is active. Its children inherit
/// the managed cgroup, so cleanup must restore the whole direct membership,
/// not merely the PID selected when capture started.
fn cgroup_processes(path: &Path) -> Result<Vec<u32>, String> {
    let contents = match fs::read_to_string(path.join("cgroup.procs")) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("read {}/cgroup.procs: {error}", path.display())),
    };
    parse_cgroup_processes(&contents, path)
}

fn parse_cgroup_processes(contents: &str, path: &Path) -> Result<Vec<u32>, String> {
    contents
        .lines()
        .map(|line| {
            line.parse::<u32>()
                .map_err(|error| format!("parse PID {line:?} in {}: {error}", path.display()))
        })
        .collect()
}

fn restore_managed_processes(
    moved: &CgroupMove,
    sudo_password: Option<&str>,
) -> Result<(), String> {
    for pid in cgroup_processes(&moved.managed_dir)? {
        if !Path::new(&format!("/proc/{pid}")).exists() {
            continue;
        }
        let target = moved.original_dir.join("cgroup.procs");
        if let Err(error) = fs::write(&target, pid.to_string()) {
            if !is_effective_root() && sudo_password.is_some() {
                let target_str = target.display().to_string();
                let contents = format!("{pid}\n");
                let res =
                    run_command_elevated("tee", &[&target_str], Some(&contents), sudo_password)?;
                if !res.status.success() {
                    return Err(format!(
                        "restore PID {pid} from {} to {}: {error}",
                        moved.managed_dir.display(),
                        moved.original_dir.display()
                    ));
                }
            } else {
                return Err(format!(
                    "restore PID {pid} from {} to {}: {error}",
                    moved.managed_dir.display(),
                    moved.original_dir.display()
                ));
            }
        }
    }
    Ok(())
}

fn command_error(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("exit status {}", output.status)
    } else {
        stderr
    }
}

/// Best-effort cleanup used by Recover / boot repair. It intentionally removes
/// only empty cgroups with the generated prefix; it never moves live processes.
pub fn cleanup_empty_sessions(sudo_password: Option<&str>) -> Result<(), String> {
    let root = Path::new(CGROUP_ROOT);
    cleanup_empty_sessions_in(root, sudo_password)
}

fn cleanup_empty_sessions_in(root: &Path, sudo_password: Option<&str>) -> Result<(), String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read {}: {error}", root.display())),
    };

    let mut errors = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(SESSION_PREFIX) {
            continue;
        }
        let path = entry.path();
        if let Err(error) = remove_empty_tree(&path, sudo_password) {
            errors.push(format!("{}: {error}", path.display()));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn remove_empty_tree(path: &Path, sudo_password: Option<&str>) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|e| e.to_string())?.flatten() {
        let child = entry.path();
        if child.is_dir() {
            remove_empty_tree(&child, sudo_password)?;
        }
    }
    remove_cgroup_dir(path, sudo_password)
}

fn cgroup_dir_for_pid(pid: u32) -> Result<PathBuf, String> {
    let contents = fs::read_to_string(format!("/proc/{pid}/cgroup"))
        .map_err(|e| format!("read /proc/{pid}/cgroup: {e}"))?;
    let relative = parse_cgroup_v2_path(&contents)
        .ok_or_else(|| format!("PID {pid} is not in a cgroup v2 hierarchy"))?;
    cgroup_dir_from_relative(relative)
}

pub(crate) fn parse_cgroup_v2_path(contents: &str) -> Option<&str> {
    contents.lines().find_map(|line| line.strip_prefix("0::"))
}

pub(crate) fn cgroup_dir_from_relative(relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative.trim_start_matches('/'));
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("invalid cgroup v2 path".into());
    }
    Ok(Path::new(CGROUP_ROOT).join(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unified_cgroup_path() {
        assert_eq!(
            parse_cgroup_v2_path("0::/user.slice/user-1000.slice/session-2.scope\n"),
            Some("/user.slice/user-1000.slice/session-2.scope")
        );
    }

    #[test]
    fn rejects_parent_components() {
        assert!(cgroup_dir_from_relative("/../outside").is_err());
    }

    #[test]
    fn renders_real_cgroup_v2_socket_expression() {
        let cgroup_match = CgroupV2Match::from_relative_path("taomni-sockscap-42/bypass").unwrap();
        assert_eq!(
            cgroup_match.nft_expression(),
            "socket cgroupv2 level 2 \"taomni-sockscap-42/bypass\""
        );
    }

    #[test]
    fn rejects_unsafe_cgroup_match_paths() {
        assert!(CgroupV2Match::from_relative_path("../outside").is_err());
        assert!(CgroupV2Match::from_relative_path("safe/with space").is_err());
        assert!(CgroupV2Match::from_relative_path("").is_err());
    }

    #[test]
    fn parses_direct_cgroup_members() {
        let members = parse_cgroup_processes("42\n1001\n", Path::new("/test")).unwrap();
        assert_eq!(members, vec![42, 1001]);
    }

    #[test]
    fn recovery_removes_only_empty_generated_trees() {
        let directory = tempfile::tempdir().unwrap();
        let managed = directory.path().join(format!("{SESSION_PREFIX}42"));
        let nested = managed.join("capture-profile-0").join("process-1-99");
        let unrelated = directory.path().join("unrelated-service");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir(&unrelated).unwrap();

        cleanup_empty_sessions_in(directory.path(), None).unwrap();

        assert!(!managed.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn recovery_does_not_remove_nonempty_generated_trees() {
        let directory = tempfile::tempdir().unwrap();
        let managed = directory.path().join(format!("{SESSION_PREFIX}43"));
        fs::create_dir(&managed).unwrap();
        fs::write(managed.join("unexpected-file"), "keep").unwrap();

        let result = cleanup_empty_sessions_in(directory.path(), None);

        assert!(result.is_err());
        assert!(managed.exists());
    }
}
