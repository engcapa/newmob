// Minimal types for the parts of gifenc we use.

declare module "gifenc" {
  export interface GifEncoderInstance {
    writeFrame(
      indexed: Uint8Array,
      width: number,
      height: number,
      options?: {
        palette?: number[][];
        delay?: number;
        transparent?: boolean;
        transparentIndex?: number;
        repeat?: number;
        first?: boolean;
        dispose?: number;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(options?: { auto?: boolean }): GifEncoderInstance;

  export type QuantizeFormat = "rgb444" | "rgb565" | "rgba4444";

  export function quantize(
    rgba: Uint8ClampedArray | Uint8Array,
    maxColors: number,
    options?: {
      format?: QuantizeFormat;
      clearAlpha?: boolean;
      clearAlphaThreshold?: number;
      clearAlphaColor?: number;
      oneBitAlpha?: boolean;
    },
  ): number[][];

  export function applyPalette(
    rgba: Uint8ClampedArray | Uint8Array,
    palette: number[][],
    format?: QuantizeFormat,
  ): Uint8Array;

  export function nearestColorIndex(
    palette: number[][],
    pixel: number[],
  ): number;

  export function snapColorsToPalette(
    palette: number[][],
    pixel: number[],
    threshold?: number,
  ): void;
}
