// Grounded research for an itinerary: reading the request, resolving where
// the trip goes, and the Perplexity and Google Places searches the itinerary
// is built from.
//
// Shared by generate-itinerary and research-trip. A batch fans out one
// itinerary per theme, and only the activities query depends on the theme,
// so research-trip runs everything else once per batch and stores it; each
// generate-itinerary call then asks only its own activities question. When
// there is no stored research (an old client, a reload, a failed
// research-trip), generate-itinerary runs the whole pipeline itself through
// these same functions, so both paths build the research from one definition.

import type { CostTracker } from "./costs.ts";
import type { TripContext, TripPreferences } from "./tripPreferences.ts";

export type TimePhase = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export type ResearchResult = { content: string; citations: string[] };

export type SourcePlan = {
  tripCharacter?: string;
  interpretations?: string[];
  avoid?: string[];
};

// What the trip is and where it goes — decided once, before any search runs.
export type TripReading = {
  resolvedCities: string[];
  destinationWasResolved: boolean;
  sourcePlan: SourcePlan | null;
};

export type QuerySpec = { key: string; query: string };

// The only query whose wording depends on the itinerary's theme.
export const THEME_SPECIFIC_KEY = "activities";

// Everything except the theme's own activities query, as research-trip
// stores it for the batch.
export type SharedResearch = {
  research: Record<string, ResearchResult>;
  placesDining: CityDining[];
};

const PERPLEXITY_STAGGER_MS = 1500;

// Helper function to call Perplexity for grounded web search.
//
// Every query is retried on 429. All six searches fire at once, and Perplexity
// rate-limits the burst: production logs showed one query succeeding and five
// returning `429 request_rate_limit_exceeded` within milliseconds. Because a
// failed search returned empty rather than raising, that surfaced not as an
// error but as an itinerary with no named restaurants — the model had nothing
// to name. `label` identifies which search is retrying in the logs.
export async function searchWithPerplexity(
  query: string,
  apiKey: string,
  label = "search",
): Promise<{ content: string; citations: string[]; usage?: Record<string, unknown> }> {
  const maxAttempts = 4;
  let retryAfterMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      // Prefer the server's own retry-after. Otherwise back off steeply and
      // jittered — the first fix used ~1s and production still showed the same
      // query 429ing on its retry, so the delay has to clear the window rather
      // than land just after it.
      const backoffMs = retryAfterMs || 1500 * (attempt - 1) + Math.floor(Math.random() * 1200);
      console.log(`[research] ${label} retrying in ${backoffMs}ms (attempt ${attempt})`);
      await new Promise(r => setTimeout(r, backoffMs));
    }

    const result = await runPerplexityQuery(query, apiKey, label);
    if (result.ok) return result.value;
    if (!result.retryable) return { content: '', citations: [] };
    retryAfterMs = result.retryAfterMs ?? 0;
  }

  console.error(`[research] ${label} exhausted ${maxAttempts} attempts — returning empty`);
  return { content: '', citations: [] };
}

async function runPerplexityQuery(
  query: string,
  apiKey: string,
  label: string,
): Promise<
  | { ok: true; value: { content: string; citations: string[]; usage?: Record<string, unknown> } }
  | { ok: false; retryable: boolean; retryAfterMs?: number }
> {
  try {
    console.log("Perplexity search query:", query);

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { 
            role: 'system', 
            content: 'You are a travel research assistant. Provide specific, detailed recommendations with exact names of restaurants, hotels, tours, and activities. When researching hotels, prioritize options within the specified price range and include nightly rates. If most options exceed the budget, explicitly note this and suggest alternatives. Include price ranges when available. Be comprehensive but concise.\n\nWhen a query carries a SOURCING instruction, treat it as part of the question rather than as advice. It asks you to attribute, not to search anywhere in particular — search as you normally would, then say where each answer came from. Where it asks you to check a published schedule, fee or rule against first-hand accounts, report both and say plainly when they disagree — a discrepancy is a finding, not something to average away. Never present a fact you found in one place as though it were corroborated, and say when you could not find something at all rather than substituting the nearest thing you could find.'
          },
          { role: 'user', content: query }
        ],
      }),
    });

    if (!response.ok) {
      // Include the body: a bare status can't distinguish a revoked key from an
      // exhausted balance from a malformed header, and this failure is silent
      // enough already.
      const errorBody = await response.text().catch(() => '');
      console.error(`Perplexity API error (${label}):`, response.status, errorBody.slice(0, 500));
      // Perplexity does not always send retry-after; when it does, it beats guessing.
      const retryAfter = Number(response.headers.get("retry-after"));
      // A rate limit clears on its own; a 401/400 will not.
      return {
        ok: false,
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 8000)
          : undefined,
      };
    }

    const data = await response.json();
    return {
      ok: true,
      value: {
        content: data.choices?.[0]?.message?.content || '',
        citations: data.citations || [],
        usage: data.usage,
      },
    };
  } catch (error) {
    console.error(`Perplexity search error (${label}):`, error);
    return { ok: false, retryable: true };
  }
}

