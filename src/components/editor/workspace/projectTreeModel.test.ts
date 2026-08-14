import { describe, expect, it } from "vitest";
import type { GitChange } from "../../../lib/git";
import type { WorkspaceEntry } from "../../../lib/editor/workspace";
import {
  applyEditorEol,
  compactEntryName,
  flatExtensionGroup,
  flatSourceGroup,
  flatSourceRelativePath,
  gitChangeForPath,
  gitDirectoryChangeCount,
  isFlatViewSourceFile,
  languageSourceRootFor,
  libraryLanguagePath,
  looksLikeDocumentUri,
  makeLibraryFile,
  matchesTreeFilter,
  normalizeEditorText,
  normalizeFsPath,
  relativePathWithinRoot,
  fsPathEquals,
  shouldHideEntry,
  type LibraryBufferInfo,
} from "./codeWorkspaceModel";

const entry = (name: string, path: string): WorkspaceEntry => ({
  name,
  path,
  fileType: "dir",
  size: 0,
  mtime: 0,
  isHidden: false,
});

describe("project tree model helpers", () => {
  it("normalizes lexical dot segments without allowing a path to escape an absolute root", () => {
    expect(normalizeFsPath("/repo/src/../outside.ts")).toBe("/repo/outside.ts");
    expect(normalizeFsPath("/repo/./src//Main.ts/")).toBe("/repo/src/Main.ts");
    expect(normalizeFsPath("src/../../outside.ts")).toBe("../outside.ts");
    expect(relativePathWithinRoot("/repo", "/repo/src/../outside.ts")).toBe("outside.ts");
    expect(relativePathWithinRoot("/repo", "/repo/../outside.ts")).toBeNull();
  });

  it("keeps Windows drive and UNC roots segment-safe and case-insensitive", () => {
    expect(normalizeFsPath("C:\\repo\\src\\..\\Main.java\\")).toBe("C:/repo/Main.java");
    expect(normalizeFsPath("\\\\server\\share\\repo\\src\\..\\Main.java")).toBe("//server/share/repo/Main.java");
    expect(relativePathWithinRoot("C:\\Repo", "c:/repo/src/../Main.java")).toBe("Main.java");
    expect(relativePathWithinRoot("C:\\Repo", "C:/repository/Main.java")).toBeNull();
    expect(relativePathWithinRoot("\\\\server\\share\\repo", "\\\\SERVER\\SHARE\\repo\\src\\Main.java")).toBe("src/Main.java");
    expect(fsPathEquals("C:\\Repo\\src\\..\\Main.java", "c:/repo/Main.java")).toBe(true);
  });

  it("does not reinterpret virtual document URIs as filesystem paths", () => {
    expect(normalizeFsPath("jdt://contents/java.base/String.class")).toBe("jdt://contents/java.base/String.class");
    expect(normalizeFsPath("file:///repo/src/../Main.java")).toBe("file:///repo/src/../Main.java");
    expect(relativePathWithinRoot("/repo", "jdt://contents/String.class")).toBeNull();
  });

  it("keeps POSIX path comparisons case-sensitive even when a name contains a backslash", () => {
    expect(fsPathEquals("/Repo/Name.ts", "/repo/name.ts")).toBe(false);
    expect(fsPathEquals("/Repo\\Name.ts", "/repo\\name.ts")).toBe(false);
  });

  it("compactEntryName folds single-child chain suffixes", () => {
    expect(compactEntryName(entry("src", "src"), undefined)).toBe("src");
    expect(compactEntryName(entry("src", "src"), { path: "src" })).toBe("src");
    expect(compactEntryName(entry("src", "src"), { path: "src/main/java" })).toBe("src/main/java");
  });

  it("flatExtensionGroup keys by lowercase extension", () => {
    expect(flatExtensionGroup("a/b/Foo.TS")).toBe(".ts");
    expect(flatExtensionGroup("Makefile")).toBe("No extension");
    expect(flatExtensionGroup("archive.")).toBe("No extension");
  });

  it("flat view only keeps language sources under recognized src roots", () => {
    expect(languageSourceRootFor("src/http2_connect.rs")).toBe("src");
    expect(languageSourceRootFor("src-tauri/src/lib.rs")).toBe("src-tauri/src");
    expect(languageSourceRootFor("packages/web/src/App.tsx")).toBe("packages/web/src");
    expect(languageSourceRootFor("README.md")).toBeNull();
    expect(languageSourceRootFor("docs/guide.md")).toBeNull();
    expect(languageSourceRootFor("target/debug/app")).toBeNull();

    expect(isFlatViewSourceFile("src/App.tsx")).toBe(true);
    expect(isFlatViewSourceFile("src-tauri/src/lib.rs")).toBe(true);
    expect(isFlatViewSourceFile("README.md")).toBe(false);
    expect(isFlatViewSourceFile("docs/guide.md")).toBe(false);
    expect(isFlatViewSourceFile("target/debug/foo.rs")).toBe(false);
    expect(isFlatViewSourceFile("output/build.log")).toBe(false);
    expect(isFlatViewSourceFile("src/README.md")).toBe(false);

    expect(flatSourceGroup("src/http2_connect.rs")).toBe("src");
    expect(flatSourceGroup("src-tauri/src/lib.rs")).toBe("src-tauri/src");
    expect(flatSourceRelativePath("src/http2_connect.rs")).toBe("http2_connect.rs");
    expect(flatSourceRelativePath("src-tauri/src/main/http.rs")).toBe("main/http.rs");
  });

  it("matchesTreeFilter finds nested path substrings", () => {
    expect(matchesTreeFilter("http2_connect.rs", "src/net/http2_connect.rs", "http")).toBe(true);
    expect(matchesTreeFilter("main.rs", "src/main.rs", "http")).toBe(false);
  });

  it("shouldHideEntry skips dependency and VCS trees", () => {
    expect(shouldHideEntry(entry("node_modules", "node_modules"))).toBe(true);
    expect(shouldHideEntry(entry("pkg", "node_modules/pkg"))).toBe(true);
    expect(shouldHideEntry(entry("lib.rs", "src/lib.rs"))).toBe(false);
  });

  it("normalizeEditorText converts CRLF for the buffer and restores on save", () => {
    const normalized = normalizeEditorText("a\r\nb\r\n");
    expect(normalized).toEqual({ text: "a\nb\n", eol: "CRLF" });
    expect(applyEditorEol(normalized.text, normalized.eol)).toBe("a\r\nb\r\n");
  });

  it("strips a UTF-8 BOM from the editor buffer before saving metadata", () => {
    const normalized = normalizeEditorText("\uFEFFhello\r\n");
    expect(normalized).toEqual({ text: "hello\n", eol: "CRLF" });
    expect(applyEditorEol(normalized.text, normalized.eol)).toBe("hello\r\n");
  });

  it("gitChange helpers read the rootId:path map", () => {
    const change: GitChange = {
      path: "src/a.ts",
      oldPath: null,
      status: "modified",
      staged: false,
      unstaged: true,
      conflict: false,
    };
    const map = new Map<string, GitChange>([["root1:src/a.ts", change]]);
    expect(gitChangeForPath(map, "root1", "src/a.ts")).toEqual(change);
    expect(gitChangeForPath(map, "root1", "src/b.ts")).toBeUndefined();
    expect(gitDirectoryChangeCount(map, "root1", "src")).toBe(1);
    expect(gitDirectoryChangeCount(map, "root1", "")).toBe(1);
    expect(gitDirectoryChangeCount(map, "other", "")).toBe(0);
  });

  it("makeLibraryFile builds a clean read-only buffer keyed by class URI", () => {
    const info: LibraryBufferInfo = {
      uri: "jdt://contents/java.base/java.lang/String.class?=java.base",
      title: "String.java",
      container: "java.lang · java.base",
      languageId: "java",
      originFilePath: "src/Main.java",
      originRootPath: "/repo",
    };
    const file = makeLibraryFile(info, "public class String {}\r\n");

    expect(file.path).toBe(info.uri);
    expect(file.title).toBe("String.java");
    expect(file.subtitle).toBe("java.lang · java.base · String.java");
    expect(file.languagePath).toBe("String.java");
    expect(file.text).toBe("public class String {}\n");
    expect(file.dirty).toBe(false);
    expect(file.library).toEqual({
      uri: info.uri,
      container: "java.lang · java.base",
      originFilePath: "src/Main.java",
      originRootPath: "/repo",
      decompiled: false,
    });

    // A decompiled buffer carries the flag so the UI can offer "Download sources".
    const decompiledFile = makeLibraryFile({ ...info, decompiled: true }, "class String {}");
    expect(decompiledFile.library?.decompiled).toBe(true);

    // Same-named classes from different packages must not share a buffer.
    const other = makeLibraryFile({
      ...info,
      uri: "jdt://contents/other.jar/com.acme/String.class?=other",
      container: "com.acme · other.jar",
    }, "class String {}");
    expect(other.key).not.toBe(file.key);

    expect(libraryLanguagePath({ ...info, title: "String", languageId: "kotlin" })).toBe("String.kt");
    expect(libraryLanguagePath({ ...info, title: "String", languageId: "csharp" })).toBe("String.cs");
    expect(libraryLanguagePath({ ...info, title: "Vector", languageId: "swift" })).toBe("Vector.swift");
    expect(libraryLanguagePath({ ...info, title: "lib", languageId: "typescript" })).toBe("lib.ts");
  });

  it("looksLikeDocumentUri separates URIs from filesystem paths", () => {
    expect(looksLikeDocumentUri("jdt://contents/java.base/java.lang/String.class?=x")).toBe(true);
    expect(looksLikeDocumentUri("jar:file:///libs/foo.jar!/com/acme/Bar.class")).toBe(true);
    expect(looksLikeDocumentUri("file:///repo/src/Main.java")).toBe(true);
    expect(looksLikeDocumentUri("C:\\repo\\src\\Main.java")).toBe(false);
    expect(looksLikeDocumentUri("/repo/src/Main.java")).toBe(false);
    expect(looksLikeDocumentUri("src/Main.java")).toBe(false);
  });
});
