//! In-process reduction of a capture (方案4). The full output never enters CC's
//! context; CC asks for a distilled slice and we run the reduction here on the
//! Taomni host (B path) or, later, remotely (C path). All ops are pure Rust —
//! `regex` for grep and the embedded `jaq` engine for jq — so they work on the
//! Windows Taomni host with no external `jq`/coreutils dependency.
//!
//! Every read is itself bounded (`MAX_READ_LINES` / `MAX_READ_BYTES`, and
//! `MAX_GREP_MATCHES`) and reports a truncation receipt, so a single
//! `read_capture` can never flood the context either.

use std::io::{BufRead, BufReader};
use std::path::Path;

/// Hard ceiling on lines returned by one `read_capture`.
pub const MAX_READ_LINES: usize = 2000;
/// Hard ceiling on bytes returned by one `read_capture`.
pub const MAX_READ_BYTES: usize = 256 * 1024;
/// Hard ceiling on grep matches returned by one `read_capture`.
pub const MAX_GREP_MATCHES: usize = 500;

/// A reduction request over a capture's stored output.
#[derive(Debug, Clone, PartialEq)]
pub enum ReduceOp {
    Head {
        n: usize,
    },
    Tail {
        n: usize,
    },
    /// 1-based inclusive line range.
    Range {
        start: usize,
        end: usize,
    },
    Grep {
        pattern: String,
        context: usize,
    },
    Jq {
        filter: String,
    },
    Stats,
}

/// Distilled output plus whether a per-call cap clipped it.
#[derive(Debug, Clone)]
pub struct ReduceResult {
    pub text: String,
    pub truncated: bool,
    pub note: Option<String>,
}

impl ReduceResult {
    fn plain(text: String, truncated: bool) -> Self {
        Self {
            text,
            truncated,
            note: None,
        }
    }
}

/// Apply `op` to the capture file at `path`.
pub fn reduce_file(path: &Path, op: &ReduceOp) -> Result<ReduceResult, String> {
    match op {
        ReduceOp::Head { n } => head(path, *n),
        ReduceOp::Tail { n } => tail(path, *n),
        ReduceOp::Range { start, end } => range(path, *start, *end),
        ReduceOp::Grep { pattern, context } => grep(path, pattern, *context),
        ReduceOp::Jq { filter } => jq(path, filter),
        ReduceOp::Stats => stats(path),
    }
}

/// Apply `op` to an in-memory string (used by the C pull-to-Rust fallback,
/// where a bounded window of a remote file is fetched and reduced locally).
/// Spills to a temp file so the streaming file ops are reused verbatim.
pub fn reduce_str(content: &str, op: &ReduceOp) -> Result<ReduceResult, String> {
    let p = std::env::temp_dir().join(format!("taomni-pull-{}.log", uuid::Uuid::new_v4().simple()));
    std::fs::write(&p, content.as_bytes()).map_err(|e| format!("pull buffer: {e}"))?;
    let r = reduce_file(&p, op);
    let _ = std::fs::remove_file(&p);
    r
}

fn open_lines(path: &Path) -> Result<impl Iterator<Item = String>, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("capture file unavailable: {e}"))?;
    Ok(BufReader::new(f).lines().map(|r| r.unwrap_or_default()))
}

/// Join lines into a byte/line-capped string, reporting truncation.
fn join_capped(lines: impl Iterator<Item = String>, max_lines: usize) -> ReduceResult {
    let mut out = String::new();
    let mut n = 0usize;
    let mut truncated = false;
    for line in lines {
        if n >= max_lines || out.len() + line.len() + 1 > MAX_READ_BYTES {
            truncated = true;
            break;
        }
        out.push_str(&line);
        out.push('\n');
        n += 1;
    }
    ReduceResult::plain(out, truncated)
}

fn head(path: &Path, n: usize) -> Result<ReduceResult, String> {
    let n = n.min(MAX_READ_LINES).max(1);
    Ok(join_capped(open_lines(path)?.take(n), n))
}

