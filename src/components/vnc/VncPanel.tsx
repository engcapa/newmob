import { useEffect, useRef, useCallback, useState } from "react";
import {
  vncConnect,
  vncDisconnect,
  encodeWsAck,
  encodeWsKey,
  encodeWsPing,
  encodeWsPointer,
  encodeWsResize,
  parseWsMessage,
  parseFrameHeader,
  keyEventToKeysym,
  mouseButtonMask,
} from "../../lib/vnc";
import type { WsOutgoing } from "../../lib/vnc";
import { useVncStore } from "../../stores/vncStore";
import { useAppStore } from "../../stores/appStore";
import { Maximize, Minimize, RefreshCw } from "lucide-react";
import CaptureToolbar from "../capture/CaptureToolbar";
import FloatingToolbar from "../floating-toolbar/FloatingToolbar";
import { captureCanvasPng } from "../../lib/capture";
import {
  readText as readClipboardText,
  readMultiFormat,
  writeMultiFormat,
  writeText as writeClipboardText,
} from "../../lib/clipboard";

export interface VncPanelProps {
  tabId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  visible: boolean;
}

type ScaleMode = "fit" | "one";
const PASTE_KEY_DELAY_MS = 120;
const CLIPBOARD_SYNC_INTERVAL_MS = 750;
const CLIPBOARD_SYNC_MIN_INTERVAL_MS = 250;
type PendingFrame = {
  x: number;
  y: number;
  w: number;
  h: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
};
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

function modifierKeysymFromKey(key: string): number | null {
  switch (key) {
    case "Shift":
      return 0xffe1;
    case "Control":
      return 0xffe3;
    case "Alt":
      return 0xffe9;
    case "Meta":
      return 0xffeb;
    default:
      return null;
  }
}

function pasteModifierKeysyms(e: KeyboardEvent): Set<number> {
  const keysyms = new Set<number>();
  if (e.shiftKey) keysyms.add(0xffe1);
  if (e.ctrlKey) keysyms.add(0xffe3);
  if (e.altKey) keysyms.add(0xffe9);
  if (e.metaKey) keysyms.add(0xffeb);
  return keysyms;
}

function isPasteShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V");
}

function hasNonAsciiText(text: string): boolean {
  return /[^\x00-\x7f]/.test(text);
}

