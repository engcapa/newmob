//! Conservative read-only command classifier for Claude Code's `Bash` /
//! `run_in_terminal` tool calls (Phase 3.6).
//!
//! Goal: skip the human confirmation card for commands we are *confident* are
//! read-only, to cut the click friction of the run→read→adjust loop — without
//! ever letting a mutating command through unconfirmed. The classifier is
//! deliberately conservative: anything it cannot *prove* read-only (unknown
//! command, write redirect, `sudo`, command substitution, any opaque shell
//! construct) is `Mutating`, the safe default. Per the design decision: "if it
//! can't be confirmed, treat it as a write."
//!
//! This runs *in addition to* the dangerous-command blacklist
//! (`ai::shell_safety::check_blacklist`), which still blocks destructive
//! commands regardless of this classification — so a read-only verdict here is
//! only ever used to *waive confirmation*, never to waive the blacklist.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandClass {
    ReadOnly,
    Mutating,
}

/// Plain commands (no subcommand) that only read state and write nothing but
/// stdout/stderr. Intentionally excludes general-purpose interpreters
/// (`awk`/`sed`/`perl`/`python`/…), anything with an obscure write mode
/// (`ip`/`dmesg`/`journalctl --vacuum`), and runners (`sudo`/`env`/`xargs`/
/// `tee`) — those fall through to the `Mutating` default. `sed`/`find`/`sort`/
/// `uniq` are handled by `special_case` instead (read-only only without their
/// write flags).
const READ_ONLY_CMDS: &[&str] = &[
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "stat",
    "file",
    "du",
    "df",
    "free",
    "uptime",
    "uname",
    "hostname",
    "whoami",
    "id",
    "groups",
    "pwd",
    "echo",
    "printf",
    "date",
    "cal",
    "printenv",
    "which",
    "type",
    "tree",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "tr",
    "column",
    "tac",
    "nl",
    "od",
    "hexdump",
    "xxd",
    "strings",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "ag",
    "ack",
    "ps",
    "pstree",
    "lsof",
    "ss",
    "netstat",
    "ping",
    "dig",
    "nslookup",
    "host",
    "getent",
    "lscpu",
    "lsblk",
    "lsusb",
    "lspci",
    "lsmod",
    "sensors",
    "vmstat",
    "iostat",
    "mpstat",
    "last",
    "w",
    "who",
    "cmp",
    "diff",
    "md5sum",
    "sha1sum",
    "sha256sum",
    "cksum",
    "jq",
    "cut",
];

/// `(command, read-only subcommands)` for tools whose first argument decides
/// whether they read or mutate. Anything not in the read set → `Mutating`.
const SUBCOMMAND_READ: &[(&str, &[&str])] = &[
    (
        "git",
        &[
            "status",
            "log",
            "diff",
            "show",
            "blame",
            "rev-parse",
            "rev-list",
            "ls-files",
            "ls-remote",
            "shortlog",
            "describe",
            "reflog",
            "grep",
            "cat-file",
            "for-each-ref",
            "merge-base",
            "symbolic-ref",
            "name-rev",
            "whatchanged",
            "version",
        ],
    ),
    (
        "docker",
        &[
            "ps", "images", "logs", "inspect", "port", "top", "stats", "version", "info",
            "history", "events",
        ],
    ),
    (
        "kubectl",
        &[
            "get",
            "describe",
            "logs",
            "top",
            "explain",
            "api-resources",
            "api-versions",
            "version",
        ],
    ),
    (
        "systemctl",
        &[
            "status",
            "list-units",
            "list-unit-files",
            "is-active",
            "is-enabled",
            "is-failed",
            "show",
            "cat",
            "get-default",
            "list-dependencies",
        ],
    ),
];

/// Secret-bearing filenames whose *contents* shouldn't be slurped into the
/// model's context without a confirmation, even by a read-only command. A
/// read-only verdict is downgraded to `Mutating` when any operand looks like
/// one of these (exact basename, or `.env*` / `*.pem` / `*.key`).
const SECRET_NAME_EXACT: &[&str] = &[
    "shadow",
    "credentials",
    ".pgpass",
    ".npmrc",
    ".htpasswd",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    ".netrc",
];

