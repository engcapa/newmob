import { describe, expect, it } from "vitest";
import {
  globToRegex,
  matchEditorConfig,
  parseEditorConfigFile,
} from "./editorConfigParser";

describe("editorConfigParser", () => {
  it("converts glob patterns to regex correctly", () => {
    expect(globToRegex("*.ts").test("main.ts")).toBe(true);
    expect(globToRegex("*.ts").test("src/main.ts")).toBe(false);
    expect(globToRegex("**.ts").test("src/sub/main.ts")).toBe(true);
    expect(globToRegex("*.{js,ts,jsx,tsx}").test("app.tsx")).toBe(true);
    expect(globToRegex("*.{js,ts,jsx,tsx}").test("app.rs")).toBe(false);
  });

  it("parses .editorconfig file into root flag and sections", () => {
    const content = `
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.java]
indent_size = 4
tab_width = 4

[*.go]
indent_style = tab
indent_size = tab
tab_width = 4
`;
    const parsed = parseEditorConfigFile(content);
    expect(parsed.isRoot).toBe(true);
    expect(parsed.sections.length).toBe(3);

    const javaProps = matchEditorConfig(parsed, "src/main/App.java");
    expect(javaProps.indent_style).toBe("space");
    expect(javaProps.indent_size).toBe(4);
    expect(javaProps.end_of_line).toBe("lf");

    const goProps = matchEditorConfig(parsed, "pkg/server/main.go");
    expect(goProps.indent_style).toBe("tab");
    expect(goProps.indent_size).toBe("tab");
    expect(goProps.tab_width).toBe(4);

    const tsProps = matchEditorConfig(parsed, "src/index.ts");
    expect(tsProps.indent_style).toBe("space");
    expect(tsProps.indent_size).toBe(2);
  });
});
