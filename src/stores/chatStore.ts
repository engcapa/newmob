import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { VAULT_LOCKED_EVENT, isVaultLockedError } from "../lib/ipc";
import type { ChatAttachment } from "../lib/chat/attachments";
import type { CodeWorkspaceContext, DbSelectedObject } from "./appStore";
import type { LlmProviderCapability } from "./aiStore";
import type { CodeWorkspaceTabInfo } from "../types";

export type ChatThreadMode = "chat" | "image" | "video";

export interface ChatThread {
  id: string;
  title: string;
  provider_id: string;
  created_at: number;
  updated_at: number;
  linked_session_id: string | null;
  source: string;
  mode?: ChatThreadMode | string | null;
  /** Per-thread output format override ("md" | "html" | "plain"). null = inherit AiConfig. */
  output_format?: string | null;
  /** Per-thread Claude Code model override. null = inherit the Claude Code default model. */
  cc_model?: string | null;
}

/** A live, display-only Claude Code tool-activity card (3.5). */
export interface CcToolCard {
  call_id: string;
  tool: string;
  detail: string;
  /** Result preview, once the tool's result arrives. */
  result?: string;
}

/** Claude Code token/cost/timing rollup for the assistant message footer (3.5). */
export interface CcUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  duration_ms?: number | null;
}

interface LocalTerminalEnv {
  platform: string;
  shellId?: string | null;
  shellName?: string | null;
  shellArgs?: string[];
  cwd?: string | null;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  redacted: boolean;
  attachments?: ChatAttachment[];
}

export interface ChatComposerDraft {
  text: string;
  selectedAttachments: ChatAttachment[];
}

interface ChatGenerateMediaResponse {
  user_message: ChatMessage;
  assistant_message: ChatMessage;
  redacted_count: number;
  saved_path: string;
  remote_url?: string | null;
  video_id?: string | null;
  model: string;
}

type StreamEvent =
  | { kind: "user_message"; message: ChatMessage }
  | { kind: "assistant_start"; id: string; thread_id: string; created_at: number }
  | { kind: "token"; id: string; content: string }
  | { kind: "end"; id: string; thread_id: string; content: string; redacted_count: number }
  | { kind: "error"; id: string; message: string }
  | {
      kind: "cc_tool_activity";
      id: string;
      call_id: string;
      phase: "use" | "result";
      tool: string;
      detail: string;
    }
  | {
      kind: "usage";
      id: string;
      input_tokens?: number | null;
      output_tokens?: number | null;
      cost_usd?: number | null;
      duration_ms?: number | null;
    };

type DrawerScope = "tab" | null;
export type ChatDrawerPosition = "left" | "right" | "top" | "bottom";

const CHAT_DRAWER_LAYOUT_STORAGE_KEY = "taomni.chatDrawer.layout.v1";
const MIN_DRAWER_FLOATING_OPACITY = 0.65;
const MAX_DRAWER_FLOATING_OPACITY = 1;

interface ChatDrawerLayoutPrefs {
  position: ChatDrawerPosition;
  pinned: boolean;
  width: number;
  height: number;
  floatingOpacity: number;
  /** Tao Ribbon offset along its docked edge, 0..1. */
  ribbonOffsetRatio: number;
}

export function isChatCapableTabType(type: string | null | undefined): boolean {
  return (
    type === "welcome" ||
    type === "terminal" ||
    type === "rdp" ||
    type === "database" ||
    type === "redis" ||
    type === "mail" ||
    type === "git" ||
    type === "code-workspace"
  );
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] || normalized || "Workspace";
}

function codeWorkspaceContextFromTab(info: CodeWorkspaceTabInfo): CodeWorkspaceContext {
  const legacyRoot = info.repoRoot?.trim() ?? "";
  const roots = info.roots && info.roots.length > 0
    ? info.roots
    : legacyRoot
      ? [{ id: "root-1", name: basename(legacyRoot), path: legacyRoot, kind: "git" as const }]
      : [];
  return {
    repoRoot: legacyRoot || roots[0]?.path || "",
    activePath: null,
    openPaths: [],
    dirtyPaths: [],
    roots,
    looseFiles: info.looseFiles ?? [],
    activeFile: null,
    openFiles: [],
    dirtyFiles: [],
  };
}

export function normalizeChatThreadMode(mode: string | null | undefined): ChatThreadMode {
  return mode === "image" || mode === "video" ? mode : "chat";
}

function capabilityForThreadMode(mode: ChatThreadMode): LlmProviderCapability {
  if (mode === "image") return "image_generation";
  if (mode === "video") return "video_generation";
  return "chat";
}

function clampDrawerWidth(width: number): number {
  const viewportMax =
    typeof window === "undefined"
      ? 960
      : Math.max(320, Math.min(1120, window.innerWidth - 32));
  return Math.max(280, Math.min(viewportMax, Math.round(width)));
}

