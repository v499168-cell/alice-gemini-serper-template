import { createHmac, timingSafeEqual } from 'node:crypto';
import { fitAliceText } from './alice.js';

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
      let run;
      try { run = await readTask(state.runId); }
      catch { return reply('Предыдущий ответ больше недоступен. Повтори вопрос, пожалуйста.'); }
      if (['pending', 'running'].includes(run.status)) return reply('Ответ ещё готовится. Чуть позже скажи «Дальше».', state);
      if (run.status !== 'completed') return reply('Не удалось подготовить ответ. Повтори вопрос, пожалуйста.');
      if (POLL.test(text) || !state.delivered) return reply(run.result.text, { ...state, delivered: true });
      history = run.result.history || [];
    } else if (POLL.test(text)) return reply('Сначала задай вопрос, пожалуйста.');
    try {
      let prepared;
      if (prepareAnswer) {
        try { prepared = await prepareAnswer(text, history); } catch { /* A slow/unavailable fast provider falls back to a durable task. */ }
      }
      const readyText = typeof prepared === 'string' && prepared.trim() ? fitAliceText(prepared) : null;
      const runId = readyText ? await startTask(text, history, readyText) : await startTask(text, history);
      const state = { runId, signature: ticketFor(runId, session, secret), delivered: false };
      if (readyText) return reply(readyText, { ...state, delivered: true });
      let ready;
      try { ready = waitTask ? await waitTask(runId) : null; } catch { /* Keep the durable task available if its status cannot be read. */ }
      if (ready?.status === 'completed') return reply(ready.result.text, { ...state, delivered: true });
      if (ready && !['pending', 'running'].includes(ready.status)) return reply('Не удалось подготовить ответ. Повтори вопрос, пожалуйста.');
      return reply('Этот ответ требует больше времени. Через несколько секунд скажи «Дальше».', state);
    } catch {
      console.error('Alice workflow could not start');
      return reply('Не удалось начать обработку вопроса. Попробуй ещё раз.');
    }
  };
}
