import { askGemini, searchWeb, isSearchIntent, safeHistory, fitAliceText, errorForUser } from '../lib/alice.js';
import { askFast } from '../lib/fast-provider.js';

export async function answerQuestion(text, history, preparedAnswer = null) {
  'use workflow';
  return await generateAnswer(text, history, preparedAnswer);
}

async function generateAnswer(text, history, preparedAnswer) {
  'use step';
  if (typeof preparedAnswer === 'string' && preparedAnswer.trim()) {
    return { text: fitAliceText(preparedAnswer), history: safeHistory([...history, { role: 'user', text }, { role: 'model', text: preparedAnswer }], 24000) };
  }
  try {
    const context = isSearchIntent(text) ? await searchWeb(text, 8000) : '';
    let answer;
    if (process.env.FAST_LLM_URL) {
      try { answer = await askFast(text, history, context); }
      catch { console.warn('Fast inference unavailable; using Gemini fallback'); }
    }
    answer ??= await askGemini(text, history, context, 30000);
    return { text: fitAliceText(answer), history: safeHistory([...history, { role: 'user', text }, { role: 'model', text: answer }], 24000) };
  } catch (error) {
    // Return a user-safe error; do not automatically repeat billable provider calls.
    return { text: errorForUser(error), history };
  }
}
