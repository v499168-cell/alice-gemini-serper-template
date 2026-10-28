import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversation, accessAllowed, validTicket } from '../lib/conversation.js';
const secret = 'test-only-'.repeat(8);
const request = (command, state = {}, session = 'session-one') => ({ version: '1.0', request: { command }, session: { session_id: session }, state: { session: state } });
test('slow provider starts once; polling retrieves result and later question keeps server history', async () => {
  const starts = [];
  let status = 'running';
  const history = [{ role: 'user', text: 'Я Николай' }, { role: 'model', text: 'Привет, Николай!' }];
  const handle = createConversation({ secret, startTask: async (...args) => { starts.push(args); return 'run-1'; }, readTask: async () => ({ status, result: { text: 'Привет, Николай!', history } }) });
  const first = await handle(request('Я Николай'));
  const state = first.body.session_state;
  assert.equal(starts.length, 1);
  assert(validTicket(state, 'session-one', secret));
  assert(Buffer.byteLength(JSON.stringify(state)) < 950);
  assert.match((await handle(request('Дальше', state))).body.response.text, /ещё готовится/);
  assert.equal(starts.length, 1);
  status = 'completed';
  const ready = await handle(request('Дальше', state));
  assert.equal(ready.body.response.text, 'Привет, Николай!');
  await handle(request('Дальше', ready.body.session_state));
  assert.equal(starts.length, 1);
  await handle(request('Как меня зовут?', ready.body.session_state));
  assert.deepEqual(starts[1], ['Как меня зовут?', history]);
});
test('signed tickets cannot read another session or forged workflow', async () => {
  let reads = 0;
  const handle = createConversation({ secret, startTask: async () => 'run-1', readTask: async () => { reads++; return { status: 'running' }; } });
  const state = (await handle(request('Вопрос'))).body.session_state;
  await handle(request('Дальше', state, 'someone-else'));
  await handle(request('Дальше', { ...state, runId: 'stolen-run' }));
  assert.equal(reads, 0);
});
test('launch, poll without job, exit and invalid request do not create jobs', async () => {
  let starts = 0;
  const handle = createConversation({ secret, startTask: async () => { starts++; }, readTask: async () => {} });
  await handle(request(''));
  await handle(request('Дальше'));
  assert.equal((await handle(request('Выход'))).body.response.end_session, true);
  assert.equal((await handle({})).status, 400);
  await handle(request('я'.repeat(2001)));
  assert.equal(starts, 0);
});
test('expired or failed workflow produces recoverable response', async () => {
  for (const failed of [false, true]) {
    const handle = createConversation({ secret, startTask: async () => 'run-1', readTask: async () => { if (failed) throw Error('expired'); return { status: 'failed' }; } });
    const state = (await handle(request('Вопрос'))).body.session_state;
    const reply = await handle(request('Дальше', state));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.session_state, {});
  }
});
test('webhook requires separate secret; rejects absent, wrong and oversized tokens', () => {
  assert(!accessAllowed(new Request('https://example.com/api'), secret));
  assert(!accessAllowed(new Request('https://example.com/api?token=wrong'), secret));
  assert(!accessAllowed(new Request('https://example.com/api', { headers: { 'x-alice-token': 'x'.repeat(1000) } }), secret));
  assert(accessAllowed(new Request('https://example.com/api', { headers: { 'x-alice-token': secret } }), secret));
  assert(accessAllowed(new Request('https://example.com/api?token=' + secret), secret));
  assert(!accessAllowed(new Request('https://example.com/api'), ''));
});
