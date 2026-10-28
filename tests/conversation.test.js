import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversation, accessAllowed, validTicket, waitForReady } from '../lib/conversation.js';
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

test('a fast durable answer is spoken in the first turn and its history survives', async () => {
  let starts = 0;
  const history = [{ role: 'user', text: 'Я Николай' }, { role: 'model', text: 'Привет, Николай!' }];
  const completed = { status: 'completed', result: { text: 'Привет, Николай!', history } };
  const args = [];
  const handle = createConversation({ secret,
    startTask: async (...a) => { starts++; args.push(a); return 'fast-run'; },
    readTask: async () => completed,
    waitTask: async () => completed
  });
  const first = await handle(request('Я Николай'));
  assert.equal(first.body.response.text, 'Привет, Николай!');
  assert.equal(first.body.session_state.delivered, true);
  assert(validTicket(first.body.session_state, 'session-one', secret));
  await handle(request('Как меня зовут?', first.body.session_state));
  assert.equal(starts, 2);
  assert.deepEqual(args[1], ['Как меня зовут?', history]);
});

test('a slow fast-path read keeps the original task for later without duplicate generation', async () => {
  for (const throws of [false, true]) {
    let starts = 0;
    const handle = createConversation({ secret,
      startTask: async () => { starts++; return 'slow-run'; },
      readTask: async () => ({ status: 'completed', result: { text: 'Готовый ответ', history: [] } }),
      waitTask: async () => { if (throws) throw Error('temporary read failure'); return null; }
    });
    const first = await handle(request('Сложный вопрос'));
    assert.equal(first.body.session_state.runId, 'slow-run');
    const next = await handle(request('Дальше', first.body.session_state));
    assert.equal(next.body.response.text, 'Готовый ответ');
    assert.equal(starts, 1);
  }
});

test('a hung status read cannot hold the response beyond the fast-path budget', async () => {
  const began = Date.now();
  const result = await waitForReady(async () => new Promise(() => {}), 'run', began + 30, 5);
  assert.equal(result, null);
  assert(Date.now() - began < 300);
});

test('fast path observes completion after pending and running states', async () => {
  let reads = 0;
  const result = await waitForReady(async () => {
    reads++;
    return reads === 1 ? { status: 'pending' } : reads === 2 ? { status: 'running' } : { status: 'completed', result: { text: 'Ответ' } };
  }, 'run', Date.now() + 300, 5);
  assert.equal(result.result.text, 'Ответ');
  assert.equal(reads, 3);
});
