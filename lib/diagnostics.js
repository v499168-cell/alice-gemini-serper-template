import { timingSafeEqual } from "node:crypto";
import { fetchJson } from "./alice.js";

// This endpoint is closed unless a separate diagnostic token is configured.
// Do not use a Gemini/Serper API key as that token.
function authorized(header) {
  const expected = process.env.DIAGNOSTICS_TOKEN || "";
  if (expected.length < 32) return false;
  const actual = String(header || "").replace(/^Bearer /, "");
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function providerStatus(response, data) {
  if (response.ok) return "ok";
  const status = Number(response.status);
  if (status === 400 && data?.error?.details?.some(d => d?.reason === "API_KEY_INVALID")) return "invalid_key";
  if (status === 400) return "invalid_request";
  if (status === 401) return "authentication_failed";
  if (status === 403) return "access_denied";
  if (status === 404) return "model_not_found";
  if (status === 429) return "quota_exceeded";
  return status >= 500 ? "provider_unavailable" : "provider_error";
}

export default async function diagnostics(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorized(req.headers?.authorization)) return res.status(404).json({ error: "Not found" });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const service = req.body?.service;
  if (service !== "gemini" && service !== "serper") return res.status(400).json({ error: "Unknown service" });
  const model = String(process.env.GEMINI_MODEL || "gemini-3.5-flash-lite").trim();
  if (service === "gemini" && !/^[A-Za-z0-9._-]+$/.test(model)) {
    return res.status(200).json({ service, ok: false, outcome: "invalid_model_name" });
  }
  const key = service === "gemini" ? process.env.GEMINI_API_KEY : process.env.SERPER_API_KEY;
  if (!key) return res.status(200).json({ service, ok: false, outcome: "missing_key" });
  const started = Date.now();
  try {
    const { response, data } = await fetchJson(
      service === "gemini" ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` : "https://google.serper.dev/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", [service === "gemini" ? "x-goog-api-key" : "X-API-KEY"]: key },
        body: JSON.stringify(service === "gemini" ? {
          contents: [{ role: "user", parts: [{ text: "Сколько будет два плюс два? Ответь одним словом." }] }],
          generationConfig: { maxOutputTokens: 128 }
        } : { q: "официальный сайт Яндекс", hl: "ru", num: 1 })
      }, 15000
    );
    const resultPresent = service === "gemini"
      ? Boolean(data?.candidates?.[0]?.content?.parts?.some(p => p?.text && !p.thought))
      : Boolean(data?.organic?.length || data?.answerBox);
    const outcome = providerStatus(response, data);
    // Fixed diagnostics only: no raw API error messages, key fragments or user data.
    return res.status(200).json({ service, ...(service === "gemini" ? { model } : {}),
      ok: response.ok && resultPresent, outcome: response.ok && !resultPresent ? "empty_response" : outcome,
      httpStatus: response.status, elapsedMs: Date.now() - started, resultPresent });
  } catch (error) {
    const outcome = ["PROVIDER_TIMEOUT", "PROVIDER_NETWORK", "PROVIDER_INVALID_JSON"].includes(error.message)
      ? error.message.toLowerCase() : "internal_error";
    return res.status(200).json({ service, ok: false, outcome, elapsedMs: Date.now() - started });
  }
}
