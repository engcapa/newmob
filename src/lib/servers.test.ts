import { describe, expect, it } from "vitest";
import { defaultConfig } from "./servers";

describe("RDP server defaults", () => {
  it("starts loopback-only and follows the primary display", () => {
    expect(defaultConfig("rdp")).toMatchObject({
      bindAddress: "127.0.0.1",
      securityMode: "hybrid",
      viewOnly: false,
      displayId: "",
      requireControlApproval: true,
    });
  });
});
