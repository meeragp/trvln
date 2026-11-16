import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CostTracker, persistCost } from "../_shared/costs.ts";
import { PreferencesSchema, describeTrip } from "../_shared/tripPreferences.ts";
import {
  buildQuerySpecs,
  readTrip,
  runResearch,
  type SharedResearch,
  THEME_SPECIFIC_KEY,
  type TimePhase,
} from "../_shared/research.ts";

// Runs the grounded research every itinerary variant of a batch shares — the
// request reading, destination resolution, and every search except the
// theme-specific activities query — once per "generate" click, and stores it
// in trip_research for generate-itinerary to load by id.
//
// Each variant used to do all of this itself, so the same searches ran once
// per theme and the variants of one trip could each resolve a different
// destination. The client starts this alongside suggest-themes, so the
// searches no longer wait on the theme call either.
//
// The row is written in stages (pending → reading → ready, or error) because
// a variant can start its own activities query as soon as the destination is
// known, rather than waiting for every shared search.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const RequestSchema = z.object({
  preferences: PreferencesSchema,
  // Minted by the client so the generate calls can carry it before this
  // request has answered.
  researchId: z.string().uuid(),
  batchId: z.string().uuid().optional(),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const timings: Record<string, number> = {};
  const timePhase: TimePhase = async (name, fn) => {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - start;
      console.log(`[timing] ${name}: ${timings[name]}ms`);
    }
  };
  const costs = new CostTracker();

  let researchId: string | undefined;
  let batchId: string | null = null;
  let grounded: boolean | null = null;

  try {
    const validation = RequestSchema.safeParse(await req.json());
    if (!validation.success) {
      return json({
        error: "Invalid input",
        details: validation.error.errors.map(e => ({ field: e.path.join("."), message: e.message })),
      }, 400);
    }
    const { preferences } = validation.data;
    batchId = validation.data.batchId ?? null;

    // Claim the id before any work, so a variant polling for it can tell a
    // research pass that is running from one that never started. A plain
    // insert: an id that already exists is never overwritten.
    const { error: claimError } = await supabaseAdmin.from("trip_research").insert({
      id: validation.data.researchId,
      batch_id: batchId,
      status: "pending",
    });
    if (claimError) {
      console.error("Could not claim trip_research row:", claimError.message);
      return json({ error: "Unable to research this trip." }, 409);
    }
    researchId = validation.data.researchId;

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");
    // Trimmed for the same reason as in generate-itinerary: a key pasted with
    // a trailing newline yields a 401 that looks exactly like a revoked key.
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY")?.trim();
    if (!PERPLEXITY_API_KEY) throw new Error("PERPLEXITY_API_KEY is not configured");
    const GOOGLE_PLACES_API_KEY = Deno.env.get("GOOGLE_PLACES_API_KEY")?.trim();

    const trip = describeTrip(preferences);
    const reading = await readTrip({ preferences, trip, anthropicKey: ANTHROPIC_API_KEY, costs, timePhase });

    const { error: readingError } = await supabaseAdmin.from("trip_research").update({
      status: "reading",
      destinations: reading.resolvedCities,
      destination_was_resolved: reading.destinationWasResolved,
      reading,
      updated_at: new Date().toISOString(),
    }).eq("id", researchId);
    if (readingError) throw new Error(`Failed to store trip reading: ${readingError.message}`);
    console.log("Shared reading stored for destinations:", reading.resolvedCities);

    const specs = buildQuerySpecs({ preferences, trip, reading })
      .filter(spec => spec.key !== THEME_SPECIFIC_KEY);
    const { research, placesDining } = await runResearch({
      specs,
      resolvedCities: reading.resolvedCities,
      foodPrefs: preferences.foodDrink ?? [],
      perplexityKey: PERPLEXITY_API_KEY,
      includePlaces: true,
      placesKey: GOOGLE_PLACES_API_KEY,
      costs,
      timePhase,
      // Slot 0 is left for the activities query each variant fires at the
      // same moment against the same Perplexity key.
      staggerSlot: 1,
    });

    // Empty searches are stored as they are rather than failed: each variant
    // decides its grounding regime over the shared results plus its own
    // activities query, exactly as when it ran every search itself.
    grounded = Object.values(research).some(r => r.content.trim().length > 0) || placesDining.length > 0;
    console.log("[research] " + JSON.stringify(Object.fromEntries(Object.entries(research).map(
      ([key, r]) => [key, { chars: r.content.trim().length, citations: r.citations.length }],
    ))));

    const payload: SharedResearch = { research, placesDining };
    const { error: readyError } = await supabaseAdmin.from("trip_research").update({
      status: "ready",
      research: payload,
      updated_at: new Date().toISOString(),
    }).eq("id", researchId);
    if (readyError) throw new Error(`Failed to store trip research: ${readyError.message}`);

    console.log(`[timing] summary ${JSON.stringify(timings)}`);
    return json({ researchId, destinations: reading.resolvedCities, grounded });
  } catch (error) {
    console.error("Error in research-trip:", error);
    if (researchId) {
      // Tells every waiting variant to stop waiting and research for itself.
      await supabaseAdmin.from("trip_research").update({
        status: "error",
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq("id", researchId);
    }
    return json({ error: "Unable to research this trip." }, 500);
  } finally {
    const s = costs.summary();
    if (s.total_usd > 0) {
      console.log("[cost] summary " + JSON.stringify(s));
      // Fire-and-forget, as everywhere else: a cost row must never fail a
      // request. Rows join to the batch's generate-itinerary rows by batch_id.
      void persistCost(costs, {
        function_name: "research-trip",
        batch_id: batchId,
        mode: "shared_research",
        grounded,
      });
    }
  }
});
