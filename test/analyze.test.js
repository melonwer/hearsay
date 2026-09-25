/**
 * Analyzer tests — every case listed in §6.5, and then some.
 *
 * Pure functions only: fixture answer texts in, rows out. No database, no network,
 * no clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { analyzeResponse, containsAlias, extractCitations, extractMentions } from '../core/analyze.js';

/** @type {import('../core/analyze.js').AnalyzeEntity[]} */
const ENTITIES = [
  { id: 1, name: 'Notewell', aliases: ['Notewell AI', 'Notewell Pro'], domains: ['notewell.io'] },
  { id: 2, name: 'Jotta', aliases: [], domains: ['jotta.app'] },
  { id: 3, name: 'EchoPad', aliases: ['Echo Pad'], domains: ['echopad.ai'] },
];

/**
 * @param {import('../core/analyze.js').MentionResult[]} mentions
 * @param {number} entityId
 * @returns {import('../core/analyze.js').MentionResult|undefined}
 */
const forEntity = (mentions, entityId) => mentions.find((m) => m.entity_id === entityId);

test('human-approved stance fixture reports definite-label precision and coverage', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/stance-cases.json', import.meta.url), 'utf8'));
  let definite = 0;
  let correctDefinite = 0;
  for (const example of cases) {
    const entity = { id: 1, name: example.entity, ambiguousName: example.ambiguousName === true };
    const mention = extractMentions(example.text, [entity])[0];
    assert.ok(mention, `Expected a mention in ${example.kind}`);
    assert.equal(mention.stance, example.label, `${example.kind}: ${example.text}`);
    assert.equal(mention.recommended, example.label === 'positive' ? 1 : 0);
    assert.ok(mention.rule_id);
    assert.equal(example.text.slice(mention.evidence_start, mention.evidence_end).includes(example.entity), true);
    if (mention.stance !== 'uncertain') {
      definite += 1;
      if (mention.stance === example.label) correctDefinite += 1;
    }
    if (example.ambiguousName) assert.deepEqual(mention.review_flags, ['ambiguous_entity_name']);
  }
  assert.deepEqual({ cases: cases.length, definite, definitePrecision: correctDefinite / definite,
    coverage: definite / cases.length }, { cases: 24, definite: 14, definitePrecision: 1, coverage: 14 / 24 });
});

test('word boundaries: "Notewellness" is not a mention of "Notewell"', () => {
  const { mentions } = analyzeResponse('Notewellness is a wellness app, unrelated to note taking.', ENTITIES);
  assert.deepEqual(mentions, []);
});

test('word boundaries: punctuation and markdown bold still bound a match', () => {
  const text = 'Options: **Notewell**, (Jotta), and "EchoPad" — all solid.';
  const { mentions } = analyzeResponse(text, ENTITIES);
  assert.deepEqual(
    mentions.map((m) => m.entity_id),
    [1, 2, 3],
  );
  assert.equal(forEntity(mentions, 1)?.first_index, text.indexOf('Notewell'));
});

test("possessives: \"Notewell's\" counts, straight and curly", () => {
  const straight = extractMentions("Notewell's transcripts are searchable.", ENTITIES);
  assert.equal(straight.length, 1);
  assert.equal(straight[0].entity_id, 1);

  const curly = extractMentions('Jotta’s free tier is generous.', ENTITIES);
  assert.equal(curly.length, 1);
  assert.equal(curly[0].entity_id, 2);
});

test('word boundaries: a preceding alphanumeric blocks the match', () => {
  assert.deepEqual(extractMentions('xNotewell and 3Jotta are different strings', ENTITIES), []);
});

test('overlap consumption: "Notewell Pro" beats "Notewell"', () => {
  const { mentions } = analyzeResponse('Notewell Pro adds speaker labels.', ENTITIES);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].entity_id, 1);
  assert.equal(mentions[0].occurrences, 1, 'the inner "Notewell" span was consumed by the longer alias');
});

test('multi-alias same entity: occurrences pool, first_index is the earliest', () => {
  const text = 'Notewell AI is the parent product. Notewell Pro is the paid tier, and plain Notewell is free.';
  const mentions = extractMentions(text, ENTITIES);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].entity_id, 1);
  assert.equal(mentions[0].occurrences, 3);
  assert.equal(mentions[0].first_index, 0);
});

test('rank ordering follows first mention, 1-based', () => {
  const text = 'EchoPad leads here. Jotta is close behind, and Notewell trails.';
  const mentions = extractMentions(text, ENTITIES);
  assert.deepEqual(
    mentions.map((m) => [m.entity_id, m.rank]),
    [
      [3, 1],
      [2, 2],
      [1, 3],
    ],
  );
});

test('entity absent from the answer produces no mention row', () => {
  const mentions = extractMentions('Two decent options are Jotta and EchoPad.', ENTITIES);
  assert.deepEqual(
    mentions.map((m) => m.entity_id),
    [2, 3],
  );
});