function clampDrawerHeight(height: number): number {
  const viewportMax =
    typeof window === "undefined"
      ? 720
      : Math.max(260, Math.min(900, window.innerHeight - 32));
  return Math.max(220, Math.min(viewportMax, Math.round(height)));
}

function clampDrawerFloatingOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return MAX_DRAWER_FLOATING_OPACITY;
  const rounded = Math.round(opacity * 100) / 100;
  return Math.max(MIN_DRAWER_FLOATING_OPACITY, Math.min(MAX_DRAWER_FLOATING_OPACITY, rounded));
}

function readDrawerLayoutPrefs(): ChatDrawerLayoutPrefs {
  const fallback: ChatDrawerLayoutPrefs = {
    position: "right",
    pinned: true,
    width: 380,
    height: 420,
    floatingOpacity: 1,
    ribbonOffsetRatio: 0.5,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(CHAT_DRAWER_LAYOUT_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ChatDrawerLayoutPrefs>;
    const position: ChatDrawerPosition =
      parsed.position === "left" || parsed.position === "right" || parsed.position === "top" || parsed.position === "bottom"
        ? parsed.position
        : fallback.position;
    const ribbonOffsetRatio =
      typeof parsed.ribbonOffsetRatio === "number" && Number.isFinite(parsed.ribbonOffsetRatio)
        ? Math.min(1, Math.max(0, parsed.ribbonOffsetRatio))
        : fallback.ribbonOffsetRatio;
    const floatingOpacity =
      typeof parsed.floatingOpacity === "number"
        ? clampDrawerFloatingOpacity(parsed.floatingOpacity)
        : fallback.floatingOpacity;
    return {
      position,
      pinned:
        typeof parsed.pinned === "boolean"
          ? parsed.pinned
          : position === "left" || position === "right",
      width: clampDrawerWidth(Number(parsed.width) || fallback.width),
      height: clampDrawerHeight(Number(parsed.height) || fallback.height),
      floatingOpacity,
      ribbonOffsetRatio,
    };
  } catch {
    return fallback;
  }
}

function writeDrawerLayoutPrefs(prefs: Partial<ChatDrawerLayoutPrefs>) {
  if (typeof window === "undefined") return;
  try {
    const current = readDrawerLayoutPrefs();
    window.localStorage.setItem(
      CHAT_DRAWER_LAYOUT_STORAGE_KEY,
      JSON.stringify({ ...current, ...prefs }),
    );
  } catch {
    // Best-effort UI preference persistence.
  }
}

async function resolveActiveChatTabId(): Promise<string | null> {
  try {
    const { useAppStore } = await import("./appStore");
    const state = useAppStore.getState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (active && isChatCapableTabType(active.type)) return active.chatTabId ?? active.id;
    return state.tabs.find((tab) => tab.type === "welcome")?.id ?? null;
  } catch {
    return null;
  }
}

interface ChatStore {
  threads: ChatThread[];
  threadsLoaded: boolean;
  activeThreadId: string | null;
  messages: Record<string, ChatMessage[]>;
  /// Currently-streaming assistant message id per thread (for cursor display).
  streamingId: Record<string, string | null>;
  /// Live, display-only Claude Code tool cards per assistant message id (3.5).
  /// Cleared when the message stops streaming (the persisted content then holds
  /// the text transcript).
  ccToolCards: Record<string, CcToolCard[]>;
  /// Claude Code usage rollup per assistant message id (3.5), for the footer.
  ccUsage: Record<string, CcUsage>;
  /// In-flight send state by thread. A tab switch can change `activeThreadId`
  /// while the original turn keeps running, so lifecycle must stay thread-bound.
  sendingByThreadId: Record<string, boolean>;
  /// Back-compat aggregate used by older call sites/tests. Prefer
  /// `sendingByThreadId[threadId]` when a specific drawer/thread is rendered.
  sending: boolean;
  drawerOpen: boolean;
  /// "tab" when the drawer is bound to a concrete app tab.
  drawerScope: DrawerScope;
  /// The terminal tab currently driving a tab-bound drawer, if any.
  drawerTabId: string | null;
  /// Mirrors attached SFTP state: each terminal tab remembers whether its
  /// bound chat drawer should be visible when that tab is active.
  tabDrawerOpenByTabId: Record<string, boolean>;
  /// The current thread per chat-capable tab. Switching tabs should restore
  /// the user's last selected/open thread for that tab instead of promoting an
  /// older history item or creating a fresh thread.
  activeThreadIdByTabId: Record<string, string>;
  drawerWidth: number;
  drawerHeight: number;
  drawerPosition: ChatDrawerPosition;
  drawerPinned: boolean;
  drawerFloatingOpacity: number;
  /// Tao Ribbon offset along its docked edge (0..1); the edge itself mirrors
  /// `drawerPosition`.
  ribbonOffsetRatio: number;
  /// Text the Composer should pick up next render (e.g. `@selection ...`).
  /// Cleared by the Composer once consumed.
  pendingComposerText: string;
  /// Unsent composer drafts keyed by thread/tab scope. Kept in memory so
  /// switching app tabs does not discard a half-written prompt.
  composerDrafts: Record<string, ChatComposerDraft>;

  loadThreads: () => Promise<void>;
  newThread: (providerId?: string, linkedSessionId?: string, mode?: ChatThreadMode) => Promise<ChatThread>;
  deleteThread: (threadId: string) => Promise<void>;
  setThreadProvider: (threadId: string, providerId: string) => Promise<void>;
  setThreadCcModel: (threadId: string, model: string | null) => Promise<void>;
  /// Set or clear the per-thread output-format override.
  /// Pass `null` (or omit) to clear so the thread inherits the global setting.
  setThreadOutputFormat: (threadId: string, format: string | null) => Promise<void>;
  setActiveThread: (threadId: string | null) => void;
  loadMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string, terminalContext?: string, attachments?: ChatAttachment[]) => Promise<void>;
  stopSending: (threadId: string) => Promise<void>;
  /// Open the drawer (creating a thread if needed) and stage `text` in the
  /// composer as a blockquote. For raw *selections* the user will write around
  /// — terminal output, a voice transcript. Callers that have already built a
  /// complete prompt want `sendPromptToTabChat` instead: the blockquote prefix
  /// would swallow their instructions and code fences.
  attachToComposer: (text: string) => Promise<void>;
  /// Send an already-composed prompt to the active tab's chat thread verbatim.
  /// Reuses (or creates) the tab-bound thread so follow-up questions stay in the
  /// same context, and auto-sends rather than staging.
  sendPromptToTabChat: (prompt: string) => Promise<void>;
  consumePendingComposerText: () => string;
  setComposerDraft: (key: string, draft: ChatComposerDraft) => void;
  clearComposerDraft: (key: string) => void;
  /// Open the drawer, create a fresh thread, and auto-send "请解释这段输出".
  /// Used by the Selection toolbar's "Explain" action.
  explainSelection: (text: string) => Promise<void>;
  /// Sweep threads older than `keepDays`. Returns the number deleted.
  purgeOldThreads: (keepDays: number) => Promise<number>;
  /// Export every thread + message to `outPath` as JSON.
  exportArchive: (outPath: string) => Promise<number>;
  toggleDrawer: () => void;
  /// Visibility-only primitive. This does not change the tab auto-restore flag.
  setDrawerOpen: (open: boolean) => void;
  /// User-driven dismissal: hide the drawer and clear the current tab's
  /// auto-restore flag. This never stops in-flight AI work; the streaming footer
  /// owns the explicit Stop action.
  dismissDrawer: () => void;
  hideDrawer: () => void;
  openTabChat: (tabId: string) => Promise<void>;
  toggleTabChat: (tabId: string) => Promise<void>;
  syncTabChatWithActiveTab: (tabId: string | null) => Promise<void>;
  setDrawerWidth: (w: number) => void;
  setDrawerHeight: (h: number) => void;
  setDrawerPosition: (position: ChatDrawerPosition) => void;
  setDrawerPinned: (pinned: boolean) => void;
  setDrawerFloatingOpacity: (opacity: number) => void;
  /// Set the Tao Ribbon's docked edge + offset in one shot. The edge updates
  /// `drawerPosition` (and pinned defaults) so the drawer opens from that edge.
  setRibbonPlacement: (position: ChatDrawerPosition, offsetRatio: number) => void;
}

