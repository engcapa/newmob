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
  Square,
  Video,
} from "lucide-react";
import {
  copyImageBlobToClipboard,
  createGifRecorder,
  type GifRecorder,
  saveBlobToFile,
  safeFilePart,
  timestampFilePart,
} from "../../lib/capture";

export interface CaptureToolbarProps {
  filenamePrefix: string;
  getVisible: () => Promise<Blob>;
  getFull?: () => Promise<Blob>;
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
  getGifFrame,
  onStatus,
  style,
  compact = false,
}: CaptureToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [recorder, setRecorder] = useState<GifRecorder | null>(null);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
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
      saveBlobToFile(blob, baseName("png"));
      onStatus?.("Saved screenshot");
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
      saveBlobToFile(blob, baseName("png"));
      onStatus?.("Saved scroll screenshot");
    } catch (err) {
      onStatus?.(err instanceof Error ? err.message : "Scroll capture failed");
    }
  }, [baseName, getFull, onStatus]);

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
        saveBlobToFile(blob, baseName("gif"));
        onStatus?.(`Saved GIF (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
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

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        ...style,
      }}
    >
      {/* Visible screenshot — split button */}
      <div ref={menuRef} style={{ position: "relative" }}>
        <div style={{ display: "flex" }}>
          <button
            onClick={() => void handleSaveVisible()}
            style={{
              ...BUTTON_STYLE,
              borderTopRightRadius: 0,
              borderBottomRightRadius: 0,
            }}
            title="Save visible-area screenshot"
          >
            <Camera size={14} />
            {compact ? null : <span>Screenshot</span>}
          </button>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            style={{
              ...BUTTON_STYLE,
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
              borderLeft: "none",
              padding: "4px 2px",
            }}
            title="Screenshot options"
          >
            <ChevronDown size={12} />
          </button>
        </div>
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
              minWidth: 180,
              zIndex: 50,
              boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            }}
          >
            <button onClick={() => void handleSaveVisible()} style={MENU_ITEM_STYLE}>
              <Download size={14} /> Save visible PNG
            </button>
            <button onClick={() => void handleCopyVisible()} style={MENU_ITEM_STYLE}>
              <Clipboard size={14} /> Copy to clipboard
            </button>
            {getFull && (
              <button onClick={() => void handleSaveFull()} style={MENU_ITEM_STYLE}>
                <FileImage size={14} /> Save full scroll PNG
              </button>
            )}
          </div>
        )}
      </div>

      {/* GIF record */}
      {getGifFrame && (
        <button
          onClick={isRecording ? () => void handleStopRecording() : handleStartRecording}
          style={{
            ...BUTTON_STYLE,
            color: isRecording ? "#ff5050" : "#ccc",
            borderColor: isRecording ? "rgba(255,80,80,0.6)" : "rgba(255,255,255,0.2)",
          }}
          title={isRecording ? "Stop GIF recording" : "Record GIF"}
        >
          {isRecording ? <Square size={14} /> : <Video size={14} />}
          {isRecording ? (
            <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>
              {formatElapsed(elapsed)}
            </span>
          ) : compact ? null : (
            <span>GIF</span>
          )}
        </button>
      )}
    </div>
  );
}
