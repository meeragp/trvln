import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { callGeminiWithFallback, classifyGeminiError } from "./gemini.ts";

const PRO = "models/gemini-2.5-pro";
const FLASH = "models/gemini-2.5-flash";

// Shapes of Google's real 429 bodies (OpenAI-compatible endpoint wraps them in an array)
const freeTier429 = JSON.stringify([{ error: {
  code: 429, status: "RESOURCE_EXHAUSTED",
  message: "You exceeded your current quota, please check your plan and billing details.",
  details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
    quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests" }] }],
} }]);
const perMinute429 = JSON.stringify({ error: {
  code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted.",
  details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }] }],
} });

const json = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

Deno.test("classifies quota, rate limit, outage and other errors", () => {
  const q = classifyGeminiError(429, freeTier429, PRO);
  assertEquals(q.kind, "quota");
  assertEquals(q.message, "You exceeded your current quota, please check your plan and billing details.");
  assertEquals(classifyGeminiError(429, perMinute429, PRO).kind, "rate_limit");
  assertEquals(classifyGeminiError(503, "overloaded", PRO).kind, "unavailable");
  assertEquals(classifyGeminiError(400, "{}", PRO).kind, "other");
  assertEquals(classifyGeminiError(429, "not json", PRO).message, "not json");
});

Deno.test("uses Pro when it works", async () => {
  const calls: string[] = [];
  const r = await callGeminiWithFallback([PRO, FLASH], (m) => { calls.push(m); return Promise.resolve(json(200, { m })); });
  assertEquals(r.ok && r.model, PRO);
  assertEquals(calls, [PRO]);
});

Deno.test("falls back to Flash when Pro is out of quota", async () => {
  const r = await callGeminiWithFallback([PRO, FLASH], (m) =>
    Promise.resolve(m === PRO ? json(429, freeTier429) : json(200, { ok: 1 })));
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.model, FLASH);
    assertEquals(r.data, { ok: 1 });
    assertEquals(r.failures.map((f) => f.kind), ["quota"]);
  }
});

Deno.test("falls back on outage and network error", async () => {
  const r1 = await callGeminiWithFallback([PRO, FLASH], (m) =>
    Promise.resolve(m === PRO ? json(503, "overloaded") : json(200, {})));
  assertEquals(r1.ok && r1.model, FLASH);
  const r2 = await callGeminiWithFallback([PRO, FLASH], (m) =>
    m === PRO ? Promise.reject(new Error("reset")) : Promise.resolve(json(200, {})));
  assertEquals(r2.ok && r2.model, FLASH);
});

Deno.test("does not retry a bad request on another model", async () => {
  const calls: string[] = [];
  const r = await callGeminiWithFallback([PRO, FLASH], (m) => { calls.push(m); return Promise.resolve(json(400, "bad")); });
  assertEquals(r.ok, false);
  assertEquals(calls, [PRO]);
});

Deno.test("reports every failure when all models fail", async () => {
  const r = await callGeminiWithFallback([PRO, FLASH], (m) =>
    Promise.resolve(json(429, m === PRO ? freeTier429 : perMinute429)));
  assertEquals(r.ok, false);
  assertEquals(r.failures.map((f) => [f.model, f.kind]), [[PRO, "quota"], [FLASH, "rate_limit"]]);
});
