import { start, getRun } from 'workflow/api';
import { answerQuestion } from '../../workflows/answer.js';
import { createConversation, accessAllowed } from '../../lib/conversation.js';

export const maxDuration = 10;
export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json({ ok: true, service: 'alice-gemini-serper', mode: 'durable-workflow', version: '2' }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request) {
  const began = Date.now();
  const secret = process.env.ALICE_ACCESS_TOKEN;
  if (!accessAllowed(request, secret)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (process.env.ALICE_SKILL_ID && body?.session?.skill_id !== process.env.ALICE_SKILL_ID) return Response.json({ error: 'Forbidden' }, { status: 403 });
  const handle = createConversation({ secret,
    startTask: async (text, history) => {
      console.info('Alice workflow enqueue started');
      const run = await start(answerQuestion, [text, history]);
      console.info('Alice workflow enqueue completed');
      return run.runId;
    },
    readTask: async id => {
      const run = getRun(id);
      const status = await run.status;
      return { status, ...(status === 'completed' ? { result: await run.returnValue } : {}) };
    }
  });
  const result = await handle(body);
  return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store', 'X-Alice-Elapsed-Ms': String(Date.now() - began) } });
}
