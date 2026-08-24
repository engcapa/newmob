import { describe, expect, it } from "vitest";
import { copyReferenceCandidates } from "./workspaceCopyReference";

const ROOTS = ["/home/dev/project", "/home/dev/other"];

describe("§8.19.5 Copy Reference candidates", () => {
  it("produces a workspace-relative path:line inside a root", () => {
    const outcome = copyReferenceCandidates({
      path: "/home/dev/project/src/Main.java",
      isLibrary: false,
      roots: ROOTS,
      line: 41,
      symbolName: null,
    });
    if (outcome.kind !== "candidates") throw new Error("expected candidates");
    expect(outcome.candidates).toHaveLength(1);
    // Display lines are 1-based in copied references.
    expect(outcome.candidates[0]).toMatchObject({
      id: "path-line",
      text: "src/Main.java:42",
    });
  });

  it("adds the provider symbol candidate only when identity exists", () => {
    const without = copyReferenceCandidates({
      path: "/home/dev/project/src/Main.java",
      isLibrary: false,
      roots: ROOTS,
      line: 0,
      symbolName: null,
    });
    if (without.kind !== "candidates") throw new Error("expected candidates");
    expect(without.candidates.map((candidate) => candidate.id)).toEqual(["path-line"]);

    const withSymbol = copyReferenceCandidates({
      path: "/home/dev/project/src/Main.java",
      isLibrary: false,
      roots: ROOTS,
      line: 0,
      symbolName: " doWork ",
    });
    if (withSymbol.kind !== "candidates") throw new Error("expected candidates");
    expect(withSymbol.candidates).toHaveLength(2);
    expect(withSymbol.candidates[1]).toMatchObject({ id: "symbol", text: "doWork" });
  });

  it("never fabricates a qualified name from display text", () => {
    // There is no qualified-name candidate kind at all in the model.
    const outcome = copyReferenceCandidates({
      path: "/home/dev/project/src/Main.java",
      isLibrary: false,
      roots: ROOTS,
      line: 0,
      symbolName: "Main",
    });
    if (outcome.kind !== "candidates") throw new Error("expected candidates");
    expect(outcome.candidates.some((candidate) => (candidate.id as string) === "qualified")).toBe(false);
  });

  it("falls back to an explicit absolute format outside every root", () => {
    const outcome = copyReferenceCandidates({
      path: "/tmp/elsewhere/File.ts",
      isLibrary: false,
      roots: ROOTS,
      line: 2,
      symbolName: null,
    });
    if (outcome.kind !== "candidates") throw new Error("expected candidates");
    expect(outcome.candidates[0]).toMatchObject({
      id: "absolute-path-line",
      text: "/tmp/elsewhere/File.ts:3",
    });
  });

  it("refuses library sources with a typed reason", () => {
    const outcome = copyReferenceCandidates({
      path: "/home/dev/project/lib/Dep.class",
      isLibrary: true,
      roots: ROOTS,
      line: 5,
      symbolName: "Dep",
    });
    expect(outcome).toMatchObject({ kind: "unavailable", reason: "library-source" });
  });

  it("refuses when there is no file path at all", () => {
    const outcome = copyReferenceCandidates({
      path: null,
      isLibrary: false,
      roots: ROOTS,
      line: 0,
      symbolName: null,
    });
    expect(outcome).toMatchObject({ kind: "unavailable", reason: "no-file" });
  });

  it("handles Windows drive paths and picks the smallest enclosing root", () => {
    const windowsRoots = ["C:/work/mono", "C:/work/mono/sub"];
    const deep = copyReferenceCandidates({
      path: "C:/work/mono/sub/pkg/A.java",
      isLibrary: false,
      roots: windowsRoots,
      line: 9,
      symbolName: null,
    });
    if (deep.kind !== "candidates") throw new Error("expected candidates");
    expect(deep.candidates[0].text).toBe("pkg/A.java:10");
  });
});
