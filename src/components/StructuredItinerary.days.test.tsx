import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { StructuredItinerary } from "./StructuredItinerary";
import { makeItinerary } from "@/test/fixtures/itinerary";
import type { DayStop } from "@/lib/dayRoute";

// Leaflet needs a real layout engine; jsdom has none. The stub renders what
// the view hands the map, which is the contract under test here. The map
// itself is exercised in the browser.
vi.mock("./DayMap", () => ({
  default: ({ stops, onSelect, label }: { stops: DayStop[]; onSelect: (k: string) => void; label: string }) => (
    <div role="region" aria-label={label}>
      {stops.filter(s => s.coords).map(s => (
        <button key={s.key} onClick={() => onSelect(s.key)}>{`pin ${s.number}`}</button>
      ))}
    </div>
  ),
}));

const openDays = () => fireEvent.click(screen.getByRole("button", { name: /^Days \(/ }));

// Day 1 of the fixture, pinned: breakfast and the first activity sit in town,
// a short walk apart; the scenic drive is 15 km out.
const withCoords = () => {
  const data = makeItinerary();
  const [morning, afternoon, evening] = data.days[0].periods;
  morning.dining![0].coords = { lat: 38.5733, lng: -109.5498 };
  morning.activities[0].coords = { lat: 38.5760, lng: -109.5510 };
  afternoon.dining![0].coords = { lat: 38.5725, lng: -109.5505 };
  afternoon.activities[0].coords = { lat: 38.6858, lng: -109.5374 };
  evening.activities[0].coords = { lat: 38.7436, lng: -109.4993 };
  // Desert Bistro left unpinned: the lookup found nothing.
  return data;
};

describe("one-page day", () => {
  it("shows morning, afternoon and evening together, with a jump bar instead of tabs", () => {
    render(<StructuredItinerary data={makeItinerary()} />);
    openDays();

    for (const label of ["Morning", "Afternoon", "Evening"]) {
      expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
    }
    // Every part of the day is on the page at once.
    expect(screen.getByText("Arrive and check in")).toBeInTheDocument();
    expect(screen.getByText("Arches scenic drive")).toBeInTheDocument();
    expect(screen.getByText("Sunset at Delicate Arch viewpoint")).toBeInTheDocument();

    const jump = screen.getByRole("navigation", { name: "Jump to part of the day" });
    expect(within(jump).getAllByRole("button").map(b => b.textContent)).toEqual(["Morning", "Afternoon", "Evening"]);

    // Meals are named by their hour, and breakfast opens the morning.
    expect(screen.getByText("Breakfast")).toBeInTheDocument();
    expect(screen.getByText("Lunch")).toBeInTheDocument();
    expect(screen.getByText("Dinner")).toBeInTheDocument();
    const morning = screen.getByRole("region", { name: "Morning" });
    const text = morning.textContent ?? "";
    expect(text.indexOf("Moab Diner")).toBeLessThan(text.indexOf("Arrive and check in"));
  });

  it("shows no map for an itinerary made before coordinates existed", () => {
    render(<StructuredItinerary data={makeItinerary()} />);
    openDays();
    expect(screen.queryByRole("region", { name: /^Map of day/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Directions")).not.toBeInTheDocument();
  });

  it("maps the pinned stops and says how many could not be placed", async () => {
    render(<StructuredItinerary data={withCoords()} />);
    openDays();

    const map = await screen.findByRole("region", { name: "Map of day 1: 5 stops in visit order" });
    expect(within(map).getAllByRole("button").map(b => b.textContent))
      .toEqual(["pin 1", "pin 2", "pin 3", "pin 4", "pin 5"]);
    expect(screen.getByText("1 of 6 stops aren't on the map")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop 6, not on the map" })).toBeDisabled();
  });

  it("links each pinned leg to directions, as a walk when it is short", async () => {
    render(<StructuredItinerary data={withCoords()} />);
    openDays();
    await screen.findByRole("region", { name: /^Map of day 1/ });

    const walk = screen.getByRole("link", { name: "Directions from Moab Diner to Arrive and check in" });
    expect(walk.getAttribute("href")).toContain("travelmode=walking");
    const drive = screen.getByRole("link", { name: "Directions from Quesadilla Mobilla to Arches scenic drive" });
    expect(drive.getAttribute("href")).not.toContain("travelmode");
    // No leg into an unpinned stop.
    expect(screen.queryByRole("link", { name: /to Desert Bistro$/ })).not.toBeInTheDocument();
  });

  it("highlights a card when its pin is tapped", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<StructuredItinerary data={withCoords()} />);
    openDays();
    const map = await screen.findByRole("region", { name: /^Map of day 1/ });

    fireEvent.click(within(map).getByRole("button", { name: "pin 4" }));
    const card = document.getElementById("stop-d0-p1-a0")!;
    expect(card.className).toContain("ring-2");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("keeps locked days free of maps and route numbers", () => {
    const data = withCoords();
    data.days[0] = { ...data.days[0], periods: [], locked: true };
    render(<StructuredItinerary data={data} onUnlockRequest={() => {}} />);
    openDays();
    expect(screen.queryByRole("region", { name: /^Map of day/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Jump to part of the day" })).not.toBeInTheDocument();
  });
});
