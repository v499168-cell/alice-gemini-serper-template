import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createConversation, ticketFor, withHistoryCache, readHistoryCache } from '../lib/conversation.js';

const secret = 'synthetic-test-only-'.repeat(4);
const session = 'cache-test';
const state = { runId: 'run-cache', signature: ticketFor('run-cache', session, secret), delivered: true };
const history = [{ role: 'user', text: 'Кодовое слово Кедр 🌲' }, { role: 'model', text: 'Запомнила: Кедр 🌲.' }];

test('complete Unicode history fits signed state and roundtrips', () => {
  const cached = withHistoryCache(state, history, session, secret);
  assert(Buffer.byteLength(JSON.stringify(cached)) <= 950);
  assert.deepEqual(readHistoryCache(cached, session, secret), history);
  for (const modified of [{ ...cached, history: cached.history + 'A' }, { ...cached, historyMac: 'wrong' }, { ...cached, runId: 'other' }]) {
    assert.equal(readHistoryCache(modified, session, secret), null);
  }
  assert.equal(readHistoryCache(cached, 'another-session', secret), null);
});

test('large incompressible history stays on the server instead of losing turns', () => {
  const large = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: randomBytes(600).toString('hex') }));
  assert.deepEqual(withHistoryCache(state, large, session, secret), state);
});

test('cached followup avoids server read and retains the complete conversation', async () => {
  const cached = withHistoryCache(state, history, session, secret);
  let starts = 0;
  const handle = createConversation({ secret,
    readTask: async () => { throw new Error('Server must not be read'); },
    prepareAnswer: async (_, prior) => { assert.deepEqual(prior, history); return 'Кедр.'; },
    startTask: async (_, prior, prepared) => { assert.deepEqual(prior, history); assert.equal(prepared, 'Кедр.'); starts++; return 'run-next'; }
  });
  const request = command => ({ version: '1.0', request: { command }, session: { session_id: session }, state: { session: cached } });
  assert.equal((await handle(request('Дальше'))).body.response.text, history.at(-1).text);
  assert.equal(starts, 0);
  const next = await handle(request('Какое кодовое слово?'));
  assert.equal(next.body.response.text, 'Кедр.');
  assert.equal(starts, 1);
  assert.deepEqual(readHistoryCache(next.body.session_state, session, secret), [...history, { role: 'user', text: 'Какое кодовое слово?' }, { role: 'model', text: 'Кедр.' }]);
});
