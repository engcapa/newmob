import { describe, expect, it } from "vitest";
import {
  editorBannerDismissalKey,
  selectActiveBanners,
  type EditorBannerItem,
} from "./editorBannerModel";

describe("editorBannerModel", () => {
  const sampleBanners: EditorBannerItem[] = [
    {
      id: "b-global-degraded",
      category: "indexing-degraded",
      severity: "warning",
      title: "Language Server Degraded",
      priority: 50,
      conditionGeneration: "provider-1",
      createdAt: 100,
    },
    {
      id: "b-file-readonly",
      fileKey: "fileA.ts",
      category: "read-only",
      severity: "info",
      title: "File is Read-Only",
      priority: 100,
      conditionGeneration: "readonly-1",
      createdAt: 200,
    },
    {
      id: "b-file-encoding",
      fileKey: "fileB.ts",
      category: "encoding-mismatch",
      severity: "error",
      title: "Encoding Mismatch",
      priority: 90,
      conditionGeneration: "encoding-1",
      createdAt: 300,
    },
  ];

  it("filters banners by active file and orders by priority descending", () => {
    const activeA = selectActiveBanners(sampleBanners, "fileA.ts", new Set());
    expect(activeA.map((b) => b.id)).toEqual(["b-file-readonly", "b-global-degraded"]);

    const activeB = selectActiveBanners(sampleBanners, "fileB.ts", new Set());
    expect(activeB.map((b) => b.id)).toEqual(["b-file-encoding", "b-global-degraded"]);

    const activeNone = selectActiveBanners(sampleBanners, null, new Set());
    expect(activeNone.map((b) => b.id)).toEqual(["b-global-degraded"]);
  });

  it("excludes dismissed banners", () => {
    const active = selectActiveBanners(
      sampleBanners,
      "fileA.ts",
      new Set([editorBannerDismissalKey(sampleBanners[1]!)]),
    );
    expect(active.map((b) => b.id)).toEqual(["b-global-degraded"]);
  });

  it("dismisses only the condition generation that was acknowledged", () => {
    const first = sampleBanners[1]!;
    const nextGeneration = { ...first, conditionGeneration: "readonly-2" };
    const dismissed = new Set([editorBannerDismissalKey(first)]);

    expect(selectActiveBanners([first], "fileA.ts", dismissed)).toEqual([]);
    expect(selectActiveBanners([nextGeneration], "fileA.ts", dismissed)).toEqual([nextGeneration]);
  });

  it("uses the banner id as a deterministic final ordering tie-breaker", () => {
    const tied = [
      { ...sampleBanners[0]!, id: "z-banner", conditionGeneration: "g1" },
      { ...sampleBanners[0]!, id: "a-banner", conditionGeneration: "g1" },
    ];
    expect(selectActiveBanners(tied, "fileA.ts", new Set()).map((banner) => banner.id))
      .toEqual(["a-banner", "z-banner"]);
  });
});
