import { useEffect, useRef, useCallback, useState } from "react";
import {
  vncConnect,
  vncDisconnect,
  encodeWsAck,
  encodeWsKey,
  encodeWsPing,
  encodeWsPointer,
  normalizeVncError,
  parseFrameBatch,
  parseWsMessage,
  keyEventToKeysym,
  mouseButtonMask,
  clientPointToFramebuffer,
  codePointToKeysym,
  iterCodePoints,
  pasteModifierKeysyms,
  shouldAutoReconnect,
  vncReconnectDelayMs,
} from "../../lib/vnc";
import type { VncError, VncFrameBatch, WsOutgoing } from "../../lib/vnc";
import type { NetworkSettingsPayload } from "../../lib/networkSettings";
import {
  DEFAULT_VNC_OPTIONS,
  vncClipboardReceives,
  vncClipboardSends,
  type VncOptions,
} from "../../types/vnc";
import { useVncStore } from "../../stores/vncStore";
import { useAppStore } from "../../stores/appStore";
import { ExternalLink, Maximize, Maximize2, Minimize, Minimize2, RefreshCw } from "lucide-react";
import { useCaptureStore, type CaptureSource } from "../../stores/captureStore";
import { CaptureMenuButton } from "../capture/CaptureMenuButton";
import { TabActions } from "../tabbar/TabActionSlot";
import {
  FT_BUTTON_STYLE,
  FT_ICON_BUTTON_STYLE,
  FT_SEPARATOR_STYLE,
} from "../floating-toolbar/floatingToolbarStyles";
import { captureCanvasPng } from "../../lib/capture";
import {
  readText as readClipboardText,
  readMultiFormat,
  writeMultiFormat,
  writeText as writeClipboardText,
} from "../../lib/clipboard";
import { useT, t as tr } from "../../lib/i18n";

export interface VncPanelProps {
  tabId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  options?: VncOptions;
  networkSettingsJson?: string | null;
  visible: boolean;
  onDetach?: () => void;
  detachedWindowControls?: {
    onReattach: () => void;
    onToggleOsFullscreen: () => void;
    osFullscreen: boolean;
  };
}

type ScaleMode = "fit" | "one";
const PASTE_KEY_DELAY_MS = 120;
const CLIPBOARD_SYNC_INTERVAL_MS = 2_000;
const CLIPBOARD_SYNC_MIN_INTERVAL_MS = 250;
type PointerState = {
  x: number;
  y: number;
  buttons: number;
};
type DelayedPointerDown = {
  pointerId: number;
  down: PointerState;
  up: PointerState | null;
};

function modifierKeysymFromKey(key: string, location: number): number | null {
  const right = location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT;
  switch (key) {
    case "Shift":
      return right ? 0xffe2 : 0xffe1;
    case "Control":
      return right ? 0xffe4 : 0xffe3;
    case "Alt":
      return right ? 0xffea : 0xffe9;
    case "Meta":
      return right ? 0xffec : 0xffeb;
    default:
      return null;
  }
}

function isPasteShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V");
}

