/* The one outbound call meal logging makes: Google's Gemini API, generateContent, with a JSON
   response schema. Plain fetch — no SDK, nothing to install, nothing that reads the environment.

   What leaves the server per call: the system prompt, the user's own description or photo, and
   nothing else. No user id, no name, no other state. */

import { GeminiError, geminiRequest, geminiResult, SYSTEM, SCHEMA } from './meal-ai.js';

export { GeminiError };
const TIMEOUT_MS = 60000;

// Test seam: the tests swap in a fake so the suite needs neither a key nor a network.
let transport = (url, init) => fetch(url, init);
export function setTransport(fn) { transport = fn || ((url, init) => fetch(url, init)); }

/**
 * @param {{ key: string, model: string, system?: string, parts: object[], schema?: object }} req
 * @returns {Promise<object>} the parsed JSON the model returned
 */
export async function generateJSON({ key, model, system = SYSTEM, parts, schema = SCHEMA }) {
  const req = geminiRequest({ key, model, parts, system, schema });
  let res;
  try {
    res = await transport(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new GeminiError(e?.name === 'TimeoutError' ? 'timeout' : 'network', e?.message || 'network error');
  }
  const body = await res.json().catch(() => ({}));
  return geminiResult(res.status, body);
}
