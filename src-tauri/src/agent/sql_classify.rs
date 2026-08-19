//! Conservative read-only SQL classifier for the DB MCP's `run_sql` /
//! `run_sql_captured` tools (Phase 6), mirroring the shell `cmd_classify` (3.6).
//!
//! Goal: skip the human confirmation card for statements we are *confident* are
//! read-only (SELECT / SHOW / DESCRIBE / EXPLAIN / read-only CTE), to cut the
//! click friction of the query→inspect→refine loop — without ever letting a
//! mutating statement through unconfirmed. Deliberately conservative: anything
//! it cannot *prove* read-only (DDL/DML, multi-statement, `SELECT … INTO`,
//! `EXPLAIN ANALYZE`, opaque construct) is `Mutating`, the safe default.
//!
//! This only ever *waives confirmation*; it never bypasses the per-session
//! "AI 写动作禁用" flag or any other safety check, which run regardless.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlClass {
    ReadOnly,
    Mutating,
}

/// Leading keywords that begin a read-only statement (subject to the extra
/// guards below — e.g. `SELECT … INTO` and data-modifying CTEs are excluded).
const READ_LEADERS: &[&str] = &[
    "select", "show", "desc", "describe", "explain", "with", "values", "table", "pragma",
];

/// Word-boundary keywords that mean a statement mutates data/schema/session.
/// Used to disqualify `WITH …` / `EXPLAIN …` bodies that wrap a write.
const MUTATING_WORDS: &[&str] = &[
    "insert", "update", "delete", "merge", "replace", "upsert", "create", "alter", "drop",
    "truncate", "grant", "revoke", "call", "exec", "execute", "copy", "load", "import", "attach",
    "rename", "vacuum", "optimize", "reindex", "cluster", "lock", "comment", "refresh", "set",
];

/// Classify a single SQL statement string. Conservative: unknown ⇒ `Mutating`.
pub fn classify(sql: &str) -> SqlClass {
    let stripped = strip_comments(sql);
    let trimmed = stripped.trim();
    if trimmed.is_empty() {
        // Nothing to run; treat as non-read so it doesn't silently auto-allow.
        return SqlClass::Mutating;
    }

    // Multiple statements: a `;` anywhere but the trailing position means more
    // than one statement — too much to verify, so confirm. (Naive on `;` inside
    // string literals → at worst an extra confirmation, never an unsafe allow.)
    let body = trimmed.trim_end_matches(';').trim_end();
    if body.contains(';') {
        return SqlClass::Mutating;
    }

    let lower = body.to_ascii_lowercase();
    let leader = lower
        .split(|c: char| !c.is_ascii_alphabetic())
        .find(|w| !w.is_empty())
        .unwrap_or("");
    if !READ_LEADERS.contains(&leader) {
        return SqlClass::Mutating;
    }

    match leader {
        // `SELECT … INTO target` materializes a table (T-SQL / PG); treat as write.
        "select" => {
            if has_word(&lower, "into") {
                SqlClass::Mutating
            } else {
                SqlClass::ReadOnly
            }
        }
        // A CTE is read-only only if its body doesn't wrap a data-modifying
        // statement (PostgreSQL allows `WITH … DELETE/UPDATE/INSERT`).
        "with" => {
            if MUTATING_WORDS.iter().any(|w| has_word(&lower, w)) {
                SqlClass::Mutating
            } else {
                SqlClass::ReadOnly
            }
        }
        // `EXPLAIN ANALYZE <mutating>` actually executes the statement, and a
        // bare EXPLAIN of a write still describes a write — only allow EXPLAIN
        // when it neither analyzes nor wraps a mutating verb.
        "explain" => {
            if has_word(&lower, "analyze") || MUTATING_WORDS.iter().any(|w| has_word(&lower, w)) {
                SqlClass::Mutating
            } else {
                SqlClass::ReadOnly
            }
        }
        // show / desc / describe / values / table / pragma — pure reads.
        _ => SqlClass::ReadOnly,
    }
}

/// True if `needle` appears in `haystack` as a whole word (ascii boundaries).
/// `haystack` is assumed already lowercased.
fn has_word(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let n = needle.len();
    let mut i = 0;
    while let Some(pos) = haystack[i..].find(needle) {
        let start = i + pos;
        let end = start + n;
        let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let after_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        i = start + 1;
        if i >= haystack.len() {
            break;
        }
    }
    false
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Remove `-- line` and `/* block */` comments so the leading keyword scan sees
/// the real statement. String-literal awareness is intentionally omitted (a
/// stray `--`/`/*` inside a literal only risks an extra confirmation).
fn strip_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
            // line comment to end of line
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2; // skip closing */
            out.push(' ');
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ro(sql: &str) {
        assert_eq!(
            classify(sql),
            SqlClass::ReadOnly,
            "expected ReadOnly: {sql}"
        );
    }
    fn mut_(sql: &str) {
        assert_eq!(
            classify(sql),
            SqlClass::Mutating,
            "expected Mutating: {sql}"
        );
    }

    #[test]
    fn plain_reads_are_readonly() {
        ro("SELECT * FROM users WHERE id = 1");
        ro("  select 1");
        ro("SHOW TABLES");
        ro("DESCRIBE users");
        ro("DESC users");
        ro("EXPLAIN SELECT * FROM t");
        ro("VALUES (1),(2)");
        ro("TABLE users");
        ro("select count(*) from orders;"); // trailing semicolon ok
    }

    #[test]
    fn dml_ddl_is_mutating() {
        mut_("INSERT INTO t VALUES (1)");
        mut_("UPDATE t SET a=1");
        mut_("DELETE FROM t WHERE id=1");
        mut_("DROP TABLE t");
        mut_("CREATE TABLE t (id int)");
        mut_("ALTER TABLE t ADD COLUMN c int");
        mut_("TRUNCATE t");
        mut_("GRANT SELECT ON t TO u");
        mut_("MERGE INTO t USING s ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET a=1");
        mut_("CALL my_proc()");
        mut_("SET search_path TO public");
    }

    #[test]
    fn select_into_is_mutating() {
        // Materializes a table — not a pure read.
        mut_("SELECT * INTO backup FROM users");
    }

    #[test]
    fn data_modifying_cte_is_mutating() {
        mut_("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d");
        ro("WITH recent AS (SELECT * FROM t ORDER BY ts DESC LIMIT 10) SELECT * FROM recent");
    }

    #[test]
    fn explain_analyze_and_explain_write_are_mutating() {
        mut_("EXPLAIN ANALYZE SELECT * FROM t"); // ANALYZE executes
        mut_("EXPLAIN INSERT INTO t VALUES (1)");
    }

    #[test]
    fn multi_statement_is_mutating() {
        mut_("SELECT 1; DROP TABLE t");
        mut_("SELECT 1; SELECT 2");
    }

    #[test]
    fn comments_are_stripped_before_classifying() {
        ro("-- fetch users\nSELECT * FROM users");
        ro("/* report */ SELECT 1");
        mut_("/* sneaky */ DROP TABLE t");
    }

    #[test]
    fn empty_or_unknown_is_mutating() {
        mut_("");
        mut_("   \n  ");
        mut_("BEGIN");
        mut_("WeirdVerb foo");
    }

    #[test]
    fn word_boundary_does_not_false_match() {
        // "created_at" contains "create" but not as a word.
        ro("SELECT created_at, updated_count FROM t");
    }
}
