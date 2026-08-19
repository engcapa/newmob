use crate::agent::tools::ToolRegistry;
use crate::agent::tools::history::SearchHistoryTool;
use crate::agent::tools::sessions::{ListSessionsTool, OpenSessionEditorTool, SwitchTabTool};
use crate::agent::tools::sftp_runbook::{SaveAsRunbookTool, SftpUploadTool};
use crate::agent::tools::terminal::{ExplainErrorTool, ReadTerminalTailTool, RunInTerminalTool};
use crate::agent::{Agent, AgentStepResult, PendingAction};
use crate::llm::{ChatMessage, ChatRequest, TaskKind};
use crate::state::AppState;
use std::sync::Arc;
use tauri::{AppHandle, State};

fn build_registry(state: &AppState, app: AppHandle) -> ToolRegistry {
    let db = Arc::new(std::sync::Mutex::new(
        // We can't move the connection, so we open a second read-only connection for agent tools.
        // The main connection stays in AppState for writes.
        rusqlite::Connection::open(
            crate::ai::config::default_ai_config_path()
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("taomni.db"),
        )
        .unwrap_or_else(|_| rusqlite::Connection::open_in_memory().unwrap()),
    ));

    let _ = state; // currently unused in v2.x; reserved for per-agent contextuals

    let mut registry = ToolRegistry::new();
    registry.register(Box::new(ListSessionsTool { db: db.clone() }));
    registry.register(Box::new(SwitchTabTool {
        app: app.clone(),
        db: db.clone(),
    }));
    registry.register(Box::new(OpenSessionEditorTool { app: app.clone() }));
    registry.register(Box::new(SearchHistoryTool { db: db.clone() }));
    registry.register(Box::new(RunInTerminalTool));
    registry.register(Box::new(ReadTerminalTailTool));
    registry.register(Box::new(ExplainErrorTool));
    registry.register(Box::new(SftpUploadTool { app: app.clone() }));
    registry.register(Box::new(SaveAsRunbookTool { app }));
    registry
}

/// Run a single-step agent to explain a terminal error.
/// terminal_content is the last N lines of terminal output (provided by frontend after user confirmation).
#[tauri::command]
pub async fn agent_explain_error(
    terminal_content: String,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let _ = session_id; // currently unused; reserved for per-session policy

    let system = "你是一个终端错误分析助手。分析用户提供的终端输出，解释错误原因，并给出具体的修复建议。用中文回答，简洁清晰。";
    let user = format!(
        "请分析以下终端输出中的错误：\n\n```\n{}\n```",
        terminal_content
    );

    let req = ChatRequest {
        messages: vec![
            ChatMessage::system(system.to_string()),
            ChatMessage::user(user),
        ],
        max_tokens: Some(800),
        temperature: Some(0.3),
        stream: false,
    };

    let resp = {
        let ai_ctx = state.ai_ctx.read().await;
        ai_ctx
            .llm
            .complete(req, TaskKind::AgentDefault)
            .await
            .map_err(|e| e.to_string())?
    };
    Ok(resp.content)
}

/// Plan a single tool call from a natural language request.
/// Returns the pending action for frontend confirmation.
#[tauri::command]
pub async fn agent_plan_tool(
    request: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<PendingAction>, String> {
    let registry = build_registry(&state, app);
    let agent = Agent::from_state(&state, TaskKind::AgentDefault, registry)
        .await
        .ok_or("No LLM provider configured")?;

    let system = "你是 Taomni 终端管理器的 AI 助手。根据用户请求，选择合适的工具执行操作。";
    let call = agent.plan_single_tool(system, &request).await?;

    if let Some(c) = call {
        let preview = agent.tools.dry_run_preview(&c);
        Ok(Some(PendingAction {
            dry_run_preview: preview,
            requires_confirmation: crate::agent::safety::requires_confirmation(&c.tool),
            tool: c.tool,
            args: c.args,
        }))
    } else {
        Ok(None)
    }
}

/// Execute a confirmed tool call (after user approved the ActionCard).
#[tauri::command]
pub async fn agent_execute_tool(
    tool: String,
    args: serde_json::Value,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use crate::agent::tools::ToolCall;
    let call = ToolCall {
        tool: tool.clone(),
        args,
    };

    // Blacklist + read-tail user-invoked safety.
    crate::agent::safety::check_tool_call(&call)?;
    // Per-session "禁用 AI 写动作" enforcement.
    crate::agent::safety::check_session_disable(&state, &call)?;

    let registry = build_registry(&state, app);
    let result = registry.execute(&call).await;
    if result.ok {
        Ok(result.output)
    } else {
        Err(result.output)
    }
}

/// Run a multi-step agent (opt-in). Returns the first step result.
/// Frontend must call agent_execute_tool + agent_continue for subsequent steps.
#[tauri::command]
pub async fn agent_run(
    request: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<AgentStepResult>, String> {
    let registry = build_registry(&state, app);
    let agent = Agent::from_state(&state, TaskKind::AgentDefault, registry)
        .await
        .ok_or("No LLM provider configured")?;

    let system = "你是 Taomni 终端管理器的 AI 助手。帮助用户管理 SSH 会话、执行命令、分析错误。每次只调用一个工具，等待结果后再继续。";
    Ok(agent.run_steps(system, &request).await)
}
