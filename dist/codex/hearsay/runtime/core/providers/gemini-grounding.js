import { sourceGroupingUrl } from '../measurement-contract.js';
import { EVIDENCE_LIMITS } from '../measurement-storage.js';

const RECEIPT_MAX_BYTES = 256 * 1024;

/** @param {unknown} value @returns {Record<string, unknown>|null} */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string, unknown>} */ (value) : null;

/**
 * Google indexes each content part in UTF-8 bytes. Return a JavaScript UTF-16
 * index only at a code point boundary.
 * @param {string} text
 * @param {number} byteIndex
 * @returns {number|null}
 */
export function utf8ByteToStringIndex(text, byteIndex) {
  if (!Number.isSafeInteger(byteIndex) || byteIndex < 0) return null;
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    if (bytes === byteIndex) return index;
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    bytes += Buffer.byteLength(character);
    index += character.length;
  }
  return bytes === byteIndex ? text.length : null;
}

/** @param {unknown} value @returns {number|null} */
const indexOrNull = (value) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

/**
 * Normalize the selected candidate's grounding metadata without creating URL-based
 * citation associations. The receipt keeps the original provider arrays for audit.
 * @param {unknown} metadata
 * @param {string[]} partTexts
 */
export function parseGeminiGrounding(metadata, partTexts) {
  const original = record(metadata);
  const queries = Array.isArray(original?.webSearchQueries)
    ? original.webSearchQueries.filter((query) => typeof query === 'string') : null;
  const chunks = Array.isArray(original?.groundingChunks) ? original.groundingChunks : null;
  const supports = Array.isArray(original?.groundingSupports) ? original.groundingSupports : null;
  if (queries && queries.length > EVIDENCE_LIMITS.queries) throw new RangeError('Too many Gemini search queries');
  if (queries?.some((query) => Buffer.byteLength(String(query)) > 2048)) {
    throw new RangeError('Gemini search query exceeds 2048 bytes');
  }
  if (chunks && chunks.length > EVIDENCE_LIMITS.sources) throw new RangeError('Too many Gemini grounding chunks');
  if (supports && supports.length > EVIDENCE_LIMITS.citations) throw new RangeError('Too many Gemini grounding supports');
  const entry = record(original?.searchEntryPoint);
  const suggestions = typeof entry?.renderedContent === 'string' ? entry.renderedContent : null;
  const receipt = {
    version: 1,
    status: original ? 'present' : 'absent',
    webSearchQueries: original?.webSearchQueries ?? null,
    groundingChunks: original?.groundingChunks ?? null,
    groundingSupports: original?.groundingSupports ?? null,
    searchEntryPoint: original?.searchEntryPoint ?? null,
  };
  if (Buffer.byteLength(JSON.stringify(receipt)) > RECEIPT_MAX_BYTES) {
    throw new RangeError(`Gemini grounding receipt exceeds ${RECEIPT_MAX_BYTES} bytes`);
  }
  const observedSearch = Boolean((queries && queries.length) || (chunks && chunks.length) ||
    (supports && supports.length) || suggestions);
  /** @type {import('../measurement-contract.js').SearchAction[]} */
  const searchActions = observedSearch ? [{
    id: 'gemini-google-search:0', kind: 'search', status: 'completed',
    queryMetadata: queries && queries.length ? 'available' : 'unavailable',
    queries: /** @type {string[]} */ (queries ?? []), observedAt: null,
    providerType: 'google_search',
  }] : [];

  /** @type {import('../measurement-contract.js').SourceObservation[]} */
  const sources = [];
  /** @type {Map<number, import('../measurement-contract.js').SourceObservation>} */
  const byChunkIndex = new Map();
  for (const [index, rawChunk] of (chunks ?? []).entries()) {
    const web = record(record(rawChunk)?.web);
    const url = typeof web?.uri === 'string' ? web.uri : null;
    if (!url || sourceGroupingUrl(url) === null) continue;
    const source = {
      id: `grounding-chunk:${index}`, url,
      title: typeof web?.title === 'string' ? web.title : null,
      provenance: /** @type {const} */ ('reported_source'), actionId: null, order: index,
    };
    sources.push(source);
    byChunkIndex.set(index, source);
  }

  const answer = partTexts.join('');
  /** @type {import('../measurement-contract.js').AnswerCitation[]} */
  const answerCitations = [];
  for (const rawSupport of supports ?? []) {
    const support = record(rawSupport);
    const segment = record(support?.segment);
    const partIndex = segment?.partIndex === undefined || segment?.partIndex === null
      ? 0 : indexOrNull(segment.partIndex);
    if (partIndex === null) continue;
    const part = partTexts[partIndex];
    const startByte = indexOrNull(segment?.startIndex);
    const endByte = indexOrNull(segment?.endIndex);
    if (part === undefined || startByte === null || endByte === null || endByte <= startByte) continue;
    const startInPart = utf8ByteToStringIndex(part, startByte);
    const endInPart = utf8ByteToStringIndex(part, endByte);
    if (startInPart === null || endInPart === null || endInPart <= startInPart) continue;
    if (typeof segment?.text === 'string' && part.slice(startInPart, endInPart) !== segment.text) continue;
    const offset = partTexts.slice(0, partIndex).reduce((sum, text) => sum + text.length, 0);
    const start = offset + startInPart;
    const end = offset + endInPart;
    if (end > answer.length) continue;
    if (!Array.isArray(support?.groundingChunkIndices)) continue;
    for (const chunkIndex of new Set(support.groundingChunkIndices)) {
      const index = indexOrNull(chunkIndex);
      const source = index === null ? undefined : byChunkIndex.get(index);
      if (!source) continue;
      answerCitations.push({ url: source.url, provenance: 'native_annotation',
        sourceId: source.id, start, end });
      if (answerCitations.length > EVIDENCE_LIMITS.citations) {
        throw new RangeError('Too many Gemini grounding citations');
      }
    }
  }
  return { searchActions, sources, answerCitations, receipt, suggestions, observedSearch };
}
