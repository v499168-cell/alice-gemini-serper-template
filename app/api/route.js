import { start, getRun } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import { answerQuestion } from '../../workflows/answer.js';
import { createConversation, accessAllowed } from '../../lib/conversation.js';

export const maxDuration = 60;
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
      const base = await getWorld();
      console.info('Alice workflow world loaded');
      const timed = (name, fn) => async (...args) => {
        const began = Date.now();
        console.info('Alice workflow operation started', name);
        try { return await fn(...args); }
        finally { console.info('Alice workflow operation finished', name, Date.now() - began); }
      };
      const world = { ...base,
        getDeploymentId: timed('deployment', (...a) => base.getDeploymentId(...a)),
        getEncryptionKeyForRun: timed('encryption', (...a) => base.getEncryptionKeyForRun(...a)),
        events: { ...base.events, create: timed('create-event', (...a) => base.events.create(...a)) },
        queue: timed('queue', (...a) => base.queue(...a))
      };
      const run = await start(answerQuestion, [text, history], { world });
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
