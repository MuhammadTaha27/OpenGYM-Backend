/* Photo or sentence → a list of foods with grams and nutrients.
 *
 * One model call, then deterministic code. The model does what only it can — recognise food in
 * a photo, read "90 grams of beef kebab and a naan", judge a portion — and hands back, per item,
 * a weight, a few USDA-style search phrases and a rough per-100 g estimate. The nutrients the
 * user logs then come from the USDA row those phrases match (food-search.js), scaled to the
 * weight. The model's own numbers are used only when nothing in USDA fits, and are labelled as
 * an estimate; for micronutrients they are not used at all — a model guessing selenium is
 * inventing it.
 *
 * Everything the model returns is treated as untrusted input: bounded, typed, truncated here
 * before any of it reaches a client.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve as resolveWith, parseImage, partsFor } from './meal-ai.js';
import { generateJSON } from './gemini.js';

// The prompt, schema and validation live in meal-ai.js — generated from the frontend's
// lib/meal-ai.js, which the Android app runs on the phone — so both recognise food alike.
export { parseImage };

const HERE = path.dirname(fileURLToPath(import.meta.url));
let db = null;
export const foodDb = () => (db ||= JSON.parse(fs.readFileSync(path.join(HERE, '../data/foods.json'), 'utf8')));

/** Validates the model's answer and resolves each item against USDA (see meal-ai.js). */
export const resolve = (raw, foods = foodDb()) => resolveWith(raw, foods);

/** One analysis. `text` and/or `image` (a parsed { mime, data }). */
export async function analyze({ key, model, text, image }) {
  const raw = await generateJSON({ key, model, parts: partsFor({ text, image }) });
  return resolve(raw);
}
