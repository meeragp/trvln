// What the inspiration analysis read from a traveler's photos and videos,
// beyond the place names: the style of trip they show. Used to pre-fill the
// Vibe step so the traveler corrects a guess instead of starting from blank.

export interface InferredVibe {
  summary: string;
  atmosphere: string[];
  adventureLevel: string | null;
  foodDrink: string[];
  interests: string[];
}

export interface DestinationHints {
  bestTime: { label: string; why: string } | null;
  valueTime: { label: string; why: string } | null;
  stay: { budget: string; moderate: string; comfortable: string; luxury: string } | null;
}

// The part of the trip preferences a vibe reading can fill in
export interface VibeFields {
  atmosphere: string[];
  adventureLevel: string;
  foodDrink: string[];
  interests: string[];
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

/** Combine readings from several analysis passes (each imported video is
 *  analyzed as it arrives). The newest summary wins; everything else adds up. */
export function mergeVibes(prev: InferredVibe | null, next: InferredVibe | null): InferredVibe | null {
  if (!next) return prev;
  if (!prev) return next;
  return {
    summary: next.summary || prev.summary,
    atmosphere: union(prev.atmosphere, next.atmosphere),
    adventureLevel: next.adventureLevel ?? prev.adventureLevel,
    foodDrink: union(prev.foodDrink, next.foodDrink),
    interests: union(prev.interests, next.interests),
  };
}

/** Pre-fill the vibe fields from a reading without overriding the traveler.
 *  A list is filled only while it is still empty, and the adventure level only
 *  while it still holds the form's default, so anything they already chose
 *  stays as they chose it. Returns just the fields that change. */
export function applyInferredVibe<T extends VibeFields>(
  prefs: T,
  vibe: InferredVibe | null,
  defaultAdventureLevel: string,
): Partial<VibeFields> {
  if (!vibe) return {};
  const updates: Partial<VibeFields> = {};
  if (prefs.atmosphere.length === 0 && vibe.atmosphere.length > 0) updates.atmosphere = vibe.atmosphere;
  if (prefs.foodDrink.length === 0 && vibe.foodDrink.length > 0) updates.foodDrink = vibe.foodDrink;
  if (prefs.interests.length === 0 && vibe.interests.length > 0) updates.interests = vibe.interests;
  if (vibe.adventureLevel && prefs.adventureLevel === defaultAdventureLevel && vibe.adventureLevel !== prefs.adventureLevel) {
    updates.adventureLevel = vibe.adventureLevel;
  }
  return updates;
}

/** How many of the traveler's current vibe choices still match the reading:
 *  the number the Vibe step quotes ("3 of these came from your video"). */
export function countInferred(prefs: VibeFields, vibe: InferredVibe | null): number {
  if (!vibe) return 0;
  const hits = (chosen: string[], inferred: string[]) => chosen.filter(id => inferred.includes(id)).length;
  return hits(prefs.atmosphere, vibe.atmosphere)
    + hits(prefs.foodDrink, vibe.foodDrink)
    + hits(prefs.interests, vibe.interests)
    + (vibe.adventureLevel && prefs.adventureLevel === vibe.adventureLevel ? 1 : 0);
}
