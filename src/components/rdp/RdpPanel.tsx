import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Bot,
  Fullscreen,
  Minimize2,
  PictureInPicture,
  PictureInPicture2,
  RefreshCw,
} from "lucide-react";

import {
  applyExtended,
  encodeAck,
  encodeKey,
  encodePing,
  encodePointer,
  encodeRefresh,
  encodeResize,
  encodeWheel,
  extractRdpCertificateChallenge,
  formatRdpCertificateFingerprint,
  keyEventToScancode,
  mouseButtonMask,
  normalizeRdpResizeSize,
  OUT_AUDIO,
  OUT_FRAME,
  parseAudioFrame,
  parseFrameTile,
  parseRdpWsText,
  rdpConnect,
  rdpDisconnect,
  rdpTrustCertificate,
  wheelDeltaToRotationUnits,
} from "../../lib/rdp";
import { useRdpStore } from "../../stores/rdpStore";
import type { RdpOptions } from "../../types/rdp";
import { useT, t as tr } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import {
  readFiles as readClipboardFiles,
  readText as readClipboardText,
  writeFiles as writeClipboardFiles,
  writeText as writeClipboardText,
} from "../../lib/clipboard";
import { TabActions } from "../tabbar/TabActionSlot";
import {
  FT_BUTTON_STYLE,
  FT_BUTTON_ACTIVE_OVERRIDE,
  FT_ICON_BUTTON_STYLE,
  FT_SEPARATOR_STYLE,
} from "../floating-toolbar/floatingToolbarStyles";
import { useCaptureStore, type CaptureSource } from "../../stores/captureStore";
import { CaptureMenuButton } from "../capture/CaptureMenuButton";
import { captureCanvasPng } from "../../lib/capture";
import { useAppStore } from "../../stores/appStore";
import { confirmAppDialog } from "../../lib/appDialogs";

export interface RdpPanelProps {
  tabId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  options: RdpOptions;
  networkSettingsJson?: string | null;
  visible: boolean;
  /** Callback for the toolbar Detach button. When undefined, the button
   *  is hidden — used by the detached window itself, which should show
   *  Reattach instead. */
  onDetach?: () => void;
  /** When set, the toolbar shows an AI-chat toggle bound to this tab.
   *  Hidden in detached windows (no ChatDrawer lives there). */
  chatToggle?: {
    open: boolean;
    onToggle: () => void;
  };
  detachedWindowControls?: {
    onReattach: () => void;
    onToggleOsFullscreen: () => void;
    osFullscreen: boolean;
  };
}

type ScaleMode = "fit" | "one";
// View state for the single "enlarge" button: normal <-> OS fullscreen.
type ViewMode = "normal" | "fullscreen";

