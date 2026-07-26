/**
 * /api/* — JSON API shared by the UI, the CLI and the MCP server (§10.3).
 *
 * Phase 0 registers no endpoints: an unimplemented route returning fabricated shapes
 * would be worse than an honest 404. Phase 1 Lane C / Phase 2 fill this in with the
 * §10.3 table:
 *
 *   GET    /api/summary?days=30          GET    /api/entities
 *   POST   /api/entities                 PATCH  /api/entities/:id
 *   DELETE /api/entities/:id             GET    /api/prompts
 *   POST   /api/prompts                  PATCH  /api/prompts/:id
 *   DELETE /api/prompts/:id              GET    /api/intents
 *   PATCH  /api/intents/:id              POST   /api/prompts/suggest
 *   GET    /api/cost/estimate            GET    /api/gap?days=30
 *   POST   /api/run                      GET    /api/runs/latest
 *   GET    /api/answers                  GET    /api/alerts?open=1
 *   POST   /api/alerts/:id/ack           GET    /api/export
 */

/**
 * @typedef {Object} ApiDeps
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {import('../../core/config.js').Config} config
 */

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} _router
 * @param {ApiDeps} _deps
 * @returns {void}
 */
export function registerApiRoutes(_router, _deps) {
  // Intentionally empty in Phase 0 — see the endpoint table above.
}
