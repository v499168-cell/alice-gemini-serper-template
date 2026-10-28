import diagnostics from '../../../lib/diagnostics.js';
export const maxDuration = 20;
export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const headers = {};
  let status = 200, output;
  const res = { setHeader(k, v) { headers[k] = v; }, status(n) { status = n; return this; }, json(value) { output = value; } };
  await diagnostics({ method: 'POST', body, oidcHeaderPresent: request.headers.has('x-vercel-oidc-token'), headers: { authorization: request.headers.get('authorization') } }, res);
  return Response.json(output, { status, headers });
}
