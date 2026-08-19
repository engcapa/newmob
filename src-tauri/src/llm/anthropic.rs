use super::{
    ChatContent, ChatContentPart, ChatMessage, ChatRequest, ChatResponse, ChatStreamEvent,
    ChatTool, ChatToolCall, Llm, LlmError, LlmResult, TokenUsage,
};
use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};

/// Anthropic Messages API provider (`POST {base_url}/messages`).
///
/// The Messages API differs from OpenAI's chat completions API in three places:
/// 1. `system` is a top-level field, not a role in `messages`.
/// 2. Auth header is `x-api-key`, not `Authorization: Bearer`.
/// 3. Streaming events are a documented set (`message_start`,
///    `content_block_delta`, `message_delta`, `message_stop`) rather than
///    OpenAI's `data: {choices: [{delta: ...}]}` chunks.
pub struct AnthropicProvider {
    client: Client,
    base_url: String,
    api_key: String,
    model: String,
    provider_id: String,
    api_version: String,
}

impl AnthropicProvider {
    pub fn new(
        provider_id: impl Into<String>,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self::new_with_proxy_url(provider_id, base_url, api_key, model, None)
    }

    pub fn new_with_proxy_url(
        provider_id: impl Into<String>,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
        proxy_url: Option<String>,
    ) -> Self {
        let mut builder = Client::builder().timeout(std::time::Duration::from_secs(60));
        if let Some(proxy_url) = proxy_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
                builder = builder.proxy(proxy);
            }
        }
        Self {
            client: builder.build().expect("failed to build reqwest client"),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            model: model.into(),
            provider_id: provider_id.into(),
            api_version: "2023-06-01".into(),
        }
    }

    pub fn preset(api_key: impl Into<String>, model_override: Option<String>) -> Self {
        Self::new(
            "anthropic",
            "https://api.anthropic.com/v1",
            api_key,
            model_override.unwrap_or_else(|| "claude-sonnet-4-5".into()),
        )
    }

    fn split_system_user(messages: &[ChatMessage]) -> (Option<String>, Vec<Value>) {
        let mut system: Option<String> = None;
        let mut convo: Vec<Value> = Vec::with_capacity(messages.len());
        for m in messages {
            match m.role.as_str() {
                "system" => {
                    if let Some(existing) = system.as_mut() {
                        existing.push_str("\n\n");
                        existing.push_str(&m.content.as_text_lossy());
                    } else {
                        system = Some(m.content.as_text_lossy());
                    }
                }
                role => {
                    let anthropic_role = if role == "tool" { "user" } else { role };
                    convo.push(json!({
                        "role": anthropic_role,
                        "content": anthropic_content(&m.content),
                    }));
                }
            }
        }
        (system, convo)
    }

    fn request_body(&self, req: &ChatRequest, stream: bool, tools: &[ChatTool]) -> Value {
        let (system, messages) = Self::split_system_user(&req.messages);
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "max_tokens": req.max_tokens.unwrap_or(1024),
        });
        if stream {
            body["stream"] = json!(true);
        }
        if let Some(temp) = req.temperature {
            body["temperature"] = json!(temp);
        }
        if let Some(s) = system {
            body["system"] = json!(s);
        }
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools.iter().map(anthropic_tool).collect());
        }
        body
    }

    async fn chat_once(&self, req: ChatRequest, tools: &[ChatTool]) -> LlmResult<ChatResponse> {
        let body = self.request_body(&req, false, tools);
        let url = format!("{}/messages", self.base_url);
        let resp = self
            .client
            .post(&url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", &self.api_version)
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            let message = serde_json::from_str::<ApiError>(&text)
                .map(|e| e.error.message)
                .unwrap_or(text);
            return Err(LlmError::Provider { status, message });
        }

        let api_resp: ApiResponse = resp.json().await?;
        let mut text_blocks = Vec::new();
        let mut tool_calls = Vec::new();
        for block in api_resp.content {
            match block.block_type.as_str() {
                "text" => {
                    if let Some(text) = block.text {
                        text_blocks.push(text);
                    }
                }
                "tool_use" => {
                    let name = block.name.unwrap_or_default();
                    if !name.is_empty() {
                        tool_calls.push(ChatToolCall {
                            id: block
                                .id
                                .unwrap_or_else(|| format!("toolu_{}", tool_calls.len())),
                            name,
                            arguments: block
                                .input
                                .unwrap_or_else(|| Value::Object(serde_json::Map::new())),
                        });
                    }
                }
                _ => {}
            }
        }

        let usage = api_resp.usage.map(|u| TokenUsage {
            prompt_tokens: u.input_tokens,
            completion_tokens: u.output_tokens,
            total_tokens: u.input_tokens + u.output_tokens,
        });

        Ok(ChatResponse {
            content: text_blocks.join(""),
            model: api_resp.model,
            usage,
            tool_calls,
        })
    }
}

