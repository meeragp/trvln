// The trip-style signals read from a traveler's inspiration media. The model
// is asked for ids from the same option lists the Vibe step shows, and this
// keeps only ids that are really on those lists, so a made-up or misspelled
// value can never reach the form.

export const VIBE_OPTIONS = {
  atmosphere: ["city", "nature", "off-beaten-path", "backcountry"],
  adventureLevel: ["none", "family", "active", "adrenaline"],
  foodDrink: ["local", "casual", "romantic", "family", "party"],
  interests: ["educational", "culture", "food", "instagram", "activities", "nature"],
} as const;

export interface InferredVibe {
  summary: string;
  atmosphere: string[];
  adventureLevel: string | null;
  foodDrink: string[];
  interests: string[];
}

const pick = (value: unknown, allowed: readonly string[]): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string" && allowed.includes(v)))]
    : [];

/** Null when the model gave nothing usable. */
export function sanitizeVibe(raw: unknown): InferredVibe | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const vibe: InferredVibe = {
    summary: typeof r.summary === "string" ? r.summary.trim().slice(0, 120) : "",
    atmosphere: pick(r.atmosphere, VIBE_OPTIONS.atmosphere),
    adventureLevel:
      typeof r.adventureLevel === "string" && (VIBE_OPTIONS.adventureLevel as readonly string[]).includes(r.adventureLevel)
        ? r.adventureLevel
        : null,
    foodDrink: pick(r.foodDrink, VIBE_OPTIONS.foodDrink),
    interests: pick(r.interests, VIBE_OPTIONS.interests),
  };
  const empty = !vibe.summary && !vibe.adventureLevel
    && vibe.atmosphere.length + vibe.foodDrink.length + vibe.interests.length === 0;
  return empty ? null : vibe;
}
