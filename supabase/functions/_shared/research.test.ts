import { deepStrictEqual as assertEquals, notDeepStrictEqual as assertNotEquals, ok as assert } from "node:assert/strict";
import { CostTracker } from "./costs.ts";
import {
  buildQuerySpecs,
  parseSharedResearch,
  parseTripReading,
  runResearch,
  THEME_SPECIFIC_KEY,
  type ResearchWaitLimits,
  type TimePhase,
  type TripReading,
  type TripResearchRow,
  waitForTripReading,
  waitForTripResearch,
} from "./research.ts";
import type { TripContext, TripPreferences } from "./tripPreferences.ts";

const preferences = {
  media: [],
  cities: ["Dolomites, Italy"],
  budgetAccommodation: 50,
  budgetFlight: 50,
  dateFlexibility: "month",
  targetMonth: "July",
  durationFlexibility: "1-week",
  durationDays: 6,
  noFlight: false,
  departureCity: "Boston",
  flightDirectness: "short-layover",
  atmosphere: ["quiet"],
  adventureLevel: "active",
  guidedPreference: "self-guided",
  foodDrink: ["local"],
  interests: ["hiking", "food"],
  additionalNotes: "hut to hut, no driving",
} as TripPreferences;

const trip: TripContext = {
  budgetInfo: { label: "Moderate", accommodation: "$50-$100/night", daily: "$100-150/day" },
  flightBudget: "$300-$600",
  durationContext: "7 day trip",
  dateContext: "Target: July",
  guidedLabel: "Self-guided only - no guided tours, DIY everything",
};

const reading: TripReading = {
  resolvedCities: ["Dolomites, Italy"],
  destinationWasResolved: false,
  sourcePlan: { tripCharacter: "A hut-to-hut traverse.", interpretations: ["Quiet means huts, not resorts."], avoid: [] },
};

const passThrough: TimePhase = (_name, fn) => fn();

Deno.test("only the activities query depends on the theme", () => {
  const a = buildQuerySpecs({ preferences, trip, reading, themeName: "Summit Chaser" });
  const b = buildQuerySpecs({ preferences, trip, reading, themeName: "Slow Valleys" });
  const shared = buildQuerySpecs({ preferences, trip, reading });

  assertEquals(a.map(s => s.key), b.map(s => s.key));
  for (const [i, spec] of a.entries()) {
    if (spec.key === THEME_SPECIFIC_KEY) {
      assertNotEquals(spec.query, b[i].query);
      assert(spec.query.includes("Summit Chaser"));
    } else {
      // Sharing these across a batch is only correct if no theme reaches them.
      assertEquals(spec.query, b[i].query, `${spec.key} changed with the theme`);
      assertEquals(spec.query, shared[i].query, `${spec.key} differs from the shared pass`);
    }
  }
});

Deno.test("the flight query runs only when there is a flight to research", () => {
  const withFlight = buildQuerySpecs({ preferences, trip, reading }).map(s => s.key);
  assertEquals(withFlight, ["activities", "restaurants", "accommodation", "nearbyAndTransport", "seasonal", "planning", "flights"]);
  const noFlight = buildQuerySpecs({ preferences: { ...preferences, noFlight: true }, trip, reading }).map(s => s.key);
  assert(!noFlight.includes("flights"));
  const noDeparture = buildQuerySpecs({ preferences: { ...preferences, departureCity: "" }, trip, reading }).map(s => s.key);
  assert(!noDeparture.includes("flights"));
});

Deno.test("a stored reading survives the round trip; malformed ones are rejected", () => {
  assertEquals(parseTripReading(JSON.parse(JSON.stringify(reading))), reading);
  assertEquals(parseTripReading({ ...reading, sourcePlan: null })?.sourcePlan, null);
  assertEquals(parseTripReading(null), null);
  assertEquals(parseTripReading({ resolvedCities: "Rome" }), null);
  assertEquals(parseTripReading({ resolvedCities: ["Rome"] }), null);
});

