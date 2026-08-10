import { beforeEach, describe, expect, it } from "vitest";
import { useVncStore } from "./vncStore";

describe("vncStore", () => {
  beforeEach(() => useVncStore.setState({ connections: {} }));

  it("tracks a complete connection lifecycle per tab", () => {
    const store = useVncStore.getState();
    store.initConnection("tab-a");
    expect(useVncStore.getState().connections["tab-a"].status).toBe("connecting");

    store.setConnecting("tab-a", "session", 1234);
    store.setConnected("tab-a", 1920, 1080, "fixture");
    expect(useVncStore.getState().connections["tab-a"]).toMatchObject({
      status: "connected", sessionId: "session", wsPort: 1234, width: 1920, height: 1080,
    });

    store.setDesktopSize("tab-a", 2560, 1440);
    expect(useVncStore.getState().connections["tab-a"]).toMatchObject({
      status: "connected", width: 2560, height: 1440, name: "fixture",
    });

    store.setDisconnected("tab-a", "network lost");
    expect(useVncStore.getState().connections["tab-a"]).toMatchObject({
      status: "disconnected", error: "network lost",
    });
    store.removeConnection("tab-a");
    expect(useVncStore.getState().connections["tab-a"]).toBeUndefined();
  });

  it("keeps tabs isolated", () => {
    useVncStore.getState().initConnection("a");
    useVncStore.getState().initConnection("b");
    useVncStore.getState().setConnected("a", 1, 2, "a");
    expect(useVncStore.getState().connections.b.status).toBe("connecting");
  });
});
