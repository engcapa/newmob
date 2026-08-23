export type ResizeCorner = "se" | "sw" | "ne" | "nw";

interface ResizeSessionOptions {
  corner: ResizeCorner;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  minWidth: number;
  minHeight: number;
  maxWidth: () => number;
  maxHeight: () => number;
  onResize: (width: number, height: number) => void;
  onDispose?: () => void;
}

export interface WindowResizeSession {
  dispose(): void;
}

export function startWindowResizeSession(options: ResizeSessionOptions): WindowResizeSession {
  let disposed = false;
  const onMouseMove = (event: MouseEvent) => {
    if (disposed) return;
    const deltaX = event.clientX - options.startX;
    const deltaY = event.clientY - options.startY;
    const horizontalDirection = options.corner === "sw" || options.corner === "nw" ? -1 : 1;
    const verticalDirection = options.corner === "ne" || options.corner === "nw" ? -1 : 1;
    const width = Math.max(
      options.minWidth,
      Math.min(options.maxWidth(), options.startWidth + deltaX * horizontalDirection),
    );
    const height = Math.max(
      options.minHeight,
      Math.min(options.maxHeight(), options.startHeight + deltaY * verticalDirection),
    );
    options.onResize(Math.round(width), Math.round(height));
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", dispose);
    window.removeEventListener("blur", dispose);
    window.removeEventListener("pointercancel", dispose);
    options.onDispose?.();
  };

  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", dispose);
  window.addEventListener("blur", dispose);
  window.addEventListener("pointercancel", dispose);
  return { dispose };
}
