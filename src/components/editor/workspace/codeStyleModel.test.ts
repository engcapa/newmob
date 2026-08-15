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
