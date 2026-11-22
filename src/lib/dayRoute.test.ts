import { describe, it, expect } from "vitest";
import { buildDayStops, describeLeg, directionsUrl, formatDistance, regraftCoords } from "./dayRoute";
import { makeItinerary } from "@/test/fixtures/itinerary";
import { mergeEditedItinerary } from "./itineraryEdit";

describe("buildDayStops", () => {
  it("orders a day as breakfast → morning → lunch → afternoon → evening → dinner", () => {
    const day = makeItinerary().days[0];
    const stops = buildDayStops(day, 0);
    expect(stops.map(s => s.name)).toEqual([
      "Moab Diner",
      "Arrive and check in",
      "Quesadilla Mobilla",
      "Arches scenic drive",
      "Sunset at Delicate Arch viewpoint",
      "Desert Bistro",
    ]);
    expect(stops.map(s => s.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stops[0]).toMatchObject({ kind: "dining", key: "d0-p0-dine0", periodLabel: "Morning" });
    expect(stops[1]).toMatchObject({ kind: "activity", key: "d0-p0-a0" });
  });

  it("counts only the primary meal as a stop", () => {
    const day = makeItinerary().days[0];
    day.periods[0].dining!.push({ name: "Backup café", description: "", isPrimary: false });
    expect(buildDayStops(day, 0).filter(s => s.periodIdx === 0).map(s => s.name))
      .toEqual(["Moab Diner", "Arrive and check in"]);
  });

  it("drops the pin of an item the traveler replaced, keeping its new name", () => {
    const day = makeItinerary().days[0];
    day.periods[0].activities[0].coords = { lat: 38.57, lng: -109.55 };
    const stops = buildDayStops(day, 0, {
      replaced: new Set(["d0-p0-a0"]),
      names: { "d0-p0-a0": "Coffee at the lodge" },
    });
    expect(stops[1]).toMatchObject({ name: "Coffee at the lodge", coords: undefined });
  });
});

describe("legs", () => {
  const a = { lat: 38.5733, lng: -109.5498 };
  const nearby = { lat: 38.5775, lng: -109.5498 }; // ~470 m north

  it("presents a short hop as a walk with a time estimate", () => {
    const leg = describeLeg(a, nearby, false);
    expect(leg.walkable).toBe(true);
    expect(leg.label).toMatch(/^\d+ m · ~\d+ min walk$/);
    expect(leg.directionsUrl).toContain("travelmode=walking");
  });

  it("does not call a 20 km leg a walk", () => {
    const far = { lat: 38.75, lng: -109.55 };
    const leg = describeLeg(a, far, false);
    expect(leg.walkable).toBe(false);
    expect(leg.label).toBe("20 km");
    expect(leg.directionsUrl).not.toContain("travelmode");
  });

  it("formats miles for imperial locales", () => {
    expect(formatDistance(1.609, true)).toBe("1.0 mi");
    expect(formatDistance(0.4, false)).toBe("400 m");
    // Under a tenth of a mile, feet: "< 0.1 mi" tells a walker nothing.
    expect(formatDistance(0.09, true)).toBe("300 ft");
  });

  it("passes place ids to Google Maps when known", () => {
    const url = directionsUrl({ ...a, placeId: "A1" }, { ...nearby, placeId: "B2" }, true);
    const q = new URL(url).searchParams;
    expect(q.get("origin")).toBe("38.5733,-109.5498");
    expect(q.get("origin_place_id")).toBe("A1");
    expect(q.get("destination_place_id")).toBe("B2");
  });
});

describe("coordinates through a whole-itinerary edit", () => {
  it("re-attaches pins to stops whose name survived, and leaves new stops unpinned", () => {
    const previous = makeItinerary();
    previous.days[0].periods[1].activities[0].coords = { lat: 38.68, lng: -109.57 };
    previous.days[0].periods[2].dining![0].coords = { lat: 38.57, lng: -109.55 };

    const edited = makeItinerary();
    edited.days[0].periods[2].dining![0] = { name: "New dinner spot", description: "", isPrimary: true };
    const merged = mergeEditedItinerary(JSON.stringify(edited), previous)!;

    expect(merged.days[0].periods[1].activities[0].coords).toEqual({ lat: 38.68, lng: -109.57 });
    expect(merged.days[0].periods[2].dining![0].coords).toBeUndefined();
  });

  it("is a no-op for itineraries made before the map", () => {
    const data = makeItinerary();
    expect(regraftCoords(data, makeItinerary())).toBe(data);
  });
});
