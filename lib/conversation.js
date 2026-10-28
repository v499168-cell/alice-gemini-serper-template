import { createHmac, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { fitAliceText, safeHistory } from './alice.js';

const POLL = /^(дальше|продолжай|продолжить|готово|готов|ответ|ответ готов|что нашла|ну что)[.!?\s]*$/i;
const EXIT = /^(выход|выйти|хватит|заверши|до свидания)[.!?\s]*$/i;
export function ticketFor(id, session, secret) {
  return createHmac('sha256', secret).update(JSON.stringify(['alice-job-v1', id, session])).digest('base64url');
}
export function validTicket(state, session, secret) {
  if (typeof state?.runId !== 'string' || state.runId.length > 180 || typeof state?.signature !== 'string') return false;
  const a = Buffer.from(state.signature), b = Buffer.from(ticketFor(state.runId, session, secret));
  return a.length === b.length && timingSafeEqual(a, b);
}
function historyMac(packed, id, session, secret) {
  return createHmac('sha256', secret).update(JSON.stringify(['alice-history-v1', id, session, packed])).digest('base64url');
}
export function withHistoryCache(state, history, session, secret) {
  if (!Array.isArray(history) || history.at(-1)?.role !== 'model') return state;
  const packed = deflateRawSync(Buffer.from(JSON.stringify(safeHistory(history, 24000)))).toString('base64url');
  const candidate = { ...state, history: packed, historyMac: historyMac(packed, state.runId, session, secret) };
  // Cache the complete existing history only. Never truncate memory to make it fit.
  return Buffer.byteLength(JSON.stringify(candidate)) <= 950 ? candidate : state;
}
export function readHistoryCache(state, session, secret) {
  if (typeof state?.history !== 'string' || !/^[A-Za-z0-9_-]{1,1100}$/.test(state.history) || typeof state?.historyMac !== 'string') return null;
  const a = Buffer.from(state.historyMac), b = Buffer.from(historyMac(state.history, state.runId, session, secret));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const history = JSON.parse(inflateRawSync(Buffer.from(state.history, 'base64url'), { maxOutputLength: 24000 }).toString());
    if (!Array.isArray(history) || history.at(-1)?.role !== 'model') return null;
    return safeHistory(history, 24000);
  } catch { return null; }
}
export function accessAllowed(request, secret) {
  if (!secret || secret.length < 32) return false;
  const token = request.headers.get('x-alice-token') || new URL(request.url).searchParams.get('token') || '';
  const a = Buffer.from(token), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
function envelope(text, state = {}, end = false) {
  if (Buffer.byteLength(JSON.stringify(state)) > 950) throw new Error('STATE_TOO_LARGE');
  return { version: '1.0', response: { text: fitAliceText(text), end_session: end }, session_state: state };
}
export async function waitForReady(readTask, runId, deadline, intervalMs = 100) {
  while (Date.now() < deadline) {
    let timer;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const run = await Promise.race([
        readTask(runId),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), remaining); })
      ]);
      if (!run || !['pending', 'running'].includes(run.status)) return run;
    } catch { return null; }
    finally { clearTimeout(timer); }
    const pause = Math.min(intervalMs, deadline - Date.now());
    if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
  }
  return null;
}
export function createConversation({ startTask, readTask, waitTask, prepareAnswer, secret }) {
  return async body => {
    const session = body?.session?.session_id;
    if (body?.version !== '1.0' || !body?.request || typeof session !== 'string' || session.length > 500 || !session || secret?.length < 32) {
      return { status: 400, body: { error: 'Invalid Alice request' } };
    }
    const reply = (text, state, end) => ({ status: 200, body: envelope(text, state, end) });
    const text = String(body.request.command ?? body.request.original_utterance ?? '').trim();
    if (EXIT.test(text)) return reply('До свидания!', {}, true);
    if (!text) return reply('Задай вопрос.');
    if (text.length > 2000) return reply('Сформулируй вопрос покороче, пожалуйста.');
    const prior = body?.state?.session;
    let history = [];
    if (validTicket(prior, session, secret)) {
      const state = { runId: prior.runId, signature: prior.signature, delivered: prior.delivered === true };
      const cached = state.delivered ? readHistoryCache(prior, session, secret) : null;
      if (cached) {
        if (POLL.test(text)) return reply(cached.at(-1).text, withHistoryCache(state, cached, session, secret));
        history = cached;
      } else {
        let run;
        try { run = await readTask(state.runId); }
        catch { return reply('Предыдущий ответ больше недоступен. Повтори вопрос, пожалуйста.'); }
        if (['pending', 'running'].includes(run.status)) return reply('Ответ ещё готовится. Чуть позже скажи «Дальше».', state);
        if (run.status !== 'completed') return reply('Не удалось подготовить ответ. Повтори вопрос, пожалуйста.');
        if (POLL.test(text) || !state.delivered) return reply(run.result.text, withHistoryCache({ ...state, delivered: true }, run.result.history, session, secret));
        history = run.result.history || [];
      }
    } else if (POLL.test(text)) return reply('Сначала задай вопрос, пожалуйста.');
    try {
      let prepared;
      if (prepareAnswer) {
        try { prepared = await prepareAnswer(text, history); } catch { /* A slow/unavailable fast provider falls back to a durable task. */ }
      }
      const readyText = typeof prepared === 'string' && prepared.trim() ? fitAliceText(prepared) : null;
      const runId = readyText ? await startTask(text, history, readyText) : await startTask(text, history);
      const state = { runId, signature: ticketFor(runId, session, secret), delivered: false };
      if (readyText) return reply(readyText, withHistoryCache({ ...state, delivered: true }, [...history, { role: 'user', text }, { role: 'model', text: readyText }], session, secret));
      let ready;
      try { ready = waitTask ? await waitTask(runId) : null; } catch { /* Keep the durable task available if its status cannot be read. */ }
      if (ready?.status === 'completed') return reply(ready.result.text, withHistoryCache({ ...state, delivered: true }, ready.result.history, session, secret));
      if (ready && !['pending', 'running'].includes(ready.status)) return reply('Не удалось подготовить ответ. Повтори вопрос, пожалуйста.');
      return reply('Этот ответ требует больше времени. Через несколько секунд скажи «Дальше».', state);
    } catch {
      console.error('Alice workflow could not start');
      return reply('Не удалось начать обработку вопроса. Попробуй ещё раз.');
    }
  };
}
