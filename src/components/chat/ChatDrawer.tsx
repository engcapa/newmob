import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  Bell,
  Bot,
  Check,
  ChevronDown,
  Copy,
  History,
  Image as ImageIcon,
  Link2,
  Mail,
  MessageSquare,
  PanelBottomOpen,
  PanelLeftOpen,
  PanelRightOpen,
  PanelTopOpen,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  StickyNote,
  TerminalSquare,
  Video,
  X,
} from "lucide-react";
import {
  MAX_QUEUED_SENDS,
  normalizeChatThreadMode,
  useChatStore,
  isChatCapableTabType,
  type ChatDrawerPosition,
  type ChatThreadMode,
  type QueuedSend,
} from "../../stores/chatStore";
import {
  chatDrawerProviderIds,
  acpProfileIdFromProvider,
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_GROK_ACP_PROFILE,
  providerGroupIdFromRoute,
  rememberChatDrawerProviderPreference,
  useAiStore,
  type AiConfig,
  type LlmProviderCapability,
} from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { MessageBubble } from "./MessageBubble";
import { CcToolCards } from "./CcToolCards";
import { Composer } from "./Composer";
import { ChatThreadList } from "./ChatThreadList";
import {
  getTerminal,
} from "../../lib/terminal/terminalRegistry";
import { getQueryTab } from "../../lib/queryRegistry";
import type { ChatOutputFormat } from "../../lib/chat/renderFormatted";
import type { ChatAttachment } from "../../lib/chat/attachments";
import { useT, type TranslateFn } from "../../lib/i18n";
import { placementFromPoint, ribbonPositionStyle } from "../../lib/tao/ribbonPlacement";
import { resolveChatDock } from "../../lib/chat/chatDock";
import { useViewportSize } from "../../hooks/useViewportSize";
import { useTaoHubStore } from "../../stores/taoHubStore";
import { useNotesStore } from "../../stores/notesStore";
import { useTaoAlertStore } from "../../stores/taoAlertStore";
import { NotesPanel } from "../notes/NotesPanel";
import { notesThemeStyle } from "../../lib/notes/notesTheme";
import { TaoAlertInbox } from "../tao/TaoAlertInbox";
import { alertColorBucket, buildTaoAlerts, topAlertKind, type TaoAlert } from "../../lib/tao/taoAlerts";

/** Stable empty array so a thread with no queue does not churn renders. */
const EMPTY_QUEUE: QueuedSend[] = [];

const DRAWER_POSITIONS: ChatDrawerPosition[] = ["left", "right", "top", "bottom"];
const CHAT_THREAD_MODES: ChatThreadMode[] = ["chat", "image", "video"];
const SIDE_RIBBON_HOVER_OPEN_DELAY_MS = 260;
const TOP_BOTTOM_RIBBON_HOVER_OPEN_DELAY_MS = 650;

interface ChatDrawerProps {
  /**
   * Optional fallback terminal scrollback. When omitted (the default in the
   * production layout), the drawer pulls live buffer text from the terminal
   * registry instead — that's what makes `@terminal:last-N` actually work.
   */
  terminalContext?: string;
}

