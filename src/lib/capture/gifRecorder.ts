// GIF recorder — driven by a frame source callback.
//
// Uses gifenc (tiny, dependency-free, no Web Worker required) under the hood.
// The recorder pulls frames at a fixed cadence by calling getFrame() and feeds
// them into the encoder; stop() resolves to a Blob.
//
// Memory budget is bounded by `maxFrames` because gifenc accumulates frame
// bytes in memory before flushing.

import { GIFEncoder, quantize, applyPalette } from "gifenc";

export interface GifRecorderOptions {
  fps: number;
  maxFrames?: number;
  /**
   * Producer of the next frame. Should return a CanvasImageSource (canvas,
   * ImageBitmap, etc.). Called on the recorder's tick.
   */
  getFrame: () => Promise<CanvasImageSource | null> | CanvasImageSource | null;
  /** Maximum encoded width in CSS pixels. The frame is downscaled to fit. */
  maxWidth?: number;
  onFrame?: (count: number) => void;
}

export interface GifRecorder {
  start: () => void;
  stop: () => Promise<Blob>;
  isRecording: () => boolean;
  framesCaptured: () => number;
}

export function createGifRecorder(opts: GifRecorderOptions): GifRecorder {
  const fps = Math.max(1, Math.min(30, opts.fps));
  const interval = 1000 / fps;
  const maxFrames = opts.maxFrames ?? fps * 60;
  const maxWidth = opts.maxWidth ?? 1280;

  let encoder: ReturnType<typeof GIFEncoder> | null = null;
  let scratch: HTMLCanvasElement | null = null;
  let timer: number | null = null;
  let recording = false;
  let captured = 0;
  let stopResolve: ((blob: Blob) => void) | null = null;
  let stopReject: ((err: unknown) => void) | null = null;
  let busy = false;

  function ensureScratch(width: number, height: number): HTMLCanvasElement {
    if (!scratch || scratch.width !== width || scratch.height !== height) {
      scratch = document.createElement("canvas");
      scratch.width = width;
      scratch.height = height;
    }
    return scratch;
  }

  async function tick(): Promise<void> {
    if (!recording || busy) return;
    busy = true;
    try {
      const frame = await opts.getFrame();
      if (!frame) return;
      const naturalWidth =
        (frame as HTMLCanvasElement).width ??
        (frame as HTMLImageElement).naturalWidth ??
        0;
      const naturalHeight =
        (frame as HTMLCanvasElement).height ??
        (frame as HTMLImageElement).naturalHeight ??
        0;
      if (!naturalWidth || !naturalHeight) return;
      const scale = naturalWidth > maxWidth ? maxWidth / naturalWidth : 1;
      const w = Math.max(1, Math.round(naturalWidth * scale));
      const h = Math.max(1, Math.round(naturalHeight * scale));
      const canvas = ensureScratch(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(frame, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      if (!encoder) encoder = GIFEncoder();
      const palette = quantize(data.data, 256, { format: "rgb444" });
      const indexed = applyPalette(data.data, palette, "rgb444");
      encoder.writeFrame(indexed, w, h, { palette, delay: Math.round(interval) });
      captured++;
      opts.onFrame?.(captured);
      if (captured >= maxFrames) {
        await stop();
      }
    } finally {
      busy = false;
    }
  }

  async function stop(): Promise<Blob> {
    if (!recording) {
      return new Blob([], { type: "image/gif" });
    }
    recording = false;
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    // Wait for any in-flight tick to release the lock.
    let waits = 0;
    while (busy && waits < 50) {
      await new Promise((r) => setTimeout(r, 20));
      waits++;
    }
    try {
      if (!encoder) {
        const empty = new Blob([], { type: "image/gif" });
        stopResolve?.(empty);
        return empty;
      }
      encoder.finish();
      const buffer = encoder.bytes();
      const blob = new Blob([buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer], { type: "image/gif" });
      stopResolve?.(blob);
      return blob;
    } catch (err) {
      stopReject?.(err);
      throw err;
    } finally {
      encoder = null;
      scratch = null;
    }
  }

  return {
    start() {
      if (recording) return;
      recording = true;
      captured = 0;
      timer = window.setInterval(() => {
        void tick();
      }, interval);
    },
    stop() {
      return new Promise<Blob>((resolve, reject) => {
        stopResolve = resolve;
        stopReject = reject;
        void stop();
      });
    },
    isRecording: () => recording,
    framesCaptured: () => captured,
  };
}
