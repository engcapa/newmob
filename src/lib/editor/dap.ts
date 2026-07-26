import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Frontend surface for the language-agnostic DAP kernel (M8 D1 + M9 D3–D5).
 * `dap_start_session` connects + initializes and returns the resolved launch
 * plan; the debug store then drives launch → initialized → setBreakpoints →
 * configurationDone and reacts to the adapter's events.
 */

export interface DapStartResult {
  sessionId: string;
  /** Adapter `initialize` response body (capabilities). */
  capabilities: Record<string, unknown>;
  /** "launch" | "attach" — the request the client sends next. */
  request: string;
  arguments: Record<string, unknown>;
}

/** Payload of a `dap:event:{sessionId}` Tauri event (adapter-initiated). */
export interface DapEventPayload {
  sessionId: string;
  event: string;
  message: unknown;
}

/** Start a debug session for a registered adapter (`"java"`). */
export function dapStartSession(
  adapterId: string,
  launchConfig: Record<string, unknown>,
): Promise<DapStartResult> {
  return invoke<DapStartResult>("dap_start_session", { adapterId, launchConfig });
}

/** Send a DAP request and await its response body. */
export function dapSendRequest(
  sessionId: string,
  command: string,
  args?: unknown,
): Promise<unknown> {
  return invoke<unknown>("dap_send_request", { sessionId, command, arguments: args ?? null });
}

/** Fire a DAP request without awaiting (launch / configurationDone). */
export function dapSend(sessionId: string, command: string, args?: unknown): Promise<void> {
  return invoke("dap_send", { sessionId, command, arguments: args ?? null });
}

/** Terminate + drop a debug session. */
export function dapTerminate(sessionId: string): Promise<void> {
  return invoke("dap_terminate", { sessionId });
}

/** Subscribe to a session's adapter events (`stopped`/`output`/`terminated`…). */
export function listenDapEvents(
  sessionId: string,
  handler: (payload: DapEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<DapEventPayload>(`dap:event:${sessionId}`, (event) => handler(event.payload));
}