Deno.test("stored shared research never supplies the theme's own query", () => {
  const stored = {
    research: {
      restaurants: { content: "Rifugio food", citations: ["https://example.com", 7] },
      activities: { content: "another theme's activities", citations: [] },
      seasonal: { content: 42 },
    },
    placesDining: [{ city: "Cortina", meals: { Breakfast: [] } }, { nope: true }],
  };
  const parsed = parseSharedResearch(stored)!;
  assertEquals(Object.keys(parsed.research).sort(), ["restaurants", "seasonal"]);
  assertEquals(parsed.research.restaurants.citations, ["https://example.com"]);
  assertEquals(parsed.research.seasonal.content, "");
  assertEquals(parsed.placesDining.length, 1);
  assertEquals(parseSharedResearch({ research: {} }), null);
  assertEquals(parseSharedResearch("ready"), null);
});

Deno.test("runResearch keys results by query, prices them, and skips Places when not asked", async () => {
  const realFetch = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    hosts.push(url.host);
    return Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: "Real places." } }],
      citations: ["https://example.com/a"],
      usage: { prompt_tokens: 100, completion_tokens: 200 },
    })));
  }) as typeof fetch;
  try {
    const costs = new CostTracker();
    const { research, placesDining } = await runResearch({
      specs: [{ key: "activities", query: "What is worth doing?" }],
      resolvedCities: ["Cortina"],
      foodPrefs: [],
      perplexityKey: "test",
      includePlaces: false,
      placesKey: "places-test",
      costs,
      timePhase: passThrough,
    });
    assertEquals(research, { activities: { content: "Real places.", citations: ["https://example.com/a"] } });
    assertEquals(placesDining, []);
    assertEquals(hosts, ["api.perplexity.ai"]);
    assertEquals(costs.entries.map(e => e.phase), ["research_activities"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Fast limits so the timeout paths run in milliseconds.
const fast: ResearchWaitLimits = {
  pollMs: 5, startGraceMs: 30, readingTimeoutMs: 120, readyTimeoutMs: 120, maxAgeMs: 60_000,
};
const row = (over: Partial<TripResearchRow>): TripResearchRow => ({
  status: "pending", batch_id: "batch-1", created_at: new Date().toISOString(), reading: null, research: null, ...over,
});
// Hands out the given rows in turn, then keeps repeating the last.
const sequence = (...rows: (TripResearchRow | null | undefined)[]) => {
  let i = 0;
  return () => Promise.resolve(rows[Math.min(i++, rows.length - 1)]);
};

Deno.test("a variant waits through pending and picks up the reading", async () => {
  const lookup = sequence(undefined, row({}), row({ status: "reading", reading }));
  assertEquals(await waitForTripReading(lookup, "batch-1", fast), reading);
});

Deno.test("a variant stops waiting for a reading when it can't be used", async () => {
  // research-trip failed
  assertEquals(await waitForTripReading(sequence(row({ status: "error" })), "batch-1", fast), null);
  // research-trip never started: no row past the start grace
  const start = Date.now();
  assertEquals(await waitForTripReading(sequence(undefined), "batch-1", fast), null);
  assert(Date.now() - start < fast.readingTimeoutMs, "gave up at the start grace, not the full timeout");
  // stuck in pending
  assertEquals(await waitForTripReading(sequence(row({})), "batch-1", fast), null);
  // someone else's batch
  assertEquals(await waitForTripReading(sequence(row({ status: "reading", reading, batch_id: "other" })), "batch-1", fast), null);
  // stale
  const old = new Date(Date.now() - 2 * fast.maxAgeMs).toISOString();
  assertEquals(await waitForTripReading(sequence(row({ status: "ready", reading, created_at: old })), "batch-1", fast), null);
  // lookup failed (e.g. the table is missing)
  assertEquals(await waitForTripReading(sequence(null), "batch-1", fast), null);
  // malformed reading
  assertEquals(await waitForTripReading(sequence(row({ status: "reading", reading: { nope: 1 } })), "batch-1", fast), null);
});

Deno.test("a variant waits for the shared searches and falls back if they never finish", async () => {
  const research = { research: { seasonal: { content: "July is busy", citations: [] } }, placesDining: [] };
  const ready = sequence(row({ status: "reading", reading }), row({ status: "ready", reading, research }));
  assertEquals(await waitForTripResearch(ready, fast), { research: { seasonal: { content: "July is busy", citations: [] } }, placesDining: [] });

  assertEquals(await waitForTripResearch(sequence(row({ status: "reading", reading }), row({ status: "error" })), fast), null);
  assertEquals(await waitForTripResearch(sequence(row({ status: "reading", reading })), fast), null);
  assertEquals(await waitForTripResearch(sequence(undefined), fast), null);
});