fn tail(path: &Path, n: usize) -> Result<ReduceResult, String> {
    let n = n.min(MAX_READ_LINES).max(1);
    // Ring buffer of the last n lines, bounded memory regardless of file size.
    let mut ring: std::collections::VecDeque<String> = std::collections::VecDeque::with_capacity(n);
    for line in open_lines(path)? {
        if ring.len() == n {
            ring.pop_front();
        }
        ring.push_back(line);
    }
    Ok(join_capped(ring.into_iter(), n))
}

fn range(path: &Path, start: usize, end: usize) -> Result<ReduceResult, String> {
    if start == 0 || end < start {
        return Err("range requires 1-based start ≤ end".into());
    }
    let want = (end - start + 1).min(MAX_READ_LINES);
    let selected = open_lines(path)?.skip(start - 1).take(want);
    Ok(join_capped(selected, want))
}

fn grep(path: &Path, pattern: &str, context: usize) -> Result<ReduceResult, String> {
    let re = regex::Regex::new(pattern).map_err(|e| format!("invalid regex: {e}"))?;
    let context = context.min(10);
    let mut out = String::new();
    let mut matches = 0usize;
    let mut truncated = false;
    // Single pass with a small look-behind ring for leading context.
    let mut behind: std::collections::VecDeque<(usize, String)> =
        std::collections::VecDeque::with_capacity(context + 1);
    let mut emit_after = 0usize; // remaining trailing-context lines to emit
    let mut last_emitted: Option<usize> = None;

    let push = |out: &mut String, no: usize, line: &str, last: &mut Option<usize>| {
        if let Some(prev) = *last {
            if no > prev + 1 {
                out.push_str("--\n");
            }
        }
        out.push_str(&format!("{no}:{line}\n"));
        *last = Some(no);
    };

    for (idx, line) in open_lines(path)?.enumerate() {
        let no = idx + 1;
        let is_match = re.is_match(&line);
        if is_match {
            if matches >= MAX_GREP_MATCHES || out.len() > MAX_READ_BYTES {
                truncated = true;
                break;
            }
            // Flush leading context.
            for (cno, cl) in behind.iter() {
                push(&mut out, *cno, cl, &mut last_emitted);
            }
            behind.clear();
            push(&mut out, no, &line, &mut last_emitted);
            matches += 1;
            emit_after = context;
        } else if emit_after > 0 {
            push(&mut out, no, &line, &mut last_emitted);
            emit_after -= 1;
        } else {
            if context > 0 {
                if behind.len() == context {
                    behind.pop_front();
                }
                behind.push_back((no, line));
            }
        }
    }
    let note = Some(format!("{matches} match(es)"));
    Ok(ReduceResult {
        text: out,
        truncated,
        note,
    })
}

fn stats(path: &Path) -> Result<ReduceResult, String> {
    let mut lines = 0u64;
    let mut bytes = 0u64;
    for line in open_lines(path)? {
        lines += 1;
        bytes += line.len() as u64 + 1;
    }
    Ok(ReduceResult::plain(
        format!("lines={lines}\nbytes≈{bytes}\n"),
        false,
    ))
}

