import { describe, expect, it } from "vitest";
import { threeWayMergeText } from "./threeWayMerge";

describe("threeWayMergeText", () => {
  it("fast-forwards when only one side changed", () => {
    expect(threeWayMergeText("base", "base", "disk")).toEqual({
      text: "disk",
      conflicts: 0,
      autoMerged: true,
    });
    expect(threeWayMergeText("base", "local", "base").text).toBe("local");
  });

  it("combines edits on different baseline lines", () => {
    const result = threeWayMergeText(
      "one\ntwo\nthree",
      "ONE\ntwo\nthree",
      "one\ntwo\nTHREE",
    );
    expect(result.conflicts).toBe(0);
    expect(result.autoMerged).toBe(true);
    expect(result.text).toBe("ONE\ntwo\nTHREE");
  });

  it("emits editable conflict markers for overlapping edits", () => {
    const result = threeWayMergeText("value = 1", "value = 2", "value = 3");
    expect(result.conflicts).toBe(1);
    expect(result.autoMerged).toBe(false);
    expect(result.text).toContain("<<<<<<< LOCAL");
    expect(result.text).toContain("||||||| BASE");
    expect(result.text).toContain("=======");
    expect(result.text).toContain(">>>>>>> DISK");
  });

  it("merges insertions and deletions without losing the untouched side", () => {
    const result = threeWayMergeText(
      "alpha\nbeta\ngamma",
      "alpha\nlocal\nbeta\ngamma",
      "alpha\nbeta\nGAMMA",
    );
    expect(result.conflicts).toBe(0);
    expect(result.text).toBe("alpha\nlocal\nbeta\nGAMMA");
  });

  it("keeps an insertion after a changed line separate from that change", () => {
    const result = threeWayMergeText(
      "alpha\nbeta\ngamma",
      "alpha\nbeta\nlocal tail\ngamma",
      "alpha\nBETA\ngamma",
    );
    expect(result.conflicts).toBe(0);
    expect(result.text).toBe("alpha\nBETA\nlocal tail\ngamma");
  });
});
