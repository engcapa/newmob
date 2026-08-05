# IPC Streaming and Binary Transport

> Status: implemented architecture decision. This document replaces the completed migration checklist.

## Decision

High-volume or binary data must not be encoded as base64 inside JSON when Tauri can carry raw bytes or a bounded stream.

Use:

- normal `invoke` JSON for small control messages;
- `Channel<InvokeResponseBody>` with `InvokeResponseBody::Raw` for terminal output;
- raw Tauri responses for bounded binary reads;
- explicit open/read/close and open/append/close/abort handles for large files;
- typed structured channels for database row streams;
- file-backed capture plus bounded reduction for agent outputs.

## Terminal output

Terminal creation receives an output channel before the PTY/SSH producer begins. This prevents the early-banner race created by “create, then attach”.

Rust sends raw byte chunks through `TerminalOutputChannel`; the frontend wraps each `ArrayBuffer` as `Uint8Array` before it reaches terminal/ZMODEM consumers. Session identifiers remain control arguments, not ad-hoc binary headers.

Terminal input remains a normal command because keystroke payloads are small and moving routing metadata into a raw request would add complexity without material benefit.

## File streaming

The file API provides:

- `read_stream_open`, `read_stream_read`, `read_stream_close`;
- `write_stream_open`, `write_stream_append`, `write_stream_close`, `write_stream_abort`;
- `read_file_bytes` for bounded one-shot raw reads.

Handles are owned by application state, validated on every operation, and removed on close/abort. Failed or cancelled writers must be aborted so partial files are not reported as complete.

ZMODEM receive serializes appends per transfer and waits for pending writes before close. Send paths use raw reads/streaming rather than constructing a full base64 copy.

## Database and agent streams

Database queries use typed stream events for metadata, row batches, completion, errors, and cancellation. Agent/CLI output that may be large is captured to managed files and queried through bounded operations such as head, tail, range, grep, jq, and stats.

## Browser preview

Browser stubs must preserve ordering, cancellation, handle lifetime, and error semantics even though they do not reproduce Tauri's native transport. Tests should assert consumer-visible byte behavior rather than depending on the internal stub representation.

## Invariants

- Register consumers before producers can emit.
- Preserve byte order and chunk boundaries only where the consumer needs them; never assume text chunks align to UTF-8 characters.
- Bound memory and response size.
- Make close/abort idempotence and invalid-handle errors explicit.
- Remove listeners/subscribers when tabs, sessions, or operations end.
- Never log raw file, terminal, credential, or model payloads.

## Verification

- Terminal output delivers raw bytes without base64 encode/decode.
- Immediate SSH/local output is not lost during creation.
- Multiple sessions cannot cross-deliver output.
- ZMODEM/file streams preserve order, hashes, cancellation, and partial-file cleanup.
- Database streams handle batches, errors, cancel, and terminal completion exactly once.
- Agent capture reducers enforce ownership and output caps.
- Browser-preview tests exercise equivalent ordering and cleanup behavior.