function latestTabThread(threads: ChatThread[], tabId: string): ChatThread | undefined {
  const candidates = threads.filter((thread) => thread.linked_session_id === tabId);
  return candidates[0];
}

function rememberedTabThread(
  threads: ChatThread[],
  activeThreadIdByTabId: Record<string, string>,
  tabId: string,
): ChatThread | undefined {
  const rememberedId = activeThreadIdByTabId[tabId];
  if (!rememberedId) return undefined;
  return threads.find(
    (thread) => thread.id === rememberedId && thread.linked_session_id === tabId,
  );
}

function scopeForThread(thread: ChatThread | undefined | null): {
  drawerScope: DrawerScope;
  drawerTabId: string | null;
} {
  if (!thread) return { drawerScope: null, drawerTabId: null };
  return thread.linked_session_id
    ? { drawerScope: "tab", drawerTabId: thread.linked_session_id }
    : { drawerScope: null, drawerTabId: null };
}

function nextSendingAggregate(sendingByThreadId: Record<string, boolean>): boolean {
  return Object.values(sendingByThreadId).some(Boolean);
}

function nextThreadSendingState(
  current: Record<string, boolean>,
  threadId: string,
  sending: boolean,
): Pick<ChatStore, "sendingByThreadId" | "sending"> {
  const next = { ...current };
  if (sending) {
    next[threadId] = true;
  } else {
    delete next[threadId];
  }
  return {
    sendingByThreadId: next,
    sending: nextSendingAggregate(next),
  };
}

