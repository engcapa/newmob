import { describe, expect, it, vi } from "vitest";
import { applyGenerateSelection, type GenerateCandidate } from "./generateCodeWorkflow";

const CANDIDATES: GenerateCandidate[] = [
  { id: "0", title: "Generate Constructor", kind: "source.generate.constructor" },
  { id: "1", title: "Generate Getters and Setters", kind: "source.generate.getters.setters" },
  { id: "2", title: "Generate toString()", kind: "source.generate.toString" },
];

describe("§8.19.8 generate workflow runner", () => {
  it("applies every selected action in order and reports the count", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, message: null });
    const outcome = await applyGenerateSelection(CANDIDATES, {
      actionFor: (c) => c.id,
      isStale: () => false,
      run,
    });
    expect(outcome).toEqual({ applied: 3, failedIndex: null, message: null });
    expect(run.mock.calls.map((call) => call[0])).toEqual(["0", "1", "2"]);
  });

  it("re-checks staleness before EVERY action and stops before touching a stale one", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, message: null });
    let checks = 0;
    const outcome = await applyGenerateSelection([CANDIDATES[0], CANDIDATES[1]], {
      actionFor: (c) => c.id,
      isStale: () => (checks += 1) === 2, // second pre-check sees a changed class
      run,
    });
    expect(outcome.failedIndex).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(outcome.message).toContain("stale");
  });

  it("stops at the first provider failure and keeps earlier successes counted", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ ok: true, message: null })
      .mockResolvedValueOnce({ ok: false, message: "resolve exploded" });
    const outcome = await applyGenerateSelection(CANDIDATES.slice(0, 2), {
      actionFor: (c) => c.id,
      isStale: () => false,
      run,
    });
    expect(outcome).toEqual({ applied: 1, failedIndex: 1, message: "resolve exploded" });
  });

  it("applies nothing for an empty selection", async () => {
    const run = vi.fn();
    const outcome = await applyGenerateSelection([], {
      actionFor: (c) => c.id,
      isStale: () => false,
      run,
    });
    expect(outcome.applied).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});
