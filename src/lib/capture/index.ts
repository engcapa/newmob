// Shared capture utilities — screenshot (visible + full scrollback) and GIF
// recording — used by terminal, SSH, and VNC tabs.
//
// Design notes:
//   * For canvas-backed views (VNC), we compose visible canvases inside the
//     container into a single PNG/Blob.
//   * For DOM-backed views (xterm with WebGL or DOM renderer), screenshotting
//     the layered canvases directly is fragile across renderer versions; we
//     instead render the active buffer to a 2D canvas using the resolved
//     theme, which works uniformly for visible + full scrollback.
//   * GIF encoding is delegated to gif.js running in a Web Worker.

import type { Terminal, IBufferLine, IBufferCell } from "@xterm/xterm";

import {
  type GifRecorderOptions,
  type GifRecorder,
  createGifRecorder,
} from "./gifRecorder";

import { writeImagePng } from "../clipboard";
import {
  selectSaveFilePath,
  writeStreamOpen,
  writeStreamAppend,
  writeStreamClose,
  writeStreamAbort,
} from "../ipc";

// ── Source helpers ──────────────────────────────────────────────────────

/** Snapshot a single canvas (e.g. VNC) to a PNG blob. */
export async function captureCanvasPng(
  canvas: HTMLCanvasElement,
): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}

/** Compose every <canvas> child of a container into one PNG. */
export async function captureContainerCanvasesPng(
  container: HTMLElement,
): Promise<Blob> {
  const canvases = Array.from(container.querySelectorAll("canvas"));
  if (canvases.length === 0) {
    throw new Error("No canvas to capture");
  }
  if (canvases.length === 1) {
    return captureCanvasPng(canvases[0]);
  }
  const baseRect = container.getBoundingClientRect();
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(baseRect.width));
  out.height = Math.max(1, Math.round(baseRect.height));
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    ctx.drawImage(
      c,
      r.left - baseRect.left,
      r.top - baseRect.top,
      r.width,
      r.height,
    );
  }
  return await new Promise<Blob>((resolve, reject) => {
    out.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}

// ── Xterm rendering ────────────────────────────────────────────────────

export interface XtermCaptureTheme {
  background: string;
  foreground: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  palette?: Partial<Record<number, string>>;
}

const DEFAULT_PALETTE: Record<number, string> = {
  0: "#000000",
  1: "#cd0000",
  2: "#00cd00",
  3: "#cdcd00",
  4: "#0000ee",
  5: "#cd00cd",
  6: "#00cdcd",
  7: "#e5e5e5",
  8: "#7f7f7f",
  9: "#ff0000",
  10: "#00ff00",
  11: "#ffff00",
  12: "#5c5cff",
  13: "#ff00ff",
  14: "#00ffff",
  15: "#ffffff",
};

function ansi256(idx: number): string {
  if (idx < 16) return DEFAULT_PALETTE[idx] ?? "#ffffff";
  if (idx >= 232) {
    const v = (idx - 232) * 10 + 8;
    return `rgb(${v},${v},${v})`;
  }
  const i = idx - 16;
  const r = Math.floor(i / 36) % 6;
  const g = Math.floor(i / 6) % 6;
  const b = i % 6;
  const conv = (n: number) => (n === 0 ? 0 : n * 40 + 55);
  return `rgb(${conv(r)},${conv(g)},${conv(b)})`;
}

function fgColor(cell: IBufferCell, theme: XtermCaptureTheme): string {
  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    return `rgb(${(c >> 16) & 0xff},${(c >> 8) & 0xff},${c & 0xff})`;
  }
  if (cell.isFgPalette()) {
    const idx = cell.getFgColor();
    return theme.palette?.[idx] ?? ansi256(idx);
  }
  return theme.foreground;
}

function bgColor(cell: IBufferCell, theme: XtermCaptureTheme): string | null {
  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    return `rgb(${(c >> 16) & 0xff},${(c >> 8) & 0xff},${c & 0xff})`;
  }
  if (cell.isBgPalette()) {
    const idx = cell.getBgColor();
    return theme.palette?.[idx] ?? ansi256(idx);
  }
  return null;
}

