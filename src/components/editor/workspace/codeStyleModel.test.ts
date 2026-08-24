import { describe, expect, it } from "vitest";
import {
  defaultLanguageCodeStyle,
  resolveEffectiveCodeStyle,
  sniffIndentation,
} from "./codeStyleModel";

describe("codeStyleModel", () => {
  it("computes default language code styles and sniffs indentation correctly", () => {
    expect(defaultLanguageCodeStyle("main.go").insertSpaces).toBe(false);
    expect(defaultLanguageCodeStyle("App.java").indentSize).toBe(4);
    expect(defaultLanguageCodeStyle("index.ts").indentSize).toBe(2);

    expect(sniffIndentation("\t\tline1\n\t\tline2").type).toBe("tabs");
    expect(sniffIndentation("  line1\n  line2").size).toBe(2);
    expect(sniffIndentation("    line1\n    line2").size).toBe(4);
  });

  it("resolves language default style when no override or editorconfig", () => {
    // Go defaults to tab
    const goStyle = resolveEffectiveCodeStyle({ filePath: "main.go" });
    expect(goStyle.insertSpaces).toBe(false);
    expect(goStyle.tabSize).toBe(4);
    expect(goStyle.source).toBe("language-default");

    // Java defaults to 4 spaces
    const javaStyle = resolveEffectiveCodeStyle({ filePath: "App.java" });
    expect(javaStyle.insertSpaces).toBe(true);
    expect(javaStyle.indentSize).toBe(4);
    expect(javaStyle.source).toBe("language-default");

    // TypeScript defaults to 2 spaces
    const tsStyle = resolveEffectiveCodeStyle({ filePath: "index.ts" });
    expect(tsStyle.insertSpaces).toBe(true);
    expect(tsStyle.indentSize).toBe(2);
    expect(tsStyle.source).toBe("language-default");
  });

  it("sniffs indentation when differing from language default", () => {
    const javaWith2Spaces = `public class App {
  public static void main(String[] args) {
    System.out.println("Hello");
  }
}`;
    const style = resolveEffectiveCodeStyle({
      filePath: "App.java",
      text: javaWith2Spaces,
    });
    expect(style.insertSpaces).toBe(true);
    expect(style.indentSize).toBe(2);
    expect(style.source).toBe("sniffed");
    expect(style.label).toBe("Spaces: 2 (Auto)");
  });

  it("prioritizes EditorConfig over language default and sniffing", () => {
    const javaWith2Spaces = `public class App {
  public static void main(String[] args) {
    System.out.println("Hello");
  }
}`;
    const style = resolveEffectiveCodeStyle({
      filePath: "App.java",
      text: javaWith2Spaces,
      editorConfigProperties: {
        indent_style: "space",
        indent_size: 4,
      },
    });
    expect(style.insertSpaces).toBe(true);
    expect(style.indentSize).toBe(4);
    expect(style.source).toBe("editorconfig");
    expect(style.label).toBe("Spaces: 4 (EditorConfig)");
  });

  it("prioritizes explicit user override above all", () => {
    const style = resolveEffectiveCodeStyle({
      filePath: "App.java",
      explicitOverride: { type: "tabs", size: 4 },
      editorConfigProperties: {
        indent_style: "space",
        indent_size: 4,
      },
    });
    expect(style.insertSpaces).toBe(false);
    expect(style.tabSize).toBe(4);
    expect(style.source).toBe("explicit-override");
    expect(style.label).toBe("Tab: 4 (Manual)");
  });
});

describe("§8.19.9 R8-D scheme precedence layer", () => {
  it("overrides language defaults and suppresses sniffing", () => {
    const style = resolveEffectiveCodeStyle({
      filePath: "App.java",
      text: "def mixed_indent():\n  return 1\n",
      activeSchemeFields: { insertSpaces: true, indentSize: 4, tabSize: 4 },
    });
    expect(style.source).toBe("scheme");
    expect(style.insertSpaces).toBe(true);
    expect(style.indentSize).toBe(4);
    expect(style.label).toBe("Spaces: 4 (Scheme)");
  });

  it("fills unspecified fields from the language default", () => {
    const style = resolveEffectiveCodeStyle({
      filePath: "App.java",
      activeSchemeFields: { endOfLine: "crlf", trimTrailingWhitespace: false },
    });
    expect(style.source).toBe("scheme");
    expect(style.indentSize).toBe(4); // java default
    expect(style.continuationIndent).toBe(8);
    expect(style.endOfLine).toBe("crlf");
    expect(style.trimTrailingWhitespace).toBe(false);
  });

  it("stays below EditorConfig and the explicit override", () => {
    const editorConfigWins = resolveEffectiveCodeStyle({
      filePath: "App.java",
      editorConfigProperties: { indent_style: "tab", indent_size: 2 },
      activeSchemeFields: { insertSpaces: true, indentSize: 8 },
    });
    expect(editorConfigWins.source).toBe("editorconfig");
    expect(editorConfigWins.insertSpaces).toBe(false); // EditorConfig indent wins
    // EditorConfig didn't set EOL → scheme fills the gap even in that branch.
    const eolFilled = resolveEffectiveCodeStyle({
      filePath: "App.java",
      editorConfigProperties: { indent_style: "space" },
      activeSchemeFields: { endOfLine: "lf", insertSpaces: false, indentSize: 9 },
    });
    expect(eolFilled.source).toBe("editorconfig");
    expect(eolFilled.endOfLine).toBe("lf");
    expect(eolFilled.indentSize).not.toBe(9); // scheme indentation does NOT win

    const overrideWins = resolveEffectiveCodeStyle({
      filePath: "App.java",
      explicitOverride: { type: "tabs", size: 4 },
      activeSchemeFields: { insertSpaces: true, indentSize: 8 },
    });
    expect(overrideWins.source).toBe("explicit-override");
    expect(overrideWins.label).toBe("Tab: 4 (Manual)");
  });

  it("keeps plain resolution untouched when no scheme is active", () => {
    const style = resolveEffectiveCodeStyle({ filePath: "main.go" });
    expect(style.source).toBe("language-default");
    expect(style.insertSpaces).toBe(false);
  });
});
