import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { CostTracker } from "./costs.ts";
import { dropOutliers, geocodeDays, knownPlaceCoords, restoreCoords, takeCoords } from "./geocode.ts";
import type { CityDining } from "./research.ts";

type Json = Record<string, unknown>;

const makeDay = (): Json => ({
  dayNumber: 1,
  title: "Old town",
  location: "Porto",
  periods: [
    {
      label: "Morning",
      activities: [
        { name: "Livraria Lello", mapQuery: "Livraria Lello", description: "" },
        { name: "Wander Ribeira", description: "No single place" },
      ],
      dining: [
        { name: "Manteigaria", description: "", isPrimary: true },
        { name: "Café Santiago", description: "", isPrimary: false },
      ],
    },
    {
      label: "Afternoon",
      activities: [{ name: "Clérigos Tower", mapQuery: "Torre dos Clérigos, Porto", description: "" }],
      dining: [{ name: "Cantinho do Avillez", description: "", isPrimary: true }],
    },
  ],
});

// Records every query and answers from a lookup table; unknown queries get no result.
function stubPlaces(answers: Record<string, { lat: number; lng: number }>) {
  const queries: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const q = JSON.parse(String(init?.body)).textQuery as string;
    queries.push(q);
    const hit = answers[q];
    const body = hit ? { places: [{ id: `id:${q}`, location: { latitude: hit.lat, longitude: hit.lng } }] } : {};
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof fetch;
  return { queries, restore: () => { globalThis.fetch = realFetch; } };
}

const at = (day: Json, p: number, kind: "activities" | "dining", i: number) =>
  ((day.periods as Json[])[p][kind] as Json[])[i];

Deno.test("pins mapQuery activities and primary meals, skips place-less activities and paid alternatives", async () => {
  const stub = stubPlaces({
    "Livraria Lello, Porto": { lat: 41.1469, lng: -8.6149 },
    "Torre dos Clérigos, Porto": { lat: 41.1456, lng: -8.6146 },
    "Manteigaria, Porto": { lat: 41.1488, lng: -8.6062 },
  });
  try {
    const day = makeDay();
    const costs = new CostTracker();
    await geocodeDays([day], { apiKey: "k", costs });

    assertEquals(at(day, 0, "activities", 0).coords, { lat: 41.1469, lng: -8.6149, placeId: "id:Livraria Lello, Porto" });
    assertEquals(at(day, 0, "activities", 1).coords, undefined);
    assert(at(day, 0, "dining", 0).coords);
    assertEquals(at(day, 0, "dining", 1).coords, undefined);
    // The query already names its town, so the day's location is not appended twice.
    assert(stub.queries.includes("Torre dos Clérigos, Porto"));
    assert(!stub.queries.some(q => q.includes("Café Santiago")));
    assertEquals(costs.entries.reduce((n, e) => n + e.requests, 0), stub.queries.length);
  } finally {
    stub.restore();
  }
});

Deno.test("meals the dining backbone already located cost nothing, alternatives included", async () => {
  const stub = stubPlaces({});
  try {
    const known = knownPlaceCoords([{
      city: "Porto",
      meals: {
        Breakfast: [
          { name: "Manteigaria", rating: 4.7, ratingCount: 900, price: "$", address: "", mapsUrl: "", coords: { lat: 41.1, lng: -8.6 } },
          { name: "Café Santiago", rating: 4.5, ratingCount: 900, price: "$", address: "", mapsUrl: "", coords: { lat: 41.2, lng: -8.6 } },
        ],
      },
    }] as CityDining[]);
    const day = makeDay();
    await geocodeDays([day], { apiKey: "k", known });
    assertEquals(at(day, 0, "dining", 0).coords, { lat: 41.1, lng: -8.6 });
    assertEquals(at(day, 0, "dining", 1).coords, { lat: 41.2, lng: -8.6 });
    assert(!stub.queries.some(q => q.startsWith("Manteigaria")));
  } finally {
    stub.restore();
  }
});

Deno.test("without an API key nothing is fetched and nothing throws", async () => {
  const stub = stubPlaces({});
  try {
    const day = makeDay();
    await geocodeDays([day], { apiKey: undefined });
    assertEquals(stub.queries.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("a lookup that lands in another city is dropped as an outlier", () => {
  const porto = [{ lat: 41.14, lng: -8.61 }, { lat: 41.15, lng: -8.62 }, { lat: 41.145, lng: -8.6 }];
  const lisbon = { lat: 38.72, lng: -9.14 };
  const bad = dropOutliers([...porto, lisbon]);
  assert(bad.has(lisbon));
  assertEquals(bad.size, 1);
});

Deno.test("coordinates survive an edit by name and are not sent to the model", () => {
  const day = makeDay();
  at(day, 0, "activities", 0).coords = { lat: 1, lng: 2 };
  const saved = takeCoords([day]);
  assertEquals(at(day, 0, "activities", 0).coords, undefined);

  const edited = makeDay();
  (at(edited, 0, "activities", 0) as Json).name = "LIVRARIA LELLO";
  restoreCoords([edited], saved);
  assertEquals(at(edited, 0, "activities", 0).coords, { lat: 1, lng: 2 });
});