function renderXtermBuffer(
  term: Terminal,
  theme: XtermCaptureTheme,
  startLine: number,
  endLineExclusive: number,
): HTMLCanvasElement {
  const buffer = term.buffer.active;
  const cols = term.cols;
  const lineCount = Math.max(0, endLineExclusive - startLine);
  // Estimate cell width by measuring a representative glyph at the chosen
  // font size. Monospace fonts make every cell the same width.
  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");
  if (!measureCtx) throw new Error("2D context unavailable");
  measureCtx.font = `${theme.fontSize}px ${theme.fontFamily}`;
  const cellWidth = Math.max(1, Math.ceil(measureCtx.measureText("M").width));
  const cellHeight = Math.max(1, Math.round(theme.fontSize * theme.lineHeight));

  const out = document.createElement("canvas");
  // High-DPI: render at 2× to keep text sharp on hidpi screens, but bound the
  // total area so a 100k-line scrollback doesn't OOM the GPU.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = cols * cellWidth;
  const height = lineCount * cellHeight;
  out.width = Math.max(1, Math.round(width * dpr));
  out.height = Math.max(1, Math.round(height * dpr));
  out.style.width = `${width}px`;
  out.style.height = `${height}px`;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "alphabetic";
  ctx.font = `${theme.fontSize}px ${theme.fontFamily}`;

  const tmpCell = (buffer.getLine(0)?.getCell(0) ?? null) as IBufferCell | null;
  if (!tmpCell) return out;

  for (let row = 0; row < lineCount; row++) {
    const line: IBufferLine | undefined = buffer.getLine(startLine + row);
    if (!line) continue;
    const y = row * cellHeight;
    const baseline = y + theme.fontSize;
    for (let col = 0; col < cols; col++) {
      const cell = line.getCell(col, tmpCell);
      if (!cell) continue;
      const chars = cell.getChars();
      const bg = bgColor(cell, theme);
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(col * cellWidth, y, cellWidth, cellHeight);
      }
      if (!chars) continue;
      ctx.fillStyle = fgColor(cell, theme);
      const bold = cell.isBold();
      const italic = cell.isItalic();
      const variant =
        (bold ? "bold " : "") + (italic ? "italic " : "");
      ctx.font = `${variant}${theme.fontSize}px ${theme.fontFamily}`;
      ctx.fillText(chars, col * cellWidth, baseline);
      if (cell.isUnderline()) {
        ctx.fillRect(col * cellWidth, baseline + 2, cellWidth, 1);
      }
    }
  }
  return out;
}

/** Capture only the visible viewport of an xterm. */
export async function captureXtermVisible(
  term: Terminal,
  theme: XtermCaptureTheme,
): Promise<Blob> {
  const canvas = renderXtermVisibleToCanvas(term, theme);
  return await canvasToBlob(canvas);
}

/** Render the visible viewport of an xterm to a fresh 2D canvas. Useful as
 *  a frame source for scroll capture / GIF recording — xterm's WebGL canvas
 *  is created without preserveDrawingBuffer, so reading it via drawImage
 *  often yields blanks. */
export function renderXtermVisibleToCanvas(
  term: Terminal,
  theme: XtermCaptureTheme,
): HTMLCanvasElement {
  const buffer = term.buffer.active;
  const start = buffer.viewportY;
  const end = Math.min(buffer.length, start + term.rows);
  return renderXtermBuffer(term, theme, start, end);
}

/** Capture the full active buffer (scrollback + screen). */
export async function captureXtermFullBuffer(
  term: Terminal,
  theme: XtermCaptureTheme,
): Promise<Blob> {
  const buffer = term.buffer.active;
  const canvas = renderXtermBuffer(term, theme, 0, buffer.length);
  return await canvasToBlob(canvas);
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}

// ── Output helpers ──────────────────────────────────────────────────────

/** Save a blob via the native "Save as" dialog. Returns the chosen path
 *  on success, null when the user cancels. Throws on write errors. */
export async function saveBlobToFile(
  blob: Blob,
  defaultName: string,
): Promise<string | null> {
  const path = await selectSaveFilePath(defaultName);
  if (!path) return null;
  await writeBlobToPath(blob, path);
  return path;
}

