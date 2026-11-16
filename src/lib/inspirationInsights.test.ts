import { describe, expect, it } from "vitest";
import { applyInferredVibe, countInferred, mergeVibes, type InferredVibe } from "./inspirationInsights";

const blank = { atmosphere: [], adventureLevel: "active", foodDrink: [], interests: [] };

const coastal: InferredVibe = {
  summary: "coastal hikes, seafood, small towns",
  atmosphere: ["nature", "off-beaten-path"],
  adventureLevel: "none",
  foodDrink: ["local"],
  interests: ["nature"],
};

describe("applyInferredVibe", () => {
  it("fills an untouched form from the reading", () => {
    expect(applyInferredVibe(blank, coastal, "active")).toEqual({
      atmosphere: ["nature", "off-beaten-path"],
      adventureLevel: "none",
      foodDrink: ["local"],
      interests: ["nature"],
    });
  });

  it("leaves alone anything the traveler already chose", () => {
    const chosen = { atmosphere: ["city"], adventureLevel: "adrenaline", foodDrink: [], interests: ["culture"] };
    expect(applyInferredVibe(chosen, coastal, "active")).toEqual({ foodDrink: ["local"] });
  });

  it("changes nothing without a reading", () => {
    expect(applyInferredVibe(blank, null, "active")).toEqual({});
  });
});

describe("countInferred", () => {
  it("counts only choices that still match the reading", () => {
    const prefs = { atmosphere: ["nature", "city"], adventureLevel: "none", foodDrink: [], interests: ["nature"] };
    expect(countInferred(prefs, coastal)).toBe(3);
    expect(countInferred(prefs, null)).toBe(0);
  });
});

describe("mergeVibes", () => {
  it("adds a second video's reading to the first", () => {
    const city: InferredVibe = { summary: "night markets", atmosphere: ["city"], adventureLevel: null, foodDrink: ["local", "party"], interests: [] };
    expect(mergeVibes(coastal, city)).toEqual({
      summary: "night markets",
      atmosphere: ["nature", "off-beaten-path", "city"],
      adventureLevel: "none",
      foodDrink: ["local", "party"],
      interests: ["nature"],
    });
  });

  it("keeps what it has when a pass reads nothing", () => {
    expect(mergeVibes(coastal, null)).toBe(coastal);
    expect(mergeVibes(null, coastal)).toBe(coastal);
  });
});
