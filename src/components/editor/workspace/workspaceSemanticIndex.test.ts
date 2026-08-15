import { describe, expect, it } from "vitest";
import {
  abandonWorkspaceSemanticIndexBuild,
  beginWorkspaceSemanticIndexBuild,
  changedWorkspaceSemanticBufferPaths,
  completeWorkspaceSemanticIndexBuild,
  createWorkspaceSemanticIndexSnapshot,
  failWorkspaceSemanticIndexBuild,
  invalidateWorkspaceSemanticIndex,
  recordWorkspaceSemanticIndexQuery,
  setWorkspaceSemanticIndexActiveProviders,
  workspaceSemanticIndexBuildIsCurrent,
  workspaceSemanticIndexIsCurrent,
} from "./workspaceSemanticIndex";

describe("workspaceSemanticIndex", () => {
  it("publishes a ready provider snapshot only for the current revision", () => {
    const initial = createWorkspaceSemanticIndexSnapshot();
    const build = beginWorkspaceSemanticIndexBuild(initial, "language-server", 20);
    const ready = completeWorkspaceSemanticIndexBuild(build.snapshot, build.token, 30);

    expect(ready).toMatchObject({
      status: "ready",
      provider: "language-server",
      indexedRevision: 0,
      revision: 0,
      staleReasons: [],
      invalidatedPaths: [],
    });
    expect(workspaceSemanticIndexIsCurrent(ready)).toBe(true);
    expect(workspaceSemanticIndexBuildIsCurrent(ready, build.token)).toBe(true);
  });

  it("keeps a rebuild stale when a file changes while it is in flight", () => {
    const build = beginWorkspaceSemanticIndexBuild(
      createWorkspaceSemanticIndexSnapshot(),
      "language-server",
      20,
    );
    const changed = invalidateWorkspaceSemanticIndex(
      build.snapshot,
      "document-saved",
      ["/repo/src/main.ts"],
    );
    const completed = completeWorkspaceSemanticIndexBuild(changed, build.token, 30);

    expect(completed.status).toBe("stale");
    expect(completed.revision).toBe(1);
    expect(completed.indexedRevision).toBe(-1);
    expect(completed.invalidatedPaths).toEqual(["/repo/src/main.ts"]);
    expect(workspaceSemanticIndexIsCurrent(completed)).toBe(false);
    expect(workspaceSemanticIndexBuildIsCurrent(completed, build.token)).toBe(false);
    expect(failWorkspaceSemanticIndexBuild(changed, build.token, "obsolete failure")).toMatchObject({
      status: "stale",
      error: null,
      revision: 1,
    });
  });

  it("ignores obsolete completions after a newer generation starts", () => {
    const first = beginWorkspaceSemanticIndexBuild(
      createWorkspaceSemanticIndexSnapshot(),
      "language-server",
    );
    const second = beginWorkspaceSemanticIndexBuild(first.snapshot, "language-server");

    expect(completeWorkspaceSemanticIndexBuild(second.snapshot, first.token))
      .toBe(second.snapshot);
    expect(failWorkspaceSemanticIndexBuild(second.snapshot, first.token, "old failure"))
      .toBe(second.snapshot);
  });

  it("abandons a cancelled build without clearing an older invalidation", () => {
    const stale = invalidateWorkspaceSemanticIndex(
      createWorkspaceSemanticIndexSnapshot(),
      "external-file-change",
      ["src/main.ts"],
    );
    const build = beginWorkspaceSemanticIndexBuild(stale, "language-server");
    const abandoned = abandonWorkspaceSemanticIndexBuild(build.snapshot, build.token);

    expect(abandoned.status).toBe("stale");
    expect(abandoned.staleReasons).toContain("external-file-change");
    expect(abandoned.invalidatedPaths).toEqual(["src/main.ts"]);
  });

  it("tracks bounded invalidations, provider progress, failures, and query provenance", () => {
    let snapshot = createWorkspaceSemanticIndexSnapshot();
    snapshot = invalidateWorkspaceSemanticIndex(snapshot, "external-file-change", ["a.ts", "a.ts", "b.ts"]);
    snapshot = setWorkspaceSemanticIndexActiveProviders(snapshot, ["typescript:/repo"]);
    expect(snapshot.activeProviders).toEqual(["typescript:/repo"]);
    expect(snapshot.status).toBe("building");

    const build = beginWorkspaceSemanticIndexBuild(snapshot, "language-server");
    snapshot = failWorkspaceSemanticIndexBuild(build.snapshot, build.token, "provider stopped");
    snapshot = recordWorkspaceSemanticIndexQuery(snapshot, {
      kind: "references",
      resultCount: 4,
      coverage: {
        scope: "document",
        sessionCount: 1,
        providerCount: 1,
        skippedProviderCount: 0,
        failedProviderCount: 0,
        complete: true,
        truncated: false,
        diagnostics: [],
      },
    }, 50);

    expect(snapshot).toMatchObject({
      status: "error",
      error: "provider stopped",
      invalidatedPaths: ["a.ts", "b.ts"],
      lastQuery: {
        kind: "references",
        resultCount: 4,
        coverage: { scope: "document", complete: true },
        provider: "language-server",
        completedAt: 50,
      },
    });
    expect(workspaceSemanticIndexIsCurrent(snapshot)).toBe(false);
  });

  it("detects only text replacements in already-open semantic buffers", () => {
    expect(changedWorkspaceSemanticBufferPaths({
      a: { path: "src/a.ts", text: "old" },
      closed: { path: "src/closed.ts", text: "same" },
    }, {
      a: { path: "src/a.ts", text: "new" },
      added: { path: "src/added.ts", text: "new" },
    })).toEqual(["src/a.ts"]);
  });
});