export default function RdpPanel({
  tabId,
  host,
  port,
  username,
  password,
  options,
  networkSettingsJson,
  visible,
  onDetach,
  chatToggle,
  detachedWindowControls,
}: RdpPanelProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imeInputRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const audioRef = useRef<{ ctx: AudioContext; nextTime: number } | null>(null);
  const lastResizeRequestRef = useRef<string | null>(null);
  const destroyedRef = useRef(false);
  const certificatePromptRef = useRef(false);
  const reconnectRef = useRef<() => void>(() => {});
  const visibleRef = useRef(visible);
  const suppressNextPasteKeyUpRef = useRef(false);
  const pressedScancodesRef = useRef(new Set<number>());
  const composingRef = useRef(false);
  const initRef = useRef({ host, port, username, password, options, networkSettingsJson });
  const [scaleMode, setScaleMode] = useState<ScaleMode>("fit");
  // Tracks whether the host OS window is fullscreen. Only meaningful for
  // attached tabs (detached windows manage their own fullscreen via
  // `detachedWindowControls`). Cosmetic — drives the toolbar icon.
  const [osFullscreen, setOsFullscreen] = useState(false);

  const store = useRdpStore();
  const conn = store.connections[tabId];

  /* ── Send helpers ────────────────────────────────────────────────── */

  const sendBinary = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  const sendText = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const releaseRemoteInput = useCallback(() => {
    pressedScancodesRef.current.clear();
    suppressNextPasteKeyUpRef.current = false;
    sendText({ type: "release_input" });
  }, [sendText]);

  const sendRemoteResize = useCallback(
    (width: number, height: number, force = false) => {
      const size = normalizeRdpResizeSize(width, height);
      if (!size) return;
      const key = `${size.width}x${size.height}`;
      if (!force && lastResizeRequestRef.current === key) return;
      lastResizeRequestRef.current = key;
      sendBinary(encodeResize(size.width, size.height));
    },
    [sendBinary],
  );

  const requestViewportResize = useCallback(
    (force = false) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      sendRemoteResize(rect.width, rect.height, force);
    },
    [sendRemoteResize],
  );

  const closeAudio = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      void audio.ctx.close().catch(() => {});
    }
  }, []);

  const playAudioFrame = useCallback((frame: ReturnType<typeof parseAudioFrame>) => {
    if (!frame || initRef.current.options.redirectAudio !== "play") return;
    if (frame.channels < 1 || frame.channels > 2 || frame.bitsPerSample !== 16) return;

    const AudioContextCtor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    let audio = audioRef.current;
    if (!audio || audio.ctx.state === "closed") {
      audio = { ctx: new AudioContextCtor({ sampleRate: frame.sampleRate }), nextTime: 0 };
      audioRef.current = audio;
    }
    if (audio.ctx.state === "suspended") {
      void audio.ctx.resume().catch(() => {});
    }

    const bytesPerSample = frame.bitsPerSample / 8;
    const frameSize = bytesPerSample * frame.channels;
    const sampleCount = Math.floor(frame.pcm.byteLength / frameSize);
    if (sampleCount <= 0) return;

    const buffer = audio.ctx.createBuffer(frame.channels, sampleCount, frame.sampleRate);
    const view = new DataView(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength);
    for (let i = 0; i < sampleCount; i += 1) {
      for (let ch = 0; ch < frame.channels; ch += 1) {
        const offset = i * frameSize + ch * bytesPerSample;
        buffer.getChannelData(ch)[i] = view.getInt16(offset, true) / 32768;
      }
    }

    const source = audio.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.ctx.destination);
    const startAt = Math.max(audio.nextTime, audio.ctx.currentTime + 0.02);
    source.start(startAt);
    audio.nextTime = startAt + buffer.duration;
  }, []);

  /* ── Connect lifecycle ───────────────────────────────────────────── */

  const doConnect = useCallback(() => {
    const args = initRef.current;
    destroyedRef.current = false;
    lastResizeRequestRef.current = null;
    store.initConnection(tabId);

    let cancelled = false;
    (async () => {
      try {
        const result = await rdpConnect(
          args.host,
          args.port,
          args.username,
          args.password,
          args.options,
          args.networkSettingsJson ?? null,
        );
        if (cancelled || destroyedRef.current) {
          rdpDisconnect(result.session_id).catch(() => {});
          return;
        }
        sessionIdRef.current = result.session_id;
        store.setConnecting(tabId, result.session_id, result.ws_port);

        const ws = new WebSocket(`ws://127.0.0.1:${result.ws_port}`, [
          `taomni-rdp.${result.ws_token}`,
        ]);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onopen = () => {
          if (heartbeatRef.current !== null) {
            window.clearInterval(heartbeatRef.current);
          }
          heartbeatRef.current = window.setInterval(() => {
            sendBinary(encodePing());
          }, 15000);
        };

        ws.onmessage = (event) => {
          if (destroyedRef.current) return;
          if (event.data instanceof ArrayBuffer) {
            const dv = new DataView(event.data);
            if (event.data.byteLength === 0) return;
            const tag = dv.getUint8(0);
            if (tag === OUT_FRAME) {
              const tile = parseFrameTile(event.data);
              if (tile) drawTile(canvasRef.current, tile);
              if (visibleRef.current) sendBinary(encodeAck());
            } else if (tag === OUT_AUDIO) {
              playAudioFrame(parseAudioFrame(event.data));
            }
          } else {
            const msg = parseRdpWsText(event.data as string);
            if (!msg) return;
            switch (msg.type) {
              case "connected":
                store.setConnected(tabId, msg.width, msg.height, msg.protocol, msg.server_name);
                resizeCanvas(canvasRef.current, msg.width, msg.height);
                window.setTimeout(() => requestViewportResize(false), 0);
                // Nudge the server to repaint the whole desktop shortly after
                // we (re)connect. Windows often hands us a stale framebuffer
                // across the logon→desktop transition; a Refresh Rect request
                // forces a fresh paint so the canvas is never stuck on the
                // pre-login image.
                window.setTimeout(() => sendBinary(encodeRefresh()), 400);
                break;
              case "disconnected":
                store.setDisconnected(tabId, msg.reason);
                break;
              case "status":
                store.setStage(tabId, msg.stage);
                break;
              case "error":
                {
                  const challenge = extractRdpCertificateChallenge(msg.message);
                  if (!challenge || certificatePromptRef.current) {
                    store.setDisconnected(tabId, msg.message);
                    break;
                  }
                  certificatePromptRef.current = true;
                  store.setStage(tabId, "certificate-review");
                  void (async () => {
                    const fingerprint = formatRdpCertificateFingerprint(challenge.observed);
                    const confirmed = await confirmAppDialog({
                      title: t(
                        challenge.changed
                          ? "rdp.certificateChangedTitle"
                          : "rdp.certificateTrustTitle",
                      ),
                      message: t(
                        challenge.changed
                          ? "rdp.certificateChangedMessage"
                          : "rdp.certificateTrustMessage",
                        {
                          host: challenge.host,
                          port: challenge.port,
                          fingerprint,
                        },
                      ),
                      confirmLabel: t("rdp.certificateTrustConfirm"),
                      danger: challenge.changed,
                    });
                    if (!confirmed || destroyedRef.current) {
                      certificatePromptRef.current = false;
                      store.setDisconnected(tabId, t("rdp.certificateTrustDeclined"));
                      return;
                    }
                    try {
                      await rdpTrustCertificate(
                        challenge.host,
                        challenge.port,
                        challenge.observed,
                      );
                      const oldSession = sessionIdRef.current;
                      sessionIdRef.current = null;
                      if (oldSession) await rdpDisconnect(oldSession).catch(() => {});
                      wsRef.current?.close();
                      wsRef.current = null;
                      certificatePromptRef.current = false;
                      window.setTimeout(() => reconnectRef.current(), 0);
                    } catch (err) {
                      certificatePromptRef.current = false;
                      store.setDisconnected(tabId, String(err));
                    }
                  })();
                }
                break;
              case "clipboard":
                void writeClipboardText(msg.text).catch((err) => {
                  console.warn("[rdp.clip] write local clipboard failed:", err);
                });
                break;
              case "clipboard_files":
                void writeClipboardFiles(msg.paths).catch((err) => {
                  console.warn("[rdp.clip] write local file clipboard failed:", err);
                  if ("text" in msg && typeof msg.text === "string") {
                    void writeClipboardText(msg.text).catch(() => {});
                  }
                });
                break;
            }
          }
        };

        ws.onclose = () => {
          closeAudio();
          pressedScancodesRef.current.clear();
          if (wsRef.current === ws) wsRef.current = null;
          if (heartbeatRef.current !== null) {
            window.clearInterval(heartbeatRef.current);
            heartbeatRef.current = null;
          }
          if (!destroyedRef.current) {
            store.setDisconnected(tabId, tr("rdp.closedConnection"));
          }
        };
        ws.onerror = () => {
          if (!destroyedRef.current) {
            store.setDisconnected(tabId, tr("rdp.websocketError"));
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
  }, [closeAudio, playAudioFrame, requestViewportResize, sendBinary, store, tabId]);

  reconnectRef.current = doConnect;

  useEffect(() => {
    initRef.current = { host, port, username, password, options, networkSettingsJson };
    let cancel: (() => void) | undefined;
    const t = window.setTimeout(() => {
      cancel = doConnect();
    }, 0);
    return () => {
      window.clearTimeout(t);
      cancel?.();
      destroyedRef.current = true;
      if (heartbeatRef.current !== null) {
        window.clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      closeAudio();
      releaseRemoteInput();
      const sid = sessionIdRef.current;
      if (sid) rdpDisconnect(sid).catch(() => {});
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      store.removeConnection(tabId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) releaseRemoteInput();
  }, [releaseRemoteInput, visible]);

  useEffect(() => {
    const release = () => releaseRemoteInput();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") release();
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [releaseRemoteInput]);

  /* ── Input handlers ──────────────────────────────────────────────── */

  const syncClipboardForRemotePaste = useCallback(async () => {
    const files = await readClipboardFiles().catch((err) => {
      console.warn("[rdp.clip] read local file clipboard failed:", err);
      return [];
    });
    if (files.length > 0) {
      sendText({ type: "clipboard_files", paths: files });
      window.setTimeout(() => {
        sendBinary(encodeKey(true, 0x1d)); // Ctrl
        sendBinary(encodeKey(true, 0x2f)); // V
        sendBinary(encodeKey(false, 0x2f));
        sendBinary(encodeKey(false, 0x1d));
      }, 40);
      return;
    }

    const text = await readClipboardText().catch((err) => {
      console.warn("[rdp.clip] read local clipboard failed:", err);
      return "";
    });
    if (!text) return;

    sendText({ type: "clipboard", text });
    window.setTimeout(() => {
      sendBinary(encodeKey(true, 0x1d)); // Ctrl
      sendBinary(encodeKey(true, 0x2f)); // V
      sendBinary(encodeKey(false, 0x2f));
      sendBinary(encodeKey(false, 0x1d));
    }, 40);
  }, [sendBinary, sendText]);

  /* ── View controls (local, never forwarded to the remote) ────────── */

  // Toggle the host OS window between fullscreen and normal. Detached
  // windows already own a fullscreen toggle (passed via
  // `detachedWindowControls`); attached tabs flip the main app window
  // directly through the Tauri window API, falling back to the DOM
  // Fullscreen API in browser dev mode.
  const toggleOsFullscreen = useCallback(() => {
    if (detachedWindowControls) {
      detachedWindowControls.onToggleOsFullscreen();
      return;
    }
    void (async () => {
      if (isTauriRuntime()) {
        try {
          const w = getCurrentWindow();
          const next = !(await w.isFullscreen());
          // On Windows a borderless (decorations:false) window that is
          // OS-*maximized* does not cleanly escape the maximized state when
          // `setFullscreen(true)` is called: the window covers the screen but
          // the webview surface stays at the work-area height (screen minus
          // taskbar), leaving a black band where the taskbar used to be. Drop
          // out of maximize first so the surface grows to the true screen
          // height before we go fullscreen.
          if (next && (await w.isMaximized())) {
            await w.unmaximize();
          }
          await w.setFullscreen(next);
          setOsFullscreen(next);
          // The surface resize lands a frame or two after setFullscreen
          // resolves; re-sync the remote desktop to the new viewport so the
          // RDP session repaints at the full screen size instead of the stale
          // work-area size.
          window.setTimeout(() => requestViewportResize(true), 120);
        } catch {
          /* window API unavailable — ignore */
        }
        return;
      }
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          setOsFullscreen(false);
        } else {
          await document.documentElement.requestFullscreen();
          setOsFullscreen(true);
        }
        window.setTimeout(() => requestViewportResize(true), 120);
      } catch {
        /* fullscreen request rejected — ignore */
      }
    })();
  }, [detachedWindowControls, requestViewportResize]);

  const onKey = useCallback(
    (down: boolean) => (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!visible || conn?.status !== "connected") return;
      const code = e.nativeEvent.code;

      if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
        e.preventDefault();
        return;
      }

      // Local view shortcuts intercepted before reaching the remote desktop:
      //   F11 → toggle host-window OS fullscreen
      if (code === "F11") {
        e.preventDefault();
        if (down && !e.nativeEvent.repeat) toggleOsFullscreen();
        return;
      }

      if (!down && suppressNextPasteKeyUpRef.current && code === "KeyV") {
        suppressNextPasteKeyUpRef.current = false;
        e.preventDefault();
        return;
      }
      if (down && (e.ctrlKey || e.metaKey) && code === "KeyV") {
        e.preventDefault();
        suppressNextPasteKeyUpRef.current = true;
        void syncClipboardForRemotePaste();
        return;
      }
      const sc = keyEventToScancode(e.nativeEvent);
      if (!sc) return;
      e.preventDefault();
      const wireScancode = applyExtended(sc.scancode, sc.extended);
      if (down) pressedScancodesRef.current.add(wireScancode);
      else pressedScancodesRef.current.delete(wireScancode);
      sendBinary(encodeKey(down, wireScancode));
    },
    [
      conn?.status,
      sendBinary,
      syncClipboardForRemotePaste,
      toggleOsFullscreen,
      visible,
    ],
  );

  const onCompositionEnd = useCallback(
    (e: React.CompositionEvent<HTMLTextAreaElement>) => {
      composingRef.current = false;
      const text = e.data;
      e.currentTarget.value = "";
      if (!text || !visible || conn?.status !== "connected") return;
      const characters = Array.from(text);
      for (let offset = 0; offset < characters.length; offset += 1024) {
        sendText({ type: "unicode", text: characters.slice(offset, offset + 1024).join("") });
      }
    },
    [conn?.status, sendText, visible],
  );

  const onPointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!visible || conn?.status !== "connected") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { x, y } = canvasPointFromClient(canvas, e.clientX, e.clientY);
      sendBinary(encodePointer(x, y, mouseButtonMask(e.nativeEvent)));
    },
    [conn?.status, sendBinary, visible],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (!visible || conn?.status !== "connected") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      e.preventDefault();
      const { x, y } = canvasPointFromClient(canvas, e.clientX, e.clientY);

      const verticalUnits = wheelDeltaToRotationUnits(e.deltaY, e.deltaMode);
      if (verticalUnits !== 0) {
        sendBinary(encodeWheel(x, y, -verticalUnits, true));
      }

      const horizontalUnits = wheelDeltaToRotationUnits(e.deltaX, e.deltaMode);
      if (horizontalUnits !== 0) {
        sendBinary(encodeWheel(x, y, horizontalUnits, false));
      }
    },
    [conn?.status, sendBinary, visible],
  );

  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;

    let timer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => requestViewportResize(false), 300);
    });
    observer.observe(viewport);
    requestViewportResize(false);

    return () => {
      observer.disconnect();
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [conn?.status, requestViewportResize, visible]);

  const reconnect = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) rdpDisconnect(sid).catch(() => {});
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    closeAudio();
    store.setDisconnected(tabId);
    doConnect();
  }, [closeAudio, doConnect, store, tabId]);

  /* ── Render ──────────────────────────────────────────────────────── */

  const status = conn?.status ?? "disconnected";
  const stage = conn?.stage;
  const dims = conn ? `${conn.width}×${conn.height}` : "";
  const protocol = conn?.protocol ?? "";
  // The backend emits granular internal stage strings (e.g. "negotiating",
  // "credssp", "refresh-requested") that are useful as live progress while we
  // are still connecting, but read as noise once the desktop is up. Show the
  // stage only during connection so the badge settles to a clean
  // "Connected · TLS · 1920×1000" once the session is live.
  const showStage = status === "connecting" && !!stage;

  const canvasClass = useMemo(
    () => (scaleMode === "fit" ? "rdp-canvas rdp-canvas-fit" : "rdp-canvas rdp-canvas-one"),
    [scaleMode],
  );

  /* ── View toggle: normal <-> OS fullscreen ───────────────────────────
   * Derived from the underlying boolean so it stays correct even when the
   * user flips it out-of-band via F11. */
  const currentFullscreen = detachedWindowControls
    ? detachedWindowControls.osFullscreen
    : osFullscreen;
  const viewMode: ViewMode = currentFullscreen ? "fullscreen" : "normal";

  const cycleView = () => toggleOsFullscreen();

  // Icon + tooltip describe what the NEXT click does, so the single button
  // still reads at a glance.
  const cycle =
    viewMode === "fullscreen"
      ? { icon: <Minimize2 size={14} />, label: t("rdp.restore"), hint: " (F11)" }
      : { icon: <Fullscreen size={14} />, label: t("rdp.osFullscreen"), hint: " (F11)" };

  // Publish this RDP canvas as the active capture source while connected and
  // visible (screenshot actions live in the tab-strip `⋯` menu / detached
  // capture button).
  useEffect(() => {
    if (!visible || status !== "connected") return;
    const source: CaptureSource = {
      filenamePrefix: `rdp-${host}`,
      getVisible: async () => {
        if (!canvasRef.current) throw new Error(t("rdp.notReady"));
        return await captureCanvasPng(canvasRef.current);
      },
      getFull: async () => {
        if (!canvasRef.current) throw new Error(t("rdp.notReady"));
        return await captureCanvasPng(canvasRef.current);
      },
      getScrollFrame: () => canvasRef.current ?? null,
      getGifFrame: () => canvasRef.current ?? null,
      onStatus: (msg) => useAppStore.getState().setStatusMessage(msg),
    };
    useCaptureStore.getState().setSource(source);
    return () => useCaptureStore.getState().clearSource(source);
  }, [visible, status, host, t]);

  return (
    <div
      ref={containerRef}
      className="rdp-panel"
      data-testid="rdp-panel"
      tabIndex={0}
      onKeyDown={onKey(true)}
      onKeyUp={onKey(false)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) releaseRemoteInput();
      }}
      style={{
        outline: "none",
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#000",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <TabActions active={visible}>
        <span
          data-testid="rdp-status"
          style={{
            fontSize: 11,
            color: "#ddd",
            padding: "0 6px",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            whiteSpace: "nowrap",
          }}
        >
          {t(`rdp.status.${status}`)}
          {protocol && <span style={{ opacity: 0.65 }}>· {protocol}</span>}
          {dims && <span style={{ opacity: 0.65 }}>· {dims}</span>}
          {showStage && <span style={{ opacity: 0.45 }}>· {stage}</span>}
        </span>
        <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
        {/* Action group — operations on the live session. */}
        <button
          type="button"
          data-testid="rdp-reconnect"
          onClick={reconnect}
          title={t("rdp.reconnect")}
          aria-label={t("rdp.reconnect")}
          style={FT_ICON_BUTTON_STYLE}
        >
          <RefreshCw size={14} />
        </button>
        {chatToggle && (
          <button
            type="button"
            data-testid="rdp-chat-toggle"
            onClick={chatToggle.onToggle}
            title={chatToggle.open ? t("terminal.chatFloatingTitleClose") : t("terminal.chatFloatingTitleOpen")}
            aria-label={chatToggle.open ? t("terminal.chatFloatingLabelClose") : t("terminal.chatFloatingLabelOpen")}
            style={{
              ...FT_ICON_BUTTON_STYLE,
              ...(chatToggle.open ? FT_BUTTON_ACTIVE_OVERRIDE : {}),
            }}
          >
            <Bot size={14} />
          </button>
        )}
        {onDetach && (
          <button
            type="button"
            data-testid="rdp-detach"
            onClick={onDetach}
            title={t("rdp.detach")}
            aria-label={t("rdp.detach")}
            style={FT_ICON_BUTTON_STYLE}
          >
            <PictureInPicture2 size={14} />
          </button>
        )}
        <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
        {/* View group — how the desktop is scaled and sized. The remote
            desktop auto-resizes to the viewport on its own (ResizeObserver
            below), so there is no manual resize button: scale toggle picks
            fit-vs-1:1, the view button toggles OS fullscreen. */}
        <button
          type="button"
          data-testid="rdp-scale-toggle"
          onClick={() => setScaleMode((m) => (m === "fit" ? "one" : "fit"))}
          title={scaleMode === "fit" ? t("rdp.scaleOne") : t("rdp.scaleFit")}
          style={FT_BUTTON_STYLE}
        >
          {scaleMode === "fit" ? t("rdp.scaleOne") : t("rdp.scaleFit")}
        </button>
        <button
          type="button"
          data-testid="rdp-view-cycle"
          onClick={cycleView}
          title={`${cycle.label}${cycle.hint}`}
          aria-label={cycle.label}
          style={FT_ICON_BUTTON_STYLE}
        >
          {cycle.icon}
        </button>
        {detachedWindowControls && (
          <>
            <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
            <CaptureMenuButton />
            <button
              type="button"
              data-testid="detached-reattach"
              onClick={detachedWindowControls.onReattach}
              title={t("rdp.reattach")}
              aria-label={t("rdp.reattach")}
              style={FT_BUTTON_STYLE}
            >
              <PictureInPicture size={14} />
              <span>{t("rdp.reattach")}</span>
            </button>
          </>
        )}
      </TabActions>

      <div
        ref={viewportRef}
        style={{
          flex: 1,
          background: "#000",
          width: "100%",
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: scaleMode === "one" ? "auto" : "hidden",
        }}
      >
        <canvas
          ref={canvasRef}
          className={canvasClass}
          data-testid="rdp-canvas"
          width={Math.max(640, conn?.width ?? 1920)}
          height={Math.max(480, conn?.height ?? 1080)}
          onPointerMove={onPointer}
          onPointerDown={(e) => {
            imeInputRef.current?.focus({ preventScroll: true });
            onPointer(e);
          }}
          onPointerUp={onPointer}
          onPointerCancel={() => releaseRemoteInput()}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            maxWidth: scaleMode === "fit" ? "100%" : undefined,
            maxHeight: scaleMode === "fit" ? "100%" : undefined,
            imageRendering: "pixelated",
            background: "#000",
          }}
        />
        <textarea
          ref={imeInputRef}
          tabIndex={-1}
          aria-label={t("rdp.imeInput")}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={onCompositionEnd}
          onInput={(e) => {
            if (!composingRef.current) e.currentTarget.value = "";
          }}
          onPaste={(e) => e.preventDefault()}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: "none",
            insetInlineStart: 0,
            bottom: 0,
            padding: 0,
            border: 0,
          }}
        />
      </div>

      {status !== "connected" && (
        <div
          className="rdp-overlay"
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            fontSize: 14,
          }}
        >
          {status === "connecting" && t("rdp.connecting")}
          {status === "disconnected" && t("rdp.disconnected")}
          {status === "error" && (conn?.error ?? t("rdp.errorGeneric"))}
        </div>
      )}
    </div>
  );
}

/* ── Canvas helpers ─────────────────────────────────────────────────── */

function resizeCanvas(canvas: HTMLCanvasElement | null, w: number, h: number) {
  if (!canvas) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function canvasPointFromClient(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  const cssX = clientX - rect.left;
  const cssY = clientY - rect.top;
  const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(cssX * (canvas.width / rect.width))));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(cssY * (canvas.height / rect.height))));
  return { x, y };
}

function drawTile(
  canvas: HTMLCanvasElement | null,
  tile: { x: number; y: number; w: number; h: number; rgba: Uint8ClampedArray<ArrayBuffer> },
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // ImageData expects rgba length == 4*w*h. If the relay over-pads (which
  // shouldn't happen given the wire format), trim.
  const expected = 4 * tile.w * tile.h;
  if (tile.rgba.length < expected) return;
  const slice =
    tile.rgba.length === expected
      ? tile.rgba
      : (new Uint8ClampedArray(tile.rgba.buffer, tile.rgba.byteOffset, expected) as Uint8ClampedArray<ArrayBuffer>);
  const img = new ImageData(slice, tile.w, tile.h);
  ctx.putImageData(img, tile.x, tile.y);
}
