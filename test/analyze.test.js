/**
 * Analyzer tests — every case listed in §6.5, and then some.
 *
 * Pure functions only: fixture answer texts in, rows out. No database, no network,
 * no clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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

test('R1 positive: a trigger phrase within 80 chars marks the entity recommended', () => {
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

test('R1 negative: the same trigger more than 80 chars away does not carry', () => {
  const gap = 'y'.repeat(100);
  const text = `The best option depends on your workflow. ${gap} Later on, Jotta gets a passing mention in a long paragraph that keeps going for a while so the short-answer rule cannot fire either. ${gap}`;
  const mentions = extractMentions(text, ENTITIES);
  assert.equal(forEntity(mentions, 2)?.recommended, 0);
});

test('R2 positive: first mention inside the first item of the first list', () => {
  const text = [
    'Here are the leading tools, in no particular order, for teams that record a lot of calls and want searchable transcripts afterwards.',
    '',
    '1. Notewell — strongest speaker separation.',
    '2. Jotta — cheapest paid tier.',
    '3. EchoPad — best mobile app.',
  ].join('\n');
  const mentions = extractMentions(text, ENTITIES);
  assert.equal(forEntity(mentions, 1)?.recommended, 1);
});

test('R2 negative: an entity in the second list item is not recommended', () => {
  const text = [
    'Here are the leading tools, in no particular order, for teams that record a lot of calls and want searchable transcripts afterwards.',
    '',
    '1. EchoPad — strongest speaker separation.',
    '2. Jotta — cheapest paid tier.',
  ].join('\n');
  const mentions = extractMentions(text, ENTITIES);
  assert.equal(forEntity(mentions, 3)?.recommended, 1);
  assert.equal(forEntity(mentions, 2)?.recommended, 0);
});

test('R3 positive: short answer, entity in the first sentence', () => {
  const mentions = extractMentions('Jotta is the usual pick for solo consultants. It syncs to Notion.', ENTITIES);
  assert.equal(forEntity(mentions, 2)?.recommended, 1);
});

test('R3 negative: long answer, a first-sentence lead is not enough', () => {
  const filler = 'This paragraph exists only to push the answer past the four hundred character threshold. '.repeat(6);
  const text = `Jotta is one of several options. ${filler}`;
  assert.ok(text.length >= 400);
  assert.equal(forEntity(extractMentions(text, ENTITIES), 2)?.recommended, 0);
});

test('R3 negative: short answer, entity only in a later sentence', () => {
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

test('analyzeResponse returns rows shaped like the mentions and citations columns (§3)', () => {
  const { mentions, citations } = analyzeResponse('Notewell wins. See https://notewell.io.', ENTITIES);
  assert.deepEqual(Object.keys(mentions[0]).sort(), [
    'entity_id',
    'first_index',
    'occurrences',
    'rank',
    'recommended',
    'snippet',
  ]);
  assert.deepEqual(Object.keys(citations[0]).sort(), ['domain', 'entity_id', 'rank', 'url']);
});

test('containsAlias shares the analyzer boundary rules with branded tagging (§6.7)', () => {
  assert.equal(containsAlias('Is Notewell any good?', ['Notewell', 'Notewell AI']), true);
  assert.equal(containsAlias('Best notewellness apps', ['Notewell']), false);
});