/// Run a jq `filter` over the capture content using the embedded `jaq` engine.
/// The content is parsed as a single JSON value; outputs are newline-joined.
fn jq(path: &Path, filter: &str) -> Result<ReduceResult, String> {
    use jaq_core::load::{Arena, File, Loader};
    use jaq_core::{Compiler, Ctx, Vars, data, unwrap_valr};
    use jaq_json::{Val, read};

    let content =
        std::fs::read_to_string(path).map_err(|e| format!("capture file unavailable: {e}"))?;
    let input: Val = read::parse_single(content.as_bytes())
        .map_err(|e| format!("capture is not valid JSON for jq: {e}"))?;

    let program = File {
        code: filter,
        path: (),
    };
    let defs = jaq_core::defs()
        .chain(jaq_std::defs())
        .chain(jaq_json::defs());
    let funs = jaq_core::funs()
        .chain(jaq_std::funs())
        .chain(jaq_json::funs());
    let loader = Loader::new(defs);
    let arena = Arena::default();
    let modules = loader
        .load(&arena, program)
        .map_err(|_| "failed to parse jq filter".to_string())?;
    let filter = Compiler::default()
        .with_funs(funs)
        .compile(modules)
        .map_err(|_| "failed to compile jq filter".to_string())?;
    let ctx = Ctx::<data::JustLut<Val>>::new(&filter.lut, Vars::new([]));

    let mut out = String::new();
    let mut truncated = false;
    let mut count = 0usize;
    for item in filter.id.run((ctx, input)).map(unwrap_valr) {
        let val = item.map_err(|e| format!("jq runtime error: {e}"))?;
        let s = val.to_string();
        if count >= MAX_READ_LINES || out.len() + s.len() + 1 > MAX_READ_BYTES {
            truncated = true;
            break;
        }
        out.push_str(&s);
        out.push('\n');
        count += 1;
    }
    Ok(ReduceResult::plain(out, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(lines: &[&str]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "taomni-reduce-{}.log",
            uuid::Uuid::new_v4().simple()
        ));
        let mut f = std::fs::File::create(&p).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        p
    }

    #[test]
    fn head_takes_first_n() {
        let p = fixture(&["one", "two", "three", "four"]);
        let r = reduce_file(&p, &ReduceOp::Head { n: 2 }).unwrap();
        assert_eq!(r.text, "one\ntwo\n");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn tail_takes_last_n() {
        let p = fixture(&["one", "two", "three", "four"]);
        let r = reduce_file(&p, &ReduceOp::Tail { n: 2 }).unwrap();
        assert_eq!(r.text, "three\nfour\n");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn range_is_one_based_inclusive() {
        let p = fixture(&["a", "b", "c", "d", "e"]);
        let r = reduce_file(&p, &ReduceOp::Range { start: 2, end: 4 }).unwrap();
        assert_eq!(r.text, "b\nc\nd\n");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn grep_matches_with_line_numbers() {
        let p = fixture(&["info: ok", "ERROR: boom", "info: ok2", "ERROR: bang"]);
        let r = reduce_file(
            &p,
            &ReduceOp::Grep {
                pattern: "ERROR".into(),
                context: 0,
            },
        )
        .unwrap();
        assert!(r.text.contains("2:ERROR: boom"));
        assert!(r.text.contains("4:ERROR: bang"));
        assert!(!r.text.contains("info"));
        assert_eq!(r.note.as_deref(), Some("2 match(es)"));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn grep_context_includes_neighbors() {
        let p = fixture(&["a", "b", "MATCH", "d", "e"]);
        let r = reduce_file(
            &p,
            &ReduceOp::Grep {
                pattern: "MATCH".into(),
                context: 1,
            },
        )
        .unwrap();
        assert!(r.text.contains("2:b"));
        assert!(r.text.contains("3:MATCH"));
        assert!(r.text.contains("4:d"));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn stats_counts() {
        let p = fixture(&["a", "bb", "ccc"]);
        let r = reduce_file(&p, &ReduceOp::Stats).unwrap();
        assert!(r.text.contains("lines=3"));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn jq_filters_json() {
        let p = fixture(&[r#"{"items":[{"n":1},{"n":2},{"n":3}]}"#]);
        let r = reduce_file(
            &p,
            &ReduceOp::Jq {
                filter: ".items[].n".into(),
            },
        )
        .unwrap();
        assert_eq!(r.text, "1\n2\n3\n");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn jq_reports_bad_json() {
        let p = fixture(&["not json at all"]);
        assert!(reduce_file(&p, &ReduceOp::Jq { filter: ".".into() }).is_err());
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn invalid_regex_errs() {
        let p = fixture(&["x"]);
        assert!(
            reduce_file(
                &p,
                &ReduceOp::Grep {
                    pattern: "(".into(),
                    context: 0
                }
            )
            .is_err()
        );
        let _ = std::fs::remove_file(p);
    }
}
