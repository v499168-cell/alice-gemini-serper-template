// Dedicated inference bridge. No Google/Serper keys and no arbitrary URLs/tools.
const MODEL = '@cf/google/gemma-4-26b-a4b-it';
function authorized(header, secret) {
  if (!secret || secret.length < 32) return false;
  const actual = new TextEncoder().encode(String(header || '').replace(/^Bearer /, ''));
  const expected = new TextEncoder().encode(secret);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { 'Cache-Control': 'no-store' };
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true, model: MODEL }, { headers });
    if (url.pathname !== '/generate') return Response.json({ error: 'Not found' }, { status: 404, headers });
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
    if (!authorized(request.headers.get('authorization'), env.ACCESS_TOKEN)) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
    let body;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 65536) return Response.json({ error: 'Request too large' }, { status: 413, headers });
      body = JSON.parse(raw);
    } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers }); }
    if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 10 || body.messages.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 16000)) {
      return Response.json({ error: 'Invalid messages' }, { status: 400, headers });
    }
    const started = Date.now();
    try {
      const result = await env.AI.run(MODEL, {
        messages: body.messages.map(m => ({ role: m.role, content: m.content })),
        max_completion_tokens: 160, temperature: 0.3,
        chat_template_kwargs: { enable_thinking: false }, store: false
      });
      const text = result?.choices?.[0]?.message?.content ?? result?.response;
      if (typeof text !== 'string' || !text.trim()) throw new Error('EMPTY_RESPONSE');
      return Response.json({ text: text.trim(), elapsedMs: Date.now() - started }, { headers });
    } catch {
      return Response.json({ error: 'Inference unavailable' }, { status: 503, headers });
    }
  }
};
