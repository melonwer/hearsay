/**
 * Intent/paraphrase generator tests (§6.7, §15) — the pure post-processing, the
 * malformed-draft retry, and the starter-pack fallback. The LLM call is injected, so
 * nothing here touches a provider, a key or the network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PROMPT_CHARS,
  buildDraftPrompt,
  cleanText,
  parseDraft,
  postProcess,
  starterPack,
  suggestIntents,
} from '../core/suggest.js';

/** @type {{name:string, aliases:string[], domains:string[]}} */
const BRAND = { name: 'Notewell', aliases: ['Notewell AI'], domains: ['notewell.io'] };
const COMPETITORS = [{ name: 'Jotta' }, { name: 'EchoPad' }, { name: 'Quillo' }];

test('cleanText strips numbering, unwraps quotes and collapses whitespace', () => {
  assert.equal(cleanText('1. best AI meeting notes tool'), 'best AI meeting notes tool');
  assert.equal(cleanText('2) Top meeting summarisers'), 'Top meeting summarisers');
  assert.equal(cleanText('- best free transcription app'), 'best free transcription app');
  assert.equal(cleanText('• best free transcription app'), 'best free transcription app');
  assert.equal(cleanText('"What is the best AI notetaker?"'), 'What is the best AI notetaker?');
  assert.equal(cleanText('3. “Which tool should I use?”'), 'Which tool should I use?');
  assert.equal(cleanText('  best   AI \n notes  '), 'best AI notes');
  assert.equal(cleanText(42), '');
});

test('cleanText caps a prompt at 300 characters on a word boundary', () => {
  const long = `Which tool should I use ${'for very long meetings '.repeat(30)}?`;
  assert.ok(long.length > MAX_PROMPT_CHARS);
  const capped = cleanText(long);
  assert.ok(capped.length <= MAX_PROMPT_CHARS, `expected ≤ ${MAX_PROMPT_CHARS}, got ${capped.length}`);
  assert.ok(!capped.endsWith(' '));
  assert.ok(long.startsWith(capped), 'the cap truncates, it never rewrites');
});

test('postProcess tags anything naming the brand or an alias as branded (§6.7)', () => {
  const intents = postProcess(
    {
      intents: [
        { label: 'best AI meeting notes tool', category: 'general', paraphrases: ['best AI meeting notes tool'] },
        { label: 'Is Notewell any good?', category: 'general', paraphrases: ['Is Notewell any good?'] },
        { label: 'Notewell AI pricing', category: 'pricing', paraphrases: ['How much does Notewell AI cost?'] },
        { label: 'notewellness apps', category: 'general', paraphrases: ['best notewellness apps'] },
      ],
    },
    { brand: BRAND },
  );

  assert.deepEqual(
    intents.map((intent) => [intent.label, intent.category]),
    [
      ['best AI meeting notes tool', 'general'],
      ['Is Notewell any good?', 'branded'],
      ['Notewell AI pricing', 'branded'],
      ['notewellness apps', 'general'],
    ],
    'branded tagging uses the analyzer word boundaries, so "notewellness" is not the brand',
  );
});

test('postProcess dedupes paraphrases and labels case-insensitively', () => {
  const intents = postProcess(
    {
      intents: [
        { label: 'best AI meeting notes tool', paraphrases: ['Best AI notetaker?', 'best ai notetaker?', 'Top notetakers'] },
        { label: 'Best AI Meeting Notes Tool', paraphrases: ['Something else entirely'] },
        { label: 'cheapest transcription', paraphrases: ['Top notetakers', 'Cheapest meeting transcription?'] },
      ],
    },
    { brand: BRAND },
  );

  assert.deepEqual(
    intents.map((intent) => intent.paraphrases),
    [['Best AI notetaker?', 'Top notetakers'], ['Cheapest meeting transcription?']],
    'a repeated label is dropped, and a paraphrase is only ever suggested once',
  );
});

test('postProcess strips numbering from paraphrases and keeps at most three', () => {
  const intents = postProcess(
    {
      intents: [
        {
          label: '1. best AI meeting notes tool',
          paraphrases: ['1. best notetaker', '2. top notetaker', '3) leading notetaker', '4. another notetaker'],
        },
      ],
    },
    { brand: BRAND },
  );
  assert.equal(intents[0].label, 'best AI meeting notes tool');
  assert.deepEqual(intents[0].paraphrases, ['best notetaker', 'top notetaker', 'leading notetaker']);
});

test('postProcess allow-lists categories and never invents one', () => {
  const intents = postProcess(
    {
      intents: [
        { label: 'a', category: 'comparison', paraphrases: ['Which is better, X or Y?'] },
        { label: 'b', category: 'sentiment', paraphrases: ['What do people think of X?'] },
        { label: 'c', category: 'branded', paraphrases: ['best tools for remote teams'] },
      ],
    },
    { brand: BRAND },
  );
  assert.deepEqual(
    intents.map((intent) => intent.category),
    ['comparison', 'general', 'general'],
    'an unknown category falls back to general, and `branded` is ours to assign, not the model\'s',
  );
});

test('postProcess drops empty intents and caps the draft at twelve', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ label: `intent ${i}`, paraphrases: [`prompt number ${i}`] }));
  assert.equal(postProcess({ intents: many }, { brand: BRAND }).length, 12);
  assert.deepEqual(postProcess({ intents: [{ label: 'x', paraphrases: [] }, null, 7] }, { brand: BRAND }), []);
});

