//! Compile and match GFWList / AutoProxy rule sets.

use super::autopxy::{host_matches_suffix, parse_autopxy_line, ParsedRule};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GfwListMeta {
    pub source: String,
    pub rule_count: usize,
    pub skipped: usize,
    pub last_refresh: Option<String>,
    #[serde(default)]
    pub etag: Option<String>,
}

impl GfwListMeta {
    pub fn load(path: &std::path::Path) -> Option<Self> {
        let s = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&s).ok()
    }

    pub fn save(&self, path: &std::path::Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let j = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, j).map_err(|e| e.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleMatch {
    /// Host matched a proxy rule in GFWList.
    Proxy { rule: String },
    /// Host matched a whitelist (@@) rule.
    Direct { rule: String },
    /// No GFWList hit.
    Miss,
}

/// Immutable compiled snapshot used on the hot path.
#[derive(Debug, Clone)]
pub struct CompiledRules {
    pub meta: GfwListMeta,
    /// Domain suffixes that should be proxied.
    proxy_suffixes: HashSet<String>,
    /// Domain suffixes that must stay direct (@@).
    direct_suffixes: HashSet<String>,
    proxy_contains: Vec<String>,
    direct_contains: Vec<String>,
    proxy_regex: Vec<(String, Regex)>,
    direct_regex: Vec<(String, Regex)>,
}

impl CompiledRules {
    /// Decode gfwlist base64 payload (or plain AutoProxy text) and compile.
    pub fn compile(raw: &str, source: &str) -> Result<Self, String> {
        let text = decode_gfwlist_payload(raw)?;
        let mut proxy_suffixes = HashSet::new();
        let mut direct_suffixes = HashSet::new();
        let mut proxy_contains = Vec::new();
        let mut direct_contains = Vec::new();
        let mut proxy_regex = Vec::new();
        let mut direct_regex = Vec::new();
        let mut skipped = 0usize;
        let mut rule_count = 0usize;

        for line in text.lines() {
            match parse_autopxy_line(line) {
                ParsedRule::Skip { .. } => skipped += 1,
                ParsedRule::DomainSuffix { host, direct } => {
                    rule_count += 1;
                    if direct {
                        direct_suffixes.insert(host);
                    } else {
                        proxy_suffixes.insert(host);
                    }
                }
                ParsedRule::Contains { needle, direct } => {
                    rule_count += 1;
                    if direct {
                        direct_contains.push(needle);
                    } else {
                        proxy_contains.push(needle);
                    }
                }
                ParsedRule::Regex { pattern, direct } => match Regex::new(&pattern) {
                    Ok(re) => {
                        rule_count += 1;
                        if direct {
                            direct_regex.push((pattern, re));
                        } else {
                            proxy_regex.push((pattern, re));
                        }
                    }
                    Err(_) => skipped += 1,
                },
            }
        }

        let last_refresh = chrono_like_now();
        Ok(Self {
            meta: GfwListMeta {
                source: source.to_string(),
                rule_count,
                skipped,
                last_refresh: Some(last_refresh),
                etag: None,
            },
            proxy_suffixes,
            direct_suffixes,
            proxy_contains,
            direct_contains,
            proxy_regex,
            direct_regex,
        })
    }

    pub fn match_host(&self, host: &str) -> RuleMatch {
        let h = host.trim_end_matches('.').to_ascii_lowercase();
        if h.is_empty() {
            return RuleMatch::Miss;
        }

        // Whitelist first (@@ takes priority within GFWList).
        if let Some(s) = match_suffix_set(&h, &self.direct_suffixes) {
            return RuleMatch::Direct {
                rule: format!("@@||{s}"),
            };
        }
        for n in &self.direct_contains {
            if h.contains(n) {
                return RuleMatch::Direct {
                    rule: format!("@@*{n}*"),
                };
            }
        }
        for (pat, re) in &self.direct_regex {
            if re.is_match(&h) {
                return RuleMatch::Direct {
                    rule: format!("@@/{pat}/"),
                };
            }
        }

        if let Some(s) = match_suffix_set(&h, &self.proxy_suffixes) {
            return RuleMatch::Proxy {
                rule: format!("||{s}"),
            };
        }
        for n in &self.proxy_contains {
            if h.contains(n) {
                return RuleMatch::Proxy {
                    rule: format!("*{n}*"),
                };
            }
        }
        for (pat, re) in &self.proxy_regex {
            if re.is_match(&h) {
                return RuleMatch::Proxy {
                    rule: format!("/{pat}/"),
                };
            }
        }
        RuleMatch::Miss
    }
}

/// Most specific suffix rule matching `host`, if any.
///
/// Probes the host's own label suffixes against the set — `a.b.example.com`,
/// then `b.example.com`, `example.com`, `com` — instead of testing the host
/// against every rule. GFWList carries thousands of suffix rules, and the old
/// linear scan additionally built a `format!(".{suffix}")` string *per rule*, so
/// a single policy decision could mean thousands of allocations. This is a
/// handful of hash lookups and no allocation, and it runs for every captured
/// connection.
///
/// Equivalent by construction: `host_matches_suffix` accepts exactly the host
/// itself and any suffix beginning at a label boundary, which is precisely the
/// sequence probed here. Longest first, so the reported rule is now the most
/// specific match rather than whichever the hash set happened to yield first.
fn match_suffix_set(host: &str, set: &HashSet<String>) -> Option<String> {
    if set.is_empty() {
        return None;
    }
    let mut rest = host;
    loop {
        if set.contains(rest) {
            return Some(rest.to_string());
        }
        match rest.find('.') {
            Some(i) => rest = &rest[i + 1..],
            None => return None,
        }
    }
}

/// GFWList files are typically base64 of the AutoProxy text. Accept either.
fn decode_gfwlist_payload(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty gfwlist payload".into());
    }
    // Heuristic: if it looks like AutoProxy already, use as-is.
    if trimmed.lines().any(|l| {
        let l = l.trim();
        l.starts_with("||") || l.starts_with("@@") || l.starts_with('!') || l.starts_with("[Auto")
    }) {
        return Ok(trimmed.to_string());
    }
    // Otherwise treat as base64 (possibly multi-line).
    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = B64
        .decode(compact.as_bytes())
        .map_err(|e| format!("gfwlist base64 decode: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("gfwlist utf8: {e}"))
}

fn chrono_like_now() -> String {
    // Avoid pulling chrono if not needed — RFC3339 via system time.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Simple ISO-ish UTC; good enough for UI/meta.
    format!("unix:{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[AutoProxy 0.2.9]
! Comment
||google.com
||github.com
@@||local.google.com
|https://cdn.jsdelivr.net/
twitter
.facebook.com
"#;

    #[test]
    fn compile_plain_and_match() {
        let c = CompiledRules::compile(SAMPLE, "test").unwrap();
        assert!(c.meta.rule_count >= 5);
        assert!(matches!(
            c.match_host("www.google.com"),
            RuleMatch::Proxy { .. }
        ));
        assert!(matches!(
            c.match_host("api.github.com"),
            RuleMatch::Proxy { .. }
        ));
        assert!(matches!(
            c.match_host("local.google.com"),
            RuleMatch::Direct { .. }
        ));
        assert!(matches!(
            c.match_host("cdn.jsdelivr.net"),
            RuleMatch::Proxy { .. }
        ));
        assert!(matches!(
            c.match_host("www.facebook.com"),
            RuleMatch::Proxy { .. }
        ));
        assert!(matches!(c.match_host("example.com"), RuleMatch::Miss));
    }

    #[test]
    fn compile_base64() {
        let b64 = B64.encode(SAMPLE.as_bytes());
        let c = CompiledRules::compile(&b64, "b64").unwrap();
        assert!(matches!(
            c.match_host("google.com"),
            RuleMatch::Proxy { .. }
        ));
    }

    #[test]
    fn suffix_probe_agrees_with_pairwise_matching() {
        // The label-suffix probe replaced a scan that tested every rule with
        // `host_matches_suffix`; the two must accept exactly the same hosts.
        let set: HashSet<String> = ["google.com", "b.example.com", "com"]
            .into_iter()
            .map(String::from)
            .collect();
        for host in [
            "google.com",
            "www.google.com",
            "a.b.example.com",
            "b.example.com",
            "example.com",
            "notgoogle.com",
            "google.com.cn",
            "",
        ] {
            let probed = match_suffix_set(host, &set).is_some();
            let pairwise = !host.is_empty()
                && set.iter().any(|s| host_matches_suffix(host, s));
            assert_eq!(probed, pairwise, "disagreement on {host:?}");
        }
    }

    #[test]
    fn suffix_probe_returns_the_most_specific_rule() {
        let set: HashSet<String> = ["example.com", "cdn.example.com"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            match_suffix_set("a.cdn.example.com", &set).as_deref(),
            Some("cdn.example.com")
        );
    }

    #[test]
    fn suffix_probe_does_not_match_across_label_boundaries() {
        let set: HashSet<String> = ["google.com"].into_iter().map(String::from).collect();
        assert!(match_suffix_set("notgoogle.com", &set).is_none());
        assert!(match_suffix_set("google.com.evil.net", &set).is_none());
    }

    #[test]
    fn empty_rule_set_is_a_miss() {
        let set: HashSet<String> = HashSet::new();
        assert!(match_suffix_set("anything.example", &set).is_none());
    }
}