// ============================================================================
// GOOGLE PLACES DINING BACKBONE
//
// Web research reads editorial coverage, and editorial food coverage is
// dinner-shaped: "where to eat in X" articles rarely name a breakfast café,
// so for destinations whose blogs cover only dinner (Whistler, most resort
// towns) the morning and midday slots went out empty — the roster rules
// correctly refuse to invent names, but the research never supplied any.
// Google Maps has no such bias: it lists every operating café with its live
// rating and review history. So dining names are grounded on Places data
// first, and the web research supplies texture (what to order, whether to
// book, what the room is like) on top.
//
// Fail-soft throughout: a missing key or a failed request returns nothing and
// generation proceeds on web research alone, exactly as before.
// ============================================================================

export type DiningPlace = {
  name: string;
  rating: number;
  ratingCount: number;
  price: string; // "$".."$$$$", or "" when Maps has no price level
  address: string;
  mapsUrl: string;
  wellKnown?: boolean; // set at selection: heavily-trafficked pick vs quieter find
};
export type CityDining = { city: string; meals: Record<string, DiningPlace[]> };

// The form's food & drink ids, as words a Maps text search understands. An id
// with no mapping passes through as-is so free-form values still steer.
const FOOD_PREF_PHRASE: Record<string, string> = {
  local: "serving regional specialties",
  casual: "casual",
  romantic: "romantic",
  family: "family-friendly",
  party: "lively",
};

// One search per meal period plus one that hunts what the traveler could not
// pull up themselves: Maps text relevance matches review language, so asking
// for "underrated" and "hidden gem" surfaces the places reviewers describe
// that way — loved rather than famous. The traveler's food preferences steer
// the dinner search, where they express a kind of evening; breakfast and
// lunch stay broad because a café is a café whatever the trip's vibe.
export const MEAL_GROUPS = ["Breakfast", "Lunch", "Dinner", "Local favorites"] as const;

function buildMealSearches(foodPrefs: string[]): { meal: string; query: (city: string) => string }[] {
  const prefWords = foodPrefs
    .map(p => FOOD_PREF_PHRASE[p.trim().toLowerCase()] ?? p.trim())
    .filter(Boolean)
    .slice(0, 2); // two qualifiers keep the query a phrase, not a word salad
  const dinnerQualifier = prefWords.length ? `${prefWords.join(" and ")} ` : "";
  return [
    { meal: "Breakfast", query: c => `best breakfast cafes and bakeries in ${c}` },
    { meal: "Lunch", query: c => `best casual lunch restaurants in ${c}` },
    { meal: "Dinner", query: c => `best ${dinnerQualifier}dinner restaurants in ${c}` },
    { meal: "Local favorites", query: c => `underrated hidden gem restaurants local favorites in ${c}` },
  ];
}

