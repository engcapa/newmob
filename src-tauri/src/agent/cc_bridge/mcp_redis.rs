//! Phase 6 — the `taomni_redis` MCP flavor: the tool surface a Claude Code
//! thread bound to a Redis session sees. Backend-direct, like `mcp_sql`: each
//! tool resolves the thread's bound connection and reuses the existing
//! `crate::database::redis_*` command functions in-process.
//!
//! Redis is its own flavor (not folded into `taomni_sql`) because its key/value
//! semantics share nothing with SQL — separate tools keep CC from confusing the
//! two surfaces.

use rmcp::handler::server::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content, ServerCapabilities, ServerInfo};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ErrorData, ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use super::mcp_http::{
    PermissionParams, TokenMap, TokenScope, decide_permission, enforce_inline_permission,
    scope_from_ctx,
};
use crate::state::AppState;

#[derive(Clone)]
pub struct RedisHandler {
    app: AppHandle,
    tokens: TokenMap,
    tool_router: ToolRouter<Self>,
}

impl RedisHandler {
    pub fn new(app: AppHandle, tokens: TokenMap) -> Self {
        Self {
            app,
            tokens,
            tool_router: Self::tool_router(),
        }
    }

    fn scope(&self, ctx: &RequestContext<RoleServer>) -> Result<TokenScope, ErrorData> {
        scope_from_ctx(&self.tokens, ctx)
    }

    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    async fn bound_conn(&self, scope: &TokenScope) -> Result<String, ErrorData> {
        self.state()
            .agent_db_bindings
            .read()
            .await
            .get(&scope.thread_id)
            .cloned()
            .ok_or_else(|| {
                ErrorData::invalid_params(
                    "this chat thread is not bound to a live Redis connection; \
                     open the Redis session tab and try again"
                        .to_string(),
                    None,
                )
            })
    }
}

fn text(s: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(s.into())])
}

fn err(e: impl Into<String>) -> ErrorData {
    ErrorData::internal_error(e.into(), None)
}

/// Redis commands that only read state. Used to waive the confirmation card for
/// `redis_exec` reads; anything not listed is treated as mutating (safe default).
const REDIS_READ_CMDS: &[&str] = &[
    "get",
    "mget",
    "strlen",
    "getrange",
    "exists",
    "type",
    "ttl",
    "pttl",
    "keys",
    "scan",
    "hget",
    "hmget",
    "hgetall",
    "hkeys",
    "hvals",
    "hlen",
    "hexists",
    "hscan",
    "hstrlen",
    "lrange",
    "lindex",
    "llen",
    "smembers",
    "sismember",
    "scard",
    "srandmember",
    "sscan",
    "zrange",
    "zrangebyscore",
    "zrevrange",
    "zscore",
    "zcard",
    "zcount",
    "zrank",
    "zscan",
    "xrange",
    "xrevrange",
    "xlen",
    "dbsize",
    "info",
    "ping",
    "memory",
    "object",
    "dump",
    "randomkey",
    "bitcount",
    "getbit",
    "pfcount",
];

/// True when a raw Redis command line is confidently read-only.
fn redis_command_is_readonly(raw: &str) -> bool {
    let first = raw
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    REDIS_READ_CMDS.contains(&first.as_str())
}

// --- tool parameter schemas ------------------------------------------------