async function writeBlobToPath(blob: Blob, path: string): Promise<void> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const handleId = await writeStreamOpen(path);
  try {
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      await writeStreamAppend(handleId, bytes.subarray(offset, end));
    }
    await writeStreamClose(handleId);
  } catch (err) {
    try {
      await writeStreamAbort(handleId);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

/** Write a PNG blob to the system clipboard. */
export async function copyImageBlobToClipboard(blob: Blob): Promise<void> {
  await writeImagePng(blob);
}

export function timestampFilePart(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function safeFilePart(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "capture"
  );
}

// ── GIF re-export ───────────────────────────────────────────────────────

export type { GifRecorderOptions, GifRecorder };
export { createGifRecorder };

// ── Scroll capture ──────────────────────────────────────────────────────
//
// Long screenshot ("scrolling screenshot") flow: while capture is active we
// poll a frame source for the current viewport; each new frame is appended
// to an accumulator, with the largest pixel-equal prefix between the bottom
// of the accumulator and the top of the new frame removed so consecutive
// scrolls don't duplicate the overlapping region.

export interface ScrollCaptureOptions {
  /** Producer of the next viewport frame. */
  getFrame: () => Promise<CanvasImageSource | null> | CanvasImageSource | null;
  /** Polling interval in ms. Default 250. */
  intervalMs?: number;
  /** Max rows of overlap to search when stitching. Default 256. */
  maxOverlap?: number;
  /** Soft cap on output height in pixels to avoid runaway memory. */
  maxHeight?: number;
  onProgress?: (info: { frames: number; height: number }) => void;
}

export interface ScrollCapture {
  stop: () => Promise<Blob>;
  isRunning: () => boolean;
}

export function startScrollCapture(opts: ScrollCaptureOptions): ScrollCapture {
  const intervalMs = Math.max(100, opts.intervalMs ?? 250);
  const maxOverlap = Math.max(8, opts.maxOverlap ?? 256);
  const maxHeight = opts.maxHeight ?? 32768;
  let acc: HTMLCanvasElement | null = null;
  let lastTopRow: Uint8ClampedArray | null = null;
  let frames = 0;
  let running = true;
  let busy = false;
  let stopResolve: ((blob: Blob) => void) | null = null;
  let stopReject: ((err: unknown) => void) | null = null;

  async function tick(): Promise<void> {
    if (!running || busy) return;
    busy = true;
    try {
      const frame = await opts.getFrame();
      if (!frame) return;
      const w =
        (frame as HTMLCanvasElement).width ??
        (frame as HTMLImageElement).naturalWidth ??
        0;
      const h =
        (frame as HTMLCanvasElement).height ??
        (frame as HTMLImageElement).naturalHeight ??
        0;
      if (!w || !h) return;

      // Materialize the new frame as a 2D canvas so we can read its pixels.
      const frameCanvas = document.createElement("canvas");
      frameCanvas.width = w;
      frameCanvas.height = h;
      const frameCtx = frameCanvas.getContext("2d");
      if (!frameCtx) return;
      frameCtx.drawImage(frame, 0, 0);
      const frameTopRow = readRow(frameCtx, 0);

      if (!acc) {
        acc = document.createElement("canvas");
        acc.width = w;
        acc.height = h;
        const accCtx = acc.getContext("2d");
        if (!accCtx) return;
        accCtx.drawImage(frameCanvas, 0, 0);
        lastTopRow = frameTopRow;
        frames = 1;
        opts.onProgress?.({ frames, height: h });
        return;
      }

      // If the very first row of the new frame is identical to the previous
      // first row, the user hasn't scrolled — skip.
      if (lastTopRow && rowsEqual(lastTopRow, frameTopRow)) {
        return;
      }

      // Find the longest prefix of `frameCanvas` that already exists at the
      // bottom of `acc`. We compare row-by-row.
      const overlap = findOverlap(acc, frameCanvas, maxOverlap);
      const newRows = h - overlap;
      if (newRows <= 0) {
        lastTopRow = frameTopRow;
        return;
      }
      if (acc.height + newRows > maxHeight) {
        // Refuse to grow beyond budget; drop excess.
        running = false;
      }
      const next = document.createElement("canvas");
      next.width = Math.max(acc.width, w);
      next.height = Math.min(acc.height + newRows, maxHeight);
      const ctx = next.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(acc, 0, 0);
      ctx.drawImage(
        frameCanvas,
        0,
        overlap,
        w,
        newRows,
        0,
        acc.height,
        w,
        Math.min(newRows, next.height - acc.height),
      );
      acc = next;
      lastTopRow = frameTopRow;
      frames++;
      opts.onProgress?.({ frames, height: acc.height });
    } finally {
      busy = false;
    }
  }

  const timer = window.setInterval(() => {
    void tick();
  }, intervalMs);

  async function stop(): Promise<Blob> {
    running = false;
    window.clearInterval(timer);
    let waits = 0;
    while (busy && waits < 50) {
      await new Promise((r) => setTimeout(r, 20));
      waits++;
    }
    if (!acc) {
      const empty = new Blob([], { type: "image/png" });
      stopResolve?.(empty);
      return empty;
    }
    const blob = await canvasToBlob(acc);
    stopResolve?.(blob);
    return blob;
  }

  return {
    stop() {
      return new Promise<Blob>((resolve, reject) => {
        stopResolve = resolve;
        stopReject = reject;
        void stop().catch((err) => stopReject?.(err));
      });
    },
    isRunning: () => running,
  };
}

function readRow(ctx: CanvasRenderingContext2D, y: number): Uint8ClampedArray {
  return ctx.getImageData(0, y, ctx.canvas.width, 1).data;
}

function rowsEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function findOverlap(
  acc: HTMLCanvasElement,
  frame: HTMLCanvasElement,
  maxRows: number,
): number {
  const accCtx = acc.getContext("2d");
  const frameCtx = frame.getContext("2d");
  if (!accCtx || !frameCtx) return 0;
  if (acc.width !== frame.width) return 0;

  const width = acc.width;
  const limit = Math.min(maxRows, acc.height, frame.height);
  if (limit === 0) return 0;

  // One getImageData per side, then row-by-row compare.
  const accBottom = accCtx.getImageData(0, acc.height - limit, width, limit).data;
  const frameTop = frameCtx.getImageData(0, 0, width, limit).data;
  const rowBytes = width * 4;

  // Try the largest possible overlap first; fall back to smaller.
  for (let overlap = limit; overlap >= 1; overlap--) {
    const accStart = (limit - overlap) * rowBytes;
    let match = true;
    for (let y = 0; y < overlap && match; y++) {
      const a = accStart + y * rowBytes;
      const b = y * rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        if (accBottom[a + i] !== frameTop[b + i]) {
          match = false;
          break;
        }
      }
    }
    if (match) return overlap;
  }
  return 0;
}
