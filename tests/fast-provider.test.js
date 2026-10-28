import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/fast-answer.js';
import { askFast } from '../lib/fast-provider.js';
import { answerQuestion } from '../workflows/answer.js';

const secret = 'private-test-key-'.repeat(4);
const url = 'https://test.workers.dev/generate';
test('a prepared answer checkpoint makes no second search or model request', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => { throw Error('No network allowed for checkpoint'); };
  const result = await answerQuestion('Найди данные', [], 'Готовый ответ.');
  assert.equal(result.text, 'Готовый ответ.');
  assert.deepEqual(result.history, [{ role: 'user', text: 'Найди данные' }, { role: 'model', text: 'Готовый ответ.' }]);
});
test('inference bridge rejects unauthorized and malformed requests without calling the model', async () => {
  let calls = 0;
  const env = { ACCESS_TOKEN: secret, AI: { run: async () => { calls++; } } };
  const missing = await worker.fetch(new Request(url, { method: 'POST', body: '{}' }), env);
  assert.equal(missing.status, 401);
  for (const messages of [[], [{ role: 'tool', content: 'unsafe' }], Array(11).fill({ role: 'user', content: 'x' })]) {
    const bad = await worker.fetch(new Request(url, { method: 'POST', headers: { Authorization: 'Bearer ' + secret }, body: JSON.stringify({ messages }) }), env);
    assert.equal(bad.status, 400);
  }
  assert.equal(calls, 0);
});
test('inference bridge uses only the fixed model and never returns reasoning or token', async () => {
  let received;
  const env = { ACCESS_TOKEN: secret, AI: { run: async (model, input) => {
    received = { model, input };
    return { choices: [{ message: { content: 'Короткий ответ.', reasoning_content: 'Private reasoning' } }] };
  } } };
  const response = await worker.fetch(new Request(url, { method: 'POST', headers: { Authorization: 'Bearer ' + secret }, body: JSON.stringify({ model: 'attacker-model', tools: ['unsafe'], messages: [{ role: 'user', content: 'Вопрос', extra: 'discard' }] }) }), env);
  const body = await response.json();
  assert.equal(body.text, 'Короткий ответ.');
  assert.equal(received.model, '@cf/google/gemma-4-26b-a4b-it');
  assert.equal(received.input.chat_template_kwargs.enable_thinking, false);
  assert.equal(received.input.store, false);
  assert.deepEqual(received.input.messages, [{ role: 'user', content: 'Вопрос' }]);
  assert(!JSON.stringify(body).includes(secret));
  assert(!JSON.stringify(body).includes('reasoning'));
});
test('fast client keeps private provider keys away from inference bridge and preserves search provenance instructions', async t => {
  const saved = { ...process.env }, originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  process.env.FAST_LLM_URL = url; process.env.FAST_LLM_TOKEN = secret;
  process.env.GEMINI_API_KEY = 'google-key'; process.env.SERPER_API_KEY = 'serper-key';
  global.fetch = async (target, options) => {
    assert.equal(target, url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + secret);
    const body = JSON.parse(options.body);
    assert.equal(body.messages[1].role, 'user');
    assert.equal(body.messages[2].role, 'assistant');
    assert.match(body.messages.at(-1).content, /недоверенные данные/);
    assert(!JSON.stringify(options).includes('google-key'));
    assert(!JSON.stringify(options).includes('serper-key'));
    return { ok: true, json: async () => ({ text: 'Ответ' }) };
  };
  assert.equal(await askFast('Вопрос', [{ role: 'user', text: 'Реплика' }, { role: 'model', text: 'Ответ' }], 'Поиск'), 'Ответ');
});
test('fast client rejects external or non-TLS endpoints before transmitting secret', async t => {
  const savedUrl = process.env.FAST_LLM_URL, savedToken = process.env.FAST_LLM_TOKEN, originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; if (savedUrl === undefined) delete process.env.FAST_LLM_URL; else process.env.FAST_LLM_URL = savedUrl; if (savedToken === undefined) delete process.env.FAST_LLM_TOKEN; else process.env.FAST_LLM_TOKEN = savedToken; });
  process.env.FAST_LLM_TOKEN = secret;
  global.fetch = async () => { throw Error('Fetch must not happen'); };
  for (const bad of ['http://test.workers.dev/generate','https://attacker.example/generate','https://test.workers.dev.attacker.example/generate']) {
    process.env.FAST_LLM_URL = bad;
    await assert.rejects(askFast('Вопрос', [], ''), /FAST_PROVIDER_INVALID_URL/);
  }
});
