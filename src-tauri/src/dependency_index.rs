//! Maven / Gradle dependency completion backend (N8.2).
//!
//! Provides proxied, cached querying against Maven Central for groupId, artifactId,
//! and accurate GAV (core=gav) version listings with 3s deadlines.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAVEN_SEARCH_URL: &str = "https://search.maven.org/solrsearch/select";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const CACHE_TTL: Duration = Duration::from_secs(300);
const MAX_CACHE_ENTRIES: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyIndexStatus {
    pub kind: String, // "available" | "unavailable" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyCoordinate {
    pub group_id: String,
    pub artifact_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyVersion {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<u64>,
}

struct CacheEntry<T> {
    data: T,
    created: Instant,
}

struct DependencyCache {
    search_cache: HashMap<String, CacheEntry<Vec<DependencyCoordinate>>>,
    version_cache: HashMap<String, CacheEntry<Vec<DependencyVersion>>>,
}

impl DependencyCache {
    fn new() -> Self {
        Self {
            search_cache: HashMap::new(),
            version_cache: HashMap::new(),
        }
    }

    fn get_search(&mut self, key: &str) -> Option<Vec<DependencyCoordinate>> {
        if let Some(entry) = self.search_cache.get(key) {
            if entry.created.elapsed() < CACHE_TTL {
                return Some(entry.data.clone());
            }
        }
        self.search_cache.remove(key);
        None
    }

    fn put_search(&mut self, key: String, data: Vec<DependencyCoordinate>) {
        if self.search_cache.len() >= MAX_CACHE_ENTRIES {
            self.search_cache.clear();
        }
        self.search_cache.insert(
            key,
            CacheEntry {
                data,
                created: Instant::now(),
            },
        );
    }

    fn get_versions(&mut self, key: &str) -> Option<Vec<DependencyVersion>> {
        if let Some(entry) = self.version_cache.get(key) {
            if entry.created.elapsed() < CACHE_TTL {
                return Some(entry.data.clone());
            }
        }
        self.version_cache.remove(key);
        None
    }

    fn put_versions(&mut self, key: String, data: Vec<DependencyVersion>) {
        if self.version_cache.len() >= MAX_CACHE_ENTRIES {
            self.version_cache.clear();
        }
        self.version_cache.insert(
            key,
            CacheEntry {
                data,
                created: Instant::now(),
            },
        );
    }
}

static CACHE: Mutex<Option<DependencyCache>> = Mutex::new(None);

fn with_cache<F, R>(f: F) -> R
where
    F: FnOnce(&mut DependencyCache) -> R,
{
    let mut guard = CACHE.lock().unwrap();
    if guard.is_none() {
        *guard = Some(DependencyCache::new());
    }
    f(guard.as_mut().unwrap())
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("Taomni-IDE/1.0 (Dependency-Completion)")
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

#[tauri::command]
pub async fn dependency_index_status() -> Result<DependencyIndexStatus, String> {
    // Quick ping to check status
    let client = match build_client() {
        Ok(c) => c,
        Err(e) => {
            return Ok(DependencyIndexStatus {
                kind: "error".to_string(),
                reason: Some(e),
            });
        }
    };

    let url = format!("{MAVEN_SEARCH_URL}?q=test&rows=1&wt=json");
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => Ok(DependencyIndexStatus {
            kind: "available".to_string(),
            reason: None,
        }),
        Ok(resp) => Ok(DependencyIndexStatus {
            kind: "unavailable".to_string(),
            reason: Some(format!("Maven Central returned HTTP {}", resp.status())),
        }),
        Err(e) => Ok(DependencyIndexStatus {
            kind: "unavailable".to_string(),
            reason: Some(e.to_string()),
        }),
    }
}

#[derive(Deserialize)]
struct SolrResponse {
    response: Option<SolrDocs>,
}

#[derive(Deserialize)]
struct SolrDocs {
    docs: Option<Vec<SolrDoc>>,
}

#[derive(Deserialize)]
struct SolrDoc {
    g: Option<String>,
    a: Option<String>,
    v: Option<String>,
    timestamp: Option<u64>,
    text: Option<String>,
}

#[tauri::command]
pub async fn dependency_index_search(
    query: String,
    kind: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<DependencyCoordinate>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let max_rows = limit.unwrap_or(20).clamp(1, 50);
    let cache_key = format!("{}:{}:{}", kind.as_deref().unwrap_or("all"), q, max_rows);

    if let Some(cached) = with_cache(|c| c.get_search(&cache_key)) {
        return Ok(cached);
    }

    let client = build_client()?;
    let solr_query = match kind.as_deref() {
        Some("group") => format!("g:\"{q}\""),
        Some("artifact") => format!("a:\"{q}\""),
        _ => q.clone(),
    };

    let resp = client
        .get(MAVEN_SEARCH_URL)
        .query(&[
            ("q", solr_query.as_str()),
            ("rows", &max_rows.to_string()),
            ("wt", "json"),
        ])
        .send()
        .await
        .map_err(|e| format!("Maven search request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Maven Central HTTP error: {}", resp.status()));
    }

    let body: SolrResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Maven search JSON: {e}"))?;

    let mut results = Vec::new();
    if let Some(docs) = body.response.and_then(|r| r.docs) {
        for doc in docs {
            if let (Some(g), Some(a)) = (doc.g, doc.a) {
                results.push(DependencyCoordinate {
                    group_id: g.clone(),
                    artifact_id: a.clone(),
                    version: doc.v,
                    description: doc.text.or_else(|| Some(format!("{g}:{a}"))),
                });
            }
        }
    }

    with_cache(|c| c.put_search(cache_key, results.clone()));
    Ok(results)
}

