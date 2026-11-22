import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { callGeminiWithFallback } from "../_shared/gemini.ts";
import { CostTracker, persistCost } from "../_shared/costs.ts";

// Destination-aware hints for the Logistics step: when to go, and what each
// accommodation tier typically gets you there. Everything here is optional
// decoration: the form works without it, so every failure answers with empty
// hints rather than an error the traveler has to read.
//
// No prices. The model has no live fare or rate data, and a made-up number
// next to a budget slider would read as a quote.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Flash first: this is general knowledge, and it has to come back while the
// traveler is still looking at the step.
const MODELS = ["models/gemini-2.5-flash", "models/gemini-2.5-pro"];

const RequestSchema = z.object({
  cities: z.array(z.string().min(1).max(100)).min(1).max(8),
});

const text = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

// A window is only worth showing with both a label and a reason
const timeWindow = (v: unknown): { label: string; why: string } | null => {
  if (!v || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  const label = text(w.label, 40);
  const why = text(w.why, 90);
  return label && why ? { label, why } : null;
};

const empty = { bestTime: null, valueTime: null, stay: null };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const validation = RequestSchema.safeParse(await req.json());
    if (!validation.success) return json({ error: "Invalid input" }, 400);
    const { cities } = validation.data;

    const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY");
    if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not configured");

    const systemPrompt = `You help a traveler fill in a trip-planning form for these places: ${cities.join("; ")}.

Answer from well-established general knowledge about the destination. If the places are too vague, too scattered across climates, or you are not confident, return null for that field: a missing hint is fine, a wrong one is not.

Return a JSON object with exactly this structure:
{
  "bestTime": { "label": "<a month or month range, e.g. \\"May – June\\">", "why": "<max 8 words: weather, crowds, what is open>" } or null,
  "valueTime": { "label": "<a different month or range that is typically cheaper or quieter but still good>", "why": "<max 8 words>" } or null,
  "stay": {
    "budget": "<max 12 words: the kind of place a budget traveler typically stays there>",
    "moderate": "<same, mid-range>",
    "comfortable": "<same, upper mid-range>",
    "luxury": "<same, top end>"
  } or null
}

Rules:
- Never state prices, fares or currency amounts.
- "stay" describes kinds of accommodation and areas (e.g. "guesthouse or B&B a short walk above the beach"), never named hotels.
- Plain sentence case, no trailing period, no emoji.`;

    const result = await callGeminiWithFallback(MODELS, (model) =>
      fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${GOOGLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: "Return the JSON object." },
          ],
          response_format: { type: "json_object" },
        }),
      }));

    for (const f of result.failures) {
      console.error(`Google AI error from ${f.model}: HTTP ${f.status} (${f.kind}): ${f.message}`);
    }
    if (!result.ok) return json(empty);

    // Recorded like every other model call, so this step's spend is visible
    const costs = new CostTracker();
    costs.addGeminiOpenAI("destination_hints", result.model, result.data.usage);
    console.log("[cost] summary " + JSON.stringify(costs.summary()));
    void persistCost(costs, { function_name: "destination-hints", mode: "hints" });

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(result.data.choices?.[0]?.message?.content || "{}");
    } catch {
      console.error("destination-hints: model did not return JSON");
      return json(empty);
    }

    const rawStay = parsed.stay && typeof parsed.stay === "object" ? parsed.stay as Record<string, unknown> : null;
    const stay = rawStay && {
      budget: text(rawStay.budget, 120),
      moderate: text(rawStay.moderate, 120),
      comfortable: text(rawStay.comfortable, 120),
      luxury: text(rawStay.luxury, 120),
    };

    return json({
      bestTime: timeWindow(parsed.bestTime),
      valueTime: timeWindow(parsed.valueTime),
      // All four tiers or none: a half-filled slider would look broken
      stay: stay && Object.values(stay).every(Boolean) ? stay : null,
    });
  } catch (error) {
    console.error("Error in destination-hints function:", error);
    return json(empty);
  }
});
