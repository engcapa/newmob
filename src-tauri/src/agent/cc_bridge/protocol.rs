use serde::{Deserialize, Serialize};

/// Token / cost / timing rollup from Claude Code's final `result` event (3.5).
/// All fields optional — older CLIs or error results may omit them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CcUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_cost_usd: Option<f64>,
    pub duration_ms: Option<u64>,
    pub num_turns: Option<u64>,
}

/// Events emitted by Claude Code's stream-json output format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CcEvent {
    /// A text message from the assistant.
    AssistantMessage { content: String },
    /// CC wants to call a tool (requires user confirmation).
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// Result of a tool call.
    ToolResult {
        tool_use_id: String,
        content: String,
    },
    /// Session header; emitted on the first event with a fresh session id.
    SessionInit { session_id: String },
    /// Session is complete. Carries the final usage rollup when present (3.5).
    Done { usage: Option<CcUsage> },
    /// An error occurred.
    Error { message: String },
    /// Partial/streaming text (included with --include-partial-messages).
    Partial { content: String },
    /// Unknown event type — preserved for forward compatibility.
    Unknown { raw: String },
}

/// Parse a single NDJSON line from CC stdout into a CcEvent.
pub fn parse_ndjson_line(line: &str) -> Option<CcEvent> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;

    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match event_type {
        "system" => {
            // CC stream-json: {"type":"system","subtype":"init","session_id":"<id>",...}
            if value.get("subtype").and_then(|v| v.as_str()) == Some("init") {
                let session_id = value
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !session_id.is_empty() {
                    return Some(CcEvent::SessionInit { session_id });
                }
            }
            Some(CcEvent::Unknown {
                raw: line.to_string(),
            })
        }
        "assistant" => {
            // CC stream-json: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
            let content = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .filter_map(|item| {
                            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                item.get("text")
                                    .and_then(|t| t.as_str())
                                    .map(|s| s.to_string())
                            } else {
                                None
                            }
                        })
                        .reduce(|a, b| a + &b)
                })
                .unwrap_or_default();
            Some(CcEvent::AssistantMessage { content })
        }
        "tool_use" => {
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name = value
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let input = value
                .get("input")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            Some(CcEvent::ToolUse { id, name, input })
        }
        "tool_result" => {
            let tool_use_id = value
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let content = value
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(CcEvent::ToolResult {
                tool_use_id,
                content,
            })
        }
        "result" => {
            // CC final result event. Error variants use subtypes like
            // "error_max_turns" / "error_during_execution", or set is_error.
            let subtype = value.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
            let is_error = value
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if is_error || subtype.starts_with("error") {
                let msg = value
                    .get("result")
                    .and_then(|v| v.as_str())
                    .or_else(|| value.get("error").and_then(|v| v.as_str()))
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Claude Code reported an error")
                    .to_string();
                Some(CcEvent::Error { message: msg })
            } else {
                Some(CcEvent::Done {
                    usage: Some(parse_usage(&value)),
                })
            }
        }
        "error" => {
            let msg = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string();
            Some(CcEvent::Error { message: msg })
        }
        "stream_event" => {
            // Streaming deltas (emitted with --include-partial-messages).
            // {"type":"stream_event","event":{"delta":{"text":"Hi","type":"text_delta"},
            //  "index":0,"type":"content_block_delta"},...}
            let inner = value.get("event");
            let inner_type = inner
                .and_then(|e| e.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            if inner_type == "content_block_delta" {
                let delta = inner.and_then(|e| e.get("delta"));
                if delta.and_then(|d| d.get("type")).and_then(|t| t.as_str()) == Some("text_delta")
                {
                    let text = delta
                        .and_then(|d| d.get("text"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                    if !text.is_empty() {
                        return Some(CcEvent::Partial { content: text });
                    }
                }
            }
            Some(CcEvent::Unknown {
                raw: line.to_string(),
            })
        }
        _ => Some(CcEvent::Unknown {
            raw: line.to_string(),
        }),
    }
}

/// Pull the token/cost/timing rollup out of CC's `result` event. CC nests the
/// token counts under `usage` and puts cost/timing at the top level.
fn parse_usage(value: &serde_json::Value) -> CcUsage {
    let usage = value.get("usage");
    let u64_at = |obj: Option<&serde_json::Value>, key: &str| {
        obj.and_then(|o| o.get(key)).and_then(|v| v.as_u64())
    };
    CcUsage {
        input_tokens: u64_at(usage, "input_tokens"),
        output_tokens: u64_at(usage, "output_tokens"),
        total_cost_usd: value.get("total_cost_usd").and_then(|v| v.as_f64()),
        duration_ms: value.get("duration_ms").and_then(|v| v.as_u64()),
        num_turns: value.get("num_turns").and_then(|v| v.as_u64()),
    }
}

/// Extract the final text answer from a list of CC events.
pub fn extract_answer(events: &[CcEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            CcEvent::AssistantMessage { content } => Some(content.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Pull a freshly-issued CC session id out of a stream, if present.
pub fn extract_session_id(events: &[CcEvent]) -> Option<String> {
    events.iter().find_map(|e| match e {
        CcEvent::SessionInit { session_id } => Some(session_id.clone()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_system_init_session_id() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc-123","tools":[]}"#;
        assert!(matches!(
            parse_ndjson_line(line),
            Some(CcEvent::SessionInit { session_id }) if session_id == "abc-123"
        ));
    }

    #[test]
    fn parses_stream_event_text_delta_as_partial() {
        let line = r#"{"type":"stream_event","event":{"delta":{"text":"Hi","type":"text_delta"},"index":0,"type":"content_block_delta"},"session_id":"x"}"#;
        assert!(matches!(
            parse_ndjson_line(line),
            Some(CcEvent::Partial { content }) if content == "Hi"
        ));
    }

    #[test]
    fn ignores_non_text_stream_events() {
        let line = r#"{"type":"stream_event","event":{"type":"message_start","message":{"content":[]}},"session_id":"x"}"#;
        assert!(matches!(
            parse_ndjson_line(line),
            Some(CcEvent::Unknown { .. })
        ));
    }

    #[test]
    fn parses_assistant_message_text() {
        let line = r#"{"type":"assistant","message":{"content":[{"text":"Hi!","type":"text"}],"role":"assistant"}}"#;
        assert!(matches!(
            parse_ndjson_line(line),
            Some(CcEvent::AssistantMessage { content }) if content == "Hi!"
        ));
    }

    #[test]
    fn parses_success_result_as_done() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"Hi!"}"#;
        assert!(matches!(
            parse_ndjson_line(line),
            Some(CcEvent::Done { .. })
        ));
    }

    #[test]
    fn parses_result_usage_tokens_cost_and_timing() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","duration_ms":1234,"num_turns":3,"total_cost_usd":0.0125,"usage":{"input_tokens":100,"output_tokens":250}}"#;
        match parse_ndjson_line(line) {
            Some(CcEvent::Done { usage: Some(u) }) => {
                assert_eq!(u.input_tokens, Some(100));
                assert_eq!(u.output_tokens, Some(250));
                assert_eq!(u.total_cost_usd, Some(0.0125));
                assert_eq!(u.duration_ms, Some(1234));
                assert_eq!(u.num_turns, Some(3));
            }
            other => panic!("expected Done with usage, got {other:?}"),
        }
    }

    #[test]
    fn parses_error_result_via_is_error() {
        let line = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}"#;
        assert!(matches!(
            parse_ndjson_line(line),
            Some(CcEvent::Error { message }) if message == "boom"
        ));
    }

    #[test]
    fn parses_error_result_max_turns_subtype() {
        let line = r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#;
        assert!(matches!(
            parse_ndjson_line(line),
            Some(CcEvent::Error { .. })
        ));
    }

    #[test]
    fn full_stream_yields_answer_and_done() {
        let lines = [
            r#"{"type":"system","subtype":"init","session_id":"s1","tools":[]}"#,
            r#"{"type":"stream_event","event":{"delta":{"text":"Hi","type":"text_delta"},"index":0,"type":"content_block_delta"}}"#,
            r#"{"type":"stream_event","event":{"delta":{"text":"!","type":"text_delta"},"index":0,"type":"content_block_delta"}}"#,
            r#"{"type":"assistant","message":{"content":[{"text":"Hi!","type":"text"}],"role":"assistant"}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Hi!"}"#,
        ];
        let events: Vec<CcEvent> = lines.iter().filter_map(|l| parse_ndjson_line(l)).collect();
        assert_eq!(extract_session_id(&events).as_deref(), Some("s1"));
        assert_eq!(extract_answer(&events), "Hi!");
        let partials: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                CcEvent::Partial { content } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(partials, vec!["Hi", "!"]);
        assert!(events.iter().any(|e| matches!(e, CcEvent::Done { .. })));
    }
}
