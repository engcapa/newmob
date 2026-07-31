import { describe, expect, it } from "vitest";
import { StrictMode, createElement, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { useMountedRef } from "./useMountedRef";

/** Renders the hook and exposes the ref it returns to the test. */
function harness(wrapper?: (children: ReactNode) => ReactNode) {
  const seen: { ref: { current: boolean } | null } = { ref: null };
  function Probe() {
    seen.ref = useMountedRef();
    return null;
  }
  const element = createElement(Probe);
  const view = render(wrapper ? (wrapper(element) as never) : element);
  return { seen, view };
}

describe("useMountedRef", () => {
  it("stays armed after StrictMode's mount → cleanup → remount double-invoke", () => {
    // The regression this guards: without re-arming on mount the StrictMode
    // cleanup leaves the ref false forever, so every `if (!mountedRef.current)
    // return` guard silently aborts (e.g. the Java Debug button resolved the
    // main class and then dropped the launch with no message).
    const { seen } = harness((children) => createElement(StrictMode, null, children));
    expect(seen.ref?.current).toBe(true);
  });

  it("is armed on a plain mount and disarmed on unmount", () => {
    const { seen, view } = harness();
    expect(seen.ref?.current).toBe(true);
    view.unmount();
    expect(seen.ref?.current).toBe(false);
  });
});