/// Classify a full command line. Returns `ReadOnly` only when every
/// separator-delimited segment is provably a read-only invocation that touches
/// no secret path; otherwise `Mutating` (the safe default).
pub fn classify(command: &str) -> CommandClass {
    let cmd = command.trim();
    if cmd.is_empty() {
        return CommandClass::Mutating;
    }
    // Command / process substitution hides arbitrary commands we can't vet.
    if cmd.contains("$(") || cmd.contains('`') || cmd.contains("<(") || cmd.contains(">(") {
        return CommandClass::Mutating;
    }
    let toks = match lex(cmd) {
        Some(t) => t,
        None => return CommandClass::Mutating, // unbalanced quotes etc.
    };
    let mut saw_command = false;
    for seg in split_segments(&toks) {
        match segment_class(&seg) {
            SegResult::ReadOnly => saw_command = true,
            SegResult::Empty => {} // e.g. a trailing/leading separator
            SegResult::Mutating => return CommandClass::Mutating,
        }
    }
    if saw_command {
        CommandClass::ReadOnly
    } else {
        CommandClass::Mutating
    }
}

#[derive(Debug, Clone)]
enum Tok {
    Word(String),
    /// Maximal run of shell operator chars (`| & ; < >`). A run containing `<`
    /// or `>` is a redirection; otherwise it's a segment separator.
    Op(String),
}

enum SegResult {
    ReadOnly,
    Mutating,
    Empty,
}

/// Lex a command line into words and operator runs, honoring single/double
/// quotes and backslash escapes. Returns `None` on an unterminated quote.
fn lex(s: &str) -> Option<Vec<Tok>> {
    let is_op = |c: char| matches!(c, '|' | '&' | ';' | '<' | '>');
    let mut toks = Vec::new();
    let mut word = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => loop {
                match chars.next() {
                    Some('\'') => break,
                    Some(ch) => word.push(ch),
                    None => return None,
                }
            },
            '"' => loop {
                match chars.next() {
                    Some('"') => break,
                    Some('\\') => match chars.next() {
                        Some(n) => word.push(n),
                        None => return None,
                    },
                    Some(ch) => word.push(ch),
                    None => return None,
                }
            },
            '\\' => match chars.next() {
                Some(n) => word.push(n),
                None => return None,
            },
            c if c.is_whitespace() => {
                if !word.is_empty() {
                    toks.push(Tok::Word(std::mem::take(&mut word)));
                }
            }
            c if is_op(c) => {
                if !word.is_empty() {
                    toks.push(Tok::Word(std::mem::take(&mut word)));
                }
                let mut op = String::from(c);
                while let Some(&n) = chars.peek() {
                    if is_op(n) {
                        op.push(n);
                        chars.next();
                    } else {
                        break;
                    }
                }
                toks.push(Tok::Op(op));
            }
            c => word.push(c),
        }
    }
    if !word.is_empty() {
        toks.push(Tok::Word(word));
    }
    Some(toks)
}

/// Split a token stream on separator operators (those with no `<`/`>`), leaving
/// redirection operators inside their segment.
fn split_segments(toks: &[Tok]) -> Vec<Vec<Tok>> {
    let mut segs = Vec::new();
    let mut cur = Vec::new();
    for t in toks {
        match t {
            Tok::Op(op) if !op.contains('<') && !op.contains('>') => {
                segs.push(std::mem::take(&mut cur));
            }
            other => cur.push(other.clone()),
        }
    }
    segs.push(cur);
    segs
}

