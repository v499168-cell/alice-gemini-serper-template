import { start, getRun } from 'workflow/api';
import { answerQuestion } from '../../workflows/answer.js';
import { createConversation, accessAllowed, waitForReady } from '../../lib/conversation.js';
import { prepareFastAnswer } from '../../lib/direct-answer.js';

export const maxDuration = 10;
export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json({ ok: true, service: 'alice-gemini-serper', mode: 'fast-response-with-durable-fallback', version: '5' }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request) {
  const began = Date.now();
  let stateMs = 0, fastMs = 0;
  const secret = process.env.ALICE_ACCESS_TOKEN;
  if (!accessAllowed(request, secret)) {
    console.warn('Alice webhook rejected: unauthorized');
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body;
  try { body = await request.json(); } catch {
    console.warn('Alice webhook rejected: invalid JSON');
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (process.env.ALICE_SKILL_ID && body?.session?.skill_id !== process.env.ALICE_SKILL_ID) {
    console.warn('Alice webhook rejected: skill mismatch');
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Only structural flags and timing: no utterances, tokens, URLs, or account IDs.
  console.info('Alice webhook received', JSON.stringify({
    newSession: body?.session?.new === true,
    screen: Boolean(body?.meta?.interfaces?.screen),
    hasCommand: Boolean(body?.request?.command || body?.request?.original_utterance),
    hasState: Boolean(body?.state?.session?.runId)
  }));
  const readTask = async id => {
    const reading = Date.now();
    try {
      const run = getRun(id);
      const status = await run.status;
      return { status, ...(status === 'completed' ? { result: await run.returnValue } : {}) };
    } finally { stateMs += Date.now() - reading; }
  };
  const handle = createConversation({ secret,
    startTask: async (text, history, preparedAnswer) => {
      console.info('Alice workflow enqueue started');
      const run = await start(answerQuestion, [text, history, preparedAnswer ?? null]);
      console.info('Alice workflow enqueue completed');
      return run.runId;
    },
    readTask,
    // Avoid the background dispatch round trip for a fast model response.
    prepareAnswer: async (text, history) => {
      const preparing = Date.now();
      try { return await prepareFastAnswer(text, history, began + 2800); }
      finally { fastMs += Date.now() - preparing; }
    },
    // Reserve 1.1s of Alice's 4.5s limit for network delivery and scheduling.
    waitTask: id => waitForReady(readTask, id, began + 3400)
  });
  const result = await handle(body);
  console.info('Alice webhook response', JSON.stringify({
    status: result.status,
    elapsedMs: Date.now() - began,
    stateMs, fastMs,
    delivered: result.body?.session_state?.delivered === true,
    responseChars: result.body?.response?.text?.length ?? 0
  }));
  return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store', 'X-Alice-Elapsed-Ms': String(Date.now() - began), 'X-Alice-State-Ms': String(stateMs), 'X-Alice-Fast-Ms': String(fastMs) } });
}