test('explicit rejection never becomes a positive recommendation by proximity or position', () => {
  const cases = [
    'I do not recommend Notewell.',
    'Notewell is unsuitable for this use case.',
    'Products to avoid:\n1. Notewell',
  ];
  for (const text of cases) {
    const mention = forEntity(extractMentions(text, ENTITIES), 1);
    assert.ok(mention, `The brand mention should still be detected: ${text}`);
    assert.equal(mention.recommended, 0, `An explicit rejection must not be positive: ${text}`);
  }
});

test('empty text yields no mentions and no citations', () => {
  assert.deepEqual(analyzeResponse('', ENTITIES), { mentions: [], citations: [] });
});

test('snippet keeps original casing and marks truncation with ellipses', () => {
  const filler = 'x'.repeat(300);
  const text = `${filler} NOTEWELL is loud here ${filler}`;
  const mentions = extractMentions(text, ENTITIES);
  assert.equal(mentions.length, 1);
  assert.match(mentions[0].snippet, /^…/);
  assert.match(mentions[0].snippet, /…$/);
  assert.match(mentions[0].snippet, /NOTEWELL is loud here/);
  assert.ok(mentions[0].snippet.length <= 120 * 2 + 'NOTEWELL'.length + 2);
});

test('a direct endorsement names its entity and does not carry to a competitor', () => {
  const text = [
    'For distributed sales teams I would recommend Notewell, which handles multi-speaker audio well and exports',
    'clean transcripts to the usual destinations without much fiddling from whoever runs the workspace day to day.',
    'Much further down the answer, well past the eighty character proximity window, Jotta turns up as a passing',
    'aside for readers who want something cheaper and are willing to give up speaker separation to get it.',
  ].join(' ');
  const mentions = extractMentions(text, ENTITIES);
  assert.ok(text.indexOf('Jotta') - (text.indexOf('recommend') + 'recommend'.length) > 80);
  assert.equal(forEntity(mentions, 1)?.recommended, 1);
  assert.equal(forEntity(mentions, 2)?.recommended, 0);
});

test('an unbound superlative does not recommend a later brand', () => {
  const gap = 'y'.repeat(100);
  const text = `The best option depends on your workflow. ${gap} Later on, Jotta gets a passing mention in a long paragraph that keeps going for a while so the short-answer rule cannot fire either. ${gap}`;
  const mentions = extractMentions(text, ENTITIES);
  assert.equal(forEntity(mentions, 2)?.recommended, 0);
});

test('citations: non-http(s) schemes are rejected on every path, including provider-native', () => {
  // The markdown/bare-URL extractors are regex-restricted to https?://, but native
  // citations (e.g. Perplexity search_results) reached the store unguarded — and a
  // stored javascript: URL becomes a clickable XSS payload as an href on /answers.
  const { citations } = analyzeResponse('no urls in this answer text', ENTITIES, [
    { url: 'javascript://benign.example/%0aalert(document.domain)' },
    { url: 'data:text/html,<script>alert(1)</script>' },
    { url: 'file:///etc/passwd' },
    { url: 'https://notewell.io/docs' },
    { url: 'http://plain.example/page' },
  ]);
  assert.deepEqual(
    citations.map((c) => c.url),
    ['https://notewell.io/docs', 'http://plain.example/page'],
  );
  assert.equal(citations[0].entity_id, 1);
});

test('endorsement claims bind to a name rather than to nearby words', () => {
  const filler = 'The rest of this answer keeps going for a good while about export formats and admin controls so that the four hundred character short-answer rule can never apply to anything here. '.repeat(2);
  // '#1' must not fire inside '#10' — the answer explicitly ranks the brand tenth.
  const ranked = `Our survey covered many tools over several weeks of daily use. Ranked #10 overall: Jotta trailed the pack. ${filler}`;
  assert.equal(forEntity(extractMentions(ranked, ENTITIES), 2)?.recommended, 0);
  // 'best' must not fire inside 'asbestos'.
  const asbestos = `Their offices dealt with an asbestos removal, and Jotta kept working through it. ${filler}`;
  assert.equal(forEntity(extractMentions(asbestos, ENTITIES), 2)?.recommended, 0);
  // 'go with' must not fire inside 'cargo with'.
  const cargo = `They ship cargo with Jotta handling the paperwork end to end. ${filler}`;
  assert.equal(forEntity(extractMentions(cargo, ENTITIES), 2)?.recommended, 0);
  // The genuine phrases still fire at word boundaries.
  const real = `Overall #1: Jotta, by a comfortable margin over everything else we tried. ${filler}`;
  assert.equal(forEntity(extractMentions(real, ENTITIES), 2)?.recommended, 1);
  const best = `The best pick here is Jotta for almost every team we talked to. ${filler}`;
  assert.equal(forEntity(extractMentions(best, ENTITIES), 2)?.recommended, 1);
});

test('a list position alone is not an endorsement', () => {
  const text = [
    'Here are the leading tools, in no particular order, for teams that record a lot of calls and want searchable transcripts afterwards.',
    '',
    '1. Notewell — strongest speaker separation.',
    '2. Jotta — cheapest paid tier.',
    '3. EchoPad — best mobile app.',
  ].join('\n');
  const mentions = extractMentions(text, ENTITIES);
  assert.equal(forEntity(mentions, 1)?.stance, 'uncertain');
  assert.equal(forEntity(mentions, 1)?.recommended, 0);
});

