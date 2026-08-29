import { describe, expect, it } from "vitest";
import {
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
      createdAt: 100,
    },
    {
      id: "b-file-readonly",
      fileKey: "fileA.ts",
      category: "read-only",
      severity: "info",
      title: "File is Read-Only",
      priority: 100,
      createdAt: 200,
    },
    {
      id: "b-file-encoding",
      fileKey: "fileB.ts",
      category: "encoding-mismatch",
      severity: "error",
      title: "Encoding Mismatch",
      priority: 90,
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
    const active = selectActiveBanners(sampleBanners, "fileA.ts", new Set(["b-file-readonly"]));
    expect(active.map((b) => b.id)).toEqual(["b-global-degraded"]);
  });
});
