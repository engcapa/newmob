use crate::agent::cc_bridge::mcp_http;
use crate::agent::context::AgentThreadContext;
use rmcp::model::{CallToolRequestParams, CallToolResult, ClientInfo, JsonObject, Tool};
use rmcp::service::RunningService;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{RoleClient, ServiceExt};
use serde_json::Value;
use std::collections::HashSet;
use tauri::AppHandle;

type RunningMcpClient = RunningService<RoleClient, ClientInfo>;

/// Protocol-neutral access to the same scoped Taomni MCP tool surfaces that
/// Claude Code and Codex use. Direct LLM providers call this runtime from the
/// backend instead of receiving the loopback MCP URL themselves.
pub struct AgentToolRuntime {
    domain: RunningMcpClient,
    control: RunningMcpClient,
    domain_tools: HashSet<String>,
    control_tools: HashSet<String>,
    token: String,
}

impl AgentToolRuntime {
    pub async fn provision(
        app: &AppHandle,
        ctx: &AgentThreadContext,
        confirm_readonly: bool,
    ) -> Result<Self, String> {
        let (domain_url, token) = mcp_http::provision_for_thread_with_inline_permission(
            app,
            &ctx.thread_id,
            ctx.linked_session_id.clone(),
            ctx.bound_session_id.clone(),
            ctx.flavor,
            confirm_readonly,
            true,
        )
        .await?;
        let control_url = mcp_http::control_server_url()?;
        let domain = connect_client(&domain_url, &token).await?;
        let control = connect_client(&control_url, &token).await?;
        let domain_tools = visible_tool_names(
            domain
                .peer()
                .list_all_tools()
                .await
                .map_err(|e| format!("list Taomni MCP tools: {e}"))?,
        );
        let control_tools = visible_tool_names(
            control
                .peer()
                .list_all_tools()
                .await
                .map_err(|e| format!("list Taomni MCP control tools: {e}"))?,
        );

        Ok(Self {
            domain,
            control,
            domain_tools,
            control_tools,
            token,
        })
    }

    pub async fn list_tools(&self) -> Result<Vec<Tool>, String> {
        let mut tools = visible_tools(
            self.domain
                .peer()
                .list_all_tools()
                .await
                .map_err(|e| format!("list Taomni MCP tools: {e}"))?,
        );
        tools.extend(visible_tools(
            self.control
                .peer()
                .list_all_tools()
                .await
                .map_err(|e| format!("list Taomni MCP control tools: {e}"))?,
        ));
        Ok(tools)
    }

    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<CallToolResult, String> {
        let clean = name.trim();
        if clean.is_empty() || clean == "permission_prompt" {
            return Err(format!(
                "tool '{name}' is not available to direct LLM providers"
            ));
        }
        let args = json_object(arguments)?;
        let req = CallToolRequestParams::new(clean.to_string()).with_arguments(args);
        if self.domain_tools.contains(clean) {
            self.domain
                .peer()
                .call_tool(req)
                .await
                .map_err(|e| e.to_string())
        } else if self.control_tools.contains(clean) {
            self.control
                .peer()
                .call_tool(req)
                .await
                .map_err(|e| e.to_string())
        } else {
            Err(format!("unknown Taomni tool: {name}"))
        }
    }
}

impl Drop for AgentToolRuntime {
    fn drop(&mut self) {
        mcp_http::revoke_token(&self.token);
    }
}

async fn connect_client(url: &str, token: &str) -> Result<RunningMcpClient, String> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url.to_string()).auth_header(token),
    );
    ClientInfo::default()
        .serve(transport)
        .await
        .map_err(|e| format!("connect Taomni MCP runtime: {e}"))
}

fn visible_tool_names(tools: Vec<Tool>) -> HashSet<String> {
    visible_tools(tools)
        .into_iter()
        .map(|tool| tool.name.to_string())
        .collect()
}

fn visible_tools(tools: Vec<Tool>) -> Vec<Tool> {
    tools
        .into_iter()
        .filter(|tool| tool.name.as_ref() != "permission_prompt")
        .collect()
}

fn json_object(value: Value) -> Result<JsonObject, String> {
    match value {
        Value::Null => Ok(JsonObject::default()),
        Value::Object(map) => Ok(map),
        other => Err(format!("tool arguments must be an object, got {other}")),
    }
}

pub fn call_tool_result_text(result: &CallToolResult) -> String {
    if let Some(value) = result.structured_content.as_ref() {
        return value.to_string();
    }
    result
        .content
        .iter()
        .filter_map(|content| content.as_text().map(|text| text.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::Content;
    use serde_json::json;

    #[test]
    fn json_object_requires_object_arguments() {
        assert!(json_object(json!({"command": "pwd"})).is_ok());
        assert!(json_object(Value::Null).is_ok());
        assert!(json_object(json!("pwd")).is_err());
    }

    #[test]
    fn text_result_prefers_structured_content() {
        let structured = CallToolResult::structured(json!({"ok": true}));
        assert_eq!(call_tool_result_text(&structured), r#"{"ok":true}"#);

        let plain = CallToolResult::success(vec![Content::text("one"), Content::text("two")]);
        assert_eq!(call_tool_result_text(&plain), "one\ntwo");
    }
}
