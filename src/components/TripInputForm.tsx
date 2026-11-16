import { useEffect, useRef, useState } from "react";
import { ArrowRight, Link as LinkIcon, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { MediaDropZone, MediaItem, MediaDropZoneHandle } from "./MediaDropZone";
import { AirportSelector } from "./AirportSelector";
import { cn } from "@/lib/utils";
import { countInferred, type DestinationHints, type InferredVibe } from "@/lib/inspirationInsights";
import { format, differenceInDays } from "date-fns";
import type { DateRange } from "react-day-picker";

export interface TripPreferences {
  // Inspiration
  media: MediaItem[];
  cities: string[];

  // Logistics
  budgetAccommodation: number;
  budgetFlight: number;
  dateFlexibility: 'strict' | 'flexible-days' | 'month' | 'anytime';
  startDate?: Date;
  endDate?: Date;
  flexibleDays?: number; // ± days for flexible-days option
  targetMonth?: string;
  durationFlexibility: 'strict' | 'flexible-days' | 'weekend' | 'long-weekend' | '1-week' | '2-weeks' | 'flexible';
  durationDays: number;
  noFlight: boolean; // Skip flight-related content
  departureCity: string;
  flightDirectness: 'nonstop' | 'short-layover' | 'long-layover';

  // Vibe
  // Who is going. Optional: trips saved before this question existed lack it.
  travelers?: '' | 'solo' | 'couple' | 'friends' | 'family';
  atmosphere: string[];
  adventureLevel: string;
  guidedPreference: 'fully-guided' | 'some-guided' | 'self-guided';
  foodDrink: string[];
  interests: string[];

  // Open text
  additionalNotes: string;
}

interface TripInputFormProps {
  preferences: TripPreferences;
  onPreferencesChange: (preferences: TripPreferences) => void;
  onGenerate: (pendingCity?: string) => void;
  isGenerating: boolean;
  onFramesReady?: (frameUrls: string[]) => void;
  isIdentifyingLocations?: boolean;
  /** What the analysis read from the traveler's media, used to mark the
   *  Vibe options it pre-filled. */
  inferredVibe?: InferredVibe | null;
  /** When-to-go and what-your-budget-gets hints for the chosen places. */
  destinationHints?: DestinationHints | null;
  /** Tells the page which step is showing, so it can drop the big hero once
   *  the traveler is past the first one. */
  onStepChange?: (step: number) => void;
}

const travelerOptions = [
  { id: 'solo', label: 'Solo' },
  { id: 'couple', label: 'Couple' },
  { id: 'friends', label: 'Friends' },
  { id: 'family', label: 'Family with kids' },
] as const;

const atmosphereOptions = [
  { id: 'city', label: 'City' },
  { id: 'nature', label: 'Nature' },
  { id: 'off-beaten-path', label: 'Off the beaten path' },
  { id: 'backcountry', label: 'Backcountry' },
];

const adventureOptions = [
  { id: 'none', label: 'Relaxed' },
  { id: 'family', label: 'Family-friendly' },
  { id: 'active', label: 'Active' },
  { id: 'adrenaline', label: 'Adrenaline junky' },
];

const guidedOptions = [
  { id: 'fully-guided', label: 'Prefer guided trips' },
  { id: 'some-guided', label: 'Some guided activities' },
  { id: 'self-guided', label: 'Just self-guided' },
];

const foodDrinkOptions = [
  { id: 'local', label: 'Local bites' },
  { id: 'casual', label: 'Casual & safe' },
  { id: 'romantic', label: 'Romantic' },
  { id: 'family', label: 'Family-friendly' },
  { id: 'party', label: 'Party & nightlife' },
];

const interestOptions = [
  { id: 'educational', label: 'Educational' },
  { id: 'culture', label: 'Culture' },
  { id: 'food', label: 'Food & drink' },
  { id: 'instagram', label: "For the 'gram" },
  { id: 'activities', label: 'Adventures' },
  { id: 'nature', label: 'Nature' },
];

const budgetLabels = [
  { min: 0, max: 25, key: 'budget', label: "Budget", range: "$0 - $50" },
  { min: 25, max: 50, key: 'moderate', label: "Moderate", range: "$50 - $100" },
  { min: 50, max: 75, key: 'comfortable', label: "Comfortable", range: "$100 - $200" },
  { min: 75, max: 100, key: 'luxury', label: "Luxury", range: "$200+" },
] as const;

const flightBudgetLabels = [
  { min: 0, max: 25, label: "Budget", range: "$100 - $300" },
  { min: 25, max: 50, label: "Moderate", range: "$300 - $600" },
  { min: 50, max: 75, label: "Comfortable", range: "$600 - $1000" },
  { min: 75, max: 100, label: "Premium", range: "$1000+" },
];

// Starting points for someone who knows the feeling they want but not the
// place. Each one carries a constraint, so the planner has something to work
// with even if the traveler adds nothing else.
const wishPrompts = [
  "Somewhere warm in February, under 6 hours away",
  "A long weekend that feels like a real trip",
  "First time in Japan, beyond Tokyo",
  "Mountains, a lake and nowhere to be",
  "A food city I can explore on foot",
  "Surprise me: one week, $1,500 all in",
];

const stepLabels = ["Inspiration", "Logistics", "Vibe"];

// The departure airport rarely changes between trips, so the form remembers it
const LAST_DEPARTURE_KEY = 'trvln:lastDeparture';

const readLastDeparture = (): string => {
  try { return localStorage.getItem(LAST_DEPARTURE_KEY) ?? ''; } catch { return ''; }
};

const bandFor = <T extends { min: number; max: number }>(value: number, bands: readonly T[]): T =>
  bands.find(b => value >= b.min && value <= b.max) ?? bands[bands.length - 1];

const optionClass = (isSelected: boolean) => cn(
  "min-h-11 rounded-xl border px-4 py-2 text-[15px] text-left inline-flex items-center gap-2.5 transition-colors",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  isSelected
    ? "border-foreground bg-foreground text-background font-medium"
    : "border-input bg-transparent text-foreground hover:border-foreground"
);

/** One choice in a group. `inferred` marks a selection the app made from the
 *  traveler's media, so they can tell its guesses from their own picks. */
function Option({ isSelected, onClick, inferred, children }: {
  isSelected: boolean;
  onClick: () => void;
  inferred?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button type="button" aria-pressed={isSelected} onClick={onClick} className={optionClass(isSelected)}>
      {children}
      {isSelected && inferred && (
        <span role="img" aria-label="From your photos and videos" className="h-2 w-2 shrink-0 bg-marigold" />
      )}
    </button>
  );
}

/** A labelled row of the form: label on the left, controls on the right,
 *  stacking on a narrow screen. */
function Row({ label, hint, htmlFor, children }: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  const LabelTag = htmlFor ? 'label' : 'h3';
  return (
    <div className="flex flex-col gap-3 border-t border-border py-5 sm:flex-row sm:gap-6">
      <div className="sm:w-36 sm:shrink-0 sm:pt-2.5">
        <LabelTag {...(htmlFor ? { htmlFor } : {})} className="block font-body text-sm font-medium tracking-normal text-foreground">
          {label}
        </LabelTag>
        {hint && <p className="mt-0.5 text-[13px] text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function TripInputForm({
  preferences, onPreferencesChange, onGenerate, isGenerating, onFramesReady,
  isIdentifyingLocations, inferredVibe, destinationHints, onStepChange,
}: TripInputFormProps) {
  const [currentStep, setStep] = useState(0);
  const setCurrentStep = (step: number) => {
    setStep(step);
    onStepChange?.(step);
    window.scrollTo({ top: 0 });
  };
  const [isDragging, setIsDragging] = useState(false);
  const [newCity, setNewCity] = useState("");
  // True while the departure airport on screen is the remembered one, not one
  // the traveler picked for this trip
  const [departureRemembered, setDepartureRemembered] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const mediaRef = useRef<MediaDropZoneHandle>(null);

  const updatePreferences = (updates: Partial<TripPreferences>) => {
    onPreferencesChange({ ...preferences, ...updates });
  };

  // Pre-fill the departure airport from the last trip, once, if none is set
  useEffect(() => {
    if (preferences.departureCity) return;
    const last = readLastDeparture();
    if (last) {
      onPreferencesChange({ ...preferences, departureCity: last });
      setDepartureRemembered(true);
    }
    // Mount only: this must not re-fill the field after the traveler clears it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setDeparture = (value: string) => {
    setDepartureRemembered(false);
    try {
      if (value) localStorage.setItem(LAST_DEPARTURE_KEY, value);
    } catch { /* storage unavailable: the field still works, it just isn't remembered */ }
    updatePreferences({ departureCity: value });
  };

  const addCity = () => {
    const city = newCity.trim();
    if (city && !preferences.cities.some(c => c.toLowerCase() === city.toLowerCase())) {
      updatePreferences({ cities: [...preferences.cities, city] });
    }
    setNewCity("");
  };

  const removeCity = (city: string) => {
    updatePreferences({ cities: preferences.cities.filter(c => c !== city) });
  };

  const toggleArrayItem = (field: 'atmosphere' | 'foodDrink' | 'interests', item: string) => {
    const current = preferences[field];
    updatePreferences({ [field]: current.includes(item) ? current.filter(i => i !== item) : [...current, item] });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.type.startsWith('image/') || f.type.startsWith('video/')
    );
    if (files.length > 0) mediaRef.current?.processFiles(files);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text');
    if (text && (text.includes('tiktok.com') || text.includes('instagram.com'))) {
      e.preventDefault();
      mediaRef.current?.addUrl(text.trim());
    }
  };

  const applyWish = (wish: string) => {
    updatePreferences({ additionalNotes: wish });
    notesRef.current?.focus();
  };

  const stayBand = bandFor(preferences.budgetAccommodation, budgetLabels);
  const flightBand = bandFor(preferences.budgetFlight, flightBudgetLabels);
  const hasMedia = preferences.media.length > 0;
  const placeCount = preferences.cities.length;
  const inferredCount = countInferred(preferences, inferredVibe ?? null);

  // The suggested travel windows are stored as the target month, so they need
  // no fields of their own and reach the planner like a month typed by hand
  const hintWindows = [
    destinationHints?.bestTime && { ...destinationHints.bestTime, tag: 'Suggested' },
    destinationHints?.valueTime && { ...destinationHints.valueTime, tag: 'Quieter, better value' },
  ].filter((w): w is { label: string; why: string; tag: string } => !!w);
  const onHintWindow = preferences.dateFlexibility === 'month'
    && hintWindows.some(w => w.label === preferences.targetMonth);

  const renderStepper = () => (
    <ol className="flex flex-wrap gap-x-6 gap-y-1 border-b border-foreground pb-3 text-sm">
      {stepLabels.map((label, i) => {
        const isActive = i === currentStep;
        const isDone = i < currentStep;
        return (
          <li key={label}>
            <button
              type="button"
              disabled={!isDone}
              aria-current={isActive ? 'step' : undefined}
              onClick={() => setCurrentStep(i)}
              className={cn(
                "min-h-11 border-b-2 border-transparent",
                isActive && "border-foreground font-medium text-foreground",
                isDone && "text-primary underline-offset-4 hover:underline",
                !isActive && !isDone && "text-muted-foreground",
              )}
            >
              <span className="tabular-nums">{`0${i + 1}`}</span> {label}
            </button>
          </li>
        );
      })}
    </ol>
  );

  const renderMediaThumb = (item: MediaItem, index: number) => (
    <li key={index} className="relative h-36 w-24 shrink-0 overflow-hidden rounded-xl bg-muted sm:h-40 sm:w-28">
      {item.type === 'video' && item.file && item.preview ? (
        <video src={item.preview} muted playsInline className="h-full w-full object-cover" />
      ) : item.preview ? (
        <img src={item.preview} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <LinkIcon className="h-5 w-5" />
        </div>
      )}
      {item.uploading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/70">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      )}
      <button
        type="button"
        aria-label={`Remove ${item.type === 'video' ? 'video' : 'photo'} ${index + 1}`}
        onClick={() => updatePreferences({ media: preferences.media.filter((_, j) => j !== index) })}
        className="absolute right-0 top-0 flex h-11 w-11 items-start justify-end p-1.5"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background">
          <X className="h-3.5 w-3.5" />
        </span>
      </button>
    </li>
  );

  const renderStep0 = () => (
    <div className="grid gap-x-16 gap-y-10 pt-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
        onDrop={handleDrop}
        className="flex min-w-0 flex-col gap-4"
      >
        <label htmlFor="trip-inspiration" className="text-[15px] font-semibold">Show us what caught your eye</label>
        <textarea
          id="trip-inspiration"
          ref={notesRef}
          value={preferences.additionalNotes}
          onChange={(e) => updatePreferences({ additionalNotes: e.target.value })}
          onPaste={handlePaste}
          rows={3}
          placeholder="Paste a TikTok or Reel you saved, drop in a screenshot, or just describe the trip you keep daydreaming about…"
          className={cn(
            "w-full resize-y rounded-2xl border-[1.5px] border-foreground bg-card px-5 py-4 text-lg leading-relaxed text-foreground",
            "placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            isDragging && "border-primary bg-accent",
          )}
        />

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="min-h-11 text-[15px] underline underline-offset-4 hover:text-primary"
          >
            Attach a video or screenshot
          </button>
          <Button type="button" className="h-[52px] rounded-xl px-6 text-base font-semibold" onClick={() => setCurrentStep(1)}>
            Continue <ArrowRight aria-hidden="true" />
          </Button>
        </div>

        {/* What we found in their media: the thumbnails are their own frames */}
        {(hasMedia || placeCount > 0 || isIdentifyingLocations) && (
          <div className="mt-2 flex flex-col gap-5">
            {hasMedia && (
              <ul className="flex gap-3 overflow-x-auto pb-1">
                {preferences.media.map(renderMediaThumb)}
              </ul>
            )}

            <div>
              <h3 className="font-display text-3xl leading-tight" aria-live="polite">
                {isIdentifyingLocations
                  ? "Looking for places in your video…"
                  : placeCount === 0
                    ? "No places yet"
                    : hasMedia
                      ? `We spotted ${placeCount} place${placeCount === 1 ? '' : 's'}`
                      : `${placeCount} place${placeCount === 1 ? '' : 's'} on your list`}
              </h3>
              {inferredVibe?.summary && (
                <p className="mt-1 text-[15px] text-muted-foreground">Reads as {inferredVibe.summary}.</p>
              )}

              {placeCount > 0 && (
                <ul className="mt-3 border-b border-border">
                  {preferences.cities.map((city) => (
                    <li key={city} className="flex items-center justify-between gap-4 border-t border-border py-1.5">
                      <span className="min-w-0 font-display text-2xl leading-snug">{city}</span>
                      <button
                        type="button"
                        onClick={() => removeCity(city)}
                        aria-label={`Remove ${city}`}
                        className="min-h-11 shrink-0 text-sm underline underline-offset-4 hover:text-primary"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 flex gap-2">
                <label htmlFor="add-place" className="sr-only">Add a place</label>
                <Input
                  id="add-place"
                  value={newCity}
                  onChange={(e) => setNewCity(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCity(); } }}
                  placeholder="Add a place yourself"
                  className="h-11 flex-1 rounded-xl bg-card text-[15px]"
                />
                <Button type="button" variant="outline" className="h-11 rounded-xl border px-4" onClick={addCity} disabled={!newCity.trim()}>
                  Add
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Hidden inputs */}
        <MediaDropZone
          ref={mediaRef}
          compact
          media={preferences.media}
          onMediaChange={(media) => updatePreferences({ media })}
          onFramesReady={onFramesReady}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const files = Array.from(e.target.files || []).filter(f =>
              f.type.startsWith('image/') || f.type.startsWith('video/')
            );
            if (files.length > 0) mediaRef.current?.processFiles(files);
            e.target.value = '';
          }}
        />
      </section>

      <section className="min-w-0">
        <h3 className="font-body text-[15px] font-semibold tracking-normal">Not sure where yet? Start with a wish</h3>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">Tap one and we'll suggest places that fit. Edit it to make it yours.</p>
        <ul className="border-b border-border">
          {wishPrompts.map((wish, i) => (
            <li key={wish} className={cn("border-t", i === 0 ? "border-foreground" : "border-border")}>
              <button
                type="button"
                onClick={() => applyWish(wish)}
                className="group flex w-full items-center justify-between gap-4 py-3.5 text-left"
              >
                <span className="font-display text-2xl leading-tight group-hover:text-primary md:text-[28px]">{wish}</span>
                <ArrowRight aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground group-hover:text-primary" />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );

  const renderStep1 = () => (
    <div className="pt-8">
      <h2 className="font-display text-4xl leading-none md:text-5xl">The practical bits</h2>
      <p className="mb-6 mt-3 text-base text-muted-foreground">
        {destinationHints && placeCount > 0 ? `Filled in for ${preferences.cities[0]} where we could. ` : ''}
        Rough is fine, you can change anything later.
      </p>

      <Row label="Flying from">
        {!preferences.noFlight && (
          <div className="mb-2">
            <AirportSelector value={preferences.departureCity} onChange={setDeparture} />
            {departureRemembered && preferences.departureCity && (
              <p className="mt-1.5 text-[13px] text-muted-foreground">From your last trip. Change it if you're leaving from somewhere else.</p>
            )}
          </div>
        )}
        <div className="flex min-h-11 items-center gap-2.5">
          <Checkbox
            id="no-flight"
            checked={preferences.noFlight}
            onCheckedChange={(checked) => updatePreferences({ noFlight: !!checked })}
          />
          <Label htmlFor="no-flight" className="cursor-pointer text-[15px] font-normal">No flight needed</Label>
        </div>
        {preferences.noFlight && (
          <p className="text-sm text-muted-foreground">We'll leave flights out: a road trip, a train, somewhere local.</p>
        )}
      </Row>

      <Row label="When">
        {hintWindows.length > 0 && (
          <div className="mb-2 flex flex-col gap-2">
            {hintWindows.map(w => {
              const isSelected = preferences.dateFlexibility === 'month' && preferences.targetMonth === w.label;
              return (
                <button
                  key={w.label}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => updatePreferences({ dateFlexibility: 'month', targetMonth: w.label })}
                  className={cn(optionClass(isSelected), "w-full flex-wrap items-baseline gap-x-4 gap-y-0.5 py-3")}
                >
                  <span className="text-[17px] font-semibold">{w.label}</span>
                  <span className={cn("min-w-[12rem] flex-1 text-sm font-normal", isSelected ? "text-background/80" : "text-muted-foreground")}>{w.why}</span>
                  <span className={cn("text-[13px] font-medium", isSelected ? "text-background" : "text-muted-foreground")}>{w.tag}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Option isSelected={preferences.dateFlexibility === 'strict'} onClick={() => updatePreferences({ dateFlexibility: 'strict' })}>
            Exact dates
          </Option>
          <Option
            isSelected={preferences.dateFlexibility === 'month' && !onHintWindow}
            onClick={() => updatePreferences({ dateFlexibility: 'month', targetMonth: onHintWindow ? '' : preferences.targetMonth })}
          >
            A certain month
          </Option>
          <Option isSelected={preferences.dateFlexibility === 'anytime'} onClick={() => updatePreferences({ dateFlexibility: 'anytime' })}>
            Anytime
          </Option>
        </div>

        {preferences.dateFlexibility === 'strict' && (
          <div className="mt-3">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className={cn("h-11 w-full justify-start rounded-xl border border-input text-foreground", !preferences.startDate && "text-muted-foreground")}>
                  {preferences.startDate && preferences.endDate ? (
                    <>
                      {format(preferences.startDate, "MMM d, yyyy")} — {format(preferences.endDate, "MMM d, yyyy")}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {differenceInDays(preferences.endDate, preferences.startDate) + 1} days
                      </span>
                    </>
                  ) : preferences.startDate ? (
                    <>{format(preferences.startDate, "MMM d, yyyy")} — Select end date</>
                  ) : (
                    "Select travel dates"
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <div className="border-b border-border p-3">
                  <p className="text-sm text-muted-foreground">
                    {!preferences.startDate ? "Select your start date" : !preferences.endDate ? "Now select your end date" : "Click to change dates"}
                  </p>
                </div>
                <CalendarComponent
                  mode="range"
                  selected={{ from: preferences.startDate, to: preferences.endDate } as DateRange}
                  onSelect={(range) => {
                    const from = range?.from;
                    const to = range?.to;
                    if (from && to) {
                      const days = differenceInDays(to, from) + 1;
                      updatePreferences({ startDate: from, endDate: to, durationFlexibility: 'strict', durationDays: days });
                      return;
                    }
                    updatePreferences({ startDate: from, endDate: to });
                  }}
                  disabled={(date) => date < new Date()}
                  numberOfMonths={2}
                  className="pointer-events-auto"
                />
                <div className="flex items-center gap-3 border-t border-border p-3">
                  <Checkbox
                    id="flexible-days"
                    checked={!!preferences.flexibleDays}
                    onCheckedChange={(checked) => updatePreferences({ flexibleDays: checked ? 2 : undefined })}
                  />
                  <Label htmlFor="flexible-days" className="cursor-pointer text-sm">
                    ± a few days is okay
                  </Label>
                  {preferences.flexibleDays && (
                    <select
                      value={preferences.flexibleDays}
                      onChange={(e) => updatePreferences({ flexibleDays: parseInt(e.target.value) })}
                      className="ml-auto rounded border bg-background px-2 py-1 text-sm"
                    >
                      <option value={1}>± 1 day</option>
                      <option value={2}>± 2 days</option>
                      <option value={3}>± 3 days</option>
                      <option value={5}>± 5 days</option>
                      <option value={7}>± 1 week</option>
                    </select>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        )}

        {preferences.dateFlexibility === 'month' && !onHintWindow && (
          <Input
            aria-label="Which month"
            placeholder="e.g. April, spring, early fall…"
            value={preferences.targetMonth || ''}
            onChange={(e) => updatePreferences({ targetMonth: e.target.value })}
            className="mt-3 h-11 rounded-xl bg-card text-[15px]"
          />
        )}
      </Row>

      {/* Duration — only when not using exact dates */}
      {preferences.dateFlexibility !== 'strict' && (
        <Row label="How long">
          <div className="flex flex-wrap gap-2">
            {([
              { value: 'weekend', label: 'Weekend' },
              { value: 'long-weekend', label: 'Long weekend' },
              { value: '1-week', label: '1 week' },
              { value: '2-weeks', label: '2 weeks' },
              { value: 'strict', label: 'Exact days' },
              { value: 'flexible', label: 'Flexible' },
            ] as const).map(opt => (
              <Option
                key={opt.value}
                isSelected={preferences.durationFlexibility === opt.value}
                onClick={() => updatePreferences({ durationFlexibility: opt.value })}
              >
                {opt.label}
              </Option>
            ))}
          </div>

          {(preferences.durationFlexibility === 'strict' || preferences.durationFlexibility === 'flexible-days') && (
            <div className="mt-3 flex items-center gap-3">
              <Input
                type="number"
                aria-label="Number of days"
                min={1}
                max={60}
                value={preferences.durationDays}
                onChange={(e) => updatePreferences({ durationDays: parseInt(e.target.value) || 7 })}
                className="h-11 w-24 rounded-xl bg-card"
              />
              <span className="text-sm text-muted-foreground">days</span>
            </div>
          )}
        </Row>
      )}

      <Row label="Stay, per night">
        <Slider
          aria-label="Accommodation budget per night"
          value={[preferences.budgetAccommodation]}
          onValueChange={([value]) => updatePreferences({ budgetAccommodation: value })}
          min={0}
          max={100}
          step={25}
          className="w-full py-3"
        />
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="font-display text-2xl">{stayBand.label} · {stayBand.range}</span>
          {destinationHints?.stay && (
            <span className="min-w-[14rem] flex-1 text-sm text-muted-foreground">
              In {preferences.cities[0] ?? 'this area'}: {destinationHints.stay[stayBand.key]}.
            </span>
          )}
        </div>
      </Row>

      {!preferences.noFlight && (
        <>
          <Row label="Flights, round trip">
            <Slider
              aria-label="Flight budget, round trip"
              value={[preferences.budgetFlight]}
              onValueChange={([value]) => updatePreferences({ budgetFlight: value })}
              min={0}
              max={100}
              step={25}
              className="w-full py-3"
            />
            <span className="font-display text-2xl">{flightBand.label} · {flightBand.range}</span>
          </Row>

          <Row label="Layovers">
            <div className="flex flex-wrap gap-2">
              {([
                { value: 'nonstop', label: 'Nonstop only' },
                { value: 'short-layover', label: 'Short layovers OK' },
                { value: 'long-layover', label: 'Any layovers' },
              ] as const).map(opt => (
                <Option
                  key={opt.value}
                  isSelected={preferences.flightDirectness === opt.value}
                  onClick={() => updatePreferences({ flightDirectness: opt.value })}
                >
                  {opt.label}
                </Option>
              ))}
            </div>
          </Row>
        </>
      )}

      <div className="flex items-center justify-between border-t border-border pt-6">
        <button type="button" onClick={() => setCurrentStep(0)} className="min-h-11 text-base underline underline-offset-4 hover:text-primary">
          Back
        </button>
        <Button type="button" className="h-[52px] rounded-xl px-6 text-base font-semibold" onClick={() => setCurrentStep(2)}>
          Continue <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );

  const renderStep2 = () => (
    <div className="pt-8">
      <h2 className="font-display text-4xl leading-none md:text-5xl">Set the vibe</h2>
      <p className="mb-6 mt-3 text-base text-muted-foreground">This is where the itinerary gets personal.</p>

      {inferredCount > 0 && (
        <p className="mb-4 flex items-center gap-2.5 text-[15px]">
          <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 bg-marigold outline outline-1 outline-foreground" />
          {inferredCount} of these came from your photos and videos. Tap to change any.
        </p>
      )}

      <Row label="Who's travelling" hint="Photos can't tell us this">
        <div className="flex flex-wrap gap-2">
          {travelerOptions.map(opt => (
            <Option
              key={opt.id}
              isSelected={preferences.travelers === opt.id}
              onClick={() => updatePreferences({ travelers: preferences.travelers === opt.id ? '' : opt.id })}
            >
              {opt.label}
            </Option>
          ))}
        </div>
      </Row>

      <Row label="Atmosphere" hint="Pick any">
        <div className="flex flex-wrap gap-2">
          {atmosphereOptions.map(opt => (
            <Option
              key={opt.id}
              isSelected={preferences.atmosphere.includes(opt.id)}
              inferred={inferredVibe?.atmosphere.includes(opt.id)}
              onClick={() => toggleArrayItem('atmosphere', opt.id)}
            >
              {opt.label}
            </Option>
          ))}
        </div>
      </Row>

      <Row label="Adventure level" hint="Pick one">
        <div className="flex flex-wrap gap-2">
          {adventureOptions.map(opt => (
            <Option
              key={opt.id}
              isSelected={preferences.adventureLevel === opt.id}
              inferred={inferredVibe?.adventureLevel === opt.id}
              onClick={() => updatePreferences({ adventureLevel: opt.id })}
            >
              {opt.label}
            </Option>
          ))}
        </div>
      </Row>

      <Row label="Guided vs. self-serve" hint="Pick one">
        <div className="flex flex-wrap gap-2">
          {guidedOptions.map(opt => (
            <Option
              key={opt.id}
              isSelected={preferences.guidedPreference === opt.id}
              onClick={() => updatePreferences({ guidedPreference: opt.id as TripPreferences['guidedPreference'] })}
            >
              {opt.label}
            </Option>
          ))}
        </div>
      </Row>

      <Row label="Food & drink" hint="Pick any">
        <div className="flex flex-wrap gap-2">
          {foodDrinkOptions.map(opt => (
            <Option
              key={opt.id}
              isSelected={preferences.foodDrink.includes(opt.id)}
              inferred={inferredVibe?.foodDrink.includes(opt.id)}
              onClick={() => toggleArrayItem('foodDrink', opt.id)}
            >
              {opt.label}
            </Option>
          ))}
        </div>
      </Row>

      <Row label="What matters most?" hint="Pick any">
        <div className="flex flex-wrap gap-2">
          {interestOptions.map(opt => (
            <Option
              key={opt.id}
              isSelected={preferences.interests.includes(opt.id)}
              inferred={inferredVibe?.interests.includes(opt.id)}
              onClick={() => toggleArrayItem('interests', opt.id)}
            >
              {opt.label}
            </Option>
          ))}
        </div>
      </Row>

      <Row label="Anything else?" hint="Optional" htmlFor="trip-notes">
        <Textarea
          id="trip-notes"
          value={preferences.additionalNotes}
          onChange={(e) => updatePreferences({ additionalNotes: e.target.value })}
          placeholder="Dietary restrictions, mobility needs, places you've heard about, things to avoid…"
          className="min-h-[100px] resize-y rounded-xl bg-card text-[15px]"
        />
      </Row>

      <div className="flex items-center justify-between border-t border-border pt-6">
        <button type="button" onClick={() => setCurrentStep(1)} className="min-h-11 text-base underline underline-offset-4 hover:text-primary">
          Back
        </button>
        <Button
          type="button"
          className="h-[52px] rounded-xl px-6 text-base font-semibold"
          onClick={() => onGenerate(undefined)}
          disabled={isGenerating}
        >
          {isGenerating ? (
            <>
              <Loader2 className="animate-spin" />
              Crafting your trip…
            </>
          ) : (
            <>Plan my trip <ArrowRight aria-hidden="true" /></>
          )}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="animate-fade-in">
      {renderStepper()}
      {currentStep === 0 && renderStep0()}
      {currentStep === 1 && renderStep1()}
      {currentStep === 2 && renderStep2()}
    </div>
  );
}
