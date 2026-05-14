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
  const buffer = term.buffer.active;
  const start = buffer.viewportY;
  const end = Math.min(buffer.length, start + term.rows);
  const canvas = renderXtermBuffer(term, theme, start, end);
  return await canvasToBlob(canvas);
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

/** Save a blob to disk via a download link. */
export function saveBlobToFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
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