const PRICE_LEVEL_LABEL: Record<string, string> = {
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

async function placesTextSearch(textQuery: string, apiKey: string): Promise<DiningPlace[]> {
  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.businessStatus,places.shortFormattedAddress,places.googleMapsUri",
      },
      // The API's maximum page: the quieter-find pool selects from below the
      // top of the ranking, so the deeper the page, the more there is to find.
      body: JSON.stringify({ textQuery, pageSize: 20 }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[places] ${response.status} for "${textQuery}": ${body.slice(0, 300)}`);
      return [];
    }
    const data = await response.json();
    type RawPlace = {
      displayName?: { text?: unknown };
      rating?: unknown;
      userRatingCount?: unknown;
      priceLevel?: unknown;
      businessStatus?: unknown;
      shortFormattedAddress?: unknown;
      googleMapsUri?: unknown;
    };
    const places: RawPlace[] = Array.isArray(data.places) ? data.places : [];
    return places
      .filter(p => (p.businessStatus ?? "OPERATIONAL") === "OPERATIONAL")
      .map(p => ({
        name: typeof p.displayName?.text === "string" ? p.displayName.text : "",
        rating: typeof p.rating === "number" ? p.rating : 0,
        ratingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : 0,
        price: PRICE_LEVEL_LABEL[String(p.priceLevel ?? "")] ?? "",
        address: typeof p.shortFormattedAddress === "string" ? p.shortFormattedAddress : "",
        mapsUrl: typeof p.googleMapsUri === "string" ? p.googleMapsUri : "",
      }))
      .filter(p => p.name);
  } catch (error) {
    console.error(`[places] search failed for "${textQuery}":`, error);
    return [];
  }
}

// The floor keeps out places nobody has vouched for — a 5.0★ with 12 reviews
// is unverified, and a mountain town's real café clears 25 reviews easily.
const MIN_PLACE_RATING = 4.0;
const MIN_PLACE_REVIEWS = 25;

// Selection deliberately does NOT rank by popularity alone. Review volume
// measures how trafficked a place is, not how good it is, and a list sorted
// by it is exactly the result the traveler gets from a two-second Maps
// search — the opposite of a recommendation. Each meal gets two pools: a few
// heavily-trafficked picks as the reliable floor, and as many equally-rated
// quieter finds — the highest-rated places the crowd hasn't got to, least
// reviewed first among equals. The labels travel into the prompt so the model
// can choose the quieter one on purpose when it fits the traveler better.
const WELL_KNOWN_PER_MEAL = 4;
const QUIETER_PER_MEAL = 4;
const QUIETER_MIN_RATING = 4.4;

function pickMealOptions(candidates: DiningPlace[]): DiningPlace[] {
  const eligible = candidates.filter(
    p => p.rating >= MIN_PLACE_RATING && p.ratingCount >= MIN_PLACE_REVIEWS,
  );
  const traffic = (p: DiningPlace) => p.rating * Math.log10(p.ratingCount + 1);
  const wellKnown = [...eligible]
    .sort((a, b) => traffic(b) - traffic(a))
    .slice(0, WELL_KNOWN_PER_MEAL)
    .map(p => ({ ...p, wellKnown: true }));
  const taken = new Set(wellKnown.map(p => p.name));
  const quieter = eligible
    .filter(p => !taken.has(p.name) && p.rating >= QUIETER_MIN_RATING)
    .sort((a, b) => b.rating - a.rating || a.ratingCount - b.ratingCount)
    .slice(0, QUIETER_PER_MEAL)
    .map(p => ({ ...p, wellKnown: false }));
  return [...wellKnown, ...quieter];
}

// Four requests per city; the cap bounds cost on multi-stop trips. Cities
// come ordered as the trip visits them, so the ones cut are the tail stops.
const MAX_PLACES_CITIES = 4;

export async function fetchDiningPlaces(
  cities: string[],
  apiKey: string | undefined,
  foodPrefs: string[],
): Promise<{ dining: CityDining[]; requests: number }> {
  if (!apiKey) {
    console.warn("[places] GOOGLE_PLACES_API_KEY not configured — dining grounds on web research only");
    return { dining: [], requests: 0 };
  }
  if (cities.length === 0) return { dining: [], requests: 0 };

  const searches = buildMealSearches(foodPrefs);
  let requests = 0;
  const dining = await Promise.all(cities.slice(0, MAX_PLACES_CITIES).map(async city => {
    const found: Record<string, DiningPlace[]> = {};
    await Promise.all(searches.map(async ({ meal, query }) => {
      requests++;
      found[meal] = await placesTextSearch(query(city), apiKey);
    }));
    // Groups are selected in MEAL_GROUPS order and a name keeps its first
    // slot: "Local favorites" overlaps the meal searches, and a place listed
    // twice would read as two options where the traveler has one.
    const meals: Record<string, DiningPlace[]> = {};
    const seen = new Set<string>();
    for (const meal of MEAL_GROUPS) {
      const picked = pickMealOptions((found[meal] ?? []).filter(p => !seen.has(p.name)));
      for (const p of picked) seen.add(p.name);
      meals[meal] = picked;
    }
    return { city, meals };
  }));

  return {
    dining: dining.filter(d => Object.values(d.meals).some(m => m.length > 0)),
    requests,
  };
}

// ============================================================================
// READING THE REQUEST AND RESOLVING THE DESTINATION
//
// `themeName` is passed only when one itinerary researches for itself. The
// shared, once-per-batch reading leaves it out: it describes the traveler and
// the trip, which every theme of the batch has in common.
// ============================================================================
export async function readTrip(args: {
  preferences: TripPreferences;
  trip: TripContext;
  themeName?: string;
  anthropicKey: string;
  costs: CostTracker;
  timePhase: TimePhase;
}): Promise<TripReading> {
  const {
    cities, noFlight, departureCity, atmosphere, adventureLevel, foodDrink, interests, additionalNotes,
  } = args.preferences;
  const { budgetInfo, flightBudget, durationContext, dateContext, guidedLabel, travelersLabel } = args.trip;
  const themeVariant = args.themeName ? { name: args.themeName } : undefined;
  const ANTHROPIC_API_KEY = args.anthropicKey;
  const { costs, timePhase } = args;

    // ============================================
    // READING THE REQUEST
    // ============================================
    // What separates a planned trip from a generated one is mostly not the
    // establishment names — it is that someone read the request closely enough
    // to know what this person would find disappointing. That reading has to
    // happen before anything else, because it decides what gets left out, and
    // leaving things out is where taste lives.
    //
    // This pass does not pick sources. An earlier version did, and it was the
    // wrong lever twice over: the model already knows an alpine club beats a
    // tourism board on snowpack, and a directive naming sources competes with
    // the actual question for retrieval. What the model cannot supply on its
    // own is this traveler's standard for a vague word, so that is what is
    // asked for here.
    //
    // Kicked off before destination resolution and awaited after it: this
    // describes the shape of the trip, not the place, so it neither needs the
    // resolved destination nor should wait behind it.
    const sourcePlanPromise: Promise<SourcePlan | null> = timePhase("request_reading", async () => {
      try {
        const strategyPrompt = `Read this travel request the way an experienced human travel planner would before doing any research — not to plan the trip, but to work out what this particular person is actually asking for.

Three things:

1. **What kind of trip is this really?** One concrete sentence. "A first trip abroad with an anxious parent" and "a self-guided traverse by someone who hikes every weekend" produce completely different itineraries to the same destination.

2. **Restate their subjective words as tests.** "Off the beaten path", "authentic", "hidden gem", "local", "chill", "romantic", "epic" are useless as search terms — every listicle claims all of them. Say what each would have to mean for a place to qualify on THIS trip, judged relative to the destination rather than in the abstract. Empty array if they used none.

3. **What would make this itinerary feel canned to THIS person?** Name the obvious inclusions that would signal nobody read their request — the specific landmark, the kind of restaurant, the pacing mistake. Be concrete enough that a planner could check a draft against it.

The traveler's request:
- What they described: ${additionalNotes || "Not specified"}
- Traveling as: ${travelersLabel}
- Atmosphere: ${atmosphere?.join(", ") || "no preference"}
- Interests (ranked): ${interests?.join(" > ") || "no preference"}
- Adventure level: ${adventureLevel || "no preference"}
- Guided vs self-serve: ${guidedLabel}
- Food & drink: ${foodDrink?.join(", ") || "no preference"}
- Budget: ${budgetInfo.label} (${budgetInfo.accommodation})
- Duration: ${durationContext}
- Timing: ${dateContext}
${themeVariant?.name ? `- Itinerary theme: ${themeVariant.name}` : ""}

Respond with ONLY a JSON object in this shape:
{
  "tripCharacter": "one concrete sentence",
  "interpretations": ["each subjective word restated as a test a place must pass"],
  "avoid": ["specific things that would read as generic to this traveler"]
}

Worked example, for "hut to hut, no driving, want to get away from the crowds" — six days, self-guided, active:
{
  "tripCharacter": "A self-guided six-day mountain traverse sleeping in huts, by someone fit enough to carry a pack who is specifically trying to get away from day-trip crowds.",
  "interpretations": ["'Away from the crowds' here means huts and valleys the cable-car day-trippers cannot reach on foot in an afternoon — not simply places less famous than the headline peak. A place qualifies if reaching it costs a half day of walking, or a connection the tour buses do not run."],
  "avoid": ["The photographed viewpoint ten minutes from a cable car station — it is the most crowded spot in the range and its presence would prove nobody read the request.", "A rest day parked in a resort town; this traveler wants the walking, not the shopping street.", "Restaurants in valley towns the route never descends into."]
}

No explanation. Just the JSON object.`;

        const strategyResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            messages: [{ role: "user", content: strategyPrompt }],
            // Seven topic directives plus the interpretations run long.
            max_tokens: 1200,
          }),
        });

        if (!strategyResponse.ok) {
          console.error("Source strategy pass failed:", strategyResponse.status);
          return null;
        }

        const strategyData = await strategyResponse.json();
        costs.addAnthropic("request_reading", "claude-haiku-4-5", strategyData.usage);
        const raw = strategyData.content?.[0]?.text?.trim() ?? "";
        const parsed = JSON.parse(raw.replace(/```[a-z]*\n?/gi, "").trim());

        // Clamp before this reaches a query: the directives are concatenated
        // into every Perplexity prompt, and a runaway generation here would
        // bury the actual question underneath its own sourcing advice.
        const clamp = (s: unknown, max: number) =>
          typeof s === "string" && s.trim() ? s.trim().slice(0, max) : undefined;

        const strList = (v: unknown, max: number, cap: number) =>
          Array.isArray(v) ? v.map((i: unknown) => clamp(i, max)).filter(Boolean).slice(0, cap) as string[] : [];

        const plan: SourcePlan = {
          tripCharacter: clamp(parsed?.tripCharacter, 300),
          interpretations: strList(parsed?.interpretations, 500, 4),
          avoid: strList(parsed?.avoid, 300, 5),
        };
        console.log("Request reading:", JSON.stringify(plan, null, 2));
        return plan;
      } catch (err) {
        console.error("Source strategy pass failed — using baseline sourcing only:", err);
        return null;
      }
    });

    // ============================================
    // DESTINATION RESOLUTION PASS
    // When no explicit city is given, ask Claude Haiku to pick the best
    // match before Perplexity runs, so all research is destination-specific.
    // ============================================
    let resolvedCities: string[] = [...(cities ?? [])];
    let destinationWasResolved = false;

    if (resolvedCities.length === 0) {
      console.log("No explicit cities — resolving destination from preferences...");
      try {
        const resolutionPrompt = `You are a travel destination expert. Based on the traveler's preferences below, choose 1-2 destinations that best fit. Be decisive and concrete — a place a traveler can actually plan around, never a continent or a vague area like "Southeast Asia".

Pick the unit that matches how the trip actually moves:
- A trip based in one place is a city: "Chiang Mai, Thailand".
- A trip that moves through an area — a road trip, a thru-hike, a hut-to-hut trek, island hopping, a wine route — is the region plus the anchor towns that bound it: "Dolomites, Italy (Cortina d'Ampezzo to Ortisei)". Naming only the gateway city would send the research to the wrong place, because the trip happens between the towns, not in one of them.

Preferences:
- What they described: ${additionalNotes || "Not specified"}
- Traveling as: ${travelersLabel}
- Atmosphere: ${atmosphere?.join(", ") || "no preference"}
- Interests: ${interests?.join(", ") || "no preference"}
- Adventure level: ${adventureLevel || "active"}
- Food preferences: ${foodDrink?.join(", ") || "no preference"}
- Accommodation budget: ${budgetInfo.label} (${budgetInfo.accommodation})
- Flight budget: ${noFlight ? "no flight needed (local/ground trip)" : flightBudget + " round trip"}
- Departing from: ${departureCity || "unknown"}
- Travel timing: ${dateContext}
- Duration: ${durationContext}

Respond with ONLY a JSON array of 1-2 destination strings. Examples:
["Lisbon, Portugal"]
["Chiang Mai, Thailand", "Bangkok, Thailand"]
["Dolomites, Italy (Cortina d'Ampezzo to Ortisei)"]
["Kii Peninsula, Japan (Kumano Kodo, Tanabe to Nachi)"]

No explanation. Just the JSON array.`;

        const resolutionResponse = await timePhase("destination_resolution", () =>
          fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5",
              messages: [{ role: "user", content: resolutionPrompt }],
              // Region answers carry their anchor towns, so they run longer than a bare city name.
              max_tokens: 200,
            }),
          }));

        if (resolutionResponse.ok) {
          const resolutionData = await resolutionResponse.json();
          costs.addAnthropic("destination_resolution", "claude-haiku-4-5", resolutionData.usage);
          const resolutionText = resolutionData.content?.[0]?.text?.trim() ?? "";
          // Strip any accidental code fences
          const cleaned = resolutionText.replace(/```[a-z]*\n?/gi, "").trim();
          const parsed = JSON.parse(cleaned);
          if (Array.isArray(parsed) && parsed.length > 0) {
            resolvedCities = parsed.filter((d: unknown) => typeof d === "string");
            destinationWasResolved = true;
            console.log("Resolved destinations:", resolvedCities);
          }
        }
      } catch (err) {
        console.error("Destination resolution failed — proceeding without explicit cities:", err);
      }
    }

    return { resolvedCities, destinationWasResolved, sourcePlan: await sourcePlanPromise };
}

// ============================================================================
// THE RESEARCH QUESTIONS
// ============================================================================
export function buildQuerySpecs(args: {
  preferences: TripPreferences;
  trip: TripContext;
  reading: TripReading;
  themeName?: string;
}): QuerySpec[] {
  const {
    interests, foodDrink, additionalNotes, durationDays, startDate, endDate, targetMonth, noFlight, departureCity,
  } = args.preferences;
  const { budgetInfo } = args.trip;
  const { resolvedCities, sourcePlan } = args.reading;
  const themeVariant = args.themeName ? { name: args.themeName } : undefined;

    const destinationStr = resolvedCities.length > 0 ? resolvedCities.join(', ') : 'popular travel destinations';
    const interestsStr = interests?.length > 0 ? interests.join(', ') : 'general sightseeing';
    const foodStr = foodDrink?.length > 0 ? foodDrink.join(', ') : 'local cuisine';
    const themeStr = themeVariant?.name || '';
    const currentYear = new Date().getFullYear();

    // The traveler's own words are usually the most specific thing in the
    // request ("hut to hut", "no driving", "travelling with a toddler"). They
    // used to reach only the final prompt, so the research never saw the trip
    // the user actually described.
    const tripNotes = (additionalNotes ?? '').trim().slice(0, 500);
    const notesClause = tripNotes
      ? ` The traveler describes the trip as: "${tripNotes}". Prioritise recommendations that fit that description.`
      : '';

    // Determine trip length for context-aware queries
    const tripDaysNum = durationDays || 7;

    // Which sources are worth reading is something the model already knows; an
    // instruction naming them mostly competes with the question for retrieval,
    // and an earlier version of this ran longer than the questions it was
    // attached to. What the model will not volunteer is where a given number
    // came from — unasked, a departure time arrives with no way to tell the
    // operator's timetable from a blog post six years stale. That is a
    // reporting contract, not knowledge, so it is stated, kept to one sentence,
    // and attached only to the topics carrying facts that expire.
    const SOURCING_CONTRACT = ` For any schedule, fare, fee, permit or opening window, name the operator or authority it came from, and say so when recent first-hand accounts contradict it. Flag anything you found in only one place.`;
    const factualTopics = new Set(['nearbyAndTransport', 'seasonal', 'planning', 'flights']);
    const sourceClause = (key: string) => (factualTopics.has(key) ? SOURCING_CONTRACT : '');

    // Vague words the traveler used, restated as tests. Injected where taste
    // decides the answer — asking a search engine for "hidden gems" returns the
    // pages that call themselves that, which is the opposite of the request.
    const interpretationClause = sourcePlan?.interpretations?.length
      ? ` Apply the following as tests a place must pass, not as phrases to match: ${sourcePlan.interpretations.join(" ")}`
      : "";

    // Keyed so a conditional query can be added without shifting the indices
    // the context block reads from.
    const searchSpecs: { key: string; query: string }[] = [
      // Activities and things to do. Asked for texture rather than a ranking:
      // "best things to do in X" is the query the listicle was written to
      // answer, and it returns the listicle no matter what sources are
      // preferred. What a day is actually like is what an itinerary is built
      // from, and what is overrated is as useful as what is good.
      {
        key: 'activities',
        query: `What is genuinely worth doing in ${destinationStr} for ${interestsStr} travelers, and what is each one actually like to do? For every recommendation: the specific name, what makes it worth the time, the time of day it is best and why, how long it realistically takes including getting there, and what it costs. Then cover two more things: what is overrated here and what people who know the place do instead, and which areas reward an unstructured hour on foot and what you would actually come across in them.${themeStr ? ` Weight this toward ${themeStr}.` : ''} ${budgetInfo.label} budget.${notesClause} Judge how well-trodden something is relative to ${destinationStr} itself — what people who know this place consider the tourist trail — not by how famous it is to an outsider.${interpretationClause}${sourceClause('activities')}`,
      },

      // Restaurants and food scene — emphasise currently operating
      {
        key: 'restaurants',
        query: `Where should someone actually eat in ${destinationStr} for ${foodStr}, confirmed still open and trading as of ${currentYear}? Exclude anything closed, temporarily closed, or of uncertain operating status. For each: the name, the neighborhood, what to order there, what a meal costs, what the room and the crowd are like and which kind of evening it suits, and whether it needs booking and how far ahead. Cover the whole range a traveler on this trip would really use across a week — the everyday place that is good every time and the one worth dressing up for — not a ranked list of the same destination restaurants. Cover ALL THREE MEALS, not only dinner: name the breakfast and coffee places — cafés, bakeries, brunch spots — and the casual lunch stops, as well as the dinner rooms. An itinerary needs somewhere real to eat every morning and midday, and dinner-only coverage cannot fill those slots. ${budgetInfo.label} budget.${tripNotes ? ` The traveler describes the trip as: "${tripNotes}" — if this trip spends nights somewhere without restaurants nearby (a mountain hut, a lodge, a remote village, a boat), say so and name where meals are actually eaten there instead.` : ''}${interpretationClause}${sourceClause('restaurants')}`,
      },

      // Where to sleep, in whatever form this trip actually needs
      {
        key: 'accommodation',
        query: `Where should someone stay in ${destinationStr} at ${budgetInfo.label} level, ${budgetInfo.accommodation}? ${startDate && endDate ? `For dates: check-in ${startDate}, check-out ${endDate}.` : targetMonth ? `For travel in ${targetMonth}.` : ''} For each: the specific name, the nightly rate, exactly where it sits and what that means for getting around, what it is actually like to stay there, what the immediate area is like in the evening, and what a night includes.${tripNotes ?` The traveler describes the trip as: "${tripNotes}" — include the kinds of lodging this trip actually requires (for example mountain huts or refuges, guesthouses, campsites, lodges, hostels, ryokan), not only conventional hotels, and note how each is booked and what a night includes such as half board.` : ''}${interpretationClause}${sourceClause('accommodation')}`,
      },

      // Where the trip goes and how it moves. Deliberately not branched on
      // whether the destination is one city: a region resolves to a single
      // string too, and the old branch then asked what to visit *outside* an
      // area the whole trip happens inside. One question covers both shapes.
      {
        key: 'nearbyAndTransport',
        query: `For a ${tripDaysNum}-day trip in ${destinationStr}: which places should the itinerary actually include, how do you travel between them (trains, buses, cable cars, ferries, driving — with prices and journey times), and how many days does each deserve? If this is a single city, cover what is worth leaving it for as day trips or overnight stops. If it is a region or a route, cover how to move between its towns and valleys, and whether it works better as a base with day trips or as a point-to-point traverse. For each move, say what it actually costs in usable hours once you count getting to the station and waiting for the connection, and whether it is worth doing at all for a stay that short.${notesClause}${sourceClause('nearbyAndTransport')}`,
      },

      // Seasonal & practical information
      {
        key: 'seasonal',
        query: `${destinationStr} travel in ${targetMonth || 'the travel season'}. Include weather, peak vs off-season pricing, festivals or events, crowd levels, and any seasonal closures.${notesClause}${sourceClause('seasonal')}`,
      },

      // Planning, booking windows, access rules, conditions and required skill.
      // These are the details that decide whether a trip is possible at all,
      // and none of the queries above ask about them.
      {
        key: 'planning',
        query: `Practical planning for a ${tripDaysNum}-day trip in ${destinationStr}${targetMonth ? ` in ${targetMonth}` : ''}${tripNotes ? `, described by the traveler as: "${tripNotes}"` : ''}. Answer each of these specifically for ${currentYear}: (1) How far in advance do the places to stay need to be booked, and how is each one booked — online, by email, deposit required, cash only? (2) What permits, reservations, entry fees, timed-entry slots, or vehicle and access restrictions apply, and how are they obtained? (3) What conditions, closures, or seasonal limits affect this trip, and what is the usable window? (4) What fitness or skill level, equipment, and guiding does it require, and where locally can equipment be rented or a guide hired, at what price?${sourceClause('planning')}`,
      },
    ];

    // Flight estimates (conditional)
    if (!noFlight && departureCity) {
      searchSpecs.push({
        key: 'flights',
        query: `Flights from ${departureCity} to ${destinationStr} in ${targetMonth || 'upcoming months'}. Which airports actually serve this destination — if it is a region rather than a city, name the realistic gateway airports and how far each is from it by road or rail. Include typical price ranges, best airlines, flight duration, and whether nonstop options exist.${sourceClause('flights')}`,
      });
    }

    return searchSpecs;
}

// ============================================================================
// RUNNING THE SEARCHES
// ============================================================================
  // Run the searches in parallel, but stagger the launches. Firing all six at
  // the same instant is what tripped Perplexity's rate limit — five came back
  // 429 in milliseconds, so the itinerary was built on one search out of six.
  // The ramp has to be wide enough that the FIRST attempt lands. 180ms apart
  // put all seven inside ~1.3s and everything 429'd; 700ms got every search
  // through, but only by retrying — the phase went from 11.9s to 34.7s, and
  // all of that was backoff. Retrying past a rate limit is far more expensive
  // than simply not tripping it, so the ramp is wider than feels necessary.
  // Watch for `[research] ... retrying` in the logs: none means this is right.
//
// `staggerSlot` shifts this call's ramp later. research-trip starts at slot 1
// because slot 0 belongs to the activities query each generate-itinerary call
// fires against the same Perplexity key at about the same moment.
export async function runResearch(args: {
  specs: QuerySpec[];
  resolvedCities: string[];
  foodPrefs: string[];
  perplexityKey: string;
  // Places dining is batch-wide, so only the call that owns the shared
  // research fetches it.
  includePlaces: boolean;
  placesKey: string | undefined;
  costs: CostTracker;
  timePhase: TimePhase;
  staggerSlot?: number;
}): Promise<{ research: Record<string, ResearchResult>; placesDining: CityDining[] }> {
  const { specs, costs, timePhase } = args;
  const slot = args.staggerSlot ?? 0;
  console.log(`Executing ${specs.length} Perplexity research queries...`);
  // Places runs alongside the web research: it answers from a different
  // corpus (the live Maps database) and shares no rate limit with
  // Perplexity, so the two phases overlap instead of stacking.
  const placesPromise = args.includePlaces
    ? timePhase("places_dining", () => fetchDiningPlaces(args.resolvedCities, args.placesKey, args.foodPrefs))
    : Promise.resolve({ dining: [] as CityDining[], requests: 0 });
  const results = await timePhase("perplexity_research", () =>
    Promise.all(specs.map(async (spec, i) => {
      const delay = (i + slot) * PERPLEXITY_STAGGER_MS;
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      return searchWithPerplexity(spec.query, args.perplexityKey, spec.key).then(r => {
        if (r.usage) costs.addPerplexity(`research_${spec.key}`, "sonar", r.usage);
        return r;
      });
    })));
  const { dining: placesDining, requests: placesRequests } = await placesPromise;
  costs.addGooglePlaces("places_dining", placesRequests);
  if (args.includePlaces) {
    console.log("[research] places dining: " + JSON.stringify(
      placesDining.map(d => ({
        city: d.city,
        ...Object.fromEntries(Object.entries(d.meals).map(([meal, ps]) => [meal, ps.length])),
      }))));
  }

  const research: Record<string, ResearchResult> = {};
  specs.forEach((spec, i) => { research[spec.key] = { content: results[i].content, citations: results[i].citations }; });
  return { research, placesDining };
}

// ============================================================================
// READING STORED RESEARCH BACK
//
// trip_research rows are written only by research-trip with the service role,
// but they are still checked for shape before the prompt treats them as
// ground truth: a malformed row falls back to researching from scratch.
// ============================================================================
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

export function parseTripReading(v: unknown): TripReading | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.resolvedCities) || typeof o.destinationWasResolved !== "boolean") return null;
  const p = o.sourcePlan as Record<string, unknown> | null | undefined;
  const sourcePlan: SourcePlan | null = p && typeof p === "object"
    ? {
      tripCharacter: typeof p.tripCharacter === "string" ? p.tripCharacter : undefined,
      interpretations: strings(p.interpretations),
      avoid: strings(p.avoid),
    }
    : null;
  return {
    resolvedCities: strings(o.resolvedCities),
    destinationWasResolved: o.destinationWasResolved,
    sourcePlan,
  };
}

export function parseSharedResearch(v: unknown): SharedResearch | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!o.research || typeof o.research !== "object" || !Array.isArray(o.placesDining)) return null;
  const research: Record<string, ResearchResult> = {};
  for (const [key, r] of Object.entries(o.research as Record<string, unknown>)) {
    if (key === THEME_SPECIFIC_KEY || !r || typeof r !== "object") continue;
    const rr = r as Record<string, unknown>;
    research[key] = {
      content: typeof rr.content === "string" ? rr.content : "",
      citations: strings(rr.citations),
    };
  }
  const placesDining = (o.placesDining as unknown[]).filter((d): d is CityDining =>
    !!d && typeof d === "object" && typeof (d as CityDining).city === "string" &&
    !!(d as CityDining).meals && typeof (d as CityDining).meals === "object");
  return { research, placesDining };
}

// ============================================================================
// WAITING FOR A BATCH'S SHARED RESEARCH
//
// research-trip writes its row in stages: `pending` the moment it starts,
// `reading` once the destination is resolved, `ready` once every batch-wide
// search is back, or `error`. A variant needs the reading before it can ask
// its own activities question, and the rest only when it builds the prompt,
// so it waits for the two separately and runs its own query in between.
//
// Every wait has a way out that ends in the variant researching the trip
// itself, so a slow or broken research-trip costs time, never the itinerary.
// The limits are sized to the shared pass (~20s measured for the same
// searches when one variant ran them all), with headroom for rate-limit
// retries.
// ============================================================================
export type TripResearchRow = {
  status: string;
  batch_id: string | null;
  created_at: string;
  reading: unknown;
  research: unknown;
};

// undefined: no row yet. null: the row is unusable or the lookup failed.
export type TripResearchLookup = () => Promise<TripResearchRow | null | undefined>;

export const RESEARCH_WAIT = {
  pollMs: 500,
  // research-trip inserts its row before doing anything else, so a row that
  // still does not exist after this long belongs to a call that never started.
  startGraceMs: 5_000,
  readingTimeoutMs: 20_000,
  readyTimeoutMs: 45_000,
  // Variants opened much later still reuse the batch's research; past this
  // it is stale enough (closures, prices) to research again.
  maxAgeMs: 12 * 60 * 60 * 1000,
};
export type ResearchWaitLimits = typeof RESEARCH_WAIT;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// A row worth waiting on, or null when the variant should stop waiting.
function usableRow(row: TripResearchRow, limits: ResearchWaitLimits): TripResearchRow | null {
  if (row.status === "error") return null;
  if (Date.now() - new Date(row.created_at).getTime() > limits.maxAgeMs) {
    console.warn("[research] shared research is stale — researching afresh");
    return null;
  }
  return row;
}

export async function waitForTripReading(
  lookup: TripResearchLookup,
  batchId: string | null,
  limits: ResearchWaitLimits = RESEARCH_WAIT,
): Promise<TripReading | null> {
  const start = Date.now();
  while (Date.now() - start < limits.readingTimeoutMs) {
    const found = await lookup();
    if (found === null) break;
    if (found === undefined) {
      if (Date.now() - start > limits.startGraceMs) {
        console.warn("[research] no shared research row — researching this variant directly");
        return null;
      }
    } else {
      const row = usableRow(found, limits);
      if (!row) break;
      // The id comes from the client; it should only ever name its own batch.
      if (batchId && row.batch_id && row.batch_id !== batchId) {
        console.warn("[research] shared research belongs to another batch — ignoring it");
        return null;
      }
      if (row.status === "reading" || row.status === "ready") {
        const reading = parseTripReading(row.reading);
        if (reading) return reading;
        break;
      }
    }
    await sleep(limits.pollMs);
  }
  console.warn("[research] shared reading unavailable — researching this variant directly");
  return null;
}

export async function waitForTripResearch(
  lookup: TripResearchLookup,
  limits: ResearchWaitLimits = RESEARCH_WAIT,
): Promise<SharedResearch | null> {
  const start = Date.now();
  while (Date.now() - start < limits.readyTimeoutMs) {
    const found = await lookup();
    const row = found ? usableRow(found, limits) : null;
    if (!row) return null;
    if (row.status === "ready") return parseSharedResearch(row.research);
    await sleep(limits.pollMs);
  }
  console.warn(`[research] shared research not ready after ${limits.readyTimeoutMs}ms`);
  return null;
}
