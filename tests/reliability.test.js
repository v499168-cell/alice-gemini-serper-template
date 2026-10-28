import test from "node:test";
import assert from "node:assert/strict";
import handler, { safeHistory, fetchJson, askGemini } from "../api/index.js";
import diagnostics from "../api/diagnostics.js";

function fixture(t) {
  const saved = { ...process.env };
  process.env.GEMINI_API_KEY = "fake-google-secret";
  process.env.SERPER_API_KEY = "fake-serper-secret";
  delete process.env.ALICE_SKILL_ID;
  delete process.env.DIAGNOSTICS_TOKEN;
  delete process.env.GEMINI_MODEL;
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
}
function response() {
  return { code: null, body: null, headers: {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return body; }, setHeader(k, v) { this.headers[k] = v; } };
}
async function invoke(command, history = []) {
  const res = response();
  await handler({ method: "POST", body: { version: "1.0", request: { command }, state: { session: { history } } } }, res);
  return res;
}
const googleReply = text => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });

test("UTF-8 session state stays below Alice's 1 KiB limit for Cyrillic and emoji", () => {
  for (const text of ["я".repeat(1200), "🙂".repeat(600), "короткая реплика"]) {
    const history = safeHistory(Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "model" : "user", text })));
    assert.ok(Buffer.byteLength(JSON.stringify({ history })) <= 950);
    assert.ok(!history.length || history[0].role === "user");
  }
});

test("failed live search never falls back to unverified Gemini knowledge", async t => {
  fixture(t); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return { ok: false, status: 503, json: async () => ({}) }; });
  const result = await invoke("Какие новости сегодня?");
  assert.equal(calls, 1);
  assert.match(result.body.response.text, /Свежие данные не проверены/);
});

test("missing Serper is explicit for current questions and does not call Gemini", async t => {
  fixture(t); delete process.env.SERPER_API_KEY;
  t.mock.method(globalThis, "fetch", async () => { assert.fail("No API call expected"); });
  assert.match((await invoke("Какая погода сегодня?")).body.response.text, /поиск.*не настроен/);
});

test("ordinary question uses only Google and fits returned session state", async t => {
  fixture(t);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).hostname, "generativelanguage.googleapis.com");
    assert.equal(options.headers["x-goog-api-key"], "fake-google-secret");
    assert.equal(options.redirect, "error");
    return googleReply("Ответ ".repeat(150));
  });
  const result = await invoke("Расскажи о Луне");
  assert.equal(result.code, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(result.body.session_state)) <= 950);
  assert.ok(result.body.response.text.length <= 1024);
});

test("successful Serper results are passed as untrusted context to Google", async t => {
  fixture(t); const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url);
    if (new URL(url).hostname === "google.serper.dev") {
      assert.equal(options.headers["X-API-KEY"], "fake-serper-secret");
      assert.equal(options.headers["x-goog-api-key"], undefined);
      return { ok: true, status: 200, json: async () => ({ organic: [{ title: "Источник", snippet: "Данные", link: "https://example.org" }] }) };
    }
    const prompt = JSON.parse(options.body).contents.at(-1).parts[0].text;
    assert.match(prompt, /недоверенные данные/);
    assert.match(prompt, /example.org/);
    assert.equal(options.headers["X-API-KEY"], undefined);
    return googleReply("Проверенный ответ");
  });
  assert.equal((await invoke("Найди новости")).body.response.text, "Проверенный ответ");
  assert.equal(calls.length, 2);
});

test("AbortError is classified as timeout regardless of localized error message", async t => {
  fixture(t);
  t.mock.method(globalThis, "fetch", async () => { throw new DOMException("This operation was aborted", "AbortError"); });
  assert.match((await invoke("Два плюс два?")).body.response.text, /Не успела/);
});

test("deadline also aborts while reading JSON response body", async t => {
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => ({
    json: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }))
  }));
  await assert.rejects(fetchJson("https://generativelanguage.googleapis.com/", {}, 100), /PROVIDER_TIMEOUT/);
});

test("malformed provider JSON is diagnosed instead of treated as empty response", async t => {
  t.mock.method(globalThis, "fetch", async () => ({ json: async () => { throw new SyntaxError("bad JSON"); } }));
  await assert.rejects(fetchJson("https://generativelanguage.googleapis.com/", {}, 100), /PROVIDER_INVALID_JSON/);
});

test("Google 404 identifies unavailable model separately from key errors", async t => {
  fixture(t);
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404, json: async () => ({ error: { message: "secret data" } }) }));
  assert.match((await invoke("Привет" )).body.response.text, /модель Gemini недоступна/);
});

test("thought parts never get spoken by Alice", async t => {
  fixture(t);
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ thought: true, text: "private thought" }, { text: "Четыре" }] } }] }) }));
  assert.equal(await askGemini("Тест", [], "", 1000), "Четыре");
});

test("unexpected skill is rejected before any provider request", async t => {
  fixture(t); process.env.ALICE_SKILL_ID = "expected-skill";
  t.mock.method(globalThis, "fetch", async () => { assert.fail("No API call expected"); });
  assert.equal((await invoke("Тест")).code, 403);
});

test("invalid webhook envelopes cannot trigger provider calls", async t => {
  fixture(t);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("No API call expected"); });
  const res = response(); await handler({ method: "POST", body: {} }, res);
  assert.equal(res.code, 400);
});

test("diagnostics is closed by default and rejects incorrect tokens", async t => {
  fixture(t);
  for (const token of [undefined, "x".repeat(32)]) {
    if (token) process.env.DIAGNOSTICS_TOKEN = token;
    const res = response(); await diagnostics({ method: "POST", headers: {}, body: { service: "gemini" } }, res);
    assert.equal(res.code, 404);
  }
});

test("authorized diagnostic measures API result without disclosing provider messages or keys", async t => {
  fixture(t); process.env.DIAGNOSTICS_TOKEN = "x".repeat(32);
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 400,
    json: async () => ({ error: { message: "fake-google-secret", details: [{ reason: "API_KEY_INVALID" }] } }) }));
  const res = response();
  await diagnostics({ method: "POST", headers: { authorization: `Bearer ${process.env.DIAGNOSTICS_TOKEN}` }, body: { service: "gemini" } }, res);
  assert.equal(res.body.outcome, "invalid_key");
  assert.equal(res.body.httpStatus, 400);
  assert.doesNotMatch(JSON.stringify(res.body), /fake-google-secret|fake-serper-secret/);
});
