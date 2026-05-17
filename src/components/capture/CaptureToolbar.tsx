// Capture toolbar — three buttons (visible PNG, full PNG, GIF record).
//
// Designed to be embedded in any tab's chrome. Callers provide:
//   * getVisible()  — Promise<Blob> snapshot of the current viewport
//   * getFull()     — Promise<Blob> snapshot of the whole buffer/framebuffer
//                     (terminal scrollback or VNC framebuffer)
//   * getGifFrame() — Promise<CanvasImageSource | null> producing the next
//                     frame for the GIF recorder
//   * filenamePrefix — used to build the saved file name
//
// The toolbar handles save-to-disk + copy-to-clipboard menus, plus recording
// state (start/stop, elapsed timer).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  ChevronDown,
  Clipboard,
  Download,
  FileImage,
  ScrollText,
  Square,
  Video,
} from "lucide-react";
import {
  copyImageBlobToClipboard,
  createGifRecorder,
  type GifRecorder,
  saveBlobToFile,
  safeFilePart,
  startScrollCapture,
  type ScrollCapture,
  timestampFilePart,
} from "../../lib/capture";

export interface CaptureToolbarProps {
  filenamePrefix: string;
  getVisible: () => Promise<Blob>;
  /** Whole-buffer snapshot (e.g. xterm scrollback). When provided, the
   *  default scroll-screenshot action saves it directly. */
  getFull?: () => Promise<Blob>;
  /** Frame source for live scroll capture (Start → manual scroll → Stop).
   *  Falls back to getFull when omitted. */
  getScrollFrame?: () => Promise<CanvasImageSource | null> | CanvasImageSource | null;
  getGifFrame?: () => Promise<CanvasImageSource | null> | CanvasImageSource | null;
  onStatus?: (msg: string) => void;
  /** Override default styling; e.g. position relative to a container. */
  style?: React.CSSProperties;
  /** Show labels alongside icons. */
  compact?: boolean;
}

const BUTTON_STYLE: React.CSSProperties = {
  background: "rgba(0,0,0,0.5)",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 4,
  padding: 4,
  cursor: "pointer",
  color: "#ccc",
  display: "flex",
  alignItems: "center",
  gap: 4,
};

