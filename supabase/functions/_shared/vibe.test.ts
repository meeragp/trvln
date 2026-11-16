import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { sanitizeVibe } from "./vibe.ts";

Deno.test("keeps only ids that are on the Vibe step's option lists", () => {
  assertEquals(
    sanitizeVibe({
      summary: "  coastal hikes, seafood, small towns ",
      atmosphere: ["nature", "seaside", "nature", 7],
      adventureLevel: "active",
      foodDrink: ["local", "michelin"],
      interests: ["nature", "food"],
    }),
    {
      summary: "coastal hikes, seafood, small towns",
      atmosphere: ["nature"],
      adventureLevel: "active",
      foodDrink: ["local"],
      interests: ["nature", "food"],
    },
  );
});

Deno.test("an unknown adventure level becomes null, not a guess", () => {
  assertEquals(sanitizeVibe({ summary: "city break", adventureLevel: "extreme" })?.adventureLevel, null);
});

Deno.test("nothing usable is null", () => {
  assertEquals(sanitizeVibe(null), null);
  assertEquals(sanitizeVibe("beachy"), null);
  assertEquals(sanitizeVibe({ atmosphere: ["seaside"], foodDrink: "local" }), null);
});
