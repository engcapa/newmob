import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ListPlus, Loader2, Paperclip, Send, X } from "lucide-react";
import { useChatStore, type EnqueueResult, type QueuedSend } from "../../stores/chatStore";
import { parseComposerInput, type AttachmentRef } from "../../lib/chat/composerRefs";
import {
  CHAT_MAX_ATTACHMENT_BYTES,
  CHAT_MAX_ATTACHMENTS,
  formatAttachmentBytes,
  mergeChatAttachments,
  pickChatAttachmentPaths,
  readClipboardImageAttachments,
  statChatAttachmentPaths,
  type ChatAttachment,
} from "../../lib/chat/attachments";
import {
  droppedFilePaths,
  droppedFiles,
  isOsFileDrag,
  NATIVE_FILE_DROP_EVENT,
  type NativeFileDropDetail,
} from "../../lib/osFileDrop";
import { AttachmentChip } from "./AttachmentChip";
import {
  isChatSendKey,
  normalizeChatSendShortcut,
} from "../../lib/chat/sendShortcut";
import { useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";

interface ComposerProps {
  /**
   * Hands the message off. Returning an `EnqueueResult` lets the composer keep
   * the user's text when the send was refused (a full queue) instead of
   * clearing the box on a message that never went anywhere.
   */
  onSend: (
    content: string,
    terminalContext?: string,
    attachments?: ChatAttachment[],
  ) => Promise<EnqueueResult | void>;
  sending: boolean;
  disabled?: boolean;
  attachmentsEnabled?: boolean;
  placeholder?: string;
  draftKey?: string | null;
  /** Sends parked behind the in-flight turn, oldest first. */
  queuedItems?: QueuedSend[];
  /** Cap on parked sends. Omit to leave the queue affordances hidden. */
  queueLimit?: number;
  /** Drop one parked send. */
  onRemoveQueued?: (itemId: string) => void;
  /**
   * Optional resolver: turns AttachmentRefs into LLM-ready text before send.
   * Currently only `terminal` refs surface to the existing terminal_context
   * field — file/session refs are previewed as chips but not resolved on
   * the client (this PR keeps the round-trip surface small).
   */
  resolveTerminalContext?: (lines: number) => string | undefined;
}

const COMPOSER_HEIGHT_STORAGE_KEY = "taomni.chatComposer.height.v1";
const MIN_COMPOSER_HEIGHT = 56;
const MAX_COMPOSER_HEIGHT = 280;

export function Composer({
  onSend,
  sending,
  disabled,
  attachmentsEnabled = true,
  placeholder,
  draftKey,
  queuedItems,
  queueLimit,
  onRemoveQueued,
  resolveTerminalContext,
}: ComposerProps) {
  const t = useT();
  const sendShortcut = normalizeChatSendShortcut(
    useAiStore((s) => s.config?.chat_send_shortcut),
  );
  const sendShortcutLabel = sendShortcut === "enter"
    ? t("chat.shortcutEnter")
    : t("chat.shortcutCtrlEnter");
  const initialDraft = draftKey ? useChatStore.getState().composerDrafts[draftKey] : undefined;
  const [text, setText] = useState(() => initialDraft?.text ?? "");
  const [selectedAttachments, setSelectedAttachments] = useState<ChatAttachment[]>(
    () => initialDraft?.selectedAttachments ?? [],
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [composerHeight, setComposerHeight] = useState(readComposerHeight);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pending = useChatStore((s) => s.pendingComposerText);
  const consumePending = useChatStore((s) => s.consumePendingComposerText);
  const setComposerDraft = useChatStore((s) => s.setComposerDraft);
  const clearComposerDraft = useChatStore((s) => s.clearComposerDraft);
  const draftDisabled = disabled === true;

  useEffect(() => {
    if (!draftKey) return;
    if (text.length > 0 || selectedAttachments.length > 0) {
      setComposerDraft(draftKey, { text, selectedAttachments });
    } else {
      clearComposerDraft(draftKey);
    }
  }, [clearComposerDraft, draftKey, selectedAttachments, setComposerDraft, text]);

  // Pick up text staged by the SelectionToolbar's "Send to AI".
  useEffect(() => {
    if (pending && pending.length > 0) {
      setText((cur) => (cur ? `${cur}\n\n${pending}` : pending));
      consumePending();
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [pending, consumePending]);

  // Queue affordances stay hidden until a host opts in by passing a limit, so
  // composers rendered outside the drawer keep their previous behaviour.
  const queue = queuedItems ?? [];
  const queueDepth = queue.length;
  const queueEnabled = typeof queueLimit === "number" && queueLimit > 0;
  const queueFull = queueEnabled && queueDepth >= queueLimit;
  /** A send right now would park rather than go out immediately. */
  const willQueue = queueEnabled && sending && !queueFull;

  // Live parse @-references so we can show chips and remove them.
  const parsed = useMemo(() => parseComposerInput(text), [text]);
  const referenceAttachments: AttachmentRef[] = attachmentsEnabled ? parsed.attachments : [];
  const sessionRefText = useMemo(
    () => referenceAttachments.filter((att) => att.kind === "session").map(refToToken).join(" "),
    [referenceAttachments],
  );
  const visibleMessage = useMemo(
    () => [parsed.message, sessionRefText].filter(Boolean).join(" ").trim(),
    [parsed.message, sessionRefText],
  );

  const showMergeError = useCallback((error: "too_many" | "too_large" | null) => {
    if (!error) {
      setAttachmentError(null);
      return;
    }
    if (error === "too_many") {
      setAttachmentError(t("attachment.tooMany", { max: CHAT_MAX_ATTACHMENTS }));
    } else {
      setAttachmentError(t("attachment.tooLarge", { max: formatAttachmentBytes(CHAT_MAX_ATTACHMENT_BYTES) }));
    }
  }, [t]);

  const addResolvedAttachments = useCallback((incoming: ChatAttachment[]) => {
    if (!attachmentsEnabled || draftDisabled) return;
    if (incoming.length === 0) return;
    setSelectedAttachments((current) => {
      const result = mergeChatAttachments(current, incoming);
      showMergeError(result.error);
      return result.attachments;
    });
  }, [attachmentsEnabled, draftDisabled, showMergeError]);

  const addAttachmentPaths = useCallback(async (paths: string[]) => {
    if (!attachmentsEnabled || draftDisabled) return;
    if (paths.length === 0) return;
    try {
      const incoming = await statChatAttachmentPaths(paths);
      addResolvedAttachments(incoming);
    } catch (e) {
      setAttachmentError(String(e));
    }
  }, [addResolvedAttachments, attachmentsEnabled, draftDisabled]);

  useEffect(() => {
    if (attachmentsEnabled) return;
    setSelectedAttachments([]);
    setAttachmentError(null);
    setDraggingFiles(false);
  }, [attachmentsEnabled]);

  useEffect(() => {
    const handleNativeFileDrop = (event: Event) => {
      if (!attachmentsEnabled || draftDisabled) return;
      const detail = (event as CustomEvent<NativeFileDropDetail>).detail;
      if (!detail?.paths?.length) return;
      const root = rootRef.current;
      const target = document.elementFromPoint(detail.clientX, detail.clientY);
      if (!root || !target || !root.contains(target)) return;
      setDraggingFiles(false);
      void addAttachmentPaths(detail.paths);
      textareaRef.current?.focus();
    };

    window.addEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
    return () => window.removeEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
  }, [addAttachmentPaths, attachmentsEnabled, draftDisabled]);

  const handleRemove = (index: number) => {
    // Reconstruct text by stripping the n-th @-token. Simple: re-build from
    // the parsed message + remaining attachments rendered as their original
    // tokens. We don't try to preserve exact whitespace.
    const remaining = referenceAttachments.filter((_, i) => i !== index);
    const tokens = remaining.map(refToToken).join(" ");
    setText(tokens ? `${parsed.message} ${tokens}`.trim() : parsed.message);
  };

  const removeSelectedAttachment = (id: string) => {
    setSelectedAttachments((current) => current.filter((att) => att.id !== id));
    setAttachmentError(null);
  };

  const handleSend = async () => {
    // Mirrors the send button's disabled condition — the keyboard path must
    // block on exactly the same rules. A mid-turn send is queued rather than
    // dropped, but only where the host opted into a queue; without one,
    // `sending` still blocks as it always did.
    if (draftDisabled || queueFull || (!queueEnabled && sending)) return;

    // Resolve terminal references to terminal_context. Multiple @terminal
    // refs are merged; we take the largest line count.
    let terminalCtx: string | undefined;
    if (attachmentsEnabled && resolveTerminalContext) {
      const maxLines = referenceAttachments
        .filter((a) => a.kind === "terminal")
        .reduce((m, a) => (a.kind === "terminal" ? Math.max(m, a.lines) : m), 0);
      if (maxLines > 0) {
        terminalCtx = resolveTerminalContext(maxLines);
      }
    }

    const fileRefs = attachmentsEnabled
      ? referenceAttachments
          .filter((att): att is Extract<AttachmentRef, { kind: "file" }> => att.kind === "file")
          .map((att) => att.path)
      : [];
    let sendAttachments = attachmentsEnabled ? selectedAttachments : [];
    if (fileRefs.length > 0) {
      try {
        const refs = await statChatAttachmentPaths(fileRefs);
        const result = mergeChatAttachments(sendAttachments, refs);
        if (result.error) {
          showMergeError(result.error);
          return;
        }
        sendAttachments = result.attachments;
      } catch (e) {
        setAttachmentError(String(e));
        return;
      }
    }

    const content = visibleMessage
      || (sendAttachments.length > 0 ? t("chat.attachmentOnlyPrompt") : "")
      || (terminalCtx ? t("chat.contextOnlyPrompt") : "");
    if (!content.trim()) return;

    // Clear optimistically so the box is ready for the next message, then put
    // the text back if the send was refused — the alternative (awaiting first)
    // leaves the sent text sitting in the box for the whole round trip.
    setText("");
    setSelectedAttachments([]);
    setAttachmentError(null);
    const result = await onSend(content, terminalCtx, sendAttachments);
    if (result?.status === "rejected") {
      setText(content);
      setSelectedAttachments(sendAttachments);
      setAttachmentError(t("chat.queueFull", { limit: result.limit }));
    }
    textareaRef.current?.focus();
  };

  const handlePickFiles = async () => {
    if (!attachmentsEnabled || draftDisabled) return;
    const paths = await pickChatAttachmentPaths();
    await addAttachmentPaths(paths);
    textareaRef.current?.focus();
  };

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!attachmentsEnabled || draftDisabled) return;
    if (!isOsFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingFiles(true);
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!attachmentsEnabled || draftDisabled) return;
    if (!isOsFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    setDraggingFiles(false);
    const paths = droppedFilePaths(event.dataTransfer);
    if (paths.length > 0) {
      void addAttachmentPaths(paths);
      return;
    }
    if (droppedFiles(event.dataTransfer).length > 0) {
      setAttachmentError(t("attachment.pathRequired"));
    }
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachmentsEnabled || draftDisabled) return;
    const imageBlobs = clipboardImageBlobs(event.clipboardData);
    if (imageBlobs.length === 0) return;
    event.preventDefault();
    void (async () => {
      try {
        const incoming = await readClipboardImageAttachments(imageBlobs);
        addResolvedAttachments(incoming);
      } catch (e) {
        setAttachmentError(String(e));
      }
      textareaRef.current?.focus();
    })();
  };

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = composerHeight;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Browser preview fallback.
    }
    const onMove = (ev: PointerEvent) => {
      const next = clampComposerHeight(startHeight - (ev.clientY - startY));
      setComposerHeight(next);
      writeComposerHeight(next);
    };
    const onUp = () => {
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

  const canSend = visibleMessage.length > 0
    || (attachmentsEnabled && selectedAttachments.length > 0)
    || (attachmentsEnabled && referenceAttachments.some((att) => att.kind === "file" || att.kind === "terminal"));

  const sendButtonTitle = queueFull
    ? t("chat.queueFull", { limit: queueDepth })
    : willQueue
      ? t("chat.willQueue", { position: queueDepth + 1 })
      : t("chat.sendShortcutTitle", { shortcut: sendShortcutLabel });

  return (
    <div
      ref={rootRef}
      className="relative border-t border-[var(--taomni-divider)] p-2"
      style={{ background: draggingFiles ? "var(--taomni-selected)" : "var(--taomni-panel-bg)" }}
      data-testid="ai-chat-composer"
      onDragOver={handleDragOver}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDraggingFiles(false);
      }}
      onDrop={handleDrop}
    >
      <div
        className="absolute top-0 left-0 right-0 h-2 cursor-row-resize bg-transparent hover:bg-[var(--taomni-accent)]/25 transition-colors"
        title={t("attachment.resizeComposer")}
        data-testid="ai-chat-composer-resize"
        onPointerDown={handleResizeStart}
      />
      {(selectedAttachments.length > 0 || referenceAttachments.length > 0) && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {selectedAttachments.map((att) => (
            <AttachmentChip key={att.id} attachment={att} onRemove={() => removeSelectedAttachment(att.id)} />
          ))}
          {referenceAttachments.map((att, i) => (
            <AttachmentChip key={i} attachment={att} onRemove={() => handleRemove(i)} />
          ))}
        </div>
      )}
      {attachmentError && (
        <div className="mb-1.5 text-[10px] text-red-400" data-testid="ai-chat-attachment-error">
          {attachmentError}
        </div>
      )}
      {queueDepth > 0 && (
        <div className="mb-1.5 space-y-1" data-testid="ai-chat-queue">
          <div className="text-[10px] text-[var(--taomni-text-muted)]">
            {t("chat.queuedHint", { count: queueDepth, limit: queueLimit ?? queueDepth })}
          </div>
          {queue.map((item, index) => (
            <div
              key={item.id}
              className="flex items-center gap-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]/50 px-1.5 py-1"
              data-testid="ai-chat-queue-item"
            >
              <span className="shrink-0 text-[10px] text-[var(--taomni-accent)]">{index + 1}</span>
              <span className="flex-1 truncate text-[10px] text-[var(--taomni-text-muted)]" title={item.content}>
                {item.content.replace(/\s+/g, " ").trim()}
              </span>
              {onRemoveQueued && (
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] hover:text-red-400"
                  onClick={() => onRemoveQueued(item.id)}
                  title={t("chat.queuedRemove")}
                  aria-label={t("chat.queuedRemove")}
                  data-testid="ai-chat-queue-remove"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 items-end">
        {attachmentsEnabled && (
          <button
            type="button"
            className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center shrink-0"
            onClick={() => void handlePickFiles()}
            disabled={draftDisabled}
            title={t("attachment.addFiles")}
            aria-label={t("attachment.addFiles")}
            data-testid="ai-chat-attach-button"
          >
            <Paperclip className="w-3.5 h-3.5" />
          </button>
        )}
        <textarea
          ref={textareaRef}
          className="taomni-input flex-1 text-[12px] resize-none py-1.5"
          placeholder={placeholder ?? t("chat.inputPlaceholder", { shortcut: sendShortcutLabel })}
          value={text}
          disabled={draftDisabled}
          style={{ height: composerHeight, minHeight: MIN_COMPOSER_HEIGHT, maxHeight: MAX_COMPOSER_HEIGHT }}
          onChange={(e) => setText(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (isChatSendKey({
              key: e.key,
              ctrlKey: e.ctrlKey,
              metaKey: e.metaKey,
              shiftKey: e.shiftKey,
              isComposing: e.nativeEvent.isComposing,
              keyCode: e.nativeEvent.keyCode,
            }, sendShortcut)) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <button
          type="button"
          className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center shrink-0"
          onClick={handleSend}
          // Stays enabled mid-turn so the next message can be queued; only a
          // full queue (or a queue-less host, where `sending` still blocks)
          // disables it.
          disabled={!canSend || draftDisabled || queueFull || (!queueEnabled && sending)}
          title={sendButtonTitle}
          data-testid="ai-chat-send-button"
        >
          {willQueue ? (
            <ListPlus className="w-3.5 h-3.5" />
          ) : sending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Send className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

function clipboardImageBlobs(data: DataTransfer): Blob[] {
  const blobs: Blob[] = [];
  const seen = new Set<File>();
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    const mime = item.type || file?.type || "";
    if (!file || !mime.startsWith("image/") || seen.has(file)) continue;
    seen.add(file);
    blobs.push(file);
  }
  for (const file of Array.from(data.files ?? [])) {
    if (!file.type.startsWith("image/") || seen.has(file)) continue;
    seen.add(file);
    blobs.push(file);
  }
  return blobs;
}

function refToToken(ref: AttachmentRef): string {
  if (ref.kind === "terminal") return `@terminal:last-${ref.lines}`;
  if (ref.kind === "file") return `@file:${ref.path}`;
  return `@session:${ref.query}`;
}

function readComposerHeight(): number {
  if (typeof window === "undefined") return MIN_COMPOSER_HEIGHT;
  const raw = window.localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY);
  return clampComposerHeight(Number(raw) || MIN_COMPOSER_HEIGHT);
}

function writeComposerHeight(height: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(clampComposerHeight(height)));
  } catch {
    // Best-effort UI preference persistence.
  }
}

function clampComposerHeight(height: number): number {
  const viewportMax =
    typeof window === "undefined"
      ? MAX_COMPOSER_HEIGHT
      : Math.min(MAX_COMPOSER_HEIGHT, Math.max(MIN_COMPOSER_HEIGHT, Math.round(window.innerHeight * 0.45)));
  return Math.max(MIN_COMPOSER_HEIGHT, Math.min(viewportMax, Math.round(height)));
}