export function ChatDrawer({ terminalContext }: ChatDrawerProps) {
  const t = useT();
  const {
    threads, activeThreadId, messages, sendingByThreadId, sendQueues, drawerOpen, drawerWidth,
    drawerHeight, drawerPosition, drawerPinned, drawerFloatingOpacity, drawerTabId,
    loadThreads, newThread, deleteThread, setActiveThread, loadMessages,
    enqueueMessage, dequeueSend, hideDrawer, setDrawerWidth, setDrawerHeight, setDrawerPosition,
    setDrawerPinned, setDrawerFloatingOpacity, dismissDrawer, purgeOldThreads, stopSending,
  } = useChatStore();

  const [showHistory, setShowHistory] = useState(false);
  const [showPositionMenu, setShowPositionMenu] = useState(false);
  const [showOpacityMenu, setShowOpacityMenu] = useState(false);
  const hubTab = useTaoHubStore((s) => s.hubTab);
  const setHubTab = useTaoHubStore((s) => s.setHubTab);
  const notesTheme = useNotesStore((s) => s.theme);
  const noteAlerts = useNotesStore((s) => s.alerts);
  const setActiveNote = useNotesStore((s) => s.setActiveNote);
  const ackNoteAlert = useNotesStore((s) => s.ackAlert);
  const aiDoneAlerts = useTaoAlertStore((s) => s.aiDone);
  const mailNewAlerts = useTaoAlertStore((s) => s.mailNew);
  const alertHistory = useTaoAlertStore((s) => s.history);
  const alertHistoryLimit = useTaoAlertStore((s) => s.historyLimit);
  const recordAlertHistory = useTaoAlertStore((s) => s.recordHistory);
  const setAlertHistoryLimit = useTaoAlertStore((s) => s.setHistoryLimit);
  const clearAlertHistory = useTaoAlertStore((s) => s.clearHistory);
  const ackAiDone = useTaoAlertStore((s) => s.ack);
  const clearMailTab = useTaoAlertStore((s) => s.clearMailTab);
  const [error, setError] = useState<string | null>(null);
  // Per-thread render-format override applied client-side ONLY (the persisted
  // `output_format` is locked once the thread has any messages — see issue
  // #3). Setting this lets the user re-render the existing transcript in
  // another format via the convert button without changing the prompt
  // contract sent to the LLM for the next turn.
  const [renderFormatOverride, setRenderFormatOverride] =
    useState<Record<string, ChatOutputFormat>>({});
  const [copiedAll, setCopiedAll] = useState(false);
  const [ccModelDraft, setCcModelDraft] = useState(DEFAULT_CLAUDE_CODE_MODEL);
  const [newThreadMode, setNewThreadMode] = useState<ChatThreadMode>("chat");
  const [draftProviderId, setDraftProviderId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
  // Track open/thread/length so tab-return (same thread, just re-shown) keeps
  // the current scroll offset instead of re-animating top→bottom.
  const prevDrawerOpenRef = useRef(false);
  const prevScrollThreadIdRef = useRef<string | null>(null);
  const prevScrollMessageCountRef = useRef(0);

  // Subscribe to the active tab so the drawer re-renders (and the
  // scope/picker logic re-evaluates) whenever the user switches tabs. We
  // can't read this from terminalRegistry alone because the registry is a
  // plain global and isn't reactive.
  const activeTab = useAppStore((s) =>
    s.tabs.find((tab) => tab.id === s.activeTabId) ?? null,
  );
  const setActiveAppTab = useAppStore((s) => s.setActiveTab);
  const activeTabId = activeTab?.id ?? null;
  const activeTabType = activeTab?.type ?? null;
  const activeChatTabId = isChatCapableTabType(activeTabType)
    ? activeTab?.chatTabId ?? activeTabId
    : null;
  // SQL echo toggle (Phase 6) — appended to the linked query tab when CC runs
  // SQL. Subscribed so the toggle reflects/persists across the app.
  const sqlEcho = useAppStore((s) => s.sqlEcho);
  const setSqlEcho = useAppStore((s) => s.setSqlEcho);
  const focusedTerminal = useMemo(() => {
    if (activeTabType !== "terminal") return null;
    return activeTabId ? getTerminal(activeTabId) : null;
    // We deliberately depend on activeTabId/Type so the memo recomputes on
    // tab switch even though terminalRegistry itself is non-reactive.
  }, [activeTabId, activeTabType]);

  const activeMessages = activeThreadId ? (messages[activeThreadId] ?? []) : [];
  const sending = activeThreadId ? sendingByThreadId[activeThreadId] === true : false;
  const queuedSends = activeThreadId ? sendQueues[activeThreadId] ?? EMPTY_QUEUE : EMPTY_QUEUE;
  const activeThread = (threads ?? []).find((t) => t.id === activeThreadId);
  const linkedTab = useAppStore((s) =>
    activeThread?.linked_session_id
      ? s.tabs.find((tab) =>
          tab.id === activeThread.linked_session_id ||
          tab.chatTabId === activeThread.linked_session_id
        ) ?? null
      : null,
  );
  const linkedTabTitle = activeThread?.linked_session_id
    ? (
        getTerminal(activeThread.linked_session_id)?.title
        ?? (linkedTab ? getTerminal(linkedTab.id)?.title : undefined)
        ?? getQueryTab(activeThread.linked_session_id)?.title
        ?? (linkedTab ? getQueryTab(linkedTab.id)?.title : undefined)
        ?? linkedTab?.title
        ?? activeThread.linked_session_id.slice(0, 8)
      )
    : null;
  // The SQL echo toggle only applies to threads bound to a SQL ("database")
  // tab. Resolved from the tab type so it stays reactive as tabs open/close.
  const linkedTabType = linkedTab?.type ?? null;
  const isQueryThread = linkedTabType === "database";
  const visibleThreads = useMemo(
    () => {
      const list = threads ?? [];
      return drawerTabId
        ? list.filter((thread) => thread.linked_session_id === drawerTabId)
        : list.filter((thread) => thread.linked_session_id);
    },
    [drawerTabId, threads],
  );
  const taoAlerts = useMemo(
    () => buildTaoAlerts(noteAlerts, aiDoneAlerts, mailNewAlerts),
    [noteAlerts, aiDoneAlerts, mailNewAlerts],
  );
  const alertBadgeCount = useMemo(
    () => taoAlerts.reduce((sum, alert) => sum + (alert.count ?? 1), 0),
    [taoAlerts],
  );
  useEffect(() => {
    recordAlertHistory(taoAlerts);
  }, [recordAlertHistory, taoAlerts]);

  const jumpToAlert = (alert: TaoAlert) => {
    if (alert.source === "notes") {
      setHubTab("notes");
      if (alert.noteId) setActiveNote(alert.noteId);
      const rawId = alert.id.startsWith("note:") ? alert.id.slice("note:".length) : alert.id;
      void ackNoteAlert(rawId);
      return;
    }
    if (alert.source === "mail") {
      const tabId = alert.mailTabId;
      if (tabId && useAppStore.getState().tabs.some((tab) => tab.id === tabId)) {
        setActiveAppTab(tabId);
        clearMailTab(tabId);
      }
      return;
    }
    setHubTab("chat");
    if (alert.threadId) setActiveThread(alert.threadId);
    ackAiDone(alert.id);
  };

  const ackAlert = (alert: TaoAlert) => {
    if (alert.source === "notes") {
      const rawId = alert.id.startsWith("note:") ? alert.id.slice("note:".length) : alert.id;
      void ackNoteAlert(rawId);
      return;
    }
    if (alert.source === "mail") {
      if (alert.mailTabId) clearMailTab(alert.mailTabId);
      return;
    }
    ackAiDone(alert.id);
  };

  // Provider switcher dropdown — pulls the live provider list from aiStore.
  const aiConfig = useAiStore((s) => s.config);
  const defaultCcModel = aiConfig?.cc_bridge.default_model?.trim() || DEFAULT_CLAUDE_CODE_MODEL;
  const defaultCodexModel = aiConfig?.codex_bridge.default_model?.trim() || DEFAULT_CODEX_MODEL;
  const isLocalAgentProvider = activeThread?.provider_id === "claude-code" || activeThread?.provider_id === "codex";
  const defaultLocalAgentModel = activeThread?.provider_id === "codex" ? defaultCodexModel : defaultCcModel;
  const ccTerminalEchoEnabled = activeThread?.provider_id === "codex"
    ? (aiConfig?.codex_bridge.terminal_echo_enabled ?? true)
    : (aiConfig?.cc_bridge.terminal_echo_enabled ?? true);
  const globalOutputFormat = aiConfig?.chat_output_format ?? "md";
  const loadAiConfig = useAiStore((s) => s.loadConfig);
  const saveAiConfig = useAiStore((s) => s.saveConfig);
  const activeThreadMode = normalizeChatThreadMode(activeThread?.mode);
  const currentMode = activeThread ? activeThreadMode : newThreadMode;
  const activeProviderIds = useMemo(
    () => chatDrawerProviderIds(aiConfig, capabilityForMode(activeThreadMode)),
    [aiConfig, activeThreadMode],
  );
  const draftProviderIds = useMemo(
    () => chatDrawerProviderIds(aiConfig, capabilityForMode(newThreadMode)),
    [aiConfig, newThreadMode],
  );
  const availableModes = useMemo(
    () => new Set(CHAT_THREAD_MODES.filter((mode) =>
      chatDrawerProviderIds(aiConfig, capabilityForMode(mode)).length > 0
    )),
    [aiConfig],
  );
  const setThreadProvider = useChatStore((s) => s.setThreadProvider);
  const setThreadCcModel = useChatStore((s) => s.setThreadCcModel);
  const setThreadOutputFormat = useChatStore((s) => s.setThreadOutputFormat);

  // Effective format for rendering this thread's messages. Resolution order:
  //   1. Client-side render-only override (set by the convert button).
  //   2. Persisted per-thread `output_format` (chosen at thread creation).
  //   3. Global default from AiConfig.
  // Mirrors the backend's resolve_output_format for #2 and #3.
  const effectiveFormat: ChatOutputFormat = useMemo(() => {
    const override = activeThreadId ? renderFormatOverride[activeThreadId] : undefined;
    if (override) return override;
    const candidate = activeThread?.output_format ?? globalOutputFormat;
    return candidate === "html" || candidate === "plain" ? candidate : "md";
  }, [activeThreadId, renderFormatOverride, activeThread?.output_format, globalOutputFormat]);

  // Once a thread has any messages, the persisted `output_format` is locked —
  // re-rendering existing replies in another format would silently invalidate
  // them (HTML rendered as Markdown is unreadable, plain text rendered as
  // Markdown collides with `*` and `_`). The user can still convert the
  // visible transcript via the render-only override.
  const formatLocked = activeThreadId
    ? (messages[activeThreadId]?.length ?? 0) > 0
    : false;

  // Load threads on mount + sweep stale (30-day retention).
  useEffect(() => {
    loadThreads();
    void purgeOldThreads(30);
    void loadAiConfig().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (activeThread) {
      setNewThreadMode(normalizeChatThreadMode(activeThread.mode));
    }
  }, [activeThread?.id, activeThread?.mode]);

  useEffect(() => {
    setDraftProviderId((current) =>
      current && draftProviderIds.includes(current) ? current : draftProviderIds[0] ?? null
    );
  }, [draftProviderIds]);

  useEffect(() => {
    if (!isLocalAgentProvider) {
      setCcModelDraft(defaultLocalAgentModel);
      return;
    }
    setCcModelDraft(activeThread.cc_model?.trim() || defaultLocalAgentModel);
  }, [activeThread?.id, activeThread?.provider_id, activeThread?.cc_model, isLocalAgentProvider, defaultLocalAgentModel]);

  // Narrow windows keep the tab usable by hiding to the ribbon; medium widths
  // float the drawer instead of consuming layout width.
  useEffect(() => {
    const handle = () => {
      const w = window.innerWidth;
      if (w < 760) {
        hideDrawer();
      } else if (w < 1120 && (drawerPosition === "left" || drawerPosition === "right") && drawerPinned) {
        setDrawerPinned(false);
      }
    };
    window.addEventListener("resize", handle);
    handle();
    return () => window.removeEventListener("resize", handle);
  }, [drawerPinned, drawerPosition, hideDrawer, setDrawerPinned]);

  // Load messages when active thread changes.
  useEffect(() => {
    if (activeThreadId && !messages[activeThreadId]) {
      loadMessages(activeThreadId);
    }
  }, [activeThreadId]);

  // Scroll policy:
  // - same thread re-shown after hide (tab switch away/back): keep scroll
  // - thread change / first open: jump to bottom instantly
  // - new messages while open: smooth-scroll only when the list already had content
  useEffect(() => {
    if (!drawerOpen) {
      prevDrawerOpenRef.current = false;
      return;
    }
    const end = messagesEndRef.current;
    if (!end) return;

    const opened = !prevDrawerOpenRef.current;
    const threadChanged = prevScrollThreadIdRef.current !== activeThreadId;
    const previousCount = prevScrollMessageCountRef.current;
    const grew = activeMessages.length > previousCount;

    prevDrawerOpenRef.current = true;
    prevScrollThreadIdRef.current = activeThreadId;
    prevScrollMessageCountRef.current = activeMessages.length;

    // Re-opening the same transcript (tab return) — preserve scroll position.
    if (opened && !threadChanged) return;

    if (threadChanged || opened) {
      end.scrollIntoView({ behavior: "auto" });
      return;
    }

    if (grew) {
      end.scrollIntoView({ behavior: previousCount === 0 ? "auto" : "smooth" });
    }
  }, [drawerOpen, activeThreadId, activeMessages.length]);

  const pickProviderForMode = (mode: ChatThreadMode, preferredProviderId?: string | null): string | null => {
    const ids = chatDrawerProviderIds(aiConfig, capabilityForMode(mode));
    if (preferredProviderId && ids.includes(preferredProviderId)) return preferredProviderId;
    return ids[0] ?? null;
  };

  const rememberProviderForMode = (mode: ChatThreadMode, providerId: string) => {
    rememberChatDrawerProviderPreference(providerId, capabilityForMode(mode));
  };

  const handleNewThread = async () => {
    const linked = drawerTabId ?? activeChatTabId;
    if (!linked) {
      setError(t("chat.noTabBinding"));
      return;
    }
    const providerId = draftProviderId && draftProviderIds.includes(draftProviderId)
      ? draftProviderId
      : draftProviderIds[0] ?? null;
    if (!providerId) {
      setError(t("chat.noProviderForMode", { mode: t(`chat.mode_${newThreadMode}`) }));
      return;
    }
    setShowHistory(false);
    try {
      await newThread(providerId, linked, newThreadMode);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleModeSelect = async (mode: ChatThreadMode) => {
    setNewThreadMode(mode);
    setError(null);
    if (!availableModes.has(mode)) {
      setError(t("chat.noProviderForMode", { mode: t(`chat.mode_${mode}`) }));
      return;
    }
    const providerId = pickProviderForMode(mode, activeThread?.provider_id ?? draftProviderId);
    setDraftProviderId(providerId);
    if (!activeThread) return;
    if (activeThreadMode === mode) return;
    const linked = activeThread.linked_session_id ?? drawerTabId ?? activeChatTabId;
    if (!linked) {
      setError(t("chat.noTabBinding"));
      return;
    }
    if (!providerId) {
      setError(t("chat.noProviderForMode", { mode: t(`chat.mode_${mode}`) }));
      return;
    }
    setShowHistory(false);
    try {
      const loadedMessages = messages[activeThread.id];
      const replaceEmptyActiveThread = loadedMessages !== undefined && loadedMessages.length === 0;
      const oldThreadId = activeThread.id;
      await newThread(providerId, linked, mode);
      if (replaceEmptyActiveThread) {
        await deleteThread(oldThreadId);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const copyAllToClipboard = async () => {
    if (!activeThreadId) return;
    const list = messages[activeThreadId] ?? [];
    if (list.length === 0) return;
    const text = list
      .map((m) => {
        const role = m.role === "user" ? t("chat.role_user") : m.role === "assistant" ? t("chat.role_assistant") : t("chat.role_system");
        return `### ${role}\n\n${m.content}`;
      })
      .join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAll(true);
      window.setTimeout(() => setCopiedAll(false), 1500);
    } catch (e) {
      console.warn("copy all failed:", e);
    }
  };

  const cycleRenderFormat = () => {
    if (!activeThreadId) return;
    const order: ChatOutputFormat[] = ["md", "html", "plain"];
    const idx = order.indexOf(effectiveFormat);
    const next = order[(idx + 1) % order.length];
    setRenderFormatOverride((m) => ({ ...m, [activeThreadId]: next }));
  };

  const setCcTerminalEcho = (enabled: boolean) => {
    if (!aiConfig) return;
    const next = activeThread?.provider_id === "codex"
      ? { ...aiConfig, codex_bridge: { ...aiConfig.codex_bridge, terminal_echo_enabled: enabled } }
      : { ...aiConfig, cc_bridge: { ...aiConfig.cc_bridge, terminal_echo_enabled: enabled } };
    void saveAiConfig(next).catch((e) => {
      console.warn("save local agent terminal echo setting failed:", e);
    });
  };

  const commitThreadCcModel = () => {
    if (!activeThread || !isLocalAgentProvider) return;
    const trimmed = ccModelDraft.trim();
    const nextModel = trimmed === "" || trimmed === defaultLocalAgentModel ? null : trimmed;
    if ((activeThread.cc_model ?? null) === nextModel) {
      setCcModelDraft(nextModel ?? defaultLocalAgentModel);
      return;
    }
    setCcModelDraft(nextModel ?? defaultLocalAgentModel);
    void setThreadCcModel(activeThread.id, nextModel).catch((e) => {
      console.warn("set local agent thread model failed:", e);
      setCcModelDraft(activeThread.cc_model?.trim() || defaultLocalAgentModel);
    });
  };

  const resolveTerminalText = (lines: number): string | undefined => {
    // Prefer the terminal linked to the active thread; fall back to the
    // currently focused terminal tab; final fallback is the legacy prop the
    // caller passed (kept for tests / programmatic use).
    const linked = activeThread?.linked_session_id ?? null;
    const entry = getTerminal(linked) ?? (linkedTab ? getTerminal(linkedTab.id) : null) ?? focusedTerminal;
    if (entry) {
      return entry.getLastLines(lines);
    }
    if (terminalContext) {
      const all = terminalContext.split("\n");
      const slice = all.slice(Math.max(0, all.length - lines));
      return slice.join("\n");
    }
    return undefined;
  };

  const handleSend = async (content: string, attachedTerminalCtx?: string, attachments?: ChatAttachment[]) => {
    // Composer can override the prop's `terminalContext` when the user
    // types `@terminal:last-N`. The override takes precedence; otherwise we
    // fall back to whatever the host (TerminalPanel) staged.
    const ctx = attachedTerminalCtx ?? terminalContext;
    setError(null);
    try {
      let threadId = activeThreadId;
      if (!threadId) {
        const linked = drawerTabId ?? activeChatTabId;
        if (!linked) {
          setError(t("chat.noTabBinding"));
          return;
        }
        const providerId = draftProviderId && draftProviderIds.includes(draftProviderId)
          ? draftProviderId
          : draftProviderIds[0] ?? null;
        if (!providerId) {
          setError(t("chat.noProviderForMode", { mode: t(`chat.mode_${newThreadMode}`) }));
          return;
        }
        const thread = await newThread(providerId, linked, newThreadMode);
        threadId = thread.id;
      }
      // Queued rather than sent directly, so typing ahead of a running turn
      // parks the message instead of racing it into the same transcript.
      const result = await enqueueMessage(threadId, content, ctx, attachments);
      if (result.status === "rejected") {
        setError(t("chat.queueFull", { limit: result.limit }));
      }
      return result;
    } catch (e) {
      setError(String(e));
    }
  };

  const isHorizontalDock = drawerPosition === "left" || drawerPosition === "right";
  const viewport = useViewportSize();
  const dockMode = resolveChatDock(drawerPosition, drawerPinned, viewport.width, viewport.height);
  const sideBySide = dockMode === "side-inline";
  const stackedInline = dockMode === "stacked-inline";
  const floating = dockMode === "floating";
  const pinnedActive = sideBySide || stackedInline;
  const topBottomFloating = floating && (drawerPosition === "top" || drawerPosition === "bottom");

  useEffect(() => {
    if (!drawerOpen || !floating) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest('[data-testid="ai-chat-drawer"]') ||
        target.closest('[data-testid="ai-chat-drawer-ribbon"]') ||
        target.closest('[data-testid="ai-chat-safety-gate"]') ||
        target.closest("[data-tao-floating-portal]")
      ) {
        return;
      }
      setShowPositionMenu(false);
      setShowOpacityMenu(false);
      dismissDrawer();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [dismissDrawer, drawerOpen, floating]);

  // Drag-to-resize the drawer.
  const handleResizeStart = (
    e: ReactPointerEvent<HTMLDivElement>,
    axis: "width" | "height",
    edge?: "left" | "right",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = true;
    resizeStartRef.current = { x: e.clientX, y: e.clientY, width: drawerWidth, height: drawerHeight };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = axis === "width" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Browser preview fallback.
    }
    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return;
      if (axis === "width") {
        if (drawerPosition === "left") {
          setDrawerWidth(resizeStartRef.current.width + ev.clientX - resizeStartRef.current.x);
        } else if (drawerPosition === "right") {
          setDrawerWidth(resizeStartRef.current.width + resizeStartRef.current.x - ev.clientX);
        } else if (edge === "left") {
          setDrawerWidth(resizeStartRef.current.width + (resizeStartRef.current.x - ev.clientX) * 2);
        } else {
          setDrawerWidth(resizeStartRef.current.width + (ev.clientX - resizeStartRef.current.x) * 2);
        }
      } else if (drawerPosition === "top") {
        setDrawerHeight(resizeStartRef.current.height + ev.clientY - resizeStartRef.current.y);
      } else {
        setDrawerHeight(resizeStartRef.current.height + resizeStartRef.current.y - ev.clientY);
      }
    };
    const onUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const positionLabel = t(`chat.drawerPosition_${drawerPosition}`);
  const PositionIcon = positionIcon(drawerPosition);
  const containerClass = [
    "ai-z-drawer",
    sideBySide ? "relative h-full shrink-0" : "",
    stackedInline ? "relative w-full shrink-0" : "",
    !sideBySide && !stackedInline ? "absolute shadow-2xl" : "",
    drawerPosition === "left" ? "order-first" : "",
    floating ? "rounded-md" : "",
  ].filter(Boolean).join(" ");
  // Stay mounted while hidden so tab switches do not remount the transcript.
  const containerStyle: CSSProperties = !drawerOpen
    ? { display: "none" }
    : sideBySide
    ? { width: drawerWidth }
    : stackedInline
    ? { height: drawerHeight, width: "100%" }
    : isHorizontalDock
    ? {
        width: drawerWidth,
        top: 0,
        bottom: 0,
        [drawerPosition]: 0,
      }
    : {
        width: drawerWidth,
        maxWidth: "calc(100% - 32px)",
        height: drawerHeight,
        left: "50%",
        transform: "translateX(-50%)",
        [drawerPosition]: 0,
      };
  if (drawerOpen && topBottomFloating) {
    containerStyle.opacity = drawerFloatingOpacity;
  }
  const themedContainerStyle: CSSProperties = drawerOpen && hubTab === "notes"
    ? { ...containerStyle, ...notesThemeStyle(notesTheme) }
    : containerStyle;
  const resizeHandleClass = isHorizontalDock
    ? `absolute ${drawerPosition === "left" ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2"} top-0 bottom-0 w-2 cursor-col-resize bg-transparent hover:bg-[var(--taomni-accent)]/35 transition-colors z-20`
    : `absolute left-0 right-0 ${drawerPosition === "top" ? "bottom-0 translate-y-1/2" : "top-0 -translate-y-1/2"} h-2 cursor-row-resize bg-transparent hover:bg-[var(--taomni-accent)]/35 transition-colors z-20`;
  const widthResizeHandleClass =
    "absolute top-0 bottom-0 w-2 cursor-col-resize bg-transparent hover:bg-[var(--taomni-accent)]/35 transition-colors z-20";
  const panelBorderClass = sideBySide
    ? drawerPosition === "left"
      ? "border-r"
      : "border-l"
    : stackedInline
    ? drawerPosition === "top"
      ? "border-b"
      : "border-t"
    : "border";
  const providerIds = activeThread ? activeProviderIds : draftProviderIds;
  const selectedProviderId = activeThread
    ? (providerIds.includes(activeThread.provider_id) ? activeThread.provider_id : "")
    : draftProviderId ?? providerIds[0] ?? "";
  const emptyHint = currentMode === "image"
    ? t("chat.emptyImageHint")
    : currentMode === "video"
      ? t("chat.emptyVideoHint")
      : t("chat.emptyHint");
  const sendShortcutLabel = (aiConfig?.chat_send_shortcut === "enter")
    ? t("chat.shortcutEnter")
    : t("chat.shortcutCtrlEnter");
  const composerPlaceholder = currentMode === "image"
    ? t("chat.imagePromptPlaceholder", { shortcut: sendShortcutLabel })
    : currentMode === "video"
      ? t("chat.videoPromptPlaceholder", { shortcut: sendShortcutLabel })
      : undefined;
  const composerDraftKey = activeThreadId
    ? `thread:${activeThreadId}`
    : (drawerTabId ?? activeChatTabId)
      ? `tab:${drawerTabId ?? activeChatTabId}`
      : null;
  // Grok media mode accepts a reference image as a local ACP resource link.
  // Other API media providers currently expose text-only generation endpoints,
  // so keep their composer attachment surface disabled rather than silently
  // discarding a picked file.
  const attachmentsEnabled = currentMode === "chat"
    || acpProfileIdFromProvider(selectedProviderId) === DEFAULT_GROK_ACP_PROFILE.id;
  const sendingLabel = currentMode === "image"
    ? t("chat.imageGenerating")
    : currentMode === "video"
      ? t("chat.videoGenerating")
      : t("chat.aiThinking");

  return (
    <div
      className={containerClass}
      style={themedContainerStyle}
      data-testid="ai-chat-drawer"
      data-position={drawerPosition}
      data-pinned={drawerPinned || undefined}
      data-open={drawerOpen || undefined}
      aria-hidden={!drawerOpen}
    >
      {/* Resize handle */}
      <div
        className={resizeHandleClass}
        data-testid={isHorizontalDock ? "ai-chat-drawer-width-resize" : "ai-chat-drawer-height-resize"}
        onPointerDown={(event) => handleResizeStart(event, isHorizontalDock ? "width" : "height")}
      />
      {!isHorizontalDock && (
        <>
          <div
            className={`${widthResizeHandleClass} left-0 -translate-x-1/2`}
            data-testid="ai-chat-drawer-width-resize-left"
            onPointerDown={(event) => handleResizeStart(event, "width", "left")}
          />
          <div
            className={`${widthResizeHandleClass} right-0 translate-x-1/2`}
            data-testid="ai-chat-drawer-width-resize-right"
            onPointerDown={(event) => handleResizeStart(event, "width", "right")}
          />
        </>
      )}

      <div
        className={`flex flex-col w-full h-full ${panelBorderClass} border-[var(--taomni-divider)] ${floating ? "rounded-md overflow-hidden" : ""}`}
        style={{ background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)" }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--taomni-divider)] shrink-0"
          style={{ background: "var(--taomni-panel-bg)" }}
        >
          {hubTab === "notes" ? (
            <StickyNote className="w-4 h-4 text-[var(--taomni-accent)] shrink-0" />
          ) : hubTab === "notifications" ? (
            <Bell className="w-4 h-4 text-[var(--taomni-accent)] shrink-0" />
          ) : (
            <Bot className="w-4 h-4 text-[var(--taomni-accent)] shrink-0" />
          )}
          <span className="text-[13px] font-semibold flex-1 truncate">
            {hubTab === "notes"
              ? t("notes.title")
              : hubTab === "notifications"
                ? t("tao.tabNotifications")
              : activeThread?.title ?? t("chat.drawerTitle")}
          </span>
          <div className="relative">
            <button
              type="button"
              className="taomni-btn h-6 px-1.5 inline-flex items-center gap-1 text-[11px]"
              onClick={() => setShowPositionMenu((v) => !v)}
              title={t("chat.drawerPositionTitle", { position: positionLabel })}
              aria-label={t("chat.drawerPositionAria")}
              data-testid="ai-chat-drawer-position"
            >
              <PositionIcon className="w-3.5 h-3.5" />
              <ChevronDown className="w-3 h-3" />
            </button>
            {showPositionMenu && (
              <div
                className="absolute right-0 top-7 z-30 min-w-[118px] rounded border border-[var(--taomni-divider)] shadow-lg overflow-hidden"
                style={{ background: "var(--taomni-panel-bg)" }}
              >
                {DRAWER_POSITIONS.map((position) => {
                  const Icon = positionIcon(position);
                  return (
                    <button
                      key={position}
                      type="button"
                      className={`w-full h-7 px-2 text-left text-[11px] flex items-center gap-2 hover:bg-[var(--taomni-hover)] ${
                        drawerPosition === position ? "text-[var(--taomni-accent)] bg-[var(--taomni-selected)]" : ""
                      }`}
                      onClick={() => {
                        setDrawerPosition(position);
                        setShowPositionMenu(false);
                      }}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{t(`chat.drawerPosition_${position}`)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            className={`taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center ${
              pinnedActive ? "text-[var(--taomni-accent)]" : ""
            }`}
            onClick={() => setDrawerPinned(!drawerPinned)}
            title={
              pinnedActive
                ? t("chat.drawerUnpinTitle")
                : t("chat.drawerPinTitle")
            }
            aria-label={pinnedActive ? t("chat.drawerUnpinTitle") : t("chat.drawerPinTitle")}
            aria-pressed={pinnedActive}
            data-testid="ai-chat-drawer-pin"
          >
            {pinnedActive ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
          </button>
          {topBottomFloating && (
            <div className="relative">
              <button
                type="button"
                className={`taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center ${
                  drawerFloatingOpacity < 1 ? "text-[var(--taomni-accent)]" : ""
                }`}
                onClick={() => setShowOpacityMenu((v) => !v)}
                title={t("chat.drawerOpacityTitle", { value: Math.round(drawerFloatingOpacity * 100) })}
                aria-label={t("chat.drawerOpacityAria")}
                aria-pressed={showOpacityMenu}
                data-testid="ai-chat-drawer-opacity"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
              </button>
              {showOpacityMenu && (
                <div
                  className="absolute right-0 top-7 z-30 w-[180px] rounded border border-[var(--taomni-divider)] shadow-lg px-2 py-1.5"
                  style={{ background: "var(--taomni-panel-bg)" }}
                  data-testid="ai-chat-drawer-opacity-menu"
                >
                  <label
                    className="mb-1 flex items-center justify-between gap-2 text-[10px] text-[var(--taomni-text-muted)]"
                    htmlFor="ai-chat-drawer-opacity-slider"
                  >
                    <span>{t("chat.drawerOpacityLabel")}</span>
                    <span>{Math.round(drawerFloatingOpacity * 100)}%</span>
                  </label>
                  <input
                    id="ai-chat-drawer-opacity-slider"
                    type="range"
                    min={0.65}
                    max={1}
                    step={0.05}
                    value={drawerFloatingOpacity}
                    onChange={(event) => setDrawerFloatingOpacity(Number(event.currentTarget.value))}
                    aria-label={t("chat.drawerOpacityAria")}
                    className="w-full accent-[var(--taomni-accent)]"
                    data-testid="ai-chat-drawer-opacity-slider"
                  />
                </div>
              )}
            </div>
          )}
          {hubTab === "chat" && (
            <>
              <button
                type="button"
                className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
                onClick={copyAllToClipboard}
                disabled={!activeThreadId || activeMessages.length === 0}
                title={t("chat.copyAllTitle")}
                aria-label={t("chat.copyAllAria")}
              >
                {copiedAll ? (
                  <Check className="w-3.5 h-3.5 text-green-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
              <button
                type="button"
                className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
                onClick={handleNewThread}
                title={t("chat.newChatTitle")}
                aria-label={t("chat.newChatAria")}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                className={`taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center ${showHistory ? "bg-[var(--taomni-selected)]" : ""}`}
                onClick={() => setShowHistory((v) => !v)}
                title={t("chat.historyTitle")}
              >
                <History className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          <button
            type="button"
            className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
            onClick={hideDrawer}
            title={t("chat.drawerHideTitle")}
            aria-label={t("chat.drawerHideTitle")}
            data-testid="ai-chat-drawer-hide"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Tao Hub tab strip — one drawer, three tabs (Chat | 便签 | Notifications). */}
        <div
          className="flex items-stretch border-b border-[var(--taomni-divider)] shrink-0 text-[11px]"
          role="tablist"
          aria-label={t("tao.hubTitle")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={hubTab === "chat"}
            data-testid="tao-hub-tab-chat"
            className={`flex-1 h-7 inline-flex items-center justify-center gap-1 border-b-2 transition-colors ${
              hubTab === "chat"
                ? "border-[var(--taomni-accent)] text-[var(--taomni-accent)]"
                : "border-transparent text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
            }`}
            onClick={() => setHubTab("chat")}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>{t("tao.tabChat")}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={hubTab === "notes"}
            data-testid="tao-hub-tab-notes"
            className={`flex-1 h-7 inline-flex items-center justify-center gap-1 border-b-2 transition-colors ${
              hubTab === "notes"
                ? "border-[var(--taomni-accent)] text-[var(--taomni-accent)]"
                : "border-transparent text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
            }`}
            onClick={() => setHubTab("notes")}
          >
            <StickyNote className="w-3.5 h-3.5" />
            <span>{t("tao.tabNotes")}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={hubTab === "notifications"}
            data-testid="tao-hub-tab-notifications"
            className={`flex-1 h-7 inline-flex items-center justify-center gap-1 border-b-2 transition-colors ${
              hubTab === "notifications"
                ? "border-[var(--taomni-accent)] text-[var(--taomni-accent)]"
                : "border-transparent text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
            }`}
            onClick={() => setHubTab("notifications")}
          >
            <Bell className="w-3.5 h-3.5" />
            <span>{t("tao.tabNotifications")}</span>
            {alertBadgeCount > 0 && (
              <span
                className="min-w-[14px] h-[14px] px-1 rounded-full text-[8px] font-bold flex items-center justify-center bg-[var(--taomni-accent)] text-white"
                data-testid="tao-hub-notifications-badge"
              >
                {alertBadgeCount > 99 ? "99+" : alertBadgeCount}
              </span>
            )}
          </button>
        </div>

        {hubTab === "notifications" ? (
          <TaoAlertInbox
            alerts={taoAlerts}
            history={alertHistory}
            historyLimit={alertHistoryLimit}
            onJump={jumpToAlert}
            onAck={ackAlert}
            onHistoryLimitChange={setAlertHistoryLimit}
            onClearHistory={clearAlertHistory}
            embedded
          />
        ) : hubTab === "notes" ? (
          <NotesPanel />
        ) : (
        <>
        {/* History panel */}
        {showHistory && (
          <div className="h-48 shrink-0 border-b border-[var(--taomni-divider)] overflow-hidden">
            <ChatThreadList
              threads={visibleThreads}
              activeThreadId={activeThreadId}
              onSelect={(id) => { setActiveThread(id); setShowHistory(false); }}
              onNew={handleNewThread}
              onDelete={deleteThread}
            />
          </div>
        )}

        {/* Mode + provider switcher */}
        <div className="px-2 py-1 text-[10px] text-[var(--taomni-text-muted)] border-b border-[var(--taomni-divider)] shrink-0 flex items-center gap-1.5 flex-wrap">
          {/* Scope badge: every visible thread is bound to a concrete app tab. */}
          {activeThread?.linked_session_id && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--taomni-accent)]/10 text-[var(--taomni-accent)] border border-[var(--taomni-accent)]/30"
              title={t("chat.boundToTab", { id: activeThread.linked_session_id })}
            >
              <Link2 className="w-2.5 h-2.5" />
              <span className="truncate max-w-[100px]">
                {linkedTabTitle}
              </span>
            </span>
          )}
          <span>{t("chat.modeLabel")}</span>
          <div className="inline-flex h-5 overflow-hidden rounded border border-[var(--taomni-divider)]">
            {CHAT_THREAD_MODES.map((mode) => {
              const selected = currentMode === mode;
              const ModeIcon = modeIcon(mode);
              return (
                <button
                  key={mode}
                  type="button"
                  className={`h-full px-1.5 inline-flex items-center gap-1 border-r last:border-r-0 border-[var(--taomni-divider)] ${
                    selected
                      ? "bg-[var(--taomni-selected)] text-[var(--taomni-accent)]"
                      : "hover:bg-[var(--taomni-hover)]"
                  } disabled:opacity-40 disabled:hover:bg-transparent`}
                  onClick={() => void handleModeSelect(mode)}
                  disabled={!availableModes.has(mode)}
                  aria-pressed={selected}
                  aria-label={t("chat.threadModeAria", { mode: t(`chat.mode_${mode}`) })}
                  title={t(`chat.mode_${mode}`)}
                  data-testid={`chat-mode-${mode}`}
                >
                  <ModeIcon className="w-2.5 h-2.5" />
                  <span>{t(`chat.mode_${mode}`)}</span>
                </button>
              );
            })}
          </div>
          <span>{t("chat.providerLabel")}</span>
          {providerIds.length > 0 ? (
            <select
              className="taomni-input h-5 text-[10px] px-1 py-0 bg-transparent text-[var(--taomni-accent)]"
              value={selectedProviderId}
              aria-label={t("chat.threadProviderAria")}
              onChange={(e) => {
                const providerId = e.target.value;
                rememberProviderForMode(currentMode, providerId);
                setDraftProviderId(providerId);
                if (activeThread) {
                  void setThreadProvider(activeThread.id, providerId);
                }
              }}
            >
              {activeThread && selectedProviderId === "" && (
                <option value="" disabled>
                  {activeThread.provider_id}
                </option>
              )}
              {providerIds.map((id) => (
                <option key={id} value={id}>
                  {providerLabel(id, t, aiConfig)}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[var(--taomni-accent)]">
              {activeThread?.provider_id ?? t("chat.noProvider")}
            </span>
          )}
          {activeThread && (activeThread.provider_id === "claude-code" || activeThread.provider_id === "codex") && (
            <input
              className="taomni-input h-5 w-[150px] min-w-[120px] text-[10px] px-1 py-0 bg-transparent text-[var(--taomni-accent)] font-mono"
              value={ccModelDraft}
              aria-label={t("chat.threadModelAria")}
              title={t("chat.threadModelTitle")}
              spellCheck={false}
              onChange={(e) => setCcModelDraft(e.target.value)}
              onBlur={commitThreadCcModel}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  setCcModelDraft(activeThread.cc_model?.trim() || defaultLocalAgentModel);
                  e.currentTarget.blur();
                }
              }}
            />
          )}
          {activeThread && (activeThread.provider_id === "claude-code" || activeThread.provider_id === "codex") && activeThread.linked_session_id && (
            <button
              type="button"
              className={`taomni-btn h-5 px-1.5 inline-flex items-center gap-1 text-[10px] ${
                ccTerminalEchoEnabled
                  ? "text-[var(--taomni-accent)]"
                  : "text-[var(--taomni-text-muted)]"
              }`}
              onClick={() => setCcTerminalEcho(!ccTerminalEchoEnabled)}
              disabled={!aiConfig}
              title={t("chat.ccTerminalEchoTitle")}
              aria-pressed={ccTerminalEchoEnabled}
              aria-label={t("chat.ccTerminalEchoAria")}
              data-testid="chat-cc-terminal-echo-toggle"
            >
              <TerminalSquare className="w-2.5 h-2.5" />
              <span>{ccTerminalEchoEnabled ? t("chat.ccTerminalEchoOn") : t("chat.ccTerminalEchoOff")}</span>
            </button>
          )}
          {activeThread && activeThreadMode === "chat" && (
            <>
              <span className="ml-2">{t("chat.formatLabel")}</span>
              {formatLocked ? (
                // Locked once the thread has any messages — issue #3.
                <span
                  className="text-[var(--taomni-accent)] px-1"
                  title={t("chat.formatLockedTooltip")}
                >
                  {activeThread.output_format ?? t("chat.inheritFormat", { format: globalOutputFormat })}
                </span>
              ) : (
                <select
                  className="taomni-input h-5 text-[10px] px-1 py-0 bg-transparent text-[var(--taomni-accent)]"
                  value={activeThread.output_format ?? ""}
                  aria-label={t("chat.formatAria")}
                  title={t("chat.formatEffectiveTooltip", { format: effectiveFormat, global: globalOutputFormat })}
                  onChange={(e) => {
                    const v = e.target.value;
                    void setThreadOutputFormat(activeThread.id, v === "" ? null : v);
                  }}
                >
                  <option value="">{t("chat.inheritFormat", { format: globalOutputFormat })}</option>
                  <option value="md">{t("chat.formatMd")}</option>
                  <option value="html">{t("chat.formatHtml")}</option>
                  <option value="plain">{t("chat.formatPlainOption")}</option>
                </select>
              )}
              <button
                type="button"
                className="taomni-btn h-5 px-1.5 inline-flex items-center gap-1 text-[10px]"
                onClick={cycleRenderFormat}
                title={t("chat.convertCycleTitle", { format: effectiveFormat })}
                aria-label={t("chat.convertVisibleAria")}
              >
                <RefreshCw className="w-2.5 h-2.5" />
                <span>{t("chat.convertLabel", { format: effectiveFormat })}</span>
              </button>
            </>
          )}
          {activeThread && activeThreadMode === "chat" && isQueryThread && (
            <button
              type="button"
              className={`taomni-btn h-5 px-1.5 inline-flex items-center gap-1 text-[10px] ${
                sqlEcho
                  ? "text-[var(--taomni-accent)]"
                  : "text-[var(--taomni-text-muted)]"
              }`}
              onClick={() => setSqlEcho(!sqlEcho)}
              title={t("chat.sqlEchoTitle")}
              aria-pressed={sqlEcho}
              data-testid="chat-sql-echo-toggle"
            >
              <TerminalSquare className="w-2.5 h-2.5" />
              <span>{sqlEcho ? t("chat.sqlEchoOn") : t("chat.sqlEchoOff")}</span>
            </button>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
          {activeMessages.length === 0 && !sending && (
            <div className="text-[11px] text-[var(--taomni-text-muted)] text-center py-8">
              <Bot className="w-8 h-8 mx-auto mb-2 opacity-30" />
              {emptyHint}
            </div>
          )}
          {activeMessages.map((msg) => (
            <div key={msg.id}>
              <MessageBubble
                message={msg}
                format={effectiveFormat}
                preferredTerminalTabId={activeThread?.linked_session_id ?? null}
                preferredQueryTabId={activeThread?.linked_session_id ?? null}
              />
              {msg.role === "assistant" && <CcToolCards messageId={msg.id} />}
            </div>
          ))}
          {sending && (
            <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--taomni-text-muted)] p-1.5 border border-[var(--taomni-divider)] rounded bg-[var(--taomni-bg)]/50 shrink-0">
              <div className="flex items-center gap-2">
                <div className="flex gap-0.5">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="w-1.5 h-1.5 rounded-full bg-[var(--taomni-accent)] animate-bounce"
                      style={{ animationDelay: `${i * 150}ms` }}
                    />
                  ))}
                </div>
                <span>{sendingLabel}</span>
                {queuedSends.length > 0 && (
                  <span className="text-[10px] text-[var(--taomni-accent)]" data-testid="ai-chat-queue-badge">
                    {t("chat.queuedBadge", { count: queuedSends.length })}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="taomni-btn h-5 px-2 text-[10px] flex items-center gap-1 hover:text-red-400 border border-[var(--taomni-divider)] rounded hover:bg-[var(--taomni-hover)] transition-colors"
                // Stops this turn only — the queue keeps draining, so this is
                // "skip this answer" rather than "abandon everything".
                title={queuedSends.length > 0 ? t("chat.stopKeepsQueue") : undefined}
                onClick={() => {
                  if (activeThreadId) {
                    void stopSending(activeThreadId);
                  }
                }}
              >
                <span className="w-1.5 h-1.5 bg-red-500 rounded-sm" />
                <span>{t("common.stop") || "Stop"}</span>
              </button>
            </div>
          )}
          {error && (
            <div className="text-[11px] text-red-400 rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5">
              {error}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Composer */}
        <Composer
          key={composerDraftKey ?? "global"}
          draftKey={composerDraftKey}
          onSend={handleSend}
          sending={sending}
          disabled={false}
          queuedItems={queuedSends}
          queueLimit={MAX_QUEUED_SENDS}
          onRemoveQueued={(itemId) => {
            if (activeThreadId) dequeueSend(activeThreadId, itemId);
          }}
          attachmentsEnabled={attachmentsEnabled}
          placeholder={composerPlaceholder}
          // Use the active terminal registry when available — that's what
          // makes `@terminal:last-N` work even when the drawer is rendered
          // without a `terminalContext` prop (the production case).
          resolveTerminalContext={currentMode === "chat" ? resolveTerminalText : undefined}
        />
        </>
        )}
      </div>
    </div>
  );
}

export function ChatDrawerRibbon() {
  const t = useT();
  const drawerOpen = useChatStore((s) => s.drawerOpen);
  const drawerPosition = useChatStore((s) => s.drawerPosition);
  const drawerPinned = useChatStore((s) => s.drawerPinned);
  const ribbonOffsetRatio = useChatStore((s) => s.ribbonOffsetRatio);
  const openTabChat = useChatStore((s) => s.openTabChat);
  const setRibbonPlacement = useChatStore((s) => s.setRibbonPlacement);
  const setHubTab = useTaoHubStore((s) => s.setHubTab);
  const noteAlerts = useNotesStore((s) => s.alerts);
  const aiDoneAlerts = useTaoAlertStore((s) => s.aiDone);
  const mailNewAlerts = useTaoAlertStore((s) => s.mailNew);
  const recordAlertHistory = useTaoAlertStore((s) => s.recordHistory);
  const pruneMailTabs = useTaoAlertStore((s) => s.pruneMailTabs);
  const bumpRef = useRef(0);
  const [bumping, setBumping] = useState(false);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const dragRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number } | null>(null);
  const [signalIndex, setSignalIndex] = useState(0);

  useEffect(() => {
    return () => {
      if (hoverOpenTimerRef.current !== null) {
        window.clearTimeout(hoverOpenTimerRef.current);
      }
    };
  }, []);

  // Unified Tao alerts (notes due/overdue/reminder + chat ai_done + mail), priority-sorted.
  const taoAlerts = useMemo(
    () => buildTaoAlerts(noteAlerts, aiDoneAlerts, mailNewAlerts),
    [noteAlerts, aiDoneAlerts, mailNewAlerts],
  );
  const alertBadgeCount = useMemo(
    () => taoAlerts.reduce((sum, alert) => sum + (alert.count ?? 1), 0),
    [taoAlerts],
  );
  useEffect(() => {
    recordAlertHistory(taoAlerts);
  }, [recordAlertHistory, taoAlerts]);
  const ribbonSignals = useMemo(() => {
    const next: Array<"mail" | "notes" | "chat"> = [];
    for (const alert of taoAlerts) {
      const source = alert.source === "mail" ? "mail" : alert.source === "notes" ? "notes" : "chat";
      if (!next.includes(source)) next.push(source);
    }
    return next;
  }, [taoAlerts]);
  const ribbonSignalKey = ribbonSignals.join("|");
  useEffect(() => {
    pruneMailTabs(tabs.map((tab) => tab.id));
  }, [pruneMailTabs, tabs]);
  useEffect(() => {
    setSignalIndex(0);
    if (ribbonSignals.length <= 1) return;
    const id = window.setInterval(() => {
      setSignalIndex((current) => (current + 1) % ribbonSignals.length);
    }, 1400);
    return () => window.clearInterval(id);
  }, [ribbonSignalKey, ribbonSignals.length]);
  const activeSignal = ribbonSignals.length > 0
    ? ribbonSignals[signalIndex % ribbonSignals.length]
    : null;
  const RibbonSignalIcon = activeSignal === "mail"
    ? Mail
    : activeSignal === "notes"
      ? StickyNote
      : Bot;
  const hasAlerts = taoAlerts.length > 0;
  const hostTab = activeTab && isChatCapableTabType(activeTab.type)
    ? activeTab
    : tabs.find((tab) => isChatCapableTabType(tab.type)) ?? activeTab;
  const chatTabId = hostTab?.chatTabId ?? hostTab?.id ?? null;
  const hostTitle = hostTab?.title ?? activeTab?.title ?? "Taomni";
  const ribbonTitle = hasAlerts ? t("tao.alertInboxTitle") : t("chat.ribbonOpenTitle", { title: hostTitle });
  const ribbonAria = ribbonTitle;
  const badgeText = alertBadgeCount > 99 ? "99+" : String(alertBadgeCount);

  useEffect(
    () => {
      if (alertBadgeCount > bumpRef.current) {
        setBumping(true);
        const id = window.setTimeout(() => setBumping(false), 1200);
        bumpRef.current = alertBadgeCount;
        return () => window.clearTimeout(id);
      }
      bumpRef.current = alertBadgeCount;
    },
    [alertBadgeCount],
  );

  if (drawerOpen || !activeTab || !chatTabId || (!hasAlerts && !isChatCapableTabType(activeTab.type))) return null;

  const placementClass = ribbonPlacementClass(drawerPosition, hasAlerts);
  const textClass = ribbonTextClass(drawerPosition);
  const dragging = dragPreview !== null;
  const ribbonClass = dragging
    ? "fixed h-10 w-10 rounded-full border"
    : `absolute ${placementClass} border`;
  const ribbonStyle: CSSProperties = {
    background: "var(--taomni-tao-ribbon-bg)",
    borderColor: "var(--taomni-tao-ribbon-border)",
    boxShadow: "var(--taomni-tao-ribbon-shadow)",
    color: "var(--taomni-tao-ribbon-text)",
    touchAction: "none",
    ...(dragPreview
      ? {
          left: dragPreview.x,
          top: dragPreview.y,
          transform: "translate(-50%, -50%)",
        }
      : ribbonPositionStyle({ edge: drawerPosition, offsetRatio: ribbonOffsetRatio })),
  };

  // Alert glow: recolor the ribbon by highest-severity pending alert.
  const topKind = topAlertKind(taoAlerts);
  const colorBucket = alertColorBucket(topKind);
  const alertColor =
    colorBucket === "red"
      ? "#ef4444"
      : colorBucket === "amber"
        ? "#f59e0b"
        : colorBucket === "accent"
          ? "var(--taomni-accent)"
          : null;
  if (alertColor && !dragPreview) {
    ribbonStyle.borderColor = alertColor;
    ribbonStyle.boxShadow = `0 0 0 2px ${alertColor}66`;
  }
  const badgeBg =
    colorBucket === "red"
      ? "bg-red-500 text-white"
      : colorBucket === "amber"
        ? "bg-amber-400 text-black"
        : "bg-[var(--taomni-accent)] text-white";

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    if (hoverOpenTimerRef.current !== null) {
      window.clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    dragRef.current = { x: event.clientX, y: event.clientY, dragging: false };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Browser preview fallback.
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6) {
      drag.dragging = true;
      setDragPreview({ x: event.clientX, y: event.clientY });
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragPreview(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Browser preview fallback.
    }
    if (!drag?.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = true;
    const placement = placementFromPoint(
      event.clientX,
      event.clientY,
      window.innerWidth || 1,
      window.innerHeight || 1,
    );
    setRibbonPlacement(placement.edge, placement.offsetRatio);
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    dragRef.current = null;
    setDragPreview(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Browser preview fallback.
    }
  };

  const scheduleHoverOpen = () => {
    if (drawerPinned || hoverOpenTimerRef.current !== null || dragRef.current) return;
    const delay = drawerPosition === "top" || drawerPosition === "bottom"
      ? TOP_BOTTOM_RIBBON_HOVER_OPEN_DELAY_MS
      : SIDE_RIBBON_HOVER_OPEN_DELAY_MS;
    hoverOpenTimerRef.current = window.setTimeout(() => {
      hoverOpenTimerRef.current = null;
      if (!dragRef.current) {
        if (hasAlerts) setHubTab("notifications");
        void openTabChat(chatTabId);
      }
    }, delay);
  };

  const clearHoverOpen = () => {
    if (hoverOpenTimerRef.current === null) return;
    window.clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
  };

  return (
    <>
      <button
        type="button"
        data-testid="ai-chat-drawer-ribbon"
        data-position={drawerPosition}
        data-dragging={dragging || undefined}
        data-alert-count={alertBadgeCount || undefined}
        className={`${ribbonClass} z-40 flex items-center justify-center text-[9px] font-semibold tracking-normal shadow-lg transition-transform duration-150 hover:scale-105 cursor-grab active:cursor-grabbing ${bumping ? "animate-bounce" : ""}`}
        style={ribbonStyle}
        title={ribbonTitle}
        aria-label={ribbonAria}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onMouseEnter={scheduleHoverOpen}
        onMouseLeave={clearHoverOpen}
        onClick={(event) => {
          if (suppressClickRef.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (hasAlerts) {
            setHubTab("notifications");
            void openTabChat(chatTabId);
            return;
          }
          void openTabChat(chatTabId);
        }}
      >
        {hasAlerts ? (
          <RibbonSignalIcon className="w-4 h-4" data-testid="tao-ribbon-alert-icon" />
        ) : (
          <span className={textClass}>Tao</span>
        )}
        {hasAlerts && (
          <span
            className={`absolute -top-1 -right-1 min-w-[13px] h-[13px] px-1 rounded-full text-[8px] font-bold flex items-center justify-center ${badgeBg}`}
            data-testid="tao-ribbon-badge"
          >
            {badgeText}
          </span>
        )}
      </button>
    </>
  );
}

function capabilityForMode(mode: ChatThreadMode): LlmProviderCapability {
  if (mode === "image") return "image_generation";
  if (mode === "video") return "video_generation";
  return "chat";
}

function modeIcon(mode: ChatThreadMode) {
  if (mode === "image") return ImageIcon;
  if (mode === "video") return Video;
  return MessageSquare;
}

function providerLabel(id: string, t: TranslateFn, config?: AiConfig | null): string {
  if (id === "claude-code") return t("chat.claudeCodeLocal");
  if (id === "codex") return "Codex local";
  const acpProfileId = acpProfileIdFromProvider(id);
  if (acpProfileId) {
    const profile = config?.acp_bridge.profiles.find((candidate) => candidate.id === acpProfileId);
    return `${profile?.name || acpProfileId} (ACP)`;
  }
  const groupId = providerGroupIdFromRoute(id);
  if (groupId) {
    const label = config?.llm.provider_groups?.[groupId]?.label || groupId;
    return `Group: ${label}`;
  }
  return id;
}

function positionIcon(position: ChatDrawerPosition) {
  switch (position) {
    case "left":
      return PanelLeftOpen;
    case "right":
      return PanelRightOpen;
    case "top":
      return PanelTopOpen;
    case "bottom":
      return PanelBottomOpen;
  }
}

function ribbonPlacementClass(position: ChatDrawerPosition, alertMode = false): string {
  // Shape only (size / rounding / open border side); the position along the
  // edge is applied via inline style from ribbonPositionStyle().
  switch (position) {
    case "left":
      return alertMode ? "h-12 w-7 rounded-r-full border-l-0" : "h-10 w-5 rounded-r-full border-l-0";
    case "right":
      return alertMode ? "h-12 w-7 rounded-l-full border-r-0" : "h-10 w-5 rounded-l-full border-r-0";
    case "top":
      return alertMode ? "h-7 w-12 rounded-b-full border-t-0" : "h-5 w-10 rounded-b-full border-t-0";
    case "bottom":
      return alertMode ? "h-7 w-12 rounded-t-full border-b-0" : "h-5 w-10 rounded-t-full border-b-0";
  }
}

function ribbonTextClass(position: ChatDrawerPosition): string {
  switch (position) {
    case "left":
      return "-rotate-90 leading-none";
    case "right":
      return "rotate-90 leading-none";
    case "top":
    case "bottom":
      return "leading-none";
  }
}