export default function VncPanel({
  tabId,
  host,
  port,
  username,
  password,
  visible,
}: VncPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const frameBufferRef = useRef<PendingFrame[]>([]);
  const rafRef = useRef<number>(0);
  const destroyedRef = useRef(false);
  const disconnectedByServerRef = useRef(false);
  const connectArgsRef = useRef({ host, port, username, password });
  const heartbeatTimerRef = useRef<number | null>(null);
  const visibleRef = useRef(visible);
  const ackPendingRef = useRef(false);
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
  const [scaleMode, setScaleMode] = useState<ScaleMode>("fit");

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
        console.info(
          `[vnc.clip] local→server ${reason} sync text_len=${text.length} ext_support=${extClipboardSupportedRef.current}`,
        );
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
    [sendWs],
  );

  // ── connect logic, callable for retry ─────────────────────────────
  const doConnect = useCallback(() => {
    const { host: h, port: p, username: user, password: pw } = connectArgsRef.current;
    destroyedRef.current = false;
    store.initConnection(tabId);

    let cancelled = false;
    disconnectedByServerRef.current = false;

    (async () => {
      try {
        const result = await vncConnect(h, p, user, pw);
        if (cancelled || destroyedRef.current) {
          vncDisconnect(result.session_id).catch(() => {});
          return;
        }

        sessionIdRef.current = result.session_id;
        store.setConnecting(tabId, result.session_id, result.ws_port);

        const ws = new WebSocket(`ws://127.0.0.1:${result.ws_port}`);
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
            if (event.data.byteLength === 0) {
              if (visibleRef.current) {
                ackPendingRef.current = false;
                sendWsBinary(encodeWsAck());
              } else {
                ackPendingRef.current = true;
              }
              return;
            }
            const header = parseFrameHeader(event.data);
            if (!header) return;
            const rgba = new Uint8ClampedArray(
              event.data as ArrayBuffer,
              12,
            ) as Uint8ClampedArray<ArrayBuffer>;
            frameBufferRef.current.push({ ...header, rgba });
          } else {
            const msg = parseWsMessage(event.data as string);
            if (!msg) return;
            switch (msg.type) {
              case "connected":
                store.setConnected(tabId, msg.width, msg.height, msg.name);
                break;
              case "disconnected":
                disconnectedByServerRef.current = true;
                store.setDisconnected(tabId, msg.reason);
                break;
              case "clipboard":
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
                serverClipboardWriteInFlightRef.current += 1;
                writeMultiFormat({
                  text: msg.text ?? "",
                  html: msg.html,
                  rtf: msg.rtf,
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
                console.info(
                  `[vnc.clip] server ExtendedClipboard support: ${msg.available}`,
                );
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
            store.setDisconnected(tabId, "Connection closed");
          }
        };

        ws.onerror = () => {
          if (!destroyedRef.current) {
            store.setDisconnected(tabId, "WebSocket error");
          }
        };
      } catch (err) {
        if (!cancelled && !destroyedRef.current) {
          store.setDisconnected(tabId, String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [host, port, username, password, tabId, store]);

  // ── Mount / unmount ───────────────────────────────────────────────
  useEffect(() => {
    connectArgsRef.current = { host, port, username, password };
    let cancel: (() => void) | undefined;
    const connectTimer = window.setTimeout(() => {
      cancel = doConnect();
    }, 0);

    return () => {
      window.clearTimeout(connectTimer);
      cancel?.();
      destroyedRef.current = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      frameBufferRef.current = [];
      if (heartbeatTimerRef.current !== null) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      if (pasteDelayTimerRef.current !== null) {
        window.clearTimeout(pasteDelayTimerRef.current);
        pasteDelayTimerRef.current = null;
      }
      ackPendingRef.current = false;
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
  }, [visible]);

  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;
    void syncLocalClipboardToServer("connect", true);
    const timer = window.setInterval(() => {
      void syncLocalClipboardToServer("poll");
    }, CLIPBOARD_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [visible, conn?.status, syncLocalClipboardToServer]);

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
        frames.length = 0;

        if (canvas.width !== conn.width || canvas.height !== conn.height) {
          canvas.width = conn.width || 1;
          canvas.height = conn.height || 1;
        }

        for (const frame of pending) {
          if (frame.rgba.length !== frame.w * frame.h * 4) continue;
          const imgData = new ImageData(frame.rgba, frame.w || 1, frame.h || 1);
          try {
            ctx.putImageData(imgData, frame.x, frame.y);
          } catch {
            // size mismatch, skip
          }
        }

      }

      if (ackPendingRef.current) {
        ackPendingRef.current = false;
        sendWsBinary(encodeWsAck());
      }

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [visible, conn?.status, conn?.width, conn?.height, sendWsBinary]);

  // ── Keyboard ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;

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
      sendWs({
        type: "ext_clipboard",
        text: data.text || undefined,
        html: data.html,
        rtf: data.rtf,
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
        heldModifiers: pasteModifierKeysyms(e),
        deferredKeyUps: new Set<number>(),
      };

      void (async () => {
        const clipboard = await readLocalClipboard();
        const text = clipboard?.text ?? "";
        if (clipboard) {
          lastSyncedLocalClipboardTextRef.current = text;
          sendExtClipboardToRelay(clipboard);
        }
        console.info(
          `[vnc.clip] paste shortcut: text_len=${text.length} non_ascii=${hasNonAsciiText(text)} ext_support=${extClipboardSupportedRef.current} → clipboard+V`,
        );

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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
        return;

      const pendingPaste = pasteInFlightRef.current;
      if (pendingPaste && e.type === "keyup") {
        const modifierKeysym = modifierKeysymFromKey(e.key);
        if (modifierKeysym && pendingPaste.heldModifiers.has(modifierKeysym)) {
          e.preventDefault();
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
      sendWsBinary(encodeWsKey(e.type === "keydown", keysym));
    };

    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", handleKey);

    // Keep the paste listener as a secondary path — useful when the OS
    // dispatches a paste event directly to the WebView.
    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const html = e.clipboardData?.getData("text/html") || undefined;
      const rtf = e.clipboardData?.getData("text/rtf") || undefined;
      if (!text && !html && !rtf) return;
      if (text) {
        lastSyncedLocalClipboardTextRef.current = text;
      }
      sendWs({ type: "ext_clipboard", text, html, rtf });
    };
    window.addEventListener("paste", handlePaste);

    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", handleKey);
      window.removeEventListener("paste", handlePaste);
    };
  }, [visible, conn?.status, sendWs, sendWsBinary]);

  // ── Pointer ───────────────────────────────────────────────────────
  const getFbCoords = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const fbWidth = conn?.width ?? 0;
      const fbHeight = conn?.height ?? 0;
      if (!canvas || fbWidth <= 0 || fbHeight <= 0) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };

      let contentLeft = rect.left;
      let contentTop = rect.top;
      let contentWidth = rect.width;
      let contentHeight = rect.height;

      if (scaleMode === "fit") {
        const fbAspect = fbWidth / fbHeight;
        const rectAspect = rect.width / rect.height;
        if (rectAspect > fbAspect) {
          contentWidth = rect.height * fbAspect;
          contentLeft += (rect.width - contentWidth) / 2;
        } else {
          contentHeight = rect.width / fbAspect;
          contentTop += (rect.height - contentHeight) / 2;
        }
      }

      const scaleX = fbWidth / contentWidth;
      const scaleY = fbHeight / contentHeight;
      const x = Math.round((clientX - contentLeft) * scaleX);
      const y = Math.round((clientY - contentTop) * scaleY);
      return {
        x: Math.max(0, Math.min(fbWidth - 1, x)),
        y: Math.max(0, Math.min(fbHeight - 1, y)),
      };
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
      if (conn?.status !== "connected") return;
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
    [conn?.status, getFbCoords, sendPointerNow, syncLocalClipboardToServer],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.currentTarget.focus({ preventScroll: true });
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture can fail if the event was already cancelled.
      }
      if (conn?.status === "connected" && (e.button === 1 || e.button === 2)) {
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
    [conn?.status, getFbCoords, handlePointer, sendPointerNow, syncLocalClipboardToServer],
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
      if (conn?.status !== "connected") return;
      e.preventDefault();
      const { x, y } = getFbCoords(e.clientX, e.clientY);
      const wheelButton = e.deltaY < 0 ? 8 : 16;
      sendWsBinary(encodeWsPointer(x, y, wheelButton));
      setTimeout(() => sendWsBinary(encodeWsPointer(x, y, 0)), 50);
    },
    [conn?.status, getFbCoords, sendWsBinary],
  );

  // ── Resize → set_desktop_size ─────────────────────────────────────
  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;
    const container = containerRef.current;
    if (!container) return;

    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver((entries) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const entry = entries[0];
        if (!entry) return;
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          sendWsBinary(encodeWsResize(Math.round(width), Math.round(height)));
        }
      }, 300);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [visible, conn?.status, sendWsBinary]);

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
      {/* Scaling toolbar */}
      {showCanvas && (
        <FloatingToolbar
          storageKey="mob.vnc.toolbar"
          defaultTop={4}
          defaultRight={4}
          testId="vnc-floating-toolbar"
        >
          <CaptureToolbar
            filenamePrefix={`vnc-${host}`}
            getVisible={async () => {
              if (!canvasRef.current) throw new Error("VNC not ready");
              return await captureCanvasPng(canvasRef.current);
            }}
            getFull={async () => {
              if (!canvasRef.current) throw new Error("VNC not ready");
              return await captureCanvasPng(canvasRef.current);
            }}
            getScrollFrame={async () => canvasRef.current ?? null}
            getGifFrame={async () => canvasRef.current ?? null}
            onStatus={(msg) => useAppStore.getState().setStatusMessage(msg)}
            compact
          />
          <button
            data-testid="vnc-scale-toggle"
            onClick={() => setScaleMode((m) => (m === "fit" ? "one" : "fit"))}
            style={{
              background: "rgba(0,0,0,0.5)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 4,
              padding: 4,
              cursor: "pointer",
              color: "#ccc",
              display: "flex",
            }}
            title={scaleMode === "fit" ? "1:1 pixel mapping" : "Fit to window"}
          >
            {scaleMode === "fit" ? <Maximize size={14} /> : <Minimize size={14} />}
          </button>
        </FloatingToolbar>
      )}

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
            <p>Connecting to {host}:{port}…</p>
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
            <p>Disconnected{conn?.error ? `: ${conn.error}` : ""}</p>
          </div>
          <button
            data-testid="vnc-reconnect"
            onClick={() => {
              // Cleanup old session
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
            Reconnect
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
    </div>
  );
}
