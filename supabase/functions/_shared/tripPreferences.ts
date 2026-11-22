// The trip request as the form sends it, and the plain-language descriptions
// of it that both the research and the itinerary prompt are built from.
// Shared by generate-itinerary and research-trip so the two describe a trip
// in exactly the same words.
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

export const PreferencesSchema = z.object({
  media: z.array(z.object({
    type: z.enum(['image', 'video']),
    preview: z.string().max(10000).optional(),
    url: z.string().max(1000).optional(), // Public URL from storage
    name: z.string().max(200).optional(),
  })).max(10).default([]),
  cities: z.array(z.string().max(100)).max(20).default([]),
  budgetAccommodation: z.number().min(0).max(100).default(50),
  budgetFlight: z.number().min(0).max(100).default(50),
  dateFlexibility: z.string().max(50).default('anytime'),
  startDate: z.string().max(50).optional(),
  endDate: z.string().max(50).optional(),
  flexibleDays: z.number().min(1).max(14).optional(), // ± days flexibility when using exact dates
  targetMonth: z.string().max(50).default(''),
  durationFlexibility: z.string().max(50).default('1-week'),
  durationDays: z.number().min(1).max(90).default(7),
  noFlight: z.boolean().default(false),
  departureCity: z.string().max(100).default(''),
  flightDirectness: z.string().max(50).default('short-layover'),
  atmosphere: z.array(z.string().max(50)).max(10).default([]),
  adventureLevel: z.string().max(50).default('active'),
  guidedPreference: z.string().max(50).default('some-guided'),
  foodDrink: z.array(z.string().max(50)).max(10).default([]),
  interests: z.array(z.string().max(50)).max(20).default([]),
  additionalNotes: z.string().max(5000).default(''),
  // Who is travelling: 'solo' | 'couple' | 'friends' | 'family', or '' when not said
  travelers: z.string().max(50).default(''),
});

export type TripPreferences = z.infer<typeof PreferencesSchema>;

export type BudgetInfo = { label: string; accommodation: string; daily: string };

// Derived, human-readable descriptions of the request. Every prompt and query
// that mentions budget, dates or duration reads these rather than the raw
// form values.
export type TripContext = {
  budgetInfo: BudgetInfo;
  flightBudget: string;
  durationContext: string;
  dateContext: string;
  guidedLabel: string;
  travelersLabel: string;
};

export function describeTrip(preferences: TripPreferences): TripContext {
  const {
    budgetAccommodation,
    budgetFlight,
    dateFlexibility,
    startDate,
    endDate,
    flexibleDays,
    targetMonth,
    durationFlexibility,
    durationDays,
    guidedPreference,
    travelers,
  } = preferences;

  // Build budget context
  const getBudgetLabel = (value: number) => {
    if (value <= 25) return { label: "Budget", accommodation: "$0-$50/night", daily: "$50-80/day" };
    if (value <= 50) return { label: "Moderate", accommodation: "$50-$100/night", daily: "$100-150/day" };
    if (value <= 75) return { label: "Comfortable", accommodation: "$100-$200/night", daily: "$200-300/day" };
    return { label: "Luxury", accommodation: "$200+/night", daily: "$400+/day" };
  };

  const getFlightBudget = (value: number) => {
    if (value <= 25) return "$100-$300";
    if (value <= 50) return "$300-$600";
    if (value <= 75) return "$600-$1000";
    return "$1000+";
  };

  const budgetInfo = getBudgetLabel(budgetAccommodation);
  const flightBudget = getFlightBudget(budgetFlight);

  // Build duration context
  const computeInclusiveDays = (startISO?: string, endISO?: string) => {
    if (!startISO || !endISO) return null;
    const start = new Date(startISO);
    const end = new Date(endISO);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    const diffMs = end.getTime() - start.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    return diffDays + 1; // inclusive
  };

  let durationContext = "";

  // If user chose exact dates, calculate base duration and apply flexibility
  if (dateFlexibility === "strict") {
    const daysFromDates = computeInclusiveDays(startDate, endDate);
    if (daysFromDates) {
      if (flexibleDays && flexibleDays > 0) {
        // User has exact dates but with ± N days flexibility
        const minDays = Math.max(1, daysFromDates - flexibleDays);
        const maxDays = daysFromDates + flexibleDays;
        durationContext = `${minDays}-${maxDays} days (base: ${daysFromDates} days, ±${flexibleDays} days flexible)`;
      } else {
        durationContext = `exactly ${daysFromDates} days`;
      }
    } else {
      durationContext = "dates provided but duration unclear";
    }
  } else {
    switch (durationFlexibility) {
      case "weekend":
        durationContext = "2-3 day weekend trip";
        break;
      case "long-weekend":
        durationContext = "4-5 day long weekend";
        break;
      case "1-week":
        durationContext = "7 day trip";
        break;
      case "2-weeks":
        durationContext = "14 day trip";
        break;
      case "strict":
        durationContext = `exactly ${durationDays} days`;
        break;
      case "flexible-days":
        durationContext = `approximately ${durationDays} days (±2 days flexible)`;
        break;
      default:
        durationContext = "flexible duration - suggest optimal length";
    }
  }

  // Build date context
  let dateContext = "";
  switch (dateFlexibility) {
    case "strict":
      if (startDate && endDate) {
        if (flexibleDays && flexibleDays > 0) {
          // Exact dates with flexibility - AI can extend trip by ± N days on either end
          dateContext = `Target dates: ${startDate} to ${endDate} (±${flexibleDays} days flexible on either end). You may start up to ${flexibleDays} days earlier or end up to ${flexibleDays} days later if it improves the trip. Choose what works best for the destination and activities.`;
        } else {
          dateContext = `Fixed dates: ${startDate} to ${endDate}`;
        }
      } else {
        dateContext = "Specific dates (not provided)";
      }
      break;
    case "flexible-days":
      dateContext = startDate ? `Around ${startDate} (±few days flexible)` : "Flexible around specific dates";
      break;
    case "month":
      dateContext = targetMonth ? `Target: ${targetMonth}` : "Specific month/season";
      break;
    default:
      dateContext = "Anytime - recommend best time to visit";
  }

  // Build vibe context
  const guidedLabels: Record<string, string> = {
    'fully-guided': 'Prefer guided tours and organized activities',
    'some-guided': 'Mix of guided activities and self-exploration',
    'self-guided': 'Self-guided only - no guided tours, DIY everything'
  };
  const guidedLabel = guidedLabels[guidedPreference as string] || 'No preference';

  // Who is travelling changes rooms, pace and where dinner makes sense
  const travelersLabels: Record<string, string> = {
    'solo': 'Solo traveler',
    'couple': 'A couple',
    'friends': 'A group of friends',
    'family': 'A family with kids',
  };
  const travelersLabel = travelersLabels[travelers as string] || 'Not specified';

  return { budgetInfo, flightBudget, durationContext, dateContext, guidedLabel, travelersLabel };
}