/// Classify one segment (a single simple command plus its redirects).
fn segment_class(seg: &[Tok]) -> SegResult {
    let mut words: Vec<&str> = Vec::new();
    // Redirect target words (input files, fd dups) — kept out of the command/arg
    // list so they don't pollute arg-based heuristics (e.g. `uniq`'s operand
    // count), but still scanned for secret paths.
    let mut redir_targets: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < seg.len() {
        match &seg[i] {
            Tok::Word(w) => {
                words.push(w.as_str());
                i += 1;
            }
            Tok::Op(op) => {
                // A bare number right before a redirect is an fd specifier
                // (`2>`, `1>`), not a command operand — drop it.
                if words.last().map_or(false, |w| {
                    !w.is_empty() && w.chars().all(|c| c.is_ascii_digit())
                }) {
                    words.pop();
                }
                let target = match seg.get(i + 1) {
                    Some(Tok::Word(t)) => Some(t.as_str()),
                    _ => None,
                };
                if op.contains('>') && !output_target_ok(target) {
                    // Output redirect to a real file → a write.
                    return SegResult::Mutating;
                }
                // Input/output target (file or fd) — scanned for secrets below.
                if let Some(t) = target {
                    redir_targets.push(t);
                }
                i += 2; // skip operator + its target word
            }
        }
    }

    // Skip leading `VAR=value` assignments to find the actual command.
    let mut idx = 0;
    while idx < words.len() && is_assignment(words[idx]) {
        idx += 1;
    }
    let cmd = match words.get(idx) {
        Some(c) => *c,
        None => {
            // No command at all (empty segment, or only assignments/redirects).
            return if words.is_empty() && redir_targets.is_empty() {
                SegResult::Empty
            } else {
                SegResult::Mutating
            };
        }
    };
    let args = &words[idx + 1..];
    if classify_command(cmd, args) == CommandClass::Mutating {
        return SegResult::Mutating;
    }
    // A read-only command that slurps a secret path (as an operand or via an
    // input redirect) still gets a confirmation.
    if references_sensitive(&words[idx..]) || references_sensitive(&redir_targets) {
        return SegResult::Mutating;
    }
    SegResult::ReadOnly
}

/// An output redirect is acceptable only to the bit-bucket or an fd dup
/// (`>/dev/null`, `2>&1`, `>&2`), never to a real file.
fn output_target_ok(target: Option<&str>) -> bool {
    match target {
        Some(t) => t == "/dev/null" || (!t.is_empty() && t.chars().all(|c| c.is_ascii_digit())),
        None => false,
    }
}

/// True for a leading `NAME=value` environment assignment token.
fn is_assignment(w: &str) -> bool {
    match w.find('=') {
        Some(eq) if eq > 0 => w[..eq].chars().enumerate().all(|(i, c)| {
            if i == 0 {
                c.is_ascii_alphabetic() || c == '_'
            } else {
                c.is_ascii_alphanumeric() || c == '_'
            }
        }),
        _ => false,
    }
}

/// Classify a single command + its args (no redirects, no separators).
fn classify_command(cmd: &str, args: &[&str]) -> CommandClass {
    let base = cmd.rsplit('/').next().unwrap_or(cmd);

    // Subcommand-driven tools: the first non-flag arg decides.
    if let Some((_, reads)) = SUBCOMMAND_READ.iter().find(|(c, _)| *c == base) {
        let sub = args.iter().find(|a| !a.starts_with('-'));
        return match sub {
            Some(s) if reads.contains(s) => CommandClass::ReadOnly,
            _ => CommandClass::Mutating,
        };
    }

    // Commands that read by default but write with a specific flag/operand.
    match base {
        // `sed -i` / `-i.bak` / combined short cluster containing `i` edits in
        // place; `--in-place` likewise. Otherwise sed prints to stdout.
        "sed" => {
            let writes = args.iter().any(|a| {
                a.starts_with("--in-place")
                    || (a.starts_with('-') && !a.starts_with("--") && a.contains('i'))
            });
            return if writes {
                CommandClass::Mutating
            } else {
                CommandClass::ReadOnly
            };
        }
        // `find` mutates only with these actions.
        "find" => {
            let writes = args.iter().any(|a| {
                matches!(
                    *a,
                    "-delete"
                        | "-exec"
                        | "-execdir"
                        | "-ok"
                        | "-okdir"
                        | "-fprint"
                        | "-fprint0"
                        | "-fprintf"
                        | "-fls"
                )
            });
            return if writes {
                CommandClass::Mutating
            } else {
                CommandClass::ReadOnly
            };
        }
        // `sort -o FILE` / `--output` writes a file.
        "sort" => {
            let writes = args
                .iter()
                .any(|a| *a == "-o" || a.starts_with("-o") || a.starts_with("--output"));
            return if writes {
                CommandClass::Mutating
            } else {
                CommandClass::ReadOnly
            };
        }
        // `uniq [input [output]]` — a 2nd file operand is an output file.
        "uniq" => {
            let operands = args.iter().filter(|a| !a.starts_with('-')).count();
            return if operands >= 2 {
                CommandClass::Mutating
            } else {
                CommandClass::ReadOnly
            };
        }
        _ => {}
    }

    if READ_ONLY_CMDS.contains(&base) {
        CommandClass::ReadOnly
    } else {
        CommandClass::Mutating
    }
}

