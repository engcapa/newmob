import { useEffect, useRef, useCallback, useState } from "react";
import {
  classifyVncConnectError,
  formatVncDisconnect,
  keyEventToKeysym,
  mouseButtonMask,
  normalizeVncDisconnectInfo,
  parseFrameHeader,
  parseWsMessage,
  vncConnect,
  vncDisconnect,
} from "../../lib/vnc";
import type { VncDisconnectInfo, WsOutgoing } from "../../lib/vnc";
import { useVncStore } from "../../stores/vncStore";
import { Maximize, Minimize, RefreshCw } from "lucide-react";

export interface VncPanelProps {
  tabId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  visible: boolean;
}

type ScaleMode = "fit" | "one";
type PendingFrame = {
  x: number;
  y: number;
  w: number;
  h: number;
  rgba: Uint8Array;
};

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
  const connectAttemptRef = useRef(0);
  const disconnectedAttemptRef = useRef<number | null>(null);
  const lastResizeRef = useRef<{ width: number; height: number } | null>(null);
  const connectArgsRef = useRef({ host, port, username, password });
  const [scaleMode, setScaleMode] = useState<ScaleMode>("fit");

  const conn = useVncStore((s) => s.connections[tabId]);
  const initConnection = useVncStore((s) => s.initConnection);
  const setConnecting = useVncStore((s) => s.setConnecting);
  const setConnected = useVncStore((s) => s.setConnected);
  const setDisconnected = useVncStore((s) => s.setDisconnected);
  const removeConnection = useVncStore((s) => s.removeConnection);

  const setDisconnectedState = useCallback(
    (info: VncDisconnectInfo) => {
      setDisconnected(tabId, formatVncDisconnect(info), info);
    },
    [setDisconnected, tabId],
  );

  const cleanupActiveConnection = useCallback((notifyBackend: boolean) => {
    const sid = sessionIdRef.current;
    sessionIdRef.current = null;

    if (notifyBackend && sid) {
      vncDisconnect(sid).catch(() => {});
    }

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // no-op
      }
      wsRef.current = null;
    }

    frameBufferRef.current = [];
    lastResizeRef.current = null;
  }, []);

  const sendWs = useCallback((msg: WsOutgoing) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // ── connect logic, callable for retry ─────────────────────────────
  const doConnect = useCallback(() => {
    const { host: h, port: p, username: user, password: pw } = connectArgsRef.current;

    const attempt = connectAttemptRef.current + 1;
    connectAttemptRef.current = attempt;
    disconnectedAttemptRef.current = null;

    cleanupActiveConnection(true);
    destroyedRef.current = false;
    initConnection(tabId);

    (async () => {
      try {
        const result = await vncConnect(h, p, user, pw);
        if (destroyedRef.current || connectAttemptRef.current !== attempt) {
          vncDisconnect(result.session_id).catch(() => {});
          return;
        }

        sessionIdRef.current = result.session_id;
        setConnecting(tabId, result.session_id, result.ws_port);

        const ws = new WebSocket(`ws://127.0.0.1:${result.ws_port}`);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onmessage = (event) => {
          if (destroyedRef.current || connectAttemptRef.current !== attempt) return;

          if (event.data instanceof ArrayBuffer) {
            const header = parseFrameHeader(event.data);
            if (!header) return;
            const rgba = new Uint8Array(event.data, 12);
            frameBufferRef.current.push({ ...header, rgba });
            return;
          }

          const msg = parseWsMessage(event.data as string);
          if (!msg) return;

          switch (msg.type) {
            case "connected":
              setConnected(tabId, msg.width, msg.height, msg.name);
              break;
            case "disconnected": {
              disconnectedAttemptRef.current = attempt;
              const info = normalizeVncDisconnectInfo(msg, "backend");
              setDisconnectedState(info);
              break;
            }
            case "clipboard":
              navigator.clipboard.writeText(msg.text).catch(() => {});
              break;
          }
        };

        ws.onclose = () => {
          if (connectAttemptRef.current !== attempt) return;
          wsRef.current = null;
          if (destroyedRef.current || disconnectedAttemptRef.current === attempt) {
            return;
          }
          const info = normalizeVncDisconnectInfo(
            {
              reason: "WebSocket channel closed",
              source: "relay",
              code: "websocket_closed",
              retryable: true,
            },
            "relay",
          );
          setDisconnectedState(info);
        };

        ws.onerror = () => {
          if (destroyedRef.current || connectAttemptRef.current !== attempt) return;
          disconnectedAttemptRef.current = attempt;
          const info = normalizeVncDisconnectInfo(
            {
              reason: "WebSocket transport error",
              source: "relay",
              code: "websocket_closed",
              retryable: true,
            },
            "relay",
          );
          setDisconnectedState(info);
        };
      } catch (error) {
        if (destroyedRef.current || connectAttemptRef.current !== attempt) return;
        setDisconnectedState(classifyVncConnectError(error));
      }
    })();
  }, [
    cleanupActiveConnection,
    initConnection,
    setConnected,
    setConnecting,
    setDisconnectedState,
    tabId,
  ]);

  useEffect(() => {
    connectArgsRef.current = { host, port, username, password };
  }, [host, port, username, password]);

  // ── Mount / unmount ───────────────────────────────────────────────
  useEffect(() => {
    const connectTimer = window.setTimeout(() => {
      doConnect();
    }, 0);

    return () => {
      window.clearTimeout(connectTimer);
      destroyedRef.current = true;
      connectAttemptRef.current += 1;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      cleanupActiveConnection(true);
      removeConnection(tabId);
    };
  }, [cleanupActiveConnection, doConnect, removeConnection, tabId]);

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
          const pixelData = new Uint8ClampedArray(frame.rgba.length);
          pixelData.set(frame.rgba);

          const imgData = new ImageData(pixelData, frame.w || 1, frame.h || 1);
          try {
            ctx.putImageData(imgData, frame.x, frame.y);
          } catch {
            // size mismatch, skip
          }
        }

        sendWs({ type: "ack" });
      }

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [visible, conn?.status, conn?.width, conn?.height, sendWs]);

  // ── Keyboard ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
        return;
      const keysym = keyEventToKeysym(e);
      if (keysym === 0) return;
      e.preventDefault();
      sendWs({ type: "key", down: e.type === "keydown", keysym });
    };

    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", handleKey);

    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text) sendWs({ type: "clipboard", text });
    };
    window.addEventListener("paste", handlePaste);

    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", handleKey);
      window.removeEventListener("paste", handlePaste);
    };
  }, [visible, conn?.status, sendWs]);

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

  const handlePointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (conn?.status !== "connected") return;
      e.preventDefault();
      const { x, y } = getFbCoords(e.clientX, e.clientY);
      const buttons = mouseButtonMask(e.nativeEvent);
      sendWs({ type: "pointer", x, y, buttons });
    },
    [conn?.status, getFbCoords, sendWs],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.currentTarget.focus({ preventScroll: true });
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture can fail if the event was already cancelled.
      }
      handlePointer(e);
    },
    [handlePointer],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      handlePointer(e);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // The pointer may already have been released by the platform.
      }
    },
    [handlePointer],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (conn?.status !== "connected") return;
      e.preventDefault();
      const { x, y } = getFbCoords(e.clientX, e.clientY);
      const wheelButton = e.deltaY < 0 ? 8 : 16;
      sendWs({ type: "pointer", x, y, buttons: wheelButton });
      setTimeout(() => sendWs({ type: "pointer", x, y, buttons: 0 }), 50);
    },
    [conn?.status, getFbCoords, sendWs],
  );

  // ── Resize → true RFB SetDesktopSize ──────────────────────────────
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

        const nextWidth = Math.max(1, Math.round(entry.contentRect.width));
        const nextHeight = Math.max(1, Math.round(entry.contentRect.height));
        const last = lastResizeRef.current;

        if (last && last.width === nextWidth && last.height === nextHeight) {
          return;
        }

        lastResizeRef.current = { width: nextWidth, height: nextHeight };
        sendWs({ type: "resize", width: nextWidth, height: nextHeight });
      }, 150);
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [visible, conn?.status, sendWs]);

  // ── Canvas CSS size for scaling ───────────────────────────────────
  const canvasStyle: React.CSSProperties =
    scaleMode === "fit"
      ? {
          width: "100%",
          height: "100%",
          objectFit: "contain",
          cursor: "none",
        }
      : {
          width: conn?.width ?? 0,
          height: conn?.height ?? 0,
          cursor: "none",
          maxWidth: "none",
          maxHeight: "none",
        };

  // ── Render ───────────────────────────────────────────────────────
  const showCanvas = conn?.status === "connected";
  const showConnecting = conn?.status === "connecting";
  const showError =
    conn?.status === "disconnected" || conn?.status === "error";
  const retryable = conn?.disconnect?.retryable ?? true;

  return (
    <div
      ref={containerRef}
      className="vnc-container"
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
        <div
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            zIndex: 10,
            display: "flex",
            gap: 4,
          }}
        >
          <button
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
        </div>
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
          <div style={{ color: "#e44", textAlign: "center", maxWidth: 540 }}>
            <p>Disconnected{conn?.error ? `: ${conn.error}` : ""}</p>
            {!retryable && (
              <p style={{ marginTop: 6, color: "#d4a017", fontSize: 12 }}>
                This error is usually not transient, but you can retry after updating credentials/settings.
              </p>
            )}
          </div>
          <button
            onClick={() => {
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
