// Calling Gemini with a model fallback, and telling apart why a call failed.

export type GeminiFailureKind =
  | "quota"        // daily/plan quota used up or not available (e.g. no billing): won't clear in a minute
  | "rate_limit"   // per-minute limit: clears on its own shortly
  | "unavailable"  // Google-side overload or outage (5xx)
  | "other";       // bad request, auth, etc.: retrying another model won't help

export interface GeminiFailure {
  kind: GeminiFailureKind;
  status: number;
  model: string;
  message: string; // Google's own message, for logs
}

// Google's 429 body names the quota that was hit. Per-minute quotas clear on
// their own; per-day ones, "limit: 0" and free-tier ones mean the plan itself
// is the problem (as when billing isn't set up).
export function classifyGeminiError(status: number, body: string, model: string): GeminiFailure {
  let message = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body);
    const err = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
    if (typeof err?.message === "string") message = err.message;
  } catch { /* not JSON: keep the raw text */ }

  let kind: GeminiFailureKind = "other";
  if (status === 429) {
    kind = /PerDay|free_tier|billing|limit: 0\b/i.test(body) ? "quota" : "rate_limit";
  } else if (status >= 500) {
    kind = "unavailable";
  }
  return { kind, status, model, message };
}

// Worth trying the next model: its quota and capacity are separate.
const FALLBACK_KINDS: GeminiFailureKind[] = ["quota", "rate_limit", "unavailable"];

export type GeminiResult =
  | { ok: true; model: string; data: any; failures: GeminiFailure[] }
  | { ok: false; failures: GeminiFailure[] };

/** Try each model in order, moving on when one is out of quota, rate
 *  limited or down. `call` sends the request for one model. */
export async function callGeminiWithFallback(
  models: string[],
  call: (model: string) => Promise<Response>,
): Promise<GeminiResult> {
  const failures: GeminiFailure[] = [];
  for (const model of models) {
    let response: Response;
    try {
      response = await call(model);
    } catch (e) {
      failures.push({ kind: "unavailable", status: 0, model, message: String(e) });
      continue;
    }
    if (response.ok) return { ok: true, model, data: await response.json(), failures };

    const failure = classifyGeminiError(response.status, await response.text(), model);
    failures.push(failure);
    if (!FALLBACK_KINDS.includes(failure.kind)) break;
  }
  return { ok: false, failures };
}