test('neither first nor second list position is an endorsement', () => {
  const text = [
    'Here are the leading tools, in no particular order, for teams that record a lot of calls and want searchable transcripts afterwards.',
    '',
    '1. EchoPad — strongest speaker separation.',
    '2. Jotta — cheapest paid tier.',
  ].join('\n');
  const mentions = extractMentions(text, ENTITIES);
  assert.equal(forEntity(mentions, 3)?.recommended, 0);
  assert.equal(forEntity(mentions, 2)?.recommended, 0);
});

test('an explicit first-sentence endorsement is positive', () => {
  const mentions = extractMentions('Jotta is the usual pick for solo consultants. It syncs to Notion.', ENTITIES);
  assert.equal(forEntity(mentions, 2)?.recommended, 1);
});

test('a first-sentence mention without an endorsement remains non-positive', () => {
  const filler = 'This paragraph exists only to push the answer past the four hundred character threshold. '.repeat(6);
  const text = `Jotta is one of several options. ${filler}`;
  assert.ok(text.length >= 400);
  assert.equal(forEntity(extractMentions(text, ENTITIES), 2)?.recommended, 0);
});

test('a later mention without an endorsement remains non-positive', () => {
  const mentions = extractMentions('Several tools do this well. EchoPad is one of them.', ENTITIES);
  assert.equal(forEntity(mentions, 3)?.recommended, 0);
});

test('citations: native, markdown and bare URLs merge, dedupe and keep the earliest rank', () => {
  const text =
    'Compare [Notewell](https://notewell.io/pricing) and https://jotta.app/features — see also https://notewell.io/pricing again.';
  const citations = extractCitations(text, ENTITIES, [{ url: 'https://reviewradar.io/best-meeting-notes' }]);
  assert.deepEqual(
    citations.map((c) => [c.rank, c.url]),
    [
      [1, 'https://reviewradar.io/best-meeting-notes'],
      [2, 'https://notewell.io/pricing'],
      [3, 'https://jotta.app/features'],
    ],
  );
});

test('citations: subdomains match the owning entity, www is stripped, unknown domains stay null', () => {
  const citations = extractCitations(
    'Docs: https://docs.notewell.io/setup · Blog: https://www.Jotta.app/blog · Roundup: https://worktools.dev/roundup',
    ENTITIES,
  );
  assert.deepEqual(
    citations.map((c) => [c.domain, c.entity_id]),
    [
      ['docs.notewell.io', 1],
      ['jotta.app', 2],
      ['worktools.dev', null],
    ],
  );
});

test('citations: trailing ")", "." and "," are trimmed off bare URLs', () => {
  const citations = extractCitations(
    'Sources: (https://echopad.ai/compare), https://jotta.app/pricing. Also https://worktools.dev/list,',
    ENTITIES,
  );
  assert.deepEqual(
    citations.map((c) => c.url),
    ['https://echopad.ai/compare', 'https://jotta.app/pricing', 'https://worktools.dev/list'],
  );
});

test('citations: an unparseable native URL is dropped rather than stored half-parsed', () => {
  const citations = extractCitations('', ENTITIES, [{ url: 'not-a-url' }, { url: 'https://notewell.io' }]);
  assert.deepEqual(
    citations.map((c) => [c.rank, c.domain]),
    [[1, 'notewell.io']],
  );
});

test('aliases shorter than three characters are ignored defensively', () => {
  /** @type {import('../core/analyze.js').AnalyzeEntity[]} */
  const entities = [{ id: 9, name: 'Quillo', aliases: ['Q'], domains: [] }];
  assert.deepEqual(extractMentions('Q is not enough of a name to match on.', entities), []);
});

test('regex metacharacters in an alias are matched literally', () => {
  /** @type {import('../core/analyze.js').AnalyzeEntity[]} */
  const entities = [{ id: 7, name: 'C++ Notes', aliases: [], domains: [] }];
  const mentions = extractMentions('Try C++ Notes for engineering standups.', entities);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].first_index, 4);
});

test('analyzeResponse returns mention decisions and citation receipts', () => {
  const { mentions, citations } = analyzeResponse('Notewell wins. See https://notewell.io.', ENTITIES);
  assert.deepEqual(Object.keys(mentions[0]).sort(), [
    'entity_id',
    'evidence_end',
    'evidence_start',
    'first_index',
    'occurrences',
    'rank',
    'recommended',
    'review_flags',
    'rule_id',
    'snippet',
    'stance',
  ]);
  assert.deepEqual(Object.keys(citations[0]).sort(), ['domain', 'entity_id', 'rank', 'url']);
});

test('containsAlias shares the analyzer boundary rules with branded tagging (§6.7)', () => {
  assert.equal(containsAlias('Is Notewell any good?', ['Notewell', 'Notewell AI']), true);
  assert.equal(containsAlias('Best notewellness apps', ['Notewell']), false);
});
