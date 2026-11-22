import type { CostTracker } from "./costs.ts";
import type { CityDining } from "./research.ts";

// ============================================================================
// PINNING A DAY'S STOPS ON A MAP
//
// The day map needs a coordinate for every stop it draws. Two sources, cheapest
// first:
//   1. Restaurants the Places dining backbone already returned. That search
//      carries each place's location at no extra cost, so a meal assigned from
//      it is pinned for free.
//   2. One Places Text Search per remaining stop. An activity is only looked up
//      when the model gave it a `mapQuery` — the one findable place where it
//      happens. Open time, a drive or a ridge walk has no single place, and
//      guessing one would put a confident pin somewhere the traveler never goes.
//
// Only the primary meal of each period is paid for: alternatives are options,
// not stops, and the map does not draw them. They still get a free coordinate
// when the dining backbone knows them.
//
// Nothing here throws. A failed lookup is a missing pin, never a failed day.
// ============================================================================

export type Coords = { lat: number; lng: number; placeId?: string };

type Json = Record<string, unknown>;

const norm = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();

const isCoords = (v: unknown): v is Coords =>
  !!v && typeof v === "object" &&
  typeof (v as Coords).lat === "number" && Number.isFinite((v as Coords).lat) &&
  typeof (v as Coords).lng === "number" && Number.isFinite((v as Coords).lng);

/** Name → coordinate for every restaurant the dining backbone returned. */
export function knownPlaceCoords(dining: CityDining[] | undefined): Map<string, Coords> {
  const out = new Map<string, Coords>();
  for (const city of dining ?? []) {
    for (const places of Object.values(city.meals)) {
      for (const p of places) {
        if (p.coords && !out.has(norm(p.name))) out.set(norm(p.name), p.coords);
      }
    }
  }
  return out;
}

