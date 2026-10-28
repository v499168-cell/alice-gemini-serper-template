import { start, getRun } from 'workflow/api';
import { answerQuestion } from '../../workflows/answer.js';
import { createConversation, accessAllowed, waitForReady } from '../../lib/conversation.js';
import { prepareFastAnswer } from '../../lib/direct-answer.js';

export const maxDuration = 10;
export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json({ ok: true, service: 'alice-gemini-serper', mode: 'fast-response-with-durable-fallback', version: '3' }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request) {
  const began = Date.now();
  const secret = process.env.ALICE_ACCESS_TOKEN;
  if (!accessAllowed(request, secret)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (process.env.ALICE_SKILL_ID && body?.session?.skill_id !== process.env.ALICE_SKILL_ID) return Response.json({ error: 'Forbidden' }, { status: 403 });
  const readTask = async id => {
    const run = getRun(id);
    const status = await run.status;
    return { status, ...(status === 'completed' ? { result: await run.returnValue } : {}) };
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
    prepareAnswer: (text, history) => prepareFastAnswer(text, history, began + 2800),
    // Reserve 1.1s of Alice's 4.5s limit for network delivery and scheduling.
    waitTask: id => waitForReady(readTask, id, began + 3400)
  });
  const result = await handle(body);
  return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store', 'X-Alice-Elapsed-Ms': String(Date.now() - began) } });
}
