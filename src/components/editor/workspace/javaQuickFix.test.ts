import { describe, expect, it } from "vitest";
import {
  extractJavaIdentifierAtPosition,
  isJavaTypeImported,
  generateJavaImportWorkspaceEdit,
  createJavaImportCodeActions,
} from "./javaQuickFix";

describe("javaQuickFix", () => {
  describe("extractJavaIdentifierAtPosition", () => {
    it("extracts identifier when cursor is in the middle of word", () => {
      const code = "public class Test {\n  private List<String> items;\n}";
      const ident = extractJavaIdentifierAtPosition(code, { line: 1, character: 12 });
      expect(ident).toBe("List");
    });

    it("extracts identifier when cursor is at the end of word", () => {
      const code = "public class Test {\n  private Map<String, Object> map;\n}";
      const ident = extractJavaIdentifierAtPosition(code, { line: 1, character: 13 });
      expect(ident).toBe("Map");
    });

    it("finds JDK class on line if cursor is nearby", () => {
      const code = "public class Test {\n  ArrayList list = new ArrayList();\n}";
      const ident = extractJavaIdentifierAtPosition(code, { line: 1, character: 0 });
      expect(ident).toBe("ArrayList");
    });
  });

  describe("isJavaTypeImported", () => {
    it("detects exact import", () => {
      const code = "package com.example;\n\nimport java.util.List;\n\nclass Test {}";
      expect(isJavaTypeImported(code, "java.util.List", "List")).toBe(true);
      expect(isJavaTypeImported(code, "java.util.Map", "Map")).toBe(false);
    });

    it("detects wildcard import", () => {
      const code = "package com.example;\n\nimport java.util.*;\n\nclass Test {}";
      expect(isJavaTypeImported(code, "java.util.List", "List")).toBe(true);
      expect(isJavaTypeImported(code, "java.io.File", "File")).toBe(false);
    });

    it("detects same package", () => {
      const code = "package java.util;\n\nclass Test {}";
      expect(isJavaTypeImported(code, "java.util.List", "List")).toBe(true);
    });

    it("detects class declared in same file", () => {
      const code = "package com.example;\n\npublic class List {}\n";
      expect(isJavaTypeImported(code, "java.util.List", "List")).toBe(true);
    });
  });

  describe("generateJavaImportWorkspaceEdit", () => {
    it("inserts after existing imports", () => {
      const code = "package com.example;\n\nimport java.io.File;\n\npublic class App {}";
      const edit = generateJavaImportWorkspaceEdit("/repo/App.java", code, "java.util.List");
      expect(edit.documentEdits).toHaveLength(1);
      const textEdit = edit.documentEdits[0]!.edits[0]!;
      expect(textEdit.range.start.line).toBe(3);
      expect(textEdit.newText).toBe("import java.util.List;\n");
    });

    it("inserts after package statement when no imports exist", () => {
      const code = "package com.example;\n\npublic class App {\n  List list;\n}";
      const edit = generateJavaImportWorkspaceEdit("/repo/App.java", code, "java.util.List");
      expect(edit.documentEdits).toHaveLength(1);
      const textEdit = edit.documentEdits[0]!.edits[0]!;
      expect(textEdit.range.start.line).toBe(1);
      expect(textEdit.newText).toBe("\nimport java.util.List;\n");
    });

    it("inserts at top of file when no package or imports exist", () => {
      const code = "public class App {\n  List list;\n}";
      const edit = generateJavaImportWorkspaceEdit("/repo/App.java", code, "java.util.List");
      expect(edit.documentEdits).toHaveLength(1);
      const textEdit = edit.documentEdits[0]!.edits[0]!;
      expect(textEdit.range.start.line).toBe(0);
      expect(textEdit.newText).toBe("import java.util.List;\n\n");
    });

    it("preserves CRLF line endings", () => {
      const code = "package com.example;\r\n\r\npublic class App {}\r\n";
      const edit = generateJavaImportWorkspaceEdit("/repo/App.java", code, "java.util.List");
      const textEdit = edit.documentEdits[0]!.edits[0]!;
      expect(textEdit.newText).toBe("\r\nimport java.util.List;\r\n");
    });
  });

  describe("createJavaImportCodeActions", () => {
    it("generates prioritized code actions for List", () => {
      const code = "package com.example;\n\npublic class App {\n  private List items;\n}";
      const actions = createJavaImportCodeActions("/repo/App.java", code, { line: 3, character: 12 });
      expect(actions).toHaveLength(2);
      expect(actions[0]!.title).toBe("Import 'List' (java.util.List)");
      expect(actions[0]!.isPreferred).toBe(true);
      expect(actions[0]!.kind).toBe("quickfix");
      expect(actions[1]!.title).toBe("Import 'List' (java.awt.List)");
      expect(actions[1]!.isPreferred).toBe(false);
    });

    it("generates code action for single candidate like ArrayList", () => {
      const code = "package com.example;\n\npublic class App {\n  ArrayList items;\n}";
      const actions = createJavaImportCodeActions("/repo/App.java", code, { line: 3, character: 5 });
      expect(actions).toHaveLength(1);
      expect(actions[0]!.title).toBe("Import 'ArrayList' (java.util.ArrayList)");
      expect(actions[0]!.isPreferred).toBe(true);
    });

    it("returns empty when already imported", () => {
      const code = "package com.example;\n\nimport java.util.List;\n\npublic class App {\n  List items;\n}";
      const actions = createJavaImportCodeActions("/repo/App.java", code, { line: 5, character: 5 });
      expect(actions).toHaveLength(0);
    });
  });
});