async function placesLocate(query: string, apiKey: string, timeoutMs: number): Promise<Coords | null> {
  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.location",
      },
      body: JSON.stringify({ textQuery: query, pageSize: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[geocode] ${response.status} for "${query}": ${body.slice(0, 200)}`);
      return null;
    }
    const data = await response.json();
    const place = Array.isArray(data.places) ? data.places[0] : null;
    const lat = place?.location?.latitude;
    const lng = place?.location?.longitude;
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return { lat, lng, ...(typeof place.id === "string" ? { placeId: place.id } : {}) };
  } catch (error) {
    console.error(`[geocode] lookup failed for "${query}":`, error instanceof Error ? error.message : error);
    return null;
  }
}

const toRad = (d: number) => (d * Math.PI) / 180;
export function distanceKm(a: Coords, b: Coords): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// A text search for "Café Central, Porto" occasionally lands on the Café
// Central in another country. Generous enough for a road-trip day; a wrong
// match is almost always a different city, not 100km down the same road.
export const OUTLIER_KM = 150;

/** Drop pins that sit implausibly far from the rest of their day. */
export function dropOutliers(points: Coords[]): Set<Coords> {
  const bad = new Set<Coords>();
  if (points.length < 3) return bad;
  const center = { lat: median(points.map(p => p.lat)), lng: median(points.map(p => p.lng)) };
  for (const p of points) if (distanceKm(center, p) > OUTLIER_KM) bad.add(p);
  return bad;
}

type Target = { holder: Json; query: string; paid: boolean };

function collectTargets(day: Json, known: Map<string, Coords>): Target[] {
  const location = typeof day.location === "string" ? day.location : "";
  const withPlace = (q: string) =>
    location && !norm(q).includes(norm(location)) ? `${q}, ${location}` : q;
  const targets: Target[] = [];
  for (const period of (Array.isArray(day.periods) ? day.periods : []) as Json[]) {
    for (const act of (Array.isArray(period?.activities) ? period.activities : []) as Json[]) {
      if (!act || isCoords(act.coords)) continue;
      const q = typeof act.mapQuery === "string" ? act.mapQuery.trim() : "";
      if (q) targets.push({ holder: act, query: withPlace(q), paid: true });
    }
    const dining = (Array.isArray(period?.dining) ? period.dining : []) as Json[];
    dining.forEach((d, i) => {
      if (!d || isCoords(d.coords) || typeof d.name !== "string" || !d.name.trim()) return;
      const hit = known.get(norm(d.name));
      if (hit) { d.coords = hit; return; }
      // Only the stop the map draws is worth a paid lookup.
      const isStop = d.isPrimary !== false && i === dining.findIndex(x => x?.isPrimary !== false);
      if (isStop) targets.push({ holder: d, query: withPlace(d.name.trim()), paid: true });
    });
  }
  return targets;
}

export type GeocodeOptions = {
  apiKey: string | undefined;
  known?: Map<string, Coords>;
  costs?: CostTracker;
  /** Cost-row phase label. */
  phase?: string;
  /** Shared across calls in one request so a repeated place is paid for once. */
  cache?: Map<string, Promise<Coords | null>>;
  /** Absolute epoch-ms after which no new lookups start. */
  deadline?: number;
  concurrency?: number;
};

/**
 * Attach `coords` to the activities and primary meals of each day, in place.
 * Days without periods (locked, failed) are skipped. Never throws.
 */
export async function geocodeDays(days: Json[], opts: GeocodeOptions): Promise<void> {
  try {
    const known = opts.known ?? new Map();
    const perDay = days.map(day => (day && typeof day === "object" ? collectTargets(day, known) : []));
    const paid = perDay.flat().filter(t => t.paid);
    if (paid.length === 0 || !opts.apiKey) {
      if (paid.length && !opts.apiKey) console.warn("[geocode] GOOGLE_PLACES_API_KEY not configured — map pins only from dining data");
      return finish(days);
    }

    const cache = opts.cache ?? new Map<string, Promise<Coords | null>>();
    const deadline = opts.deadline ?? Date.now() + 10_000;
    const queue = [...paid];
    let requests = 0;
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const remaining = deadline - Date.now();
        if (remaining < 500) return;
        const key = norm(t.query);
        let pending = cache.get(key);
        if (!pending) {
          requests++;
          pending = placesLocate(t.query, opts.apiKey!, Math.min(5_000, remaining));
          cache.set(key, pending);
        }
        const found = await pending;
        if (found) t.holder.coords = found;
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, queue.length) }, worker));
    if (requests > 0) opts.costs?.addGooglePlaces(opts.phase ?? "places_geocode", requests);
    finish(days);
    const pinned = paid.filter(t => isCoords(t.holder.coords)).length;
    console.log(`[geocode] ${pinned}/${paid.length} paid stop(s) pinned with ${requests} request(s)`);
  } catch (error) {
    console.error("[geocode] unexpected failure — shipping days without new pins:", error);
  }
}

// Outlier pass, per day, over every coordinate the day now carries.
function finish(days: Json[]) {
  for (const day of days) {
    const holders: Json[] = [];
    for (const period of (Array.isArray(day?.periods) ? day.periods : []) as Json[]) {
      for (const a of (Array.isArray(period?.activities) ? period.activities : []) as Json[]) if (a && isCoords(a.coords)) holders.push(a);
      for (const d of (Array.isArray(period?.dining) ? period.dining : []) as Json[]) if (d && isCoords(d.coords)) holders.push(d);
    }
    const bad = dropOutliers(holders.map(h => h.coords as Coords));
    for (const h of holders) {
      if (bad.has(h.coords as Coords)) {
        console.warn(`[geocode] dropped outlier pin for "${String(h.name ?? "")}"`);
        delete h.coords;
      }
    }
  }
}

/** Strip coordinates (they are not the edit model's business) and remember them by name. */
export function takeCoords(days: Json[]): Map<string, Coords> {
  const out = new Map<string, Coords>();
  for (const day of days) {
    for (const period of (Array.isArray(day?.periods) ? day.periods : []) as Json[]) {
      for (const item of [
        ...((Array.isArray(period?.activities) ? period.activities : []) as Json[]),
        ...((Array.isArray(period?.dining) ? period.dining : []) as Json[]),
      ]) {
        if (!item) continue;
        if (isCoords(item.coords) && typeof item.name === "string") out.set(norm(item.name), item.coords);
        delete item.coords;
      }
    }
  }
  return out;
}

/** Re-attach remembered coordinates to items whose name survived the edit. */
export function restoreCoords(days: Json[], saved: Map<string, Coords>) {
  for (const day of days) {
    for (const period of (Array.isArray(day?.periods) ? day.periods : []) as Json[]) {
      for (const item of [
        ...((Array.isArray(period?.activities) ? period.activities : []) as Json[]),
        ...((Array.isArray(period?.dining) ? period.dining : []) as Json[]),
      ]) {
        if (!item || isCoords(item.coords) || typeof item.name !== "string") continue;
        const hit = saved.get(norm(item.name));
        if (hit) item.coords = hit;
      }
    }
  }
}
