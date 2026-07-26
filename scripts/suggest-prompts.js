/**
 * CLI: node scripts/suggest-prompts.js "Brand" brand.com [--keywords "..."]
 *
 * Drafts intents × paraphrases via core/suggest.js and prints them for review — it
 * never writes to the database (§6.7). With zero provider keys this is the static
 * starter pack; either way the output is a DRAFT for a human to edit.
 */

import { parseArgs } from 'node:util';
import { suggestIntents } from '../core/suggest.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    keywords: { type: 'string' },
  },
});

const name = positionals[0];
const domain = positionals[1];

const result = await suggestIntents({
  // No name given → the starter pack's own '{Brand}' placeholder keeps the draft generic.
  brand: { name: name ?? '{Brand}', aliases: [], domains: domain === undefined ? [] : [domain] },
  keywords: values.keywords,
});

process.stdout.write(`${JSON.stringify({ source: result.source, intents: result.intents }, null, 2)}\n`);
