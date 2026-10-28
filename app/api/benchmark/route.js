import { accessAllowed } from '../../../lib/conversation.js';
import { askGemini } from '../../../lib/alice.js';
export const maxDuration = 30;
export async function POST(request) {
  if (process.env.VERCEL_ENV !== 'preview' || !accessAllowed(request, process.env.ALICE_ACCESS_TOKEN)) return Response.json({ error: 'Not found' }, { status: 404 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const variants = {
    current: { model: 'gemini-3.5-flash-lite', fast: false },
    minimal: { model: 'gemini-3.5-flash-lite', fast: true },
    older: { model: 'gemini-3.1-flash-lite', fast: true },
    gemma26: { model: 'gemma-4-26b-a4b-it', fast: true },
    gemma31: { model: 'gemma-4-31b-it', fast: true }
  };
  const prompts = { arithmetic: 'Сколько будет два плюс два? Ответь одним коротким предложением.', explain: 'Почему осенью желтеют листья? Ответь двумя короткими предложениями.' };
  if (!Object.hasOwn(variants, body?.variant) || !Object.hasOwn(prompts, body?.prompt)) return Response.json({ error: 'Invalid benchmark' }, { status: 400 });
  const started = Date.now();
  try {
    const text = await askGemini(prompts[body.prompt], [], '', 20000, variants[body.variant]);
    return Response.json({ variant: body.variant, prompt: body.prompt, elapsedMs: Date.now() - started, text });
  } catch (error) {
    return Response.json({ variant: body.variant, prompt: body.prompt, elapsedMs: Date.now() - started, error: /^[A-Z_]+$/.test(error.message) ? error.message : 'PROVIDER_ERROR' });
  }
}