#[tauri::command]
pub async fn dependency_index_versions(
    group_id: String,
    artifact_id: String,
    limit: Option<usize>,
) -> Result<Vec<DependencyVersion>, String> {
    let gid = group_id.trim().to_string();
    let aid = artifact_id.trim().to_string();
    if gid.is_empty() || aid.is_empty() {
        return Ok(Vec::new());
    }

    let max_rows = limit.unwrap_or(30).clamp(1, 100);
    let cache_key = format!("{}:{}:{}", gid, aid, max_rows);

    if let Some(cached) = with_cache(|c| c.get_versions(&cache_key)) {
        return Ok(cached);
    }

    let client = build_client()?;
    let solr_query = format!("g:\"{gid}\" AND a:\"{aid}\"");

    let resp = client
        .get(MAVEN_SEARCH_URL)
        .query(&[
            ("q", solr_query.as_str()),
            ("core", "gav"),
            ("rows", &max_rows.to_string()),
            ("wt", "json"),
            ("sort", "timestamp desc"),
        ])
        .send()
        .await
        .map_err(|e| format!("Maven versions request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Maven Central HTTP error: {}", resp.status()));
    }

    let body: SolrResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Maven versions JSON: {e}"))?;

    let mut versions = Vec::new();
    if let Some(docs) = body.response.and_then(|r| r.docs) {
        for doc in docs {
            if let Some(v) = doc.v {
                versions.push(DependencyVersion {
                    version: v,
                    timestamp: doc.timestamp,
                });
            }
        }
    }

    with_cache(|c| c.put_versions(cache_key, versions.clone()));
    Ok(versions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_put_and_get() {
        let mut cache = DependencyCache::new();
        let coords = vec![DependencyCoordinate {
            group_id: "org.junit.jupiter".to_string(),
            artifact_id: "junit-jupiter-api".to_string(),
            version: Some("5.10.3".to_string()),
            description: None,
        }];
        cache.put_search("junit:20".to_string(), coords.clone());
        let retrieved = cache.get_search("junit:20");
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().len(), 1);
    }
}
