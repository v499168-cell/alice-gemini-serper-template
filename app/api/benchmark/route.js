import { accessAllowed } from '../../../lib/conversation.js';
import { askGemini } from '../../../lib/alice.js';
export const maxDuration = 30;
export async function POST(request) {
  if (process.env.VERCEL_ENV !== 'preview' || !accessAllowed(request, process.env.ALICE_ACCESS_TOKEN)) return Response.json({ error: 'Not found' }, { status: 404 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (body?.variant === 'stream') {
    const began = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let firstTextMs = null, firstSentenceMs = null, text = '', buffer = '';
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Почему осенью желтеют листья? Ответь по-русски одним коротким предложением, до 20 слов.' }] }], generationConfig: { maxOutputTokens: 96, thinkingConfig: { thinkingLevel: 'minimal' } } })
      });
      if (!response.ok) return Response.json({ variant: 'stream', httpStatus: response.status, elapsedMs: Date.now() - began });
      const reader = response.body.getReader(), decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') continue;
          const event = JSON.parse(raw);
          for (const part of event?.candidates?.[0]?.content?.parts || []) if (part.text && !part.thought) {
            firstTextMs ??= Date.now() - began;
            text += part.text;
            if (/[.!?](?:\s|$)/.test(text)) firstSentenceMs ??= Date.now() - began;
          }
        }
        if (done) break;
      }
      return Response.json({ variant: 'stream', elapsedMs: Date.now() - began, firstTextMs, firstSentenceMs, text });
    } catch { return Response.json({ variant: 'stream', elapsedMs: Date.now() - began, firstTextMs, firstSentenceMs, error: 'STREAM_FAILED' }); }
    finally { clearTimeout(timer); }
  }
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
