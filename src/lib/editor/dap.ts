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

/** One runnable main-class option for the Java debug picker. */
export interface JavaMainClassOption {
  mainClass: string;
  projectName: string;
  filePath: string | null;
}

/**
 * What the frontend should do before starting a Java debug session:
 * `resolved` → launch `main` directly; `choose` → show a picker over
 * `candidates`; `none` → no runnable main in the project.
 */
export type JavaMainClassResolution =
  | { kind: "resolved"; main: JavaMainClassOption }
  | { kind: "choose"; candidates: JavaMainClassOption[] }
  | { kind: "none" };

/**
 * Resolve the runnable main class(es) for a launch config before opening the
 * DAP session, so the UI can launch directly (active-file / sole match) or
 * prompt (ambiguous) instead of the adapter silently debugging an arbitrary
 * class. `launchConfig` carries the same filePath + jdtls identity as startDebug.
 */
export function dapResolveJavaMainClasses(
  launchConfig: Record<string, unknown>,
): Promise<JavaMainClassResolution> {
  return invoke<JavaMainClassResolution>("java_debug_resolve_main_classes", { launchConfig });
}

/** Subscribe to a session's adapter events (`stopped`/`output`/`terminated`…). */
export function listenDapEvents(
  sessionId: string,
  handler: (payload: DapEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<DapEventPayload>(`dap:event:${sessionId}`, (event) => handler(event.payload));
}
