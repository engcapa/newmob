use crate::agent::search::searxng::SearXngProvider;
use crate::agent::search::serper::SerperProvider;
use crate::agent::search::tavily::TavilyProvider;
use crate::agent::search::{SearchHit, SearchOptions, SearchProvider};
use crate::agent::tools::{Tool, ToolDescriptor, ToolResult};
use async_trait::async_trait;
use std::sync::Arc;

pub struct WebSearchTool {
    provider: Arc<dyn SearchProvider>,
}

impl WebSearchTool {
    pub fn new(provider: Arc<dyn SearchProvider>) -> Self {
        Self { provider }
    }

    /// Build from config: picks SearXNG (default), Tavily, or Serper based on web_search config.
    pub fn from_config(config: &crate::ai::config::WebSearchConfig) -> Self {
        let provider: Arc<dyn SearchProvider> = match config.client_provider.as_str() {
            "tavily" if !config.byok_key.is_empty() => {
                Arc::new(TavilyProvider::new(&config.byok_key))
            }
            "serper" if !config.byok_key.is_empty() => {
                Arc::new(SerperProvider::new(&config.byok_key))
            }
            _ => {
                // Default: SearXNG with first public instance (probe happens at runtime).
                Arc::new(SearXngProvider::new(
                    config
                        .searxng_url
                        .as_deref()
                        .unwrap_or(crate::agent::search::instances::PUBLIC_INSTANCES[0]),
                ))
            }
        };
        Self { provider }
    }
}

#[async_trait]
impl Tool for WebSearchTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "web_search",
            description: "在网络上搜索信息。每次调用前会向用户确认搜索关键词与提供方。",
            params: "query: string, freshness?: 'day'|'week'|'month', max_results?: number (default 5)",
        }
    }

    async fn execute(&self, args: &serde_json::Value) -> ToolResult {
        let query = match args.get("query").and_then(|v| v.as_str()) {
            Some(q) => q.to_string(),
            None => return ToolResult::err("web_search", "query is required"),
        };
        let freshness = args
            .get("freshness")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let max_results = args
            .get("max_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(5) as u32;

        let opts = SearchOptions {
            freshness,
            max_results: max_results.min(10),
        };

        match self.provider.search(&query, &opts).await {
            Ok(hits) => {
                let formatted = hits
                    .iter()
                    .enumerate()
                    .map(|(i, h)| {
                        format!("{}. **{}**\n   {}\n   {}", i + 1, h.title, h.snippet, h.url)
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n");
                ToolResult::ok(
                    "web_search",
                    if formatted.is_empty() {
                        "No results found.".into()
                    } else {
                        formatted
                    },
                )
            }
            Err(e) => ToolResult::err("web_search", e),
        }
    }

    fn dry_run_preview(&self, args: &serde_json::Value) -> Option<String> {
        args.get("query")
            .and_then(|v| v.as_str())
            .map(|q| format!("搜索: \"{}\" via {}", q, self.provider.provider_id()))
    }
}
