import { afterEach, describe, expect, it, vi } from "vitest";
import { startWindowResizeSession } from "./windowResizeSession";

afterEach(() => vi.restoreAllMocks());

describe("startWindowResizeSession", () => {
  it("updates dimensions and removes every listener on pointer cancellation", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const onResize = vi.fn();
    startWindowResizeSession({
      corner: "se",
      startX: 100,
      startY: 100,
      startWidth: 300,
      startHeight: 200,
      minWidth: 280,
      minHeight: 140,
      maxWidth: () => 600,
      maxHeight: () => 500,
      onResize,
    });

    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 150, clientY: 180 }));
    expect(onResize).toHaveBeenCalledWith(350, 280);
    window.dispatchEvent(new Event("pointercancel"));
    expect(removeSpy.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(["mousemove", "mouseup", "blur", "pointercancel"]),
    );

    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 200 }));
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it("clamps north-west resize to configured bounds", () => {
    const onResize = vi.fn();
    const session = startWindowResizeSession({
      corner: "nw",
      startX: 100,
      startY: 100,
      startWidth: 300,
      startHeight: 200,
      minWidth: 280,
      minHeight: 140,
      maxWidth: () => 400,
      maxHeight: () => 300,
      onResize,
    });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 500, clientY: 500 }));
    expect(onResize).toHaveBeenCalledWith(280, 140);
    session.dispose();
  });
});