#[derive(Deserialize, schemars::JsonSchema, Default)]
struct ListKeysParams {
    /// Glob pattern (default `*`).
    #[serde(default)]
    pattern: Option<String>,
    /// SCAN cursor ("0" to start).
    #[serde(default)]
    cursor: Option<String>,
    /// SCAN COUNT hint (default 200).
    #[serde(default)]
    count: Option<u64>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct GetKeyParams {
    key: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct SetKeyParams {
    key: String,
    /// "string" | "hash" | "list" | "set" | "zset".
    kind: String,
    /// Value whose shape depends on `kind` (see redis_get_key output).
    value: serde_json::Value,
    #[serde(default)]
    ttl: Option<i64>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct DelKeyParams {
    key: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct ExecParams {
    /// Raw Redis command line, e.g. `HGETALL user:1`. Read commands auto-run;
    /// writes pause for user confirmation.
    command: String,
}

// --- tools -----------------------------------------------------------------

#[tool_router]
impl RedisHandler {
    #[tool(
        name = "redis_list_keys",
        description = "SCAN 扫描键空间（按 pattern，分页 cursor）"
    )]
    async fn redis_list_keys(
        &self,
        Parameters(p): Parameters<ListKeysParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let page = crate::database::redis_list_keys(
            self.state(),
            conn,
            p.pattern.unwrap_or_else(|| "*".into()),
            p.cursor.unwrap_or_else(|| "0".into()),
            p.count.unwrap_or(200),
        )
        .await
        .map_err(err)?;
        let mut out = String::new();
        for k in &page.keys {
            out.push_str(&format!("{} [{}] ttl={}\n", k.key, k.kind, k.ttl));
        }
        out.push_str(&format!("--- next cursor: {} ---", page.cursor));
        Ok(text(out))
    }

    #[tool(name = "redis_get_key", description = "读取一个键的值、类型与 TTL")]
    async fn redis_get_key(
        &self,
        Parameters(p): Parameters<GetKeyParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let v = crate::database::redis_get_key(self.state(), conn, p.key)
            .await
            .map_err(err)?;
        Ok(text(format!(
            "type={} ttl={}\n{}",
            v.kind,
            v.ttl,
            serde_json::to_string_pretty(&v.value).unwrap_or_default()
        )))
    }

    #[tool(
        name = "redis_set_key",
        description = "写入/覆盖一个键（写动作，需用户确认）"
    )]
    async fn redis_set_key(
        &self,
        Parameters(p): Parameters<SetKeyParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let args = serde_json::json!({
            "key": p.key.clone(),
            "kind": p.kind.clone(),
            "value": p.value.clone(),
            "ttl": p.ttl,
        });
        enforce_inline_permission(&self.app, &scope, "redis_set_key", &args, false).await?;
        crate::database::redis_set_key(self.state(), conn, p.key, p.kind, p.value, p.ttl)
            .await
            .map_err(err)?;
        Ok(text("OK"))
    }

    #[tool(
        name = "redis_del_key",
        description = "删除一个键（写动作，需用户确认）"
    )]
    async fn redis_del_key(
        &self,
        Parameters(p): Parameters<DelKeyParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let args = serde_json::json!({ "key": p.key.clone() });
        enforce_inline_permission(&self.app, &scope, "redis_del_key", &args, false).await?;
        crate::database::redis_del_key(self.state(), conn, p.key)
            .await
            .map_err(err)?;
        Ok(text("OK"))
    }

    #[tool(
        name = "redis_exec",
        description = "执行一条原始 Redis 命令（读命令自动放行；写命令需用户确认）"
    )]
    async fn redis_exec(
        &self,
        Parameters(p): Parameters<ExecParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let args = serde_json::json!({ "command": p.command.clone() });
        let is_readonly = !scope.confirm_readonly && redis_command_is_readonly(&p.command);
        enforce_inline_permission(&self.app, &scope, "redis_exec", &args, is_readonly).await?;
        let out = crate::database::redis_exec(self.state(), conn, p.command)
            .await
            .map_err(err)?;
        Ok(text(out))
    }

    #[tool(
        name = "permission_prompt",
        description = "Approve or deny a Claude Code Redis tool call per Taomni's safety rules + human-in-the-loop confirmation."
    )]
    async fn permission_prompt(
        &self,
        Parameters(p): Parameters<PermissionParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let tool = super::mcp_http::normalize_tool_name(&p.tool_name);
        // redis_exec waives confirmation for read commands; everything else
        // relies on is_write_tool (get/list are not write tools → no card).
        let is_readonly = !scope.confirm_readonly
            && tool == "redis_exec"
            && p.tool_input
                .get("command")
                .and_then(|v| v.as_str())
                .map(redis_command_is_readonly)
                .unwrap_or(false);
        Ok(decide_permission(&self.app, &scope, &p.tool_name, &p.tool_input, is_readonly).await)
    }
}

#[tool_handler]
impl ServerHandler for RedisHandler {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some(
            "Taomni Redis tools. You operate on the chat thread's bound Redis connection. \
             Use these tools, not local Bash. Writes route through human confirmation."
                .into(),
        );
        info
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redis_read_commands_classified() {
        assert!(redis_command_is_readonly("GET foo"));
        assert!(redis_command_is_readonly("  hgetall user:1"));
        assert!(redis_command_is_readonly("SCAN 0 MATCH x*"));
        assert!(!redis_command_is_readonly("SET foo bar"));
        assert!(!redis_command_is_readonly("DEL foo"));
        assert!(!redis_command_is_readonly("FLUSHALL"));
        assert!(!redis_command_is_readonly(""));
    }
}
