import { describe, expect, it } from "vitest";
import {
  MAX_COMPLETION_OPTIONS,
  parseLspSnippet,
  recordBasicCompletionInvocation,
  resetCompletionTelemetry,
  toCompletionProviderResult,
} from "./lspCompletion";

describe("§8.18.3 snippet choice placeholders", () => {
  it("keeps the full option list and inlines the first as default", () => {
    const parsed = parseLspSnippet("${1|Alpha,Beta,Gamma|}(${2});");
    expect(parsed.text).toBe("Alpha($2);".replace("$2", ""));
    expect(parsed.placeholders[0].choices).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(parsed.placeholders[0].start).toBe(0);
    expect(parsed.placeholders[0].end).toBe(5);
  });

  it("plain placeholders carry no choice options", () => {
    const parsed = parseLspSnippet("${1:name}: ${2:int}");
    expect(parsed.placeholders[0].choices).toBeUndefined();
    expect(parsed.placeholders[1].choices).toBeUndefined();
  });
});

describe("§8.18.3 invocation ordinal", () => {
  it("counts repeated explicit invocations at the same revision+position", () => {
    resetCompletionTelemetry();
    const base = { workspaceId: "ws", fileKey: "k", reason: "explicit" as const };
    const first = recordBasicCompletionInvocation({ ...base, documentRevision: 4, positionKey: "0:10" });
    const second = recordBasicCompletionInvocation({ ...base, documentRevision: 4, positionKey: "0:10" });
    expect([first, second]).toEqual([1, 2]);
    // Any edit resets the ordinal.
    const afterEdit = recordBasicCompletionInvocation({ ...base, documentRevision: 5, positionKey: "0:12" });
    expect(afterEdit).toBe(1);
  });
});

describe("§8.18.3 provider result envelope", () => {
  const identity = {
    workspaceId: "ws",
    fileKey: "k",
    filePath: "/p/A.java",
    uri: "file:///p/A.java",
    languageId: "java",
    documentRevision: 7,
    lspSessionGeneration: 2,
  };
  const status = { selectedCommandId: "jdtls", displayName: "jdtls" } as never;

  it("classifies missing capability as capability-not-advertised (not empty list)", () => {
    const envelope = toCompletionProviderResult({
      identity,
      result: null,
      statusActive: false,
      capabilityAdvertised: false,
    });
    expect(envelope.kind).toBe("unavailable");
    if (envelope.kind === "unavailable") expect(envelope.reason).toBe("capability-not-advertised");
  });

  it("reports truncation against the 200 cap instead of hiding it", () => {
    const items = Array.from({ length: MAX_COMPLETION_OPTIONS }, (_, index) => ({ label: `m${index}` }));
    const envelope = toCompletionProviderResult({
      identity,
      result: { items, isIncomplete: true, status } as never,
      statusActive: true,
      capabilityAdvertised: true,
    });
    expect(envelope.kind).toBe("available");
    if (envelope.kind === "available") {
      expect(envelope.truncated).toBe(true);
      expect(envelope.isIncomplete).toBe(true);
      expect(envelope.evidence.completeness).toBe("available-partial");
    }
  });

  it("maps a null response for a live provider to stale, not to zero candidates", () => {
    const envelope = toCompletionProviderResult({
      identity,
      result: null,
      statusActive: true,
      capabilityAdvertised: true,
    });
    expect(envelope.kind).toBe("stale");
  });

  it("never fabricates evidence fields the transport did not supply", () => {
    const envelope = toCompletionProviderResult({
      identity,
      result: { items: [{ label: "x" }], isIncomplete: false, status } as never,
      statusActive: true,
      capabilityAdvertised: true,
    });
    if (envelope.kind === "available") {
      expect(envelope.evidence.providerId).toBe("jdtls");
      expect(envelope.truncated).toBe(false);
    }
  });
});