test('parseDraft survives a code fence, preamble and a bare array', () => {
  const fenced = '```json\n{"intents":[{"label":"a","paraphrases":["p"]}]}\n```';
  assert.equal(parseDraft(fenced)?.intents.length, 1);
  assert.equal(parseDraft('Sure! Here you go:\n{"intents":[{"label":"a","paraphrases":["p"]}]}')?.intents.length, 1);
  assert.equal(parseDraft('[{"label":"a","paraphrases":["p"]}]')?.intents.length, 1);
  assert.equal(parseDraft('sorry, I cannot help with that'), null);
  assert.equal(parseDraft('{"oops":true}'), null);
});

test('starterPack fills placeholders from the entities and quarantines branded rows (§20.3)', () => {
  const intents = starterPack({ brand: BRAND, competitors: COMPETITORS, categoryHint: 'AI meeting notes tools', year: 2026 });

  assert.ok(intents.length >= 8 && intents.length <= 12);
  assert.ok(
    intents.some((intent) => intent.label === "What's the best AI meeting notes tools for {audience}?"),
    'unfillable placeholders stay in braces for the user to edit',
  );
  assert.ok(intents.some((intent) => intent.label === 'Top 5 AI meeting notes tools in 2026'));
  assert.ok(intents.some((intent) => intent.label === 'Notewell vs Jotta — which is better?'));
  assert.ok(
    intents.some((intent) => intent.label === 'Notewell vs EchoPad — which is better?'),
    'the extra slots are filled from the remaining competitors',
  );

  for (const intent of intents) {
    assert.equal(intent.paraphrases.length, 1, 'a starter row is a single-paraphrase intent the user can extend');
    assert.ok(intent.label.length <= MAX_PROMPT_CHARS);
    const branded = /Notewell/.test(intent.label);
    assert.equal(intent.category === 'branded', branded, `category mismatch for "${intent.label}"`);
  }
});

test('starterPack still works with no competitors and no category', () => {
  const intents = starterPack({ brand: { name: 'Notewell' } });
  assert.ok(intents.length >= 8);
  assert.ok(intents.some((intent) => intent.label.includes('{Competitor}')));
  assert.ok(intents.some((intent) => intent.label.includes('{category}')));
});

test('suggestIntents falls back to the starter pack when no key is configured', async () => {
  const result = await suggestIntents({ brand: BRAND, competitors: COMPETITORS, year: 2026 });
  assert.equal(result.source, 'starter');
  assert.equal(result.reason, 'no-provider-key');
  assert.ok(result.intents.length >= 8);
});

test('suggestIntents uses the injected model call and post-processes its draft', async () => {
  /** @type {string[]} */
  const prompts = [];
  const result = await suggestIntents({
    brand: BRAND,
    competitors: COMPETITORS,
    categoryHint: 'AI meeting notes',
    runPrompt: async (prompt) => {
      prompts.push(prompt);
      return {
        text: '```json\n{"intents":[{"label":"1. best AI meeting notes tool","category":"general","paraphrases":["1. What is the best AI meeting notes tool?","Which AI notetaker should I use?"]},{"label":"Is Notewell worth it?","category":"general","paraphrases":["Is Notewell worth paying for?"]}]}\n```',
      };
    },
  });

  assert.equal(result.source, 'llm');
  assert.equal(prompts.length, 1, 'a parseable draft needs no retry');
  assert.match(prompts[0], /Brand: Notewell/);
  assert.match(prompts[0], /Competitors: Jotta, EchoPad, Quillo/);
  assert.deepEqual(
    result.intents.map((intent) => [intent.label, intent.category, intent.paraphrases.length]),
    [
      ['best AI meeting notes tool', 'general', 2],
      ['Is Notewell worth it?', 'branded', 1],
    ],
  );
});

test('suggestIntents retries once on a malformed draft, then falls back (§6.7)', async () => {
  /** @type {string[]} */
  const attempts = [];
  const bad = await suggestIntents({
    brand: BRAND,
    competitors: COMPETITORS,
    year: 2026,
    runPrompt: async (prompt) => {
      attempts.push(prompt);
      return 'I am afraid I cannot do that.';
    },
  });

  assert.equal(attempts.length, 2, 'exactly one retry');
  assert.match(attempts[1], /JSON only/, 'the retry asks harder');
  assert.equal(bad.source, 'starter');
  assert.equal(bad.reason, 'unparseable-draft');
  assert.ok(bad.intents.length >= 8, 'the flow is never a dead end');

  let calls = 0;
  const recovered = await suggestIntents({
    brand: BRAND,
    runPrompt: async () => {
      calls += 1;
      return calls === 1 ? 'nope' : '{"intents":[{"label":"best notetaker","paraphrases":["best notetaker?"]}]}';
    },
  });
  assert.equal(calls, 2);
  assert.equal(recovered.source, 'llm');
  assert.deepEqual(recovered.intents.map((intent) => intent.label), ['best notetaker']);
});

test('suggestIntents swallows a provider failure into the starter pack', async () => {
  const result = await suggestIntents({
    brand: BRAND,
    year: 2026,
    runPrompt: async () => {
      throw new Error('quota');
    },
  });
  assert.equal(result.source, 'starter');
  assert.equal(result.reason, 'provider-error');
});

test('buildDraftPrompt asks for the §6.6 shape without leaking anything but entities', () => {
  const prompt = buildDraftPrompt({ brand: BRAND, competitors: COMPETITORS, categoryHint: 'AI notes', keywords: 'transcription' });
  assert.match(prompt, /8-12 intents/);
  assert.match(prompt, /exactly 3 paraphrases/);
  assert.match(prompt, /under 300 characters/);
  assert.match(prompt, /"intents":\[/);
  assert.match(prompt, /Keywords: transcription/);
});
