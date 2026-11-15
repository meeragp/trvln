import { describe, expect, it } from "vitest";
import { interleave } from "./interleave";

describe("interleave", () => {
  it("takes one item from each list in turn", () => {
    expect(interleave([["a1", "a2", "a3"], ["b1"], ["c1", "c2"]])).toEqual(
      ["a1", "b1", "c1", "a2", "c2", "a3"]
    );
  });

  it("handles empty input and empty lists", () => {
    expect(interleave([])).toEqual([]);
    expect(interleave([[], ["x"], []])).toEqual(["x"]);
  });

  it("keeps every video within a 20-image cap", () => {
    const videos = [0, 1, 2].map(v => Array.from({ length: 10 }, (_, f) => `v${v}f${f}`));
    const kept = interleave(videos).slice(0, 20);
    for (const v of [0, 1, 2]) expect(kept.some(u => u.startsWith(`v${v}`))).toBe(true);
  });
});
