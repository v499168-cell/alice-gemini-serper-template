import { isSearchIntent, searchWeb } from './alice.js';
import { askFast } from './fast-provider.js';
export async function prepareFastAnswer(text, history, deadline) {
  if (!process.env.FAST_LLM_URL || !process.env.FAST_LLM_TOKEN) return null;
  const remaining = () => deadline - Date.now();
  if (remaining() < 200) return null;
  const context = isSearchIntent(text) ? await searchWeb(text, Math.min(1800, remaining())) : '';
  if (remaining() < 200) return null;
  return await askFast(text, history, context, remaining());
}