fn anthropic_content(content: &ChatContent) -> Value {
    match content {
        ChatContent::Text(text) => Value::String(text.clone()),
        ChatContent::Parts(parts) => Value::Array(
            parts
                .iter()
                .map(|part| match part {
                    ChatContentPart::Text { text } => {
                        json!({ "type": "text", "text": text })
                    }
                    ChatContentPart::Image {
                        mime_type,
                        data_base64,
                    } => {
                        json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": mime_type,
                                "data": data_base64
                            }
                        })
                    }
                    ChatContentPart::ToolUse {
                        id,
                        name,
                        arguments,
                    } => json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": arguments
                    }),
                    ChatContentPart::ToolResult {
                        tool_call_id,
                        content,
                        is_error,
                    } => json!({
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": content,
                        "is_error": is_error,
                    }),
                })
                .collect(),
        ),
    }
}

fn anthropic_tool(tool: &ChatTool) -> Value {
    let mut value = json!({
        "name": &tool.name,
        "input_schema": tool.input_schema.clone(),
    });
    if let Some(description) = tool.description.as_ref() {
        value["description"] = json!(description);
    }
    value
}

#[derive(Deserialize)]
struct ApiResponse {
    content: Vec<ApiBlock>,
    model: Option<String>,
    usage: Option<ApiUsage>,
}

#[derive(Deserialize)]
struct ApiBlock {
    #[serde(rename = "type")]
    block_type: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    input: Option<Value>,
}

#[derive(Deserialize)]
struct ApiUsage {
    input_tokens: u32,
    output_tokens: u32,
}

#[derive(Deserialize)]
struct ApiError {
    error: ApiErrorBody,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    message: String,
}

#[async_trait]
impl Llm for AnthropicProvider {
    async fn chat(&self, req: ChatRequest) -> LlmResult<ChatResponse> {
        self.chat_once(req, &[]).await
    }

    async fn chat_with_tools(
        &self,
        req: ChatRequest,
        tools: Vec<ChatTool>,
    ) -> LlmResult<ChatResponse> {
        self.chat_once(req, &tools).await
    }

    fn supports_tools(&self) -> bool {
        true
    }

    async fn chat_stream(
        &self,
        req: ChatRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<ChatStreamEvent>>> {
        let body = self.request_body(&req, true, &[]);

        let url = format!("{}/messages", self.base_url);
        let resp = self
            .client
            .post(&url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", &self.api_version)
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            let message = serde_json::from_str::<ApiError>(&text)
                .map(|e| e.error.message)
                .unwrap_or(text);
            return Err(LlmError::Provider { status, message });
        }

        let model = self.model.clone();
        let bytes = resp.bytes_stream();

        let stream = async_stream::stream! {
            let mut buffer = String::new();
            let mut bytes = Box::pin(bytes);
            let mut model_id: Option<String> = Some(model.clone());

            while let Some(chunk) = bytes.next().await {
                let chunk = match chunk {
                    Ok(b) => b,
                    Err(e) => {
                        yield Ok(ChatStreamEvent::Error { message: format!("stream: {e}") });
                        return;
                    }
                };
                buffer.push_str(&String::from_utf8_lossy(&chunk));

                // Anthropic SSE format: "event: <name>\ndata: <json>\n\n".
                while let Some(idx) = buffer.find("\n\n") {
                    let event = buffer[..idx].to_string();
                    buffer.drain(..idx + 2);

                    let mut data_payload: Option<String> = None;
                    for line in event.lines() {
                        if let Some(payload) = line.strip_prefix("data:") {
                            data_payload = Some(payload.trim().to_string());
                        }
                    }
                    let Some(payload) = data_payload else { continue; };
                    let Ok(json) = serde_json::from_str::<Value>(&payload) else { continue; };

                    match json.get("type").and_then(|t| t.as_str()) {
                        Some("content_block_delta") => {
                            if let Some(delta) = json.get("delta") {
                                if delta.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                                    if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                                        if !text.is_empty() {
                                            yield Ok(ChatStreamEvent::Token { content: text.to_string() });
                                        }
                                    }
                                }
                            }
                        }
                        Some("message_start") => {
                            if let Some(m) = json.pointer("/message/model").and_then(|m| m.as_str()) {
                                model_id = Some(m.to_string());
                            }
                        }
                        Some("message_delta") => {
                            // usage updates land here in `usage`, but only at end of stream
                            // we capture usage on message_stop below if present.
                        }
                        Some("message_stop") => {
                            yield Ok(ChatStreamEvent::End { model: model_id.take(), usage: None });
                            return;
                        }
                        _ => {}
                    }
                }
            }

            yield Ok(ChatStreamEvent::End { model: model_id.take(), usage: None });
        };

        Ok(Box::pin(stream))
    }

    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn model(&self) -> &str {
        &self.model
    }
}
