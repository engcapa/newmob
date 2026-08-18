import { beforeEach, describe, expect, it } from "vitest";
import {
  DefaultEditorConfigResolver,
  type EditorConfigFileProvider,
} from "./editorConfigResolver";

describe("editorConfigResolver", () => {
  let resolver: DefaultEditorConfigResolver;
  let virtualFiles: Map<string, string>;

  beforeEach(() => {
    virtualFiles = new Map<string, string>();
    const fileProvider: EditorConfigFileProvider = {
      readFile: async (path) => virtualFiles.get(path) ?? null,
      fileExists: async (path) => virtualFiles.has(path),
    };
    resolver = new DefaultEditorConfigResolver(fileProvider);
  });

  it("resolves language default indentation when no .editorconfig exists", async () => {
    const javaResult = await resolver.resolveForFile({
      workspaceId: "w1",
      filePath: "/project/src/Main.java",
    });
    expect(javaResult.tabSize).toBe(4);
    expect(javaResult.insertSpaces).toBe(true);
    expect(javaResult.source).toBe("language-default");

    const tsResult = await resolver.resolveForFile({
      workspaceId: "w1",
      filePath: "/project/src/index.ts",
    });
    expect(tsResult.tabSize).toBe(2);
    expect(tsResult.insertSpaces).toBe(true);
    expect(tsResult.source).toBe("language-default");

    const goResult = await resolver.resolveForFile({
      workspaceId: "w1",
      filePath: "/project/main.go",
    });
    expect(goResult.insertSpaces).toBe(false);
    expect(goResult.source).toBe("language-default");
  });

  it("applies .editorconfig properties and tracks field provenance", async () => {
    virtualFiles.set(
      "/project/.editorconfig",
      `root = true

[*]
indent_style = space
indent_size = 4
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.ts]
indent_size = 2
`
    );

    const tsResult = await resolver.resolveForFile({
      workspaceId: "w1",
      filePath: "/project/src/index.ts",
    });

    expect(tsResult.insertSpaces).toBe(true);
    expect(tsResult.indentSize).toBe(2);
    expect(tsResult.endOfLine).toBe("lf");
    expect(tsResult.charset).toBe("utf-8");
    expect(tsResult.trimTrailingWhitespace).toBe(true);
    expect(tsResult.insertFinalNewline).toBe(true);
    expect(tsResult.source).toBe("editorconfig");
    expect(tsResult.provenance.indent_size?.source).toBe("editorconfig");
    expect(tsResult.provenance.end_of_line?.source).toBe("editorconfig");
  });

  it("merges nested .editorconfig and stops climbing when root=true", async () => {
    // Root level editorconfig
    virtualFiles.set(
      "/project/.editorconfig",
      `root = true

[*]
indent_style = space
indent_size = 4
`
    );

    // Subdirectory editorconfig overriding indent_size for java
    virtualFiles.set(
      "/project/submodule/.editorconfig",
      `[*]
indent_size = 2
`
    );

    const subJava = await resolver.resolveForFile({
      workspaceId: "w1",
      filePath: "/project/submodule/src/Test.java",
    });
    expect(subJava.indentSize).toBe(2);
    expect(subJava.provenance.indent_size?.configPath).toBe("/project/submodule/.editorconfig");
  });

  it("prioritizes explicit user override over EditorConfig while preserving non-indentation properties", async () => {
    virtualFiles.set(
      "/project/.editorconfig",
      `root = true
[*]
indent_size = 4
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
`
    );

    const result = await resolver.resolveForFile({
      workspaceId: "w1",
      filePath: "/project/src/Main.java",
      explicitOverride: { type: "tabs", size: 8 },
    });

    expect(result.insertSpaces).toBe(false);
    expect(result.tabSize).toBe(8);
    expect(result.source).toBe("explicit-override");
    expect(result.provenance.indent_style?.source).toBe("explicit");
    expect(result.endOfLine).toBe("lf");
    expect(result.charset).toBe("utf-8");
    expect(result.trimTrailingWhitespace).toBe(true);
    expect(result.provenance.end_of_line?.source).toBe("editorconfig");
  });

  it("falls back to sniffed indentation when EditorConfig is not set and file text differs", async () => {
    const textWith4Spaces = `function test() {
    const a = 1;
    const b = 2;
}`;

    // TypeScript normally defaults to 2 spaces, but text clearly uses 4 spaces
    const result = await resolver.resolveForFile({
      workspaceId: "w1",
      filePath: "/project/src/app.ts",
      text: textWith4Spaces,
    });

    expect(result.indentSize).toBe(4);
    expect(result.source).toBe("sniffed");
    expect(result.provenance.indent_size?.source).toBe("sniffed");
  });

  it("does not suppress indentation sniffing when .editorconfig only configures non-indent fields like EOL/charset", async () => {
    virtualFiles.set(
      "/project/.editorconfig",
      `root = true
[*]
end_of_line = lf
charset = utf-8
`
    );

    const textWith4Spaces = `function test() {
    const a = 1;
    const b = 2;
}`;

    const result = await resolver.resolveForFile({
      workspaceId: "w1",
      filePath: "/project/src/app.ts",
      text: textWith4Spaces,
    });

    // Indentation should be sniffed (4 spaces) instead of falling into editorconfig or language default 2
    expect(result.indentSize).toBe(4);
    expect(result.source).toBe("sniffed");
    expect(result.provenance.indent_size?.source).toBe("sniffed");
    // While end_of_line and charset come from editorconfig
    expect(result.endOfLine).toBe("lf");
    expect(result.charset).toBe("utf-8");
    expect(result.provenance.end_of_line?.source).toBe("editorconfig");
  });

  it("isolates cache per workspaceId and clearWorkspace only invalidates that workspace", async () => {
    resolver.setCachedConfigFile("/project/.editorconfig", "root = true\n[*]\nindent_size = 8\n", "w1");
    resolver.setCachedConfigFile("/project/.editorconfig", "root = true\n[*]\nindent_size = 2\n", "w2");

    const w1Res = await resolver.resolveForFile({ workspaceId: "w1", filePath: "/project/src/index.ts" });
    const w2Res = await resolver.resolveForFile({ workspaceId: "w2", filePath: "/project/src/index.ts" });

    expect(w1Res.indentSize).toBe(8);
    expect(w2Res.indentSize).toBe(2);

    resolver.clearWorkspace("w1");

    // w2 should still have its cached config
    const w2After = await resolver.resolveForFile({ workspaceId: "w2", filePath: "/project/src/index.ts" });
    expect(w2After.indentSize).toBe(2);
  });
});