const MENU_ITEM_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  background: "transparent",
  border: "none",
  color: "#eee",
  textAlign: "left",
  cursor: "pointer",
  width: "100%",
};

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export default function CaptureToolbar({
  filenamePrefix,
  getVisible,
  getFull,
  getScrollFrame,
  getGifFrame,
  onStatus,
  style,
  compact = false,
}: CaptureToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [recorder, setRecorder] = useState<GifRecorder | null>(null);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [scroller, setScroller] = useState<ScrollCapture | null>(null);
  const [scrollProgress, setScrollProgress] = useState({ frames: 0, height: 0 });
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Tick the elapsed display while recording.
  useEffect(() => {
    if (recordingStartedAt === null) return;
    const id = window.setInterval(() => {
      setElapsed(Date.now() - recordingStartedAt);
    }, 250);
    return () => window.clearInterval(id);
  }, [recordingStartedAt]);

  // Close menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const baseName = useCallback(
    (ext: "png" | "gif") =>
      `${safeFilePart(filenamePrefix)}-${timestampFilePart()}.${ext}`,
    [filenamePrefix],
  );

  const handleSaveVisible = useCallback(async () => {
    setMenuOpen(false);
    try {
      const blob = await getVisible();
      const saved = await saveBlobToFile(blob, baseName("png"));
      if (saved) {
        onStatus?.(`Saved screenshot to ${saved}`);
      } else {
        onStatus?.("Save canceled");
      }
    } catch (err) {
      onStatus?.(err instanceof Error ? err.message : "Screenshot failed");
    }
  }, [baseName, getVisible, onStatus]);

  const handleCopyVisible = useCallback(async () => {
    setMenuOpen(false);
    try {
      const blob = await getVisible();
      await copyImageBlobToClipboard(blob);
      onStatus?.("Copied screenshot to clipboard");
    } catch (err) {
      onStatus?.(err instanceof Error ? err.message : "Copy to clipboard failed");
    }
  }, [getVisible, onStatus]);

  const handleSaveFull = useCallback(async () => {
    setMenuOpen(false);
    if (!getFull) return;
    try {
      onStatus?.("Capturing scroll screenshot…");
      const blob = await getFull();
      const saved = await saveBlobToFile(blob, baseName("png"));
      if (saved) {
        onStatus?.(`Saved scroll screenshot to ${saved}`);
      } else {
        onStatus?.("Save canceled");
      }
    } catch (err) {
      onStatus?.(err instanceof Error ? err.message : "Scroll capture failed");
    }
  }, [baseName, getFull, onStatus]);

  const handleStartScrollCapture = useCallback(() => {
    setMenuOpen(false);
    if (!getScrollFrame || scroller) return;
    setScrollProgress({ frames: 0, height: 0 });
    const s = startScrollCapture({
      getFrame: getScrollFrame,
      intervalMs: 250,
      onProgress: (info) => setScrollProgress(info),
    });
    setScroller(s);
    onStatus?.("Scroll capture started — scroll the view, then press Stop");
  }, [getScrollFrame, onStatus, scroller]);

  const handleStopScrollCapture = useCallback(async () => {
    if (!scroller) return;
    onStatus?.("Finalizing scroll screenshot…");
    try {
      const blob = await scroller.stop();
      if (blob.size === 0) {
        onStatus?.("Scroll capture stopped (no frames)");
        return;
      }
      const saved = await saveBlobToFile(blob, baseName("png"));
      if (saved) {
        onStatus?.(`Saved scroll screenshot to ${saved}`);
      } else {
        onStatus?.("Save canceled");
      }
    } catch (err) {
      onStatus?.(err instanceof Error ? err.message : "Scroll capture failed");
    } finally {
      setScroller(null);
      setScrollProgress({ frames: 0, height: 0 });
    }
  }, [baseName, onStatus, scroller]);

  const handleStartRecording = useCallback(() => {
    if (!getGifFrame || recorder) return;
    const r = createGifRecorder({
      fps: 10,
      maxFrames: 600,
      maxWidth: 1280,
      getFrame: getGifFrame,
      onFrame: () => {},
    });
    r.start();
    setRecorder(r);
    setRecordingStartedAt(Date.now());
    setElapsed(0);
    onStatus?.("Recording GIF…");
  }, [getGifFrame, onStatus, recorder]);

  const handleStopRecording = useCallback(async () => {
    if (!recorder) return;
    onStatus?.("Encoding GIF…");
    try {
      const blob = await recorder.stop();
      if (blob.size > 0) {
        const saved = await saveBlobToFile(blob, baseName("gif"));
        if (saved) {
          onStatus?.(`Saved GIF (${(blob.size / 1024 / 1024).toFixed(1)} MB) to ${saved}`);
        } else {
          onStatus?.("GIF save canceled");
        }
      } else {
        onStatus?.("Recording stopped (no frames)");
      }
    } catch (err) {
      onStatus?.(err instanceof Error ? err.message : "GIF encoding failed");
    } finally {
      setRecorder(null);
      setRecordingStartedAt(null);
      setElapsed(0);
    }
  }, [baseName, onStatus, recorder]);

  const isRecording = recorder !== null;
  const isScrollCapturing = scroller !== null;

  return (
    <div
      data-testid="capture-toolbar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        ...style,
      }}
    >
      {/* Active-capture pill: only visible while a scroll capture or GIF
       *  recording is running. Tap Stop to finalize. */}
      {isScrollCapturing && (
        <button
          data-testid="capture-stop-scroll"
          onClick={() => void handleStopScrollCapture()}
          style={{
            ...BUTTON_STYLE,
            color: "#5cb8ff",
            borderColor: "rgba(92,184,255,0.6)",
          }}
          title="Stop scroll capture and save"
        >
          <Square size={14} />
          <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>
            {scrollProgress.frames}f
          </span>
        </button>
      )}
      {isRecording && (
        <button
          data-testid="capture-stop-gif"
          onClick={() => void handleStopRecording()}
          style={{
            ...BUTTON_STYLE,
            color: "#ff5050",
            borderColor: "rgba(255,80,80,0.6)",
          }}
          title="Stop GIF recording"
        >
          <Square size={14} />
          <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>
            {formatElapsed(elapsed)}
          </span>
        </button>
      )}

      {/* Single camera button → dropdown with every capture action.
       *  Hides into a 22×22 icon so it never collides with neighbouring
       *  toolbar buttons (e.g. the SFTP toggle). */}
      <div ref={menuRef} style={{ position: "relative" }}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          data-testid="capture-menu"
          style={{
            ...BUTTON_STYLE,
            opacity: menuOpen ? 1 : 0.6,
          }}
          title="Capture"
          aria-label="Capture menu"
        >
          <Camera size={14} />
          {compact ? null : <span>Capture</span>}
          <ChevronDown size={12} />
        </button>
        {menuOpen && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              right: 0,
              marginTop: 2,
              background: "rgba(20,20,28,0.95)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 4,
              minWidth: 220,
              zIndex: 50,
              boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            }}
          >
            <button data-testid="capture-save-visible" onClick={() => void handleSaveVisible()} style={MENU_ITEM_STYLE}>
              <Download size={14} /> Save visible PNG
            </button>
            <button data-testid="capture-copy-clipboard" onClick={() => void handleCopyVisible()} style={MENU_ITEM_STYLE}>
              <Clipboard size={14} /> Copy to clipboard
            </button>
            {getFull && (
              <button data-testid="capture-save-full" onClick={() => void handleSaveFull()} style={MENU_ITEM_STYLE}>
                <FileImage size={14} /> Save full scroll PNG
              </button>
            )}
            {getScrollFrame && (
              <button
                data-testid="capture-toggle-scroll"
                onClick={
                  isScrollCapturing
                    ? () => void handleStopScrollCapture()
                    : handleStartScrollCapture
                }
                style={MENU_ITEM_STYLE}
              >
                <ScrollText size={14} />
                {isScrollCapturing
                  ? `Stop scroll capture (${scrollProgress.frames} frames)`
                  : "Start scroll capture (manual scroll)"}
              </button>
            )}
            {getGifFrame && (
              <button
                data-testid="capture-toggle-gif"
                onClick={isRecording ? () => void handleStopRecording() : handleStartRecording}
                style={MENU_ITEM_STYLE}
              >
                {isRecording ? <Square size={14} /> : <Video size={14} />}
                {isRecording ? `Stop GIF (${formatElapsed(elapsed)})` : "Record GIF"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
