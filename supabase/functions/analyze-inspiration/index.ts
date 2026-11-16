import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { CostTracker, persistCost } from "../_shared/costs.ts";
import { callGeminiWithFallback, type GeminiFailureKind } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODELS = ["models/gemini-2.5-pro", "models/gemini-2.5-flash"];

// What the app shows when every model failed. Users can always add
// destinations by hand, so say so instead of blaming their photos.
const USER_ERRORS: Record<GeminiFailureKind, { status: number; error: string }> = {
  rate_limit: { status: 429, error: "Location detection is busy right now. Try again in a minute, or add your destinations manually." },
  quota: { status: 503, error: "Location detection is unavailable right now. Add your destinations manually." },
  unavailable: { status: 503, error: "Location detection is temporarily down. Try again shortly, or add your destinations manually." },
  other: { status: 500, error: "Couldn't analyze these images. Add your destinations manually." },
};

const RequestSchema = z.object({
  mediaUrls: z.array(z.string().url()).max(20),
  // What the caller fed in: uploaded photos, frames pulled out of a video, or
  // both in one pass. Vision billing is per image either way, but this is the
  // only place that knows which inspiration source the dollars came from, so
  // it is recorded on the cost row. Older clients omit it.
  source: z.enum(["image", "video", "mixed"]).optional(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const validationResult = RequestSchema.safeParse(body);

    if (!validationResult.success) {
      console.error("Validation error:", validationResult.error.errors);
      return new Response(
        JSON.stringify({ error: "Invalid input", details: validationResult.error.errors }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { mediaUrls, source } = validationResult.data;

    if (mediaUrls.length === 0) {
      return new Response(
        JSON.stringify({ destinations: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY");
    if (!GOOGLE_API_KEY) {
      throw new Error("GOOGLE_API_KEY is not configured");
    }

    console.log(`Analyzing ${mediaUrls.length} media items for location recognition`);

    const systemPrompt = `You are a travel location identification expert. Analyze the provided images and identify any travel destinations, landmarks, cities, or locations visible in them.

For each image, identify:
1. The specific location (city, landmark, region, country)
2. Confidence level: "high" (iconic/unmistakable), "medium" (likely but not certain), "low" (educated guess)
3. Brief reasoning for the identification

IMPORTANT GUIDELINES:
- Be specific: "Santorini, Greece" not just "Greece"
- Include landmarks when identifiable: "Eiffel Tower, Paris, France"
- If multiple locations are visible, list them all
- If you cannot identify a location, say so honestly
- Look for visual cues: architecture, signage, landscapes, famous landmarks, street styles

Return a JSON object with this exact structure:
{
  "destinations": [
    {
      "location": "City, Country" or "Landmark, City, Country",
      "confidence": "high" | "medium" | "low",
      "reasoning": "Brief explanation of how you identified this location"
    }
  ]
}

If no locations can be identified from any images, return:
{ "destinations": [] }`;

    // Build the content array with all images
    const content: any[] = [
      { 
        type: "text", 
        text: `Analyze these ${mediaUrls.length} travel inspiration image(s) and identify the locations shown. Return your response as a JSON object.` 
      }
    ];

    for (const url of mediaUrls) {
      content.push({
        type: "image_url",
        image_url: { url },
      });
    }

    // Pro reads landmarks and signage best; Flash has separate quota and
    // capacity, so it keeps location detection working when Pro is out of
    // quota, rate limited or overloaded.
    const result = await callGeminiWithFallback(MODELS, (model) => {
      console.log(`Calling ${model} for vision analysis`);
      return fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GOOGLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content },
          ],
          response_format: { type: "json_object" },
        }),
      });
    });

    for (const f of result.failures) {
      console.error(`Google AI error from ${f.model}: HTTP ${f.status} (${f.kind}): ${f.message}`);
      if (f.kind === "quota") {
        console.error(`${f.model} is out of quota on GOOGLE_API_KEY's Google Cloud project; check its billing and quota in Google AI Studio`);
      }
    }

    if (!result.ok) {
      // The last model tried decides what the user is told
      const { kind } = result.failures[result.failures.length - 1];
      const { status, error } = USER_ERRORS[kind];
      return new Response(
        JSON.stringify({ error, code: kind }),
        { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (result.failures.length > 0) console.warn(`Fell back to ${result.model}`);

    const data = result.data;

    // Vision analysis is the priciest thing this function does — one Gemini
    // call whose input scales with the number of images (a single imported
    // video contributes several frames). Record it before parsing so a
    // malformed response still leaves the spend accounted for. Priced against
    // the model that actually answered, since Flash is the fallback.
    const costs = new CostTracker();
    costs.addGeminiOpenAI(`inspiration_${source ?? "media"}_analysis`, result.model, data.usage);
    console.log("[cost] summary " + JSON.stringify(costs.summary()));
    void persistCost(costs, { function_name: "analyze-inspiration", mode: source ?? "media" });

    const responseContent = data.choices?.[0]?.message?.content || "{}";
    
    console.log("Raw AI response:", responseContent);

    let parsed;
    try {
      parsed = JSON.parse(responseContent);
    } catch {
      console.error("Failed to parse AI response as JSON:", responseContent);
      parsed = { destinations: [] };
    }

    const destinations = parsed.destinations || [];
    console.log(`Identified ${destinations.length} destination(s):`, destinations);

    return new Response(
      JSON.stringify({ destinations, model: result.model }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in analyze-inspiration function:", error);
    return new Response(
      JSON.stringify({ error: "Unable to process request. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
