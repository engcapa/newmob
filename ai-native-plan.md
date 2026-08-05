# AI and Agent Architecture

> Status: implemented architecture. The former v2 rollout plan was retired after delivery. Current UI coverage is under the AI sections of `qa-ui-auto-tests/feature-list.md`.

## Scope

Taomni's AI subsystem provides:

- cloud and local LLM provider routing;
- local ASR-backed push-to-talk transcription;
- terminal suggestions and command rewrite;
- tab-bound Chat threads with text, file, image, and structured references;
- web search/fetch with explicit policy;
- Claude Code, Codex, and general ACP local-agent integrations;
- Taomni-owned MCP tools for terminal, SFTP, database, Redis, capture, and UI operations;
- confirmation, redaction, session safety, and audit controls.

## Backend boundaries

### Configuration and runtime

`src-tauri/src/ai/config.rs` defines `AiConfig`. Non-secret preferences are persisted in the AI config file; API keys and credentials use `vault:<id>` references resolved through the encrypted vault.

`AppAiCtx` owns:

- `AsrManager`, the active transcription boundary;
- `LlmRouter`, which selects the provider/runtime by task kind;
- the normalized `AiConfig`;
- a vault handle used when rebuilding provider clients.

Saving configuration hot-rebuilds the router. Unlocking or changing the vault rebuilds provider clients without requiring a second Save.

### LLM providers

`src-tauri/src/llm/` contains the common router, OpenAI-compatible client, Anthropic client, local llama-server runtime, and GPU detection. Provider capabilities determine which chat/media/search modes may be offered; UI selection does not override backend capability checks.

Local runtimes include loopback or in-process providers. Remote providers are blocked when full-local mode is active.

### Agents

Agent integrations are separate process/protocol adapters:

- `agent/cc_bridge/`: Claude Code CLI plus scoped HTTP MCP servers;
- `agent/codex_bridge/`: Codex process and protocol handling;
- `agent/acp_bridge/`: configurable ACP agents and presets;
- `agent/mcp_bridge/`: shared Taomni MCP ownership;
- `agent/capture/`: file-backed, bounded command/result capture;
- `agent/search/`: search-provider implementations;
- `agent/tools/`: Taomni-native tools.

Processes are registered per thread, have bounded idle lifetimes, and are reaped after inactivity. A local agent is not trusted merely because it runs on the same machine.

## Frontend model

`aiStore` owns provider/settings state. `chatStore` owns tab-bound threads, messages, composer attachments, streaming state, drawer placement, and provider/output-format selection.

The Chat Drawer supports:

- per-tab threads and history;
- Markdown/HTML/plain output modes;
- local attachments and structured `@terminal`, `@file`, and `@session` references;
- image/video modes only when an eligible provider exists;
- visible tool/search progress and cancellation;
- permission cards from Claude Code, Codex, and ACP;
- left/right/top/bottom floating or pinned placement.

## Safety invariants

### Master modes

- `fully_disabled`: remove AI entry points and reject AI work.
- `full_local_mode`: allow AI but reject non-loopback network calls and hide/disable remote-only providers.

The backend network policy is authoritative; hiding UI alone is insufficient.

### Tool execution

- Tool calls are classified by scope and risk.
- Write/destructive actions pass through backend safety checks and the configured permission prompt.
- Session-bound tools resolve the intended live/saved session before execution.
- Database writes and exports use SQL classification, bounded output, and managed directories.
- SFTP operations resolve an SFTP-capable resource and use the transfer queue.
- `disableAiWrite` on a session is enforced in backend safety code.
- Large output uses `run_captured`/`read_capture` or database capture instead of injecting unbounded text into the model context.

### Data egress

- Secrets and sensitive context are redacted before provider calls.
- Full-local mode blocks remote URLs through the canonical network predicate.
- Search supports per-call, per-thread, always-allow, and disabled confirmation modes.
- Attachments sent to ordinary LLMs are converted to bounded content/metadata; local filesystem paths are exposed only to local-agent paths that require them.
- Audit records must not become a second secret store.

## Voice and terminal assistance

PTT capture transcribes speech and stages it in the Chat composer for review. See `voice-input-plan.md` for the exact current behavior.

Terminal assistance includes history/PATH/AI suggestion sources and an explicit command-rewrite overlay. Suggested commands remain text until the user accepts the normal preview/permission flow.

## Web search

Search providers include SearXNG, Tavily, Serper, Brave, Exa, and Google CSE. Search/fetch validates provider configuration, network policy, URL safety, confirmation mode, result bounds, and cancellation. Search progress is visible in Chat.

## Model distribution

Managed models use a manifest, integrity metadata, mirror selection, and a managed cache directory. Runtime availability must be based on installed/validated artifacts and successful probes, not only configuration entries. GPU detection always has a CPU or unavailable fallback.

## Known follow-up work

- Complete real-platform ASR/model/runtime smoke coverage.
- Continue reducing duplicated bridge/tool schemas as ACP ownership stabilizes.
- Finish complete runbook recording/playback UX.
- Expand native-agent and database fixture tests without weakening permission gates.
- Keep process cleanup, cancellation, output limits, and schema compatibility covered as external CLIs evolve.

## Verification

- Rust tests cover configuration normalization, routing, network policy, safety classification, redaction, provider clients, MCP scope, capture reducers, and process protocols.
- Vitest covers settings, Chat state, attachments, drawer behavior, permission cards, and provider controls.
- YAML cases and stable controls live in `qa-ui-auto-tests/`.
- Real CLI/provider tests must be opt-in and must never require committed credentials.