async function resolveDefaultProviderId(capability: LlmProviderCapability = "chat"): Promise<string | null> {
  try {
    const { chatDrawerProviderIds, defaultChatProviderId, useAiStore } = await import("./aiStore");
    const aiStore = useAiStore.getState();
    if (!aiStore.config) {
      await aiStore.loadConfig();
    }
    const config = useAiStore.getState().config;
    if (capability !== "chat") {
      return chatDrawerProviderIds(config, capability)[0] ?? null;
    }
    return defaultChatProviderId(config) ?? null;
  } catch (e) {
    console.warn("resolve default chat provider failed:", e);
    return null;
  }
}

const initialDrawerLayoutPrefs = readDrawerLayoutPrefs();

export const useChatStore = create<ChatStore>((set, get) => ({
  threads: [],
  threadsLoaded: false,
  activeThreadId: null,
  messages: {},
  streamingId: {},
  ccToolCards: {},
  ccUsage: {},
  sendingByThreadId: {},
  sending: false,
  drawerOpen: false,
  drawerScope: null,
  drawerTabId: null,
  tabDrawerOpenByTabId: {},
  activeThreadIdByTabId: {},
  drawerWidth: initialDrawerLayoutPrefs.width,
  drawerHeight: initialDrawerLayoutPrefs.height,
  drawerPosition: initialDrawerLayoutPrefs.position,
  drawerPinned: initialDrawerLayoutPrefs.pinned,
  drawerFloatingOpacity: initialDrawerLayoutPrefs.floatingOpacity,
  ribbonOffsetRatio: initialDrawerLayoutPrefs.ribbonOffsetRatio,
  pendingComposerText: "",
  composerDrafts: {},

  loadThreads: async () => {
    try {
      const threads = await invoke<ChatThread[]>("chat_list_threads", { limit: 50 });
      set({ threads, threadsLoaded: true });
    } catch (e) {
      console.error("chat_list_threads failed:", e);
      set({ threadsLoaded: true });
    }
  },

  newThread: async (providerId?: string, linkedSessionId?: string, mode?: ChatThreadMode) => {
    const threadMode = mode ?? "chat";
    const resolvedProviderId = providerId ?? (await resolveDefaultProviderId(capabilityForThreadMode(threadMode)));
    const thread = await invoke<ChatThread>("chat_new_thread", {
      providerId: resolvedProviderId,
      linkedSessionId: linkedSessionId ?? null,
      mode: threadMode,
    });
    const scope = scopeForThread(thread);
    set((s) => ({
      threads: [thread, ...s.threads],
      activeThreadId: thread.id,
      ...scope,
      tabDrawerOpenByTabId: linkedSessionId
        ? { ...s.tabDrawerOpenByTabId, [linkedSessionId]: true }
        : s.tabDrawerOpenByTabId,
      activeThreadIdByTabId: linkedSessionId
        ? { ...s.activeThreadIdByTabId, [linkedSessionId]: thread.id }
        : s.activeThreadIdByTabId,
    }));
    return thread;
  },

  deleteThread: async (threadId: string) => {
    await invoke("chat_delete_thread", { threadId });
    const active = get().activeThreadId === threadId;
    set((s) => ({
      threads: s.threads.filter((t) => t.id !== threadId),
      activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
      messages: Object.fromEntries(Object.entries(s.messages).filter(([k]) => k !== threadId)),
      activeThreadIdByTabId: Object.fromEntries(
        Object.entries(s.activeThreadIdByTabId).filter(([, id]) => id !== threadId),
      ),
      composerDrafts: Object.fromEntries(
        Object.entries(s.composerDrafts).filter(([key]) => key !== `thread:${threadId}`),
      ),
      ...(active ? { drawerScope: null, drawerTabId: null } : {}),
    }));
  },

  setThreadProvider: async (threadId: string, providerId: string) => {
    await invoke("chat_set_thread_provider", { threadId, providerId });
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, provider_id: providerId } : t
      ),
    }));
  },

  setThreadCcModel: async (threadId: string, model: string | null) => {
    // Backend recycles the CC process so the next message respawns with the
    // new --model; empty/null clears the override (inherit default).
    await invoke("chat_set_thread_cc_model", { threadId, model: model ?? null });
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, cc_model: model } : t
      ),
    }));
  },

  setThreadOutputFormat: async (threadId: string, format: string | null) => {
    // Backend treats empty/null the same — clears the override.
    await invoke("chat_set_thread_output_format", {
      threadId,
      outputFormat: format ?? null,
    });
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, output_format: format } : t
      ),
    }));
  },

  setActiveThread: (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId);
    set((s) => ({
      activeThreadId: threadId,
      ...scopeForThread(thread),
      activeThreadIdByTabId: thread?.linked_session_id
        ? { ...s.activeThreadIdByTabId, [thread.linked_session_id]: thread.id }
        : s.activeThreadIdByTabId,
    }));
  },

  loadMessages: async (threadId: string) => {
    try {
      const msgs = await invoke<ChatMessage[]>("chat_list_messages", { threadId });
      set((s) => ({ messages: { ...s.messages, [threadId]: msgs } }));
    } catch (e) {
      console.error("chat_list_messages failed:", e);
    }
  },

  sendMessage: async (threadId: string, content: string, terminalContext?: string, attachments?: ChatAttachment[]) => {
    set((s) => nextThreadSendingState(s.sendingByThreadId, threadId, true));

    const thread = get().threads.find((t) => t.id === threadId) ?? null;
    const threadMode = normalizeChatThreadMode(thread?.mode);
    if (threadMode !== "chat") {
      try {
        const hadMessages = (get().messages[threadId]?.length ?? 0) > 0;
        const resp = await invoke<ChatGenerateMediaResponse>("chat_generate_media", {
          req: {
            thread_id: threadId,
            prompt: content,
            kind: threadMode,
            attachments: attachments ?? [],
          },
        });
        set((s) => ({
          messages: {
            ...s.messages,
            [threadId]: [
              ...(s.messages[threadId] ?? []),
              resp.user_message,
              resp.assistant_message,
            ],
          },
          threads: s.threads.map((t) =>
            t.id === threadId
              ? {
                  ...t,
                  updated_at: Date.now() / 1000,
                  title: hadMessages ? t.title : resp.user_message.content.slice(0, 40) || t.title,
                }
              : t
          ),
        }));
      } catch (e) {
        if (isVaultLockedError(e)) {
          window.dispatchEvent(
            new CustomEvent(VAULT_LOCKED_EVENT, {
              detail: {
                reason:
                  "This AI provider's API key is in the credential vault — unlock it to continue.",
              },
            }),
          );
        }
        throw e;
      } finally {
        set((s) => nextThreadSendingState(s.sendingByThreadId, threadId, false));
      }
      return;
    }

    // Phase 3.S — resolve the saved SessionConfig.id this thread is bound to so
    // the backend can build Claude Code's session-identity card.
    // `thread.linked_session_id` is a terminal *tab* id; the saved-session id
    // lives on the Tab as `sessionId` (set when the tab was opened from a saved
    // session). Null for unbound / local / unsaved-tab threads — the backend
    // then emits a degraded "local workspace" card.
    let boundSessionId: string | null = null;
    // Phase 3.3 — the bound terminal's live cwd (OSC-7), injected per-turn so
    // CC knows the working directory without re-querying. Volatile, so resolved
    // fresh each send. Null for unbound/local/unsaved-tab threads or shells that
    // can't report a cwd.
    let cwd: string | null = null;
    // Phase 6 — the live DB connection id for a thread bound to a DB/Redis tab,
    // bridged per-turn so the CC DB MCP can target it (the backend can't derive
    // the runtime key). Null for non-DB threads or a disconnected DB tab.
    let boundDbConnectionId: string | null = null;
    // Current object-tree selection for DB SQL MCP. Empty for non-DB/Redis tabs
    // or when no object is selected.
    let boundDbSelectedObjects: DbSelectedObject[] = [];
    // Local terminal facts for Claude Code's appended system prompt. Only set
    // for a live local terminal; SSH/remote tabs deliberately leave this null.
    let localTerminalEnv: LocalTerminalEnv | null = null;
    // Current code workspace state for Codex/Claude Code turns bound to an
    // editor tab. This is context only; file writes still go through tools.
    let codeWorkspace: CodeWorkspaceContext | null = null;
    {
      const tabId = get().threads.find((t) => t.id === threadId)?.linked_session_id ?? null;
      if (tabId) {
        try {
          const { useAppStore } = await import("./appStore");
          const { getTerminal } = await import("../lib/terminal/terminalRegistry");
          const appState = useAppStore.getState();
          const boundTab = appState.tabs.find((t) => t.id === tabId || t.chatTabId === tabId) ?? null;
          const runtimeTabId = boundTab?.id ?? tabId;
          boundSessionId = boundTab?.sessionId ?? null;
          cwd = appState.cwdByTab[tabId] ?? appState.cwdByTab[runtimeTabId] ?? null;
          boundDbConnectionId = appState.dbConnByTab[tabId] ?? appState.dbConnByTab[runtimeTabId] ?? null;
          boundDbSelectedObjects =
            appState.dbSelectedObjectsByTab[tabId] ??
            appState.dbSelectedObjectsByTab[runtimeTabId] ??
            [];
          codeWorkspace =
            appState.codeWorkspaceByTab[tabId] ??
            appState.codeWorkspaceByTab[runtimeTabId] ??
            (boundTab?.type === "code-workspace" && boundTab.codeWorkspace
              ? codeWorkspaceContextFromTab(boundTab.codeWorkspace)
              : null);
          const localEnv = getTerminal(tabId)?.localEnvironment ?? getTerminal(runtimeTabId)?.localEnvironment ?? null;
          if (localEnv) {
            localTerminalEnv = { ...localEnv, cwd };
          }
        } catch (err) {
          console.warn("bound_session_id resolution failed:", err);
        }
      }
    }

    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<StreamEvent>(`chat-stream:${threadId}`, (event) => {
        const e = event.payload;
        const upsertMessage = (msg: ChatMessage) => {
          const list = get().messages[threadId] ?? [];
          const idx = list.findIndex((m) => m.id === msg.id);
          const next = idx >= 0
            ? list.map((m, i) => (i === idx ? msg : m))
            : [...list, msg];
          set((s) => ({ messages: { ...s.messages, [threadId]: next } }));
        };

        switch (e.kind) {
          case "user_message":
            upsertMessage(e.message);
            break;
          case "assistant_start":
            upsertMessage({
              id: e.id,
              thread_id: e.thread_id,
              role: "assistant",
              content: "",
              created_at: e.created_at,
              redacted: false,
              attachments: [],
            });
            set((s) => ({ streamingId: { ...s.streamingId, [threadId]: e.id } }));
            break;
          case "token": {
            const list = get().messages[threadId] ?? [];
            const idx = list.findIndex((m) => m.id === e.id);
            if (idx >= 0) {
              const next = [...list];
              next[idx] = { ...next[idx], content: next[idx].content + e.content };
              set((s) => ({ messages: { ...s.messages, [threadId]: next } }));
            }
            break;
          }
          case "end": {
            const list = get().messages[threadId] ?? [];
            const idx = list.findIndex((m) => m.id === e.id);
            if (idx >= 0) {
              const next = [...list];
              next[idx] = { ...next[idx], content: e.content };
              set((s) => {
                // The persisted content now holds the text transcript of tool
                // activity, so the live cards would duplicate it — drop them.
                const cards = { ...s.ccToolCards };
                delete cards[e.id];
                return {
                  messages: { ...s.messages, [threadId]: next },
                  streamingId: { ...s.streamingId, [threadId]: null },
                  ccToolCards: cards,
                  threads: s.threads.map((t) =>
                    t.id === threadId ? { ...t, updated_at: Date.now() / 1000 } : t
                  ),
                };
              });
            }
            // Tao Ribbon: if this reply landed while its Chat panel wasn't the
            // visible surface, raise an `ai_done` alert so the user is notified
            // and can jump back to the thread (§10.2).
            void (async () => {
              try {
                const { useTaoAlertStore } = await import("./taoAlertStore");
                const { useTaoHubStore } = await import("./taoHubStore");
                const s = get();
                const visible =
                  s.drawerOpen &&
                  s.activeThreadId === threadId &&
                  useTaoHubStore.getState().hubTab === "chat";
                if (!visible) {
                  const thread = s.threads.find((th) => th.id === threadId);
                  useTaoAlertStore.getState().pushAiDone(threadId, thread?.title ?? "AI");
                }
              } catch {
                /* alert bridge is best-effort */
              }
            })();
            break;
          }
          case "error": {
            if (isVaultLockedError(e.message)) {
              window.dispatchEvent(
                new CustomEvent(VAULT_LOCKED_EVENT, {
                  detail: {
                    reason:
                      "This AI provider's API key is in the credential vault — unlock it to continue.",
                  },
                }),
              );
            }
            const list = get().messages[threadId] ?? [];
            const idx = list.findIndex((m) => m.id === e.id);
            if (idx >= 0) {
              const next = [...list];
              next[idx] = { ...next[idx], content: `[错误] ${e.message}` };
              set((s) => ({
                messages: { ...s.messages, [threadId]: next },
                streamingId: { ...s.streamingId, [threadId]: null },
              }));
            }
            break;
          }
          case "cc_tool_activity": {
            set((s) => {
              const cards = [...(s.ccToolCards[e.id] ?? [])];
              if (e.phase === "use") {
                cards.push({ call_id: e.call_id, tool: e.tool, detail: e.detail });
              } else {
                // "result" — attach the preview to the matching pending card.
                const ci = cards.findIndex(
                  (c) => c.call_id === e.call_id && c.result === undefined,
                );
                if (ci >= 0) {
                  cards[ci] = { ...cards[ci], result: e.detail };
                }
              }
              return { ccToolCards: { ...s.ccToolCards, [e.id]: cards } };
            });
            break;
          }
          case "usage": {
            set((s) => ({
              ccUsage: {
                ...s.ccUsage,
                [e.id]: {
                  input_tokens: e.input_tokens,
                  output_tokens: e.output_tokens,
                  cost_usd: e.cost_usd,
                  duration_ms: e.duration_ms,
                },
              },
            }));
            break;
          }
        }
      });

      await invoke("chat_stream", {
        req: {
          thread_id: threadId,
          content,
          attachments: attachments ?? [],
          terminal_context: terminalContext ?? null,
          bound_session_id: boundSessionId,
          cwd,
          local_terminal_env: localTerminalEnv,
          bound_db_connection_id: boundDbConnectionId,
          bound_db_selected_objects: boundDbSelectedObjects,
          code_workspace: codeWorkspace,
        },
      });
    } catch (e) {
      if (isVaultLockedError(e)) {
        // Surface the unlock dialog, then bail out — the user re-presses Send
        // after unlocking. Don't fall back to chat_send since that would hit
        // the same locked vault.
        window.dispatchEvent(
          new CustomEvent(VAULT_LOCKED_EVENT, {
            detail: {
              reason:
                "This AI provider's API key is in the credential vault — unlock it to continue.",
            },
          }),
        );
        throw e;
      }
      console.error("chat_stream failed, falling back to chat_send:", e);
      try {
        const resp = await invoke<{
          user_message: ChatMessage;
          assistant_message: ChatMessage;
          redacted_count: number;
        }>("chat_send", {
          req: {
            thread_id: threadId,
            content,
            attachments: attachments ?? [],
            terminal_context: terminalContext ?? null,
            bound_session_id: boundSessionId,
            cwd,
            local_terminal_env: localTerminalEnv,
            bound_db_connection_id: boundDbConnectionId,
            bound_db_selected_objects: boundDbSelectedObjects,
            code_workspace: codeWorkspace,
          },
        });
        set((s) => ({
          messages: {
            ...s.messages,
            [threadId]: [...(s.messages[threadId] ?? []), resp.user_message, resp.assistant_message],
          },
        }));
      } catch (e2) {
        if (isVaultLockedError(e2)) {
          window.dispatchEvent(
            new CustomEvent(VAULT_LOCKED_EVENT, {
              detail: {
                reason:
                  "This AI provider's API key is in the credential vault — unlock it to continue.",
              },
            }),
          );
        }
        throw e2;
      }
    } finally {
      if (unlisten) unlisten();
      set((s) => nextThreadSendingState(s.sendingByThreadId, threadId, false));
    }
  },

  stopSending: async (threadId: string) => {
    try {
      await invoke("chat_stop_stream", { threadId });
    } catch (e) {
      console.error("chat_stop_stream failed:", e);
    }
    set((s) => nextThreadSendingState(s.sendingByThreadId, threadId, false));
  },

  toggleDrawer: () => {
    const s = get();
    const tabId = s.drawerScope === "tab" ? s.drawerTabId : null;
    set({
      drawerOpen: !s.drawerOpen,
      ...(s.drawerOpen && tabId
        ? { tabDrawerOpenByTabId: { ...s.tabDrawerOpenByTabId, [tabId]: false } }
        : {}),
    });
  },
  setDrawerOpen: (open) => {
    set({ drawerOpen: open });
  },
  dismissDrawer: () => {
    const s = get();
    const tabId = s.drawerScope === "tab" ? s.drawerTabId : null;
    set({
      drawerOpen: false,
      ...(tabId
        ? { tabDrawerOpenByTabId: { ...s.tabDrawerOpenByTabId, [tabId]: false } }
        : {}),
    });
  },
  hideDrawer: () => {
    get().dismissDrawer();
  },
  setDrawerWidth: (w) => {
    const width = clampDrawerWidth(w);
    writeDrawerLayoutPrefs({ width });
    set({ drawerWidth: width });
  },
  setDrawerHeight: (h) => {
    const height = clampDrawerHeight(h);
    writeDrawerLayoutPrefs({ height });
    set({ drawerHeight: height });
  },
  setDrawerPosition: (position) => {
    const pinned = position === "left" || position === "right";
    writeDrawerLayoutPrefs({ position, pinned });
    set({ drawerPosition: position, drawerPinned: pinned });
  },
  setDrawerPinned: (pinned) => {
    // Any edge can now be pinned (top/bottom dock as a horizontal band; §8).
    writeDrawerLayoutPrefs({ pinned });
    set({ drawerPinned: pinned });
  },
  setDrawerFloatingOpacity: (opacity) => {
    const floatingOpacity = clampDrawerFloatingOpacity(opacity);
    writeDrawerLayoutPrefs({ floatingOpacity });
    set({ drawerFloatingOpacity: floatingOpacity });
  },
  setRibbonPlacement: (position, offsetRatio) => {
    const pinned = position === "left" || position === "right";
    const ribbonOffsetRatio = Math.min(1, Math.max(0, offsetRatio));
    writeDrawerLayoutPrefs({ position, pinned, ribbonOffsetRatio });
    set({ drawerPosition: position, drawerPinned: pinned, ribbonOffsetRatio });
  },

  openTabChat: async (tabId: string) => {
    if (!tabId) return;
    if (!get().threadsLoaded) {
      await get().loadThreads();
    }
    let thread = rememberedTabThread(
      get().threads,
      get().activeThreadIdByTabId,
      tabId,
    ) ?? latestTabThread(get().threads, tabId);
    if (!thread) {
      const defaultProviderId = await resolveDefaultProviderId();
      thread = await get().newThread(defaultProviderId ?? undefined, tabId);
    }
    set((s) => ({
      activeThreadId: thread.id,
      drawerOpen: true,
      drawerScope: "tab",
      drawerTabId: tabId,
      tabDrawerOpenByTabId: { ...s.tabDrawerOpenByTabId, [tabId]: true },
      activeThreadIdByTabId: { ...s.activeThreadIdByTabId, [tabId]: thread.id },
    }));
    // Opening the thread clears any pending "AI reply ready" ribbon alert.
    void import("./taoAlertStore")
      .then((m) => m.useTaoAlertStore.getState().clearThread(thread.id))
      .catch(() => {});
  },

  toggleTabChat: async (tabId: string) => {
    if (!tabId) return;
    const s = get();
    if (s.drawerOpen && s.drawerScope === "tab" && s.drawerTabId === tabId) {
      set({
        drawerOpen: false,
        tabDrawerOpenByTabId: { ...s.tabDrawerOpenByTabId, [tabId]: false },
      });
      return;
    }
    await get().openTabChat(tabId);
  },

  syncTabChatWithActiveTab: async (tabId: string | null) => {
    const s = get();

    if (!tabId) {
      if (s.drawerOpen) {
        set({ drawerOpen: false, drawerTabId: null });
      }
      return;
    }

    if (s.tabDrawerOpenByTabId[tabId]) {
      await get().openTabChat(tabId);
      return;
    }

    if (s.drawerScope === "tab" && s.drawerOpen) {
      set({ drawerOpen: false, drawerTabId: tabId });
    }
  },

  attachToComposer: async (text: string) => {
    const { getActiveTerminalTabId } = await import("../lib/terminal/terminalRegistry");
    const tabId = getActiveTerminalTabId() ?? (await resolveActiveChatTabId());
    if (tabId) {
      await get().openTabChat(tabId);
    }
    set({
      drawerOpen: true,
      pendingComposerText: `> ${text.replace(/\n+/g, "\n> ")}\n\n`,
    });
  },

  sendPromptToTabChat: async (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const { getActiveTerminalTabId } = await import("../lib/terminal/terminalRegistry");
    const tabId = getActiveTerminalTabId() ?? (await resolveActiveChatTabId());
    let threadId: string | null = null;
    if (tabId) {
      // Resolves the remembered/latest thread for this tab, or creates one.
      await get().openTabChat(tabId);
      threadId = get().activeThreadId;
    }
    if (!threadId) {
      const thread = await get().newThread(undefined, tabId ?? undefined);
      set((s) => ({
        activeThreadId: thread.id,
        ...scopeForThread(thread),
        tabDrawerOpenByTabId: tabId
          ? { ...s.tabDrawerOpenByTabId, [tabId]: true }
          : s.tabDrawerOpenByTabId,
      }));
      threadId = thread.id;
    }
    set({ drawerOpen: true });
    // Fire-and-forget — sendMessage owns its own loading state.
    void get().sendMessage(threadId, trimmed);
  },

  consumePendingComposerText: () => {
    const text = get().pendingComposerText;
    if (text) set({ pendingComposerText: "" });
    return text;
  },

  setComposerDraft: (key: string, draft: ChatComposerDraft) => {
    set((s) => ({
      composerDrafts: {
        ...s.composerDrafts,
        [key]: draft,
      },
    }));
  },

  clearComposerDraft: (key: string) => {
    set((s) => {
      if (!(key in s.composerDrafts)) return s;
      const next = { ...s.composerDrafts };
      delete next[key];
      return { composerDrafts: next };
    });
  },

  explainSelection: async (text: string) => {
    // Bind the new thread to the current terminal so the user can keep
    // chatting about the same pty without re-staging context.
    const { getActiveTerminalTabId } = await import("../lib/terminal/terminalRegistry");
    const tabId = getActiveTerminalTabId() ?? (await resolveActiveChatTabId());
    const thread = await get().newThread(undefined, tabId ?? undefined);
    set((s) => ({
      drawerOpen: true,
      ...scopeForThread(thread),
      tabDrawerOpenByTabId: tabId
        ? { ...s.tabDrawerOpenByTabId, [tabId]: true }
        : s.tabDrawerOpenByTabId,
    }));
    // Fire-and-forget — sendMessage owns its own loading state.
    void get().sendMessage(thread.id, `请解释下面这段终端输出：\n\n\`\`\`\n${text}\n\`\`\``);
  },

  purgeOldThreads: async (keepDays: number) => {
    try {
      const deleted = await invoke<number>("chat_purge_old", { keepDays });
      if (deleted > 0) {
        await get().loadThreads();
      }
      return deleted;
    } catch (e) {
      console.error("chat_purge_old failed:", e);
      return 0;
    }
  },

  exportArchive: async (outPath: string) => {
    return await invoke<number>("chat_export_archive", { outPath });
  },
}));
