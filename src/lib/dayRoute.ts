import type { GeoPoint, ItineraryData, ItineraryDay } from "@/types/itinerary";

// One day as a route: the order the traveler visits its stops, shared by the
// day list (the numbers on the cards) and the day map (the numbers on the
// pins) so the two can never disagree.
//
// Within a period the meal is placed by its hour, the same convention the
// generation prompt routes by: breakfast and lunch open their periods, dinner
// closes the evening. Only a period's primary meal is a stop; alternatives
// are options, not places the traveler also goes.

export type StopKind = "activity" | "dining";

export interface DayStop {
  /** Same key the itinerary view uses for the item's feedback state. */
  key: string;
  /** 1-based visit order across the whole day. */
  number: number;
  periodIdx: number;
  periodLabel: string;
  kind: StopKind;
  /** Index into the period's activities or dining array. */
  itemIdx: number;
  name: string;
  coords?: GeoPoint;
}

export const activityKey = (d: number, p: number, a: number) => `d${d}-p${p}-a${a}`;
export const diningKey = (d: number, p: number, i: number) => `d${d}-p${p}-dine${i}`;

const MEAL_FIRST = new Set(["morning", "afternoon"]);
export const mealComesFirst = (periodLabel: string) => MEAL_FIRST.has(periodLabel.toLowerCase());

/** The colour family a stop is drawn in, on its card badge and its map pin. */
export const periodTone = (label: string): "morning" | "afternoon" | "evening" => {
  const l = label.toLowerCase();
  return l === "morning" ? "morning" : l === "afternoon" ? "afternoon" : "evening";
};

/** Index of the period's primary meal, or -1 when it has none. */
export const primaryDiningIdx = (dining: { isPrimary?: boolean }[] | null | undefined): number =>
  (dining ?? []).findIndex(d => d.isPrimary !== false);

/**
 * @param replaced Keys of items the traveler swapped for something else in
 *   this session. Their name still shows, but their old coordinates belong to
 *   the place that was replaced, so they lose their pin.
 * @param names Display-name overrides, keyed like `replaced`.
 */
export function buildDayStops(
  day: ItineraryDay,
  dayIdx: number,
  opts: { replaced?: ReadonlySet<string>; names?: Readonly<Record<string, string | undefined>> } = {},
): DayStop[] {
  const stops: Omit<DayStop, "number">[] = [];
  day.periods.forEach((period, p) => {
    const acts = (period.activities ?? []).map((a, i): Omit<DayStop, "number"> => {
      const key = activityKey(dayIdx, p, i);
      return {
        key, periodIdx: p, periodLabel: period.label, kind: "activity", itemIdx: i,
        name: opts.names?.[key] ?? a.name,
        coords: opts.replaced?.has(key) ? undefined : a.coords,
      };
    });
    const mealIdx = primaryDiningIdx(period.dining);
    const meal: Omit<DayStop, "number">[] = [];
    if (mealIdx >= 0) {
      const d = period.dining![mealIdx];
      const key = diningKey(dayIdx, p, mealIdx);
      meal.push({
        key, periodIdx: p, periodLabel: period.label, kind: "dining", itemIdx: mealIdx,
        name: opts.names?.[key] ?? d.name,
        coords: opts.replaced?.has(key) ? undefined : d.coords,
      });
    }
    stops.push(...(mealComesFirst(period.label) ? [...meal, ...acts] : [...acts, ...meal]));
  });
  return stops.map((s, i) => ({ ...s, number: i + 1 }));
}

const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance. Streets are longer; see `describeLeg`. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Streets wind: a straight line under-reads a city walk by roughly a quarter
// to a third. Applied only to the walking-time estimate, which is the number a
// traveler plans by; the distance itself is shown as the honest straight line.
const STREET_FACTOR = 1.3;
const WALK_KMH = 4.8;
/** Beyond this, a leg is not presented as a walk. */
export const WALK_LIMIT_KM = 2;

const MILE_LOCALES = /^en-(US|LR)\b|^my\b/i;
const usesMiles = () =>
  typeof navigator !== "undefined" && MILE_LOCALES.test(navigator.language ?? "");

export interface Leg {
  km: number;
  label: string;
  walkable: boolean;
  directionsUrl: string;
}

export function formatDistance(km: number, miles = usesMiles()): string {
  if (miles) {
    const mi = km * 0.621371;
    if (mi < 0.1) return `${Math.max(50, Math.round((km * 3280.84) / 50) * 50)} ft`;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (km < 1) return `${Math.max(50, Math.round((km * 1000) / 50) * 50)} m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** Google Maps directions between two stops: free, no API key, and it handles walking and transit itself. */
export function directionsUrl(from: GeoPoint, to: GeoPoint, walking: boolean): string {
  const params = new URLSearchParams({
    api: "1",
    origin: `${from.lat},${from.lng}`,
    destination: `${to.lat},${to.lng}`,
  });
  if (from.placeId) params.set("origin_place_id", from.placeId);
  if (to.placeId) params.set("destination_place_id", to.placeId);
  if (walking) params.set("travelmode", "walking");
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function describeLeg(from: GeoPoint, to: GeoPoint, miles?: boolean): Leg {
  const km = distanceKm(from, to);
  const walkable = km <= WALK_LIMIT_KM;
  const distance = formatDistance(km, miles);
  const minutes = Math.max(1, Math.round(((km * STREET_FACTOR) / WALK_KMH) * 60));
  return {
    km,
    walkable,
    label: walkable ? `${distance} · ~${minutes} min walk` : distance,
    directionsUrl: directionsUrl(from, to, walkable),
  };
}

const norm = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Fill in missing coordinates on `next` from same-named stops in `previous`.
 * The edit function does this server-side; this covers a response whose JSON
 * only parsed after the client's truncation repair.
 */
export function regraftCoords(next: ItineraryData, previous: ItineraryData): ItineraryData {
  const known = new Map<string, GeoPoint>();
  for (const day of previous.days) {
    for (const p of day.periods ?? []) {
      for (const item of [...(p.activities ?? []), ...(p.dining ?? [])]) {
        if (item.coords && item.name) known.set(norm(item.name), item.coords);
      }
    }
  }
  if (known.size === 0) return next;
  return {
    ...next,
    days: next.days.map(day => ({
      ...day,
      periods: (day.periods ?? []).map(p => ({
        ...p,
        activities: (p.activities ?? []).map(a =>
          a.coords || !a.name || !known.has(norm(a.name)) ? a : { ...a, coords: known.get(norm(a.name)) }),
        dining: p.dining?.map(d =>
          d.coords || !d.name || !known.has(norm(d.name)) ? d : { ...d, coords: known.get(norm(d.name)) }) ?? p.dining,
      })),
    })),
  };
}
