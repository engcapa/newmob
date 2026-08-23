pub mod acp_bridge;
pub mod capture;
pub mod cc_bridge;
pub mod cmd_classify;
pub mod codex_bridge;
pub mod commands;
pub mod context;
pub mod local;
pub mod mcp_bridge;
pub mod safety;
pub mod search;
pub mod sql_classify;
pub mod tool_runtime;
pub mod tools;

use crate::llm::{ChatMessage, ChatRequest, Llm, TaskKind};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tools::{ToolCall, ToolRegistry, ToolResult};

pub const MAX_AGENT_STEPS: usize = 5;

/// A pending tool call that requires user confirmation before execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAction {
    pub tool: String,
    pub args: serde_json::Value,
    pub dry_run_preview: Option<String>,
    pub requires_confirmation: bool,
}

/// The result of one agent run step.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentStepResult {
    /// Agent wants to call a tool — frontend must confirm.
    ToolRequest { action: PendingAction },
    /// Tool was executed (after confirmation), result fed back to LLM.
    ToolExecuted { tool: String, result: String },
    /// Agent produced a final text answer.
    Answer { text: String },
    /// Agent hit the step limit.
    StepLimitReached { partial_answer: String },
    /// An error occurred.
    Error { message: String },
}

/// Lightweight agent that wraps an LLM + tool registry.
/// Implements a simple ReAct loop: think → act → observe, up to MAX_AGENT_STEPS.
pub struct Agent {
    llm: Arc<dyn Llm>,
    pub tools: ToolRegistry,
}

impl Agent {
    pub fn new(llm: Arc<dyn Llm>, tools: ToolRegistry) -> Self {
        Self { llm, tools }
    }

    /// Build an agent from the live `LlmRouter` for a given task kind.
    /// Reads through `AppState.ai_ctx` so the active provider, fallback,
    /// and task routing all stay in sync with the user's config without
    /// re-reading ai.json on every call.
    pub async fn from_state(state: &AppState, task: TaskKind, tools: ToolRegistry) -> Option<Self> {
        let ai_ctx = state.ai_ctx.read().await;
        // Pick the provider id this task would actually route to.
        let provider_id = ai_ctx.llm.provider_for_task(task);
        let llm = ai_ctx.llm.provider(&provider_id)?;
        Some(Self::new(llm, tools))
    }

    /// Run a single-step tool call (used by voice intent dispatcher).
    /// Returns the tool call the LLM wants to make, without executing it.
    pub async fn plan_single_tool(
        &self,
        system: &str,
        user: &str,
    ) -> Result<Option<ToolCall>, String> {
        let tools_desc = self.tools.describe_all();
        let system_with_tools = format!(
            "{}\n\nAvailable tools (respond with JSON {{\"tool\": \"<name>\", \"args\": {{...}}}} or plain text if no tool needed):\n{}",
            system, tools_desc
        );

        let req = ChatRequest {
            messages: vec![
                ChatMessage::system(system_with_tools),
                ChatMessage::user(user.to_string()),
            ],
            max_tokens: Some(256),
            temperature: Some(0.1),
            stream: false,
        };

        let resp = self.llm.chat(req).await.map_err(|e| e.to_string())?;
        let content = resp.content.trim();

        // Try to parse as tool call JSON.
        let json_str = if content.starts_with("```") {
            content
                .lines()
                .skip(1)
                .take_while(|l| !l.starts_with("```"))
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            content.to_string()
        };

        if let Ok(call) = serde_json::from_str::<ToolCall>(&json_str) {
            return Ok(Some(call));
        }
        Ok(None)
    }

    /// Run a multi-step ReAct loop. Returns a stream of step results.
    /// The caller is responsible for confirming tool calls before calling execute_tool.
    pub async fn run_steps(&self, system: &str, user: &str) -> Vec<AgentStepResult> {
        let tools_desc = self.tools.describe_all();
        let system_prompt = format!(
            "{}\n\nAvailable tools:\n{}\n\nWhen you need to use a tool, respond with JSON: {{\"tool\": \"<name>\", \"args\": {{...}}}}\nWhen you have a final answer, respond with plain text.",
            system, tools_desc
        );

        let mut messages = vec![
            ChatMessage::system(system_prompt),
            ChatMessage::user(user.to_string()),
        ];

        let mut results = Vec::new();

        for _step in 0..MAX_AGENT_STEPS {
            let req = ChatRequest {
                messages: messages.clone(),
                max_tokens: Some(512),
                temperature: Some(0.1),
                stream: false,
            };

            let resp = match self.llm.chat(req).await {
                Ok(r) => r,
                Err(e) => {
                    results.push(AgentStepResult::Error {
                        message: e.to_string(),
                    });
                    return results;
                }
            };

            let content = resp.content.trim().to_string();

            // Try to parse as tool call.
            let json_str = if content.starts_with("```") {
                content
                    .lines()
                    .skip(1)
                    .take_while(|l| !l.starts_with("```"))
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                content.clone()
            };

            if let Ok(call) = serde_json::from_str::<ToolCall>(&json_str) {
                // Safety check for write tools.
                if let Err(e) = safety::check_tool_call(&call) {
                    results.push(AgentStepResult::Error { message: e });
                    return results;
                }

                let preview = self.tools.dry_run_preview(&call);
                results.push(AgentStepResult::ToolRequest {
                    action: PendingAction {
                        tool: call.tool.clone(),
                        args: call.args.clone(),
                        dry_run_preview: preview,
                        requires_confirmation: safety::requires_confirmation(&call.tool),
                    },
                });
                // In multi-step mode, we stop here and wait for frontend confirmation.
                // The caller resumes by calling execute_tool and feeding the result back.
                return results;
            }

            // Plain text = final answer.
            results.push(AgentStepResult::Answer { text: content });
            return results;
        }

        results.push(AgentStepResult::StepLimitReached {
            partial_answer: "Reached maximum steps without a final answer.".into(),
        });
        results
    }

    /// Execute a confirmed tool call and return the result string.
    pub async fn execute_tool(&self, call: &ToolCall) -> ToolResult {
        self.tools.execute(call).await
    }
}
