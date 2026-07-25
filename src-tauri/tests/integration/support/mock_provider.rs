//! Mock LLM provider used by integration tests so CI never needs a real key.
//!
//! Public so we can re-use it from `#[test]` blocks without exposing it from
//! the main library surface.

use async_trait::async_trait;
use futures::stream::{self, BoxStream, StreamExt};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use taomni_lib::llm::{
    ChatRequest, ChatResponse, ChatStreamEvent, Llm, LlmError, LlmResult, TokenUsage,
};
use tokio::time::sleep;

#[derive(Debug, Clone)]
pub enum MockEvent {
    Token(String),
    Wait(Duration),
    Error(String),
}

pub struct MockLlm {
    pub script: Mutex<Vec<MockEvent>>,
    pub provider_id: String,
    pub model: String,
}

impl MockLlm {
    pub fn new(script: Vec<MockEvent>) -> Self {
        Self {
            script: Mutex::new(script),
            provider_id: "mock".into(),
            model: "mock-model".into(),
        }
    }

    pub fn echo(text: &str) -> Arc<dyn Llm> {
        Arc::new(MockLlm::new(vec![MockEvent::Token(text.to_string())]))
    }
}

#[async_trait]
impl Llm for MockLlm {
    async fn chat(&self, _req: ChatRequest) -> LlmResult<ChatResponse> {
        let script = self.script.lock().unwrap().clone();
        let mut buf = String::new();
        for ev in &script {
            match ev {
                MockEvent::Token(t) => buf.push_str(t),
                MockEvent::Wait(d) => sleep(*d).await,
                MockEvent::Error(m) => {
                    return Err(LlmError::Provider {
                        status: 500,
                        message: m.clone(),
                    })
                }
            }
        }
        Ok(ChatResponse {
            content: buf,
            model: Some(self.model.clone()),
            usage: Some(TokenUsage {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            }),
            tool_calls: Vec::new(),
        })
    }

    async fn chat_stream(
        &self,
        _req: ChatRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<ChatStreamEvent>>> {
        let script = self.script.lock().unwrap().clone();
        let model = self.model.clone();
        let s = stream::iter(script.into_iter().map(move |ev| match ev {
            MockEvent::Token(t) => Ok(ChatStreamEvent::Token { content: t }),
            MockEvent::Wait(_) => Ok(ChatStreamEvent::Token { content: "".into() }),
            MockEvent::Error(m) => Ok(ChatStreamEvent::Error { message: m }),
        }))
        .chain(stream::iter(vec![Ok(ChatStreamEvent::End {
            model: Some(model),
            usage: None,
        })]));
        Ok(Box::pin(s))
    }

    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn model(&self) -> &str {
        &self.model
    }
}