/// True if any operand looks like a secret-bearing path — so a read-only
/// command that would dump its contents into the model context is still
/// confirmed. Skips flag tokens.
fn references_sensitive(words: &[&str]) -> bool {
    words.iter().any(|w| {
        if w.starts_with('-') {
            return false;
        }
        if crate::agent::safety::path_is_sensitive(w) {
            return true;
        }
        let base = w.rsplit('/').next().unwrap_or(w).to_ascii_lowercase();
        SECRET_NAME_EXACT.contains(&base.as_str())
            || base.contains(".env")
            || base.ends_with(".pem")
            || base.ends_with(".key")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ro(c: &str) -> bool {
        classify(c) == CommandClass::ReadOnly
    }

    #[test]
    fn confidently_read_only_commands_waive_confirmation() {
        for c in [
            "ls -la",
            "cat foo.txt",
            "cat /etc/passwd",
            "df -h",
            "du -sh .",
            "ps aux",
            "uname -a",
            "whoami",
            "grep -r foo src",
            "git log --oneline -20",
            "git status",
            "git diff HEAD~1",
            "docker ps -a",
            "docker logs web",
            "kubectl get pods -n prod",
            "systemctl status nginx",
            "ps aux | grep nginx",
            "cat a.txt | grep b | wc -l",
            "ls 2>/dev/null",
            "ls -l >/dev/null 2>&1",
            "find . -name '*.rs'",
            "sed -n '1,5p' file.txt",
            "sort data.txt",
            "uniq data.txt",
            "FOO=bar ls",
            "/bin/cat x.txt",
            "tail -f app.log",
            "grep x < input.txt",
            "uniq f.txt 2>/dev/null",
        ] {
            assert!(ro(c), "expected read-only (no card): {c:?}");
        }
    }

    #[test]
    fn mutating_or_unverifiable_commands_confirm() {
        for c in [
            "rm -rf build",
            "cat x > out.txt",
            "echo hi >> log.txt",
            "ps | tee f.txt",
            "sudo ls",
            "git push",
            "git branch -D old",
            "docker run img",
            "kubectl delete pod x",
            "systemctl restart nginx",
            "find . -delete",
            "find . -exec rm {} +",
            "sed -i s/a/b/ f.txt",
            "sort -o out.txt f.txt",
            "uniq in.txt out.txt",
            "cat $(rm x)",
            "echo `rm x`",
            "unknowncmd --flag",
            "awk '{print}' f.txt",
            "ls && rm x",
            "ls; rm -rf y",
            "mv a b",
            "",
            "   ",
            "tee out.txt",
        ] {
            assert!(!ro(c), "expected confirm (mutating/unverifiable): {c:?}");
        }
    }

    #[test]
    fn read_only_commands_touching_secrets_confirm() {
        for c in [
            "cat /etc/shadow",
            "grep x .env",
            "cat secrets.pem",
            "cat config.key",
            "head ~/.netrc",
            "cat .env.production",
            "grep token < .env",
        ] {
            assert!(!ro(c), "secret read must confirm: {c:?}");
        }
    }

    #[test]
    fn redirect_to_devnull_is_read_only_but_to_file_is_not() {
        assert!(ro("grep foo bar.log 2>/dev/null"));
        assert!(ro("ls -l >/dev/null"));
        assert!(!ro("ls -l > listing.txt"));
    }
}
