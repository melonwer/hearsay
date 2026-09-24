import { get, getSetting, setSetting, SETTING_KEYS } from './db.js';
import { apiExecutionBudget } from './execution-budget.js';
import { stableIdentity } from './measurement-contract.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./config.js').Config} Config */

export const API_SEARCH_SCHEDULE_CONSENT_VERSION = 'api-search-schedule-v1';

/** @param {Config} config */
export function apiScheduleBudgetHash(config) {
  return stableIdentity(config.enabledProviders.map((provider) => apiExecutionBudget(config, provider.id)));
}

/** @param {Config} config @param {string} runQuoteId @param {number} targetCeiling */
export function apiScheduleQuoteId(config, runQuoteId, targetCeiling) {
  return stableIdentity({ kind: API_SEARCH_SCHEDULE_CONSENT_VERSION, runQuoteId,
    targetCeiling, runAt: config.runAt, budgetHash: apiScheduleBudgetHash(config) });
}

/** @param {Db} db @returns {{enabled:true,consentVersion:string,runAt:string,
 *   budgetHash:string,targetCeiling:number,consentedAt:string}|null} */
export function getApiSearchSchedule(db) {
  const value = getSetting(db, SETTING_KEYS.API_SEARCH_SCHEDULE, null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = /** @type {Record<string,unknown>} */ (value);
  if (record.enabled !== true || record.consentVersion !== API_SEARCH_SCHEDULE_CONSENT_VERSION ||
      typeof record.runAt !== 'string' || typeof record.budgetHash !== 'string' ||
      !Number.isInteger(record.targetCeiling) || Number(record.targetCeiling) < 1 ||
      typeof record.consentedAt !== 'string') return null;
  return /** @type {ReturnType<typeof getApiSearchSchedule>} */ (record);
}

/** @param {Db} db @param {Config} config @param {number} targetCeiling */
export function saveApiSearchSchedule(db, config, targetCeiling) {
  if (!Number.isInteger(targetCeiling) || targetCeiling < 1) throw new RangeError('targetCeiling must be positive');
  if (config.apiSearchPolicies.openai === 'off' || !config.providers.openai.enabled) {
    throw new RangeError('An enabled OpenAI web-search route is required');
  }
  const schedule = { enabled: /** @type {const} */ (true),
    consentVersion: API_SEARCH_SCHEDULE_CONSENT_VERSION,
    runAt: config.runAt, budgetHash: apiScheduleBudgetHash(config), targetCeiling,
    consentedAt: new Date().toISOString() };
  setSetting(db, SETTING_KEYS.API_SEARCH_SCHEDULE, schedule);
  return schedule;
}

/** @param {Db} db */
export function disableApiSearchSchedule(db) {
  const schedule = getApiSearchSchedule(db);
  if (!schedule) return false;
  setSetting(db, SETTING_KEYS.API_SEARCH_SCHEDULE, { ...schedule, enabled: false });
  return true;
}

/** @param {Db} db @param {Config} config */
export function apiSearchScheduleApproved(db, config) {
  if (config.apiSearchPolicies.openai === 'off') return false;
  const schedule = getApiSearchSchedule(db);
  if (!schedule || schedule.runAt !== config.runAt ||
      schedule.budgetHash !== apiScheduleBudgetHash(config)) return false;
  const prompts = Number(get(db, 'SELECT COUNT(*) AS n FROM prompts WHERE active = 1')?.n ?? 0);
  return prompts * config.samples * config.enabledProviders.length <= schedule.targetCeiling;
}