export default function VncPanel({
  tabId,
  host,
  port,
  username,
  password,
  options = DEFAULT_VNC_OPTIONS,
  networkSettingsJson = null,
  visible,
  onDetach,
  detachedWindowControls,
}: VncPanelProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imeInputRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const frameBufferRef = useRef<VncFrameBatch[]>([]);
  const rafRef = useRef<number>(0);
  const destroyedRef = useRef(false);
  const disconnectedByServerRef = useRef(false);
  const connectArgsRef = useRef({ host, port, username, password, options, networkSettingsJson });
  const heartbeatTimerRef = useRef<number | null>(null);
  const visibleRef = useRef(visible);
  const ackPendingRef = useRef(false);
  const lastRenderedFrameRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const pressedKeysymsRef = useRef(new Set<number>());
  const composingRef = useRef(false);
  const pasteDelayTimerRef = useRef<number | null>(null);
  const pointerRafRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<PointerState | null>(null);
  const lastPointerSentRef = useRef<PointerState | null>(null);
  const delayedPointerDownRef = useRef<DelayedPointerDown | null>(null);
  const clipboardSyncPromiseRef = useRef<Promise<void> | null>(null);
  const serverClipboardWriteInFlightRef = useRef(0);
  const lastClipboardSyncCheckAtRef = useRef(0);
  const lastSyncedLocalClipboardTextRef = useRef<string | null>(null);
  const pasteInFlightRef = useRef<{
    pasteKeysym: number;
    heldModifiers: Set<number>;
    deferredKeyUps: Set<number>;
  } | null>(null);
  // Tracks whether the connected server negotiated the ExtendedClipboard
  // pseudo-encoding. Stored as a ref so input handlers read the latest value
  // without re-binding.
  const extClipboardSupportedRef = useRef<boolean>(false);
  const doConnectRef = useRef<() => void>(() => {});
  const [scaleMode, setScaleMode] = useState<ScaleMode>("fit");
  const [securityLabel, setSecurityLabel] = useState("");

  const store = useVncStore();
  const conn = store.connections[tabId];

  const sendWs = useCallback((msg: WsOutgoing) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const sendWsBinary = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  const syncLocalClipboardToServer = useCallback(
    (reason: string, force = false): Promise<void> => {
      if (!vncClipboardSends(options.clipboardPolicy) || options.viewOnly) {
        return Promise.resolve();
      }
      if (destroyedRef.current || wsRef.current?.readyState !== WebSocket.OPEN) {
        return Promise.resolve();
      }
      if (serverClipboardWriteInFlightRef.current > 0) {
        return Promise.resolve();
      }

      const now = Date.now();
      if (!force && now - lastClipboardSyncCheckAtRef.current < CLIPBOARD_SYNC_MIN_INTERVAL_MS) {
        return Promise.resolve();
      }
      lastClipboardSyncCheckAtRef.current = now;

      if (clipboardSyncPromiseRef.current) {
        return clipboardSyncPromiseRef.current;
      }

      const sync = (async () => {
        let text = "";
        try {
          text = await readClipboardText();
        } catch (err) {
          console.warn(`[vnc.clip] read local clipboard for ${reason} sync failed:`, err);
          return;
        }
        if (serverClipboardWriteInFlightRef.current > 0) {
          return;
        }

        // Avoid clearing the remote clipboard just because the local clipboard
        // is temporarily empty or unreadable.
        if (!text || text === lastSyncedLocalClipboardTextRef.current) {
          return;
        }
        // Non-ASCII text is sent even when the server lacks ExtendedClipboard:
        // the relay will fall back to UTF-8 legacy ClientCutText, which vino
        // and most modern servers accept despite RFC 6143 specifying Latin-1.
        lastSyncedLocalClipboardTextRef.current = text;
        sendWs({ type: "ext_clipboard", text });
      })();

      const tracked = sync.finally(() => {
        if (clipboardSyncPromiseRef.current === tracked) {
          clipboardSyncPromiseRef.current = null;
        }
      });
      clipboardSyncPromiseRef.current = tracked;
      return clipboardSyncPromiseRef.current;
    },
    [options.clipboardPolicy, options.viewOnly, sendWs],
  );

  const releaseInputState = useCallback(() => {
    for (const keysym of pressedKeysymsRef.current) {
      sendWsBinary(encodeWsKey(false, keysym));
    }
    pressedKeysymsRef.current.clear();
    const pointer = lastPointerSentRef.current;
    if (pointer?.buttons) {
      sendWsBinary(encodeWsPointer(pointer.x, pointer.y, 0));
      lastPointerSentRef.current = { ...pointer, buttons: 0 };
    }
    pendingPointerRef.current = null;
    delayedPointerDownRef.current = null;
    pasteInFlightRef.current = null;
  }, [sendWsBinary]);

  // ── connect logic, callable for retry ─────────────────────────────
  const doConnect = useCallback(() => {
    const {
      host: h,
      port: p,
      username: user,
      password: pw,
      options: connectOptions,
      networkSettingsJson: networkJson,
    } = connectArgsRef.current;
    destroyedRef.current = false;
    frameBufferRef.current = [];
    ackPendingRef.current = false;
    lastRenderedFrameRef.current = 0;
    extClipboardSupportedRef.current = false;
    setSecurityLabel("");
    store.initConnection(tabId);

    let cancelled = false;
    disconnectedByServerRef.current = false;

    const handleConnectionFailure = (error: VncError) => {
      releaseInputState();
      frameBufferRef.current = [];
      ackPendingRef.current = false;
      lastRenderedFrameRef.current = 0;
      store.setDisconnected(tabId, error.sanitizedMessage);
      if (
        !shouldAutoReconnect(
          error,
          connectOptions.autoReconnect,
          reconnectAttemptsRef.current,
          connectOptions.reconnectMaxAttempts,
        ) ||
        reconnectTimerRef.current !== null
      ) {
        return;
      }
      const attempt = reconnectAttemptsRef.current;
      reconnectAttemptsRef.current += 1;
      const delay = vncReconnectDelayMs(attempt);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (destroyedRef.current) return;
        releaseInputState();
        const sessionId = sessionIdRef.current;
        sessionIdRef.current = null;
        if (sessionId) vncDisconnect(sessionId).catch(() => {});
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
        doConnectRef.current();
      }, delay);
    };

    (async () => {
      try {
        let networkSettings: NetworkSettingsPayload | null = null;
        if (networkJson) {
          try {
            networkSettings = JSON.parse(networkJson) as NetworkSettingsPayload;
          } catch {
            throw new Error("Invalid VNC network settings");
          }
        }
        const result = await vncConnect(h, p, user, pw, connectOptions, networkSettings);
        if (cancelled || destroyedRef.current) {
          vncDisconnect(result.session_id).catch(() => {});
          return;
        }

        sessionIdRef.current = result.session_id;
        store.setConnecting(tabId, result.session_id, result.ws_port);

        const ws = new WebSocket(
          `ws://127.0.0.1:${result.ws_port}/vnc`,
          `taomni-vnc.${result.ws_token}`,
        );
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onopen = () => {
          if (heartbeatTimerRef.current !== null) {
            window.clearInterval(heartbeatTimerRef.current);
          }
          // Ping every 15s; the backend tears the session down after 30s of silence.
          heartbeatTimerRef.current = window.setInterval(() => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(encodeWsPing());
            }
          }, 15000);
        };

        ws.onmessage = (event) => {
          if (destroyedRef.current) return;
          if (event.data instanceof ArrayBuffer) {
            const batch = parseFrameBatch(event.data);
            if (!batch) {
              disconnectedByServerRef.current = true;
              handleConnectionFailure({
                code: "VNC_RELAY_PROTOCOL",
                stage: "relay",
                retryable: false,
                sanitizedMessage: "Invalid VNC relay frame",
              });
              ws.close(1002, "invalid relay frame");
              return;
            }
            frameBufferRef.current.push(batch);
            ackPendingRef.current = true;
          } else {
            const msg = parseWsMessage(event.data as string);
            if (!msg) return;
            switch (msg.type) {
              case "connected":
                reconnectAttemptsRef.current = 0;
                setSecurityLabel(
                  `${msg.protocol_version} / ${msg.security_type}${msg.encrypted ? " / encrypted" : ""}`,
                );
                store.setConnected(tabId, msg.width, msg.height, msg.name);
                break;
              case "disconnected":
                disconnectedByServerRef.current = true;
                handleConnectionFailure(normalizeVncError(msg));
                ws.close(1011, "VNC session ended");
                break;
              case "clipboard":
                if (!vncClipboardReceives(connectOptions.clipboardPolicy)) break;
                serverClipboardWriteInFlightRef.current += 1;
                writeClipboardText(msg.text)
                  .then(() => {
                    lastSyncedLocalClipboardTextRef.current = msg.text;
                  })
                  .catch(() => {})
                  .finally(() => {
                    serverClipboardWriteInFlightRef.current = Math.max(
                      0,
                      serverClipboardWriteInFlightRef.current - 1,
                    );
                  });
                break;
              case "ext_clipboard":
                if (!vncClipboardReceives(connectOptions.clipboardPolicy)) break;
                serverClipboardWriteInFlightRef.current += 1;
                writeMultiFormat({
                  text: msg.text ?? "",
                  html:
                    !connectOptions.clipboardTextOnly && connectOptions.allowHtmlClipboard
                      ? msg.html
                      : undefined,
                  rtf:
                    !connectOptions.clipboardTextOnly && connectOptions.allowRtfClipboard
                      ? msg.rtf
                      : undefined,
                })
                  .then(() => {
                    if (msg.text !== undefined) {
                      lastSyncedLocalClipboardTextRef.current = msg.text;
                    }
                  })
                  .catch(() => {})
                  .finally(() => {
                    serverClipboardWriteInFlightRef.current = Math.max(
                      0,
                      serverClipboardWriteInFlightRef.current - 1,
                    );
                  });
                break;
              case "ext_clipboard_support":
                extClipboardSupportedRef.current = msg.available;
                break;
            }
          }
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (heartbeatTimerRef.current !== null) {
            window.clearInterval(heartbeatTimerRef.current);
            heartbeatTimerRef.current = null;
          }
          if (!destroyedRef.current && !disconnectedByServerRef.current) {
            handleConnectionFailure({
              code: "VNC_WEBSOCKET_CLOSED",
              stage: "relay",
              retryable: true,
              sanitizedMessage: tr("vnc.closedConnection"),
            });
          }
        };

        ws.onerror = () => {
          if (!destroyedRef.current && !disconnectedByServerRef.current) {
            store.setDisconnected(tabId, tr("vnc.websocketError"));
          }
        };
      } catch (err) {
        if (!cancelled && !destroyedRef.current) {
          const normalized = normalizeVncError(err);
          handleConnectionFailure(normalized);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [releaseInputState, tabId, store]);
  doConnectRef.current = doConnect;

  // ── Mount / unmount ───────────────────────────────────────────────
  useEffect(() => {
    connectArgsRef.current = { host, port, username, password, options, networkSettingsJson };
    let cancel: (() => void) | undefined;
    const connectTimer = window.setTimeout(() => {
      cancel = doConnect();
    }, 0);

    return () => {
      window.clearTimeout(connectTimer);
      cancel?.();
      destroyedRef.current = true;
      releaseInputState();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      frameBufferRef.current = [];
      if (heartbeatTimerRef.current !== null) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pasteDelayTimerRef.current !== null) {
        window.clearTimeout(pasteDelayTimerRef.current);
        pasteDelayTimerRef.current = null;
      }
      ackPendingRef.current = false;
      lastRenderedFrameRef.current = 0;
      composingRef.current = false;
      if (pointerRafRef.current !== null) {
        cancelAnimationFrame(pointerRafRef.current);
        pointerRafRef.current = null;
      }
      pendingPointerRef.current = null;
      lastPointerSentRef.current = null;
      delayedPointerDownRef.current = null;
      pasteInFlightRef.current = null;
      extClipboardSupportedRef.current = false;
      clipboardSyncPromiseRef.current = null;
      serverClipboardWriteInFlightRef.current = 0;
      lastClipboardSyncCheckAtRef.current = 0;
      lastSyncedLocalClipboardTextRef.current = null;
      const sid = sessionIdRef.current;
      if (sid) {
        vncDisconnect(sid).catch(() => {});
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      store.removeConnection(tabId);
    };
  }, []);

  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) releaseInputState();
  }, [releaseInputState, visible]);

  useEffect(() => {
    const release = () => releaseInputState();
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") release();
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [releaseInputState]);

  useEffect(() => {
    if (
      !visible ||
      conn?.status !== "connected" ||
      !vncClipboardSends(options.clipboardPolicy) ||
      options.viewOnly
    ) return;
    void syncLocalClipboardToServer("connect", true);
    const timer = window.setInterval(() => {
      void syncLocalClipboardToServer("poll");
    }, CLIPBOARD_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [visible, conn?.status, options.clipboardPolicy, options.viewOnly, syncLocalClipboardToServer]);

  // ── Canvas rendering loop ────────────────────────────────────────
  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;
    const render = () => {
      if (!running || destroyedRef.current) return;

      const frames = frameBufferRef.current;
      if (frames.length > 0) {
        const pending = frames.splice(0, frames.length);
        let renderedFrameId = 0;

        for (const batch of pending) {
          if (canvas.width !== batch.width || canvas.height !== batch.height) {
            canvas.width = batch.width;
            canvas.height = batch.height;
            store.setConnected(tabId, batch.width, batch.height, conn.name);
          }
          let batchRendered = true;
          for (const rect of batch.rects) {
            try {
              ctx.putImageData(new ImageData(rect.rgba, rect.w, rect.h), rect.x, rect.y);
            } catch {
              batchRendered = false;
              break;
            }
          }
          if (batchRendered) {
            renderedFrameId = batch.frameId;
          }
        }
        if (renderedFrameId > lastRenderedFrameRef.current) {
          lastRenderedFrameRef.current = renderedFrameId;
          ackPendingRef.current = false;
          sendWsBinary(encodeWsAck(renderedFrameId));
        }
      }

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [visible, conn?.status, conn?.name, sendWsBinary, store, tabId]);

  // ── Keyboard ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible || conn?.status !== "connected" || options.viewOnly) return;

    const readLocalClipboard = async (): Promise<{
      text: string;
      html?: string;
      rtf?: string;
    } | null> => {
      try {
        const data = await readMultiFormat();
        if (!data.text && !data.html && !data.rtf) return null;
        return { text: data.text || "", html: data.html, rtf: data.rtf };
      } catch (err) {
        console.warn("[vnc.clip] read local clipboard failed:", err);
        return null;
      }
    };

    const sendExtClipboardToRelay = (data: {
      text: string;
      html?: string;
      rtf?: string;
    }) => {
      if (!vncClipboardSends(options.clipboardPolicy)) return;
      sendWs({
        type: "ext_clipboard",
        text: data.text || undefined,
        html:
          !options.clipboardTextOnly && options.allowHtmlClipboard ? data.html : undefined,
        rtf: !options.clipboardTextOnly && options.allowRtfClipboard ? data.rtf : undefined,
      });
    };

    /**
     * When the user presses Ctrl+V on the canvas, send the clipboard content
     * via the relay (UTF-8 legacy ClientCutText for servers without
     * ExtendedClipboard, ExtendedClipboard for servers that support it).
     * instead and deliberately do not send the remote V shortcut.
     */
    const handlePasteShortcut = (e: KeyboardEvent) => {
      const pasteKeysym = keyEventToKeysym(e);
      if (pasteKeysym === 0 || pasteInFlightRef.current) return;

      pasteInFlightRef.current = {
        pasteKeysym,
        heldModifiers: pasteModifierKeysyms(e, pressedKeysymsRef.current),
        deferredKeyUps: new Set<number>(),
      };

      void (async () => {
        const clipboard = await readLocalClipboard();
        const text = clipboard?.text ?? "";
        if (clipboard) {
          lastSyncedLocalClipboardTextRef.current = text;
          sendExtClipboardToRelay(clipboard);
        }
        if (destroyedRef.current) {
          pasteInFlightRef.current = null;
          return;
        }
        if (pasteDelayTimerRef.current !== null) {
          window.clearTimeout(pasteDelayTimerRef.current);
        }

        // Wait briefly so the relay has time to ship the clipboard payload
        // ahead of the V keystroke (when we send one).
        pasteDelayTimerRef.current = window.setTimeout(() => {
          pasteDelayTimerRef.current = null;
          const pending = pasteInFlightRef.current;
          if (!pending || destroyedRef.current) {
            pasteInFlightRef.current = null;
            return;
          }

          // Release any held modifiers (Ctrl/Cmd/Shift) before injecting
          // characters — otherwise the remote app sees Ctrl+character
          // shortcuts instead of plain text.
          pending.heldModifiers.forEach((modKeysym) => {
            sendWsBinary(encodeWsKey(false, modKeysym));
          });

          // Re-press modifiers and send V so the remote app's paste shortcut
          // fires against the now-updated clipboard.
          pending.heldModifiers.forEach((modKeysym) => {
            sendWsBinary(encodeWsKey(true, modKeysym));
          });
          sendWsBinary(encodeWsKey(true, pasteKeysym));
          sendWsBinary(encodeWsKey(false, pasteKeysym));

          // The user's physical modifier keys are still held — defer their
          // key-ups until the user actually releases them so we don't
          // generate phantom up events.
          pending.deferredKeyUps.forEach((modKeysym) => {
            sendWsBinary(encodeWsKey(false, modKeysym));
          });
          pasteInFlightRef.current = null;
        }, PASTE_KEY_DELAY_MS);
      })();
    };

    const handleKey = (e: KeyboardEvent) => {
      if (
        (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) &&
        e.target !== imeInputRef.current
      ) {
        return;
      }
      if (e.isComposing || composingRef.current || e.key === "Dead" || e.key === "Process") {
        return;
      }
      if (options.commandKeyMode === "local-shortcuts" && e.metaKey && !isPasteShortcut(e)) {
        return;
      }

      const pendingPaste = pasteInFlightRef.current;
      if (pendingPaste && e.type === "keyup") {
        const modifierKeysym = modifierKeysymFromKey(e.key, e.location);
        if (modifierKeysym && pendingPaste.heldModifiers.has(modifierKeysym)) {
          e.preventDefault();
          pressedKeysymsRef.current.delete(modifierKeysym);
          pendingPaste.deferredKeyUps.add(modifierKeysym);
          return;
        }
        const keysym = keyEventToKeysym(e);
        if (keysym === pendingPaste.pasteKeysym) {
          e.preventDefault();
          return;
        }
      }

      // Intercept Ctrl/Meta + V so the remote clipboard is updated before the
      // remote application receives the paste shortcut.
      if (isPasteShortcut(e)) {
        e.preventDefault();
        if (e.type === "keydown" && !e.repeat) {
          handlePasteShortcut(e);
        }
        return;
      }

      const keysym = keyEventToKeysym(e);
      if (keysym === 0) return;
      e.preventDefault();
      const down = e.type === "keydown";
      if (down) {
        if (e.repeat || pressedKeysymsRef.current.has(keysym)) return;
        pressedKeysymsRef.current.add(keysym);
      } else {
        if (!pressedKeysymsRef.current.delete(keysym)) return;
      }
      sendWsBinary(encodeWsKey(down, keysym));
    };

    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", handleKey);

    // Keep the paste listener as a secondary path — useful when the OS
    // dispatches a paste event directly to the WebView.
    const handlePaste = (e: ClipboardEvent) => {
      if (!vncClipboardSends(options.clipboardPolicy)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const html = e.clipboardData?.getData("text/html") || undefined;
      const rtf = e.clipboardData?.getData("text/rtf") || undefined;
      if (!text && !html && !rtf) return;
      e.preventDefault();
      if (text) {
        lastSyncedLocalClipboardTextRef.current = text;
      }
      sendWs({
        type: "ext_clipboard",
        text,
        html: !options.clipboardTextOnly && options.allowHtmlClipboard ? html : undefined,
        rtf: !options.clipboardTextOnly && options.allowRtfClipboard ? rtf : undefined,
      });
    };
    window.addEventListener("paste", handlePaste);

    return () => {
      releaseInputState();
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", handleKey);
      window.removeEventListener("paste", handlePaste);
    };
  }, [
    visible,
    conn?.status,
    options,
    releaseInputState,
    sendWs,
    sendWsBinary,
  ]);

  // ── Pointer ───────────────────────────────────────────────────────
  const getFbCoords = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const fbWidth = conn?.width ?? 0;
      const fbHeight = conn?.height ?? 0;
      if (!canvas || fbWidth <= 0 || fbHeight <= 0) return { x: 0, y: 0 };
      return clientPointToFramebuffer(
        clientX,
        clientY,
        canvas.getBoundingClientRect(),
        fbWidth,
        fbHeight,
        scaleMode,
      );
    },
    [conn?.width, conn?.height, scaleMode],
  );

  const sendPointerNow = useCallback(
    (pointer: PointerState) => {
      const last = lastPointerSentRef.current;
      if (
        last &&
        last.x === pointer.x &&
        last.y === pointer.y &&
        last.buttons === pointer.buttons
      ) {
        return;
      }
      lastPointerSentRef.current = pointer;
      sendWsBinary(encodeWsPointer(pointer.x, pointer.y, pointer.buttons));
    },
    [sendWsBinary],
  );

  const handlePointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (conn?.status !== "connected" || options.viewOnly) return;
      if (delayedPointerDownRef.current?.pointerId === e.pointerId) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      void syncLocalClipboardToServer("pointer");
      const { x, y } = getFbCoords(e.clientX, e.clientY);
      const buttons = mouseButtonMask(e.nativeEvent);
      const pointer = { x, y, buttons };

      if (e.type === "pointermove") {
        pendingPointerRef.current = pointer;
        if (pointerRafRef.current === null) {
          pointerRafRef.current = requestAnimationFrame(() => {
            pointerRafRef.current = null;
            const pending = pendingPointerRef.current;
            pendingPointerRef.current = null;
            if (!pending || destroyedRef.current || conn?.status !== "connected") return;
            sendPointerNow(pending);
          });
        }
        return;
      }

      pendingPointerRef.current = null;
      sendPointerNow(pointer);
    },
    [conn?.status, getFbCoords, options.viewOnly, sendPointerNow, syncLocalClipboardToServer],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!options.viewOnly && conn?.status === "connected" && imeInputRef.current) {
        const containerBounds = containerRef.current?.getBoundingClientRect();
        if (containerBounds) {
          imeInputRef.current.style.left = `${Math.max(0, e.clientX - containerBounds.left)}px`;
          imeInputRef.current.style.top = `${Math.max(0, e.clientY - containerBounds.top)}px`;
        }
        imeInputRef.current.focus({ preventScroll: true });
      } else {
        e.currentTarget.focus({ preventScroll: true });
      }
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture can fail if the event was already cancelled.
      }
      if (!options.viewOnly && conn?.status === "connected" && (e.button === 1 || e.button === 2)) {
        e.preventDefault();
        const { x, y } = getFbCoords(e.clientX, e.clientY);
        const delayed: DelayedPointerDown = {
          pointerId: e.pointerId,
          down: { x, y, buttons: mouseButtonMask(e.nativeEvent) },
          up: null,
        };
        delayedPointerDownRef.current = delayed;
        void (async () => {
          await syncLocalClipboardToServer("button", true);
          await new Promise((resolve) => window.setTimeout(resolve, PASTE_KEY_DELAY_MS));
          if (destroyedRef.current || delayedPointerDownRef.current !== delayed) return;
          sendPointerNow(delayed.down);
          if (delayed.up) {
            sendPointerNow(delayed.up);
          }
          delayedPointerDownRef.current = null;
        })();
        return;
      }
      handlePointer(e);
    },
    [conn?.status, getFbCoords, handlePointer, options.viewOnly, sendPointerNow, syncLocalClipboardToServer],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const delayed = delayedPointerDownRef.current;
      if (delayed?.pointerId === e.pointerId) {
        e.preventDefault();
        const { x, y } = getFbCoords(e.clientX, e.clientY);
        delayed.up = { x, y, buttons: mouseButtonMask(e.nativeEvent) };
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // The pointer may already have been released by the platform.
        }
        return;
      }
      handlePointer(e);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // The pointer may already have been released by the platform.
      }
    },
    [getFbCoords, handlePointer],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (conn?.status !== "connected" || options.viewOnly) return;
      e.preventDefault();
      const { x, y } = getFbCoords(e.clientX, e.clientY);
      const wheelButton = e.deltaY < 0 ? 8 : 16;
      sendWsBinary(encodeWsPointer(x, y, wheelButton));
      setTimeout(() => sendWsBinary(encodeWsPointer(x, y, 0)), 50);
    },
    [conn?.status, getFbCoords, options.viewOnly, sendWsBinary],
  );

  // ── Canvas CSS size for scaling ───────────────────────────────────
  const canvasStyle: React.CSSProperties =
    scaleMode === "fit"
      ? {
          width: "100%",
          height: "100%",
          objectFit: "contain",
          cursor: "default",
        }
      : {
          width: conn?.width ?? 0,
          height: conn?.height ?? 0,
          cursor: "default",
          maxWidth: "none",
          maxHeight: "none",
        };

  // ── Render ───────────────────────────────────────────────────────
  const showCanvas = conn?.status === "connected";
  const showConnecting = conn?.status === "connecting";
  const showError =
    conn?.status === "disconnected" || conn?.status === "error";

  // Publish this VNC canvas as the active capture source while connected and
  // visible, so the screenshot actions (tab-strip `⋯` menu / detached capture
  // button) target the framebuffer.
  useEffect(() => {
    if (!visible || !showCanvas) return;
    const source: CaptureSource = {
      filenamePrefix: `vnc-${host}`,
      getVisible: async () => {
        if (!canvasRef.current) throw new Error(t("vnc.notReady"));
        return await captureCanvasPng(canvasRef.current);
      },
      getFull: async () => {
        if (!canvasRef.current) throw new Error(t("vnc.notReady"));
        return await captureCanvasPng(canvasRef.current);
      },
      getScrollFrame: async () => canvasRef.current ?? null,
      getGifFrame: async () => canvasRef.current ?? null,
      onStatus: (msg) => useAppStore.getState().setStatusMessage(msg),
    };
    useCaptureStore.getState().setSource(source);
    return () => useCaptureStore.getState().clearSource(source);
  }, [visible, showCanvas, host, t]);

  return (
    <div
      ref={containerRef}
      className="vnc-container"
      data-testid="vnc-panel"
      style={{
        width: "100%",
        height: "100%",
        overflow: scaleMode === "one" ? "auto" : "hidden",
        backgroundColor: "#1a1a2e",
        position: "relative",
      }}
    >
      {/* Tab-action toolbar. Always rendered so a dropped session can still be
          restored; the scale control needs the live canvas, so it's gated on
          the connection state. Screenshot actions live in the tab-strip `⋯`
          menu (main window) or the detached capture button. */}
      <TabActions active={visible}>
        {showCanvas && securityLabel && (
          <span
            data-testid="vnc-security-status"
            title={securityLabel}
            style={{ color: "var(--taomni-text-muted)", fontSize: 11, whiteSpace: "nowrap" }}
          >
            {securityLabel}
          </span>
        )}
        {showCanvas && (
          <button
            data-testid="vnc-scale-toggle"
            onClick={() => setScaleMode((m) => (m === "fit" ? "one" : "fit"))}
            style={FT_ICON_BUTTON_STYLE}
            title={scaleMode === "fit" ? t("vnc.scaleToggleOne") : t("vnc.scaleToggleFit")}
          >
            {scaleMode === "fit" ? <Maximize size={14} /> : <Minimize size={14} />}
          </button>
        )}
          {onDetach && (
            <>
              <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
              <button
                data-testid="vnc-detach"
                onClick={onDetach}
                title={t("rdp.detach")}
                aria-label={t("rdp.detach")}
                style={FT_ICON_BUTTON_STYLE}
              >
                <ExternalLink size={14} />
              </button>
            </>
          )}
          {detachedWindowControls && (
            <>
              <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
              <CaptureMenuButton />
              <button
                data-testid="detached-reattach"
                onClick={detachedWindowControls.onReattach}
                title={t("rdp.reattach")}
                aria-label={t("rdp.reattach")}
                style={FT_BUTTON_STYLE}
              >
                <ExternalLink size={14} />
                <span>{t("rdp.reattach")}</span>
              </button>
              <button
                data-testid="detached-os-fullscreen"
                onClick={detachedWindowControls.onToggleOsFullscreen}
                title={t("rdp.osFullscreen")}
                aria-label={t("rdp.osFullscreen")}
                style={FT_ICON_BUTTON_STYLE}
              >
                {detachedWindowControls.osFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </>
          )}
        </TabActions>

      {/* Status overlays */}
      {showConnecting && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.6)",
            zIndex: 5,
          }}
        >
          <div style={{ color: "#aaa", textAlign: "center" }}>
            <p>{t("vnc.connectingHost", { host, port })}</p>
          </div>
        </div>
      )}

      {showError && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.7)",
            zIndex: 5,
            gap: 12,
          }}
        >
          <div style={{ color: "#e44", textAlign: "center" }}>
            <p>{conn?.error ? t("vnc.disconnectedReason", { reason: conn.error }) : t("vnc.disconnected")}</p>
          </div>
          <button
            data-testid="vnc-reconnect"
            onClick={() => {
              // Cleanup old session
              reconnectAttemptsRef.current = 0;
              if (reconnectTimerRef.current !== null) {
                window.clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
              }
              releaseInputState();
              const sid = sessionIdRef.current;
              if (sid) vncDisconnect(sid).catch(() => {});
              if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
              }
              // Reconnect
              doConnect();
            }}
            style={{
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.3)",
              borderRadius: 4,
              padding: "6px 16px",
              cursor: "pointer",
              color: "#ccc",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <RefreshCw size={14} />
            {t("vnc.reconnect")}
          </button>
        </div>
      )}

      <canvas
        ref={canvasRef}
        data-testid="vnc-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointer}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={handleWheel}
        style={{
          display: showCanvas ? "block" : "none",
          ...canvasStyle,
          touchAction: "none",
          userSelect: "none",
        }}
        tabIndex={0}
      />
      <textarea
        ref={imeInputRef}
        aria-label="VNC remote input"
        tabIndex={-1}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onBlur={releaseInputState}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          const text = event.data || event.currentTarget.value;
          event.currentTarget.value = "";
          if (!visible || conn?.status !== "connected" || options.viewOnly) return;
          for (const codePoint of iterCodePoints(text)) {
            const keysym = codePointToKeysym(codePoint);
            if (keysym === 0) continue;
            sendWsBinary(encodeWsKey(true, keysym));
            sendWsBinary(encodeWsKey(false, keysym));
          }
        }}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          opacity: 0,
          padding: 0,
          border: 0,
          resize: "none",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
