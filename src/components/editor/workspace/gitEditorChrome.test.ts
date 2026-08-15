import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { GitBlameLine } from "../../../lib/git";
import {
  blameLabel,
  buildGitLineChanges,
  createGitEditorChrome,
  formatBlameAge,
  rollbackGitLineChange,
} from "./gitEditorChrome";

describe("gitEditorChrome", () => {
  it("builds added, modified, and deleted line hunks against HEAD", () => {
    const changes = buildGitLineChanges(
      "one\ntwo\nthree\nfour",
      "one\nTWO\ninserted\nfour",
    );
    expect(changes.map((change) => change.kind)).toEqual(["modified"]);
    expect(changes[0].oldText).toContain("two");
    expect(changes[0].newText).toContain("TWO");

    expect(buildGitLineChanges("one\n", "one\ntwo\n")[0].kind).toBe("added");
    expect(buildGitLineChanges("one\ntwo\n", "one\n")[0].kind).toBe("deleted");
  });

  it("renders clickable gutter marks and an inline blame widget", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const blame: GitBlameLine = {
      line: 2,
      commit: "0123456789abcdef",
      author: "Ada",
      authorMail: "ada@example.test",
      authorTime: 1_783_814_400,
      summary: "feat: add gutter",
    };
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "one\ntwo",
        extensions: createGitEditorChrome(buildGitLineChanges("one\nold", "one\ntwo"), blame),
      }),
    });
    expect(parent.querySelector(".cm-git-change-gutter")).toBeTruthy();
    expect(parent.querySelector(".cm-git-change-modified")).toBeTruthy();
    expect(parent.querySelector(".cm-inline-git-blame")?.textContent).toContain("Ada");
    view.destroy();
    parent.remove();
  });

  it("formats blame ages and uncommitted lines", () => {
    expect(formatBlameAge(1_000, 1_000_000 + 90 * 60_000)).toBe("1h ago");
    expect(blameLabel({
      line: 1,
      commit: "0000000000000000000000000000000000000000",
      author: "Not Committed Yet",
      authorMail: null,
      authorTime: 0,
      summary: "draft",
    })).toBe("Uncommitted change");
  });

  it("reverts added, deleted, and modified diff chunks with rollbackGitLineChange", () => {
    const headDoc = "line1\noriginal line 2\noriginal line 3\nline4";
    const modifiedDoc = "line1\nMODIFIED LINE 2\nline4";
    const changes = buildGitLineChanges(headDoc, modifiedDoc);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("modified");

    const restoredDoc = rollbackGitLineChange(modifiedDoc, changes[0]);
    expect(restoredDoc).toBe(headDoc);

    const addedDoc = "line1\nline2\nnew line 3\nline4";
    const addedChange = buildGitLineChanges("line1\nline2\nline4", addedDoc)[0];
    expect(rollbackGitLineChange(addedDoc, addedChange)).toBe("line1\nline2\nline4");

    const deletedDoc = "line1\nline4";
    const deletedChange = buildGitLineChanges("line1\nline2\nline3\nline4", deletedDoc)[0];
    expect(rollbackGitLineChange(deletedDoc, deletedChange)).toBe("line1\nline2\nline3\nline4");
  });
});
