/**
 * Page route table (§10.2). Each page module is a pair: `buildView` reads the
 * database, `render` turns the view model into HTML. Keeping them apart is what lets
 * the render half be tested as a pure function against a fixed view model, and it is
 * why no SQL appears inside a template.
 *
 * The dashboard redirects to /setup on a cold database when demo mode is off (§11.8).
 */

import { sendHtml } from '../router.js';
import * as alertsPage from './alerts.js';
import * as answersPage from './answers.js';
import * as dashboardPage from './dashboard.js';
import * as entitiesPage from './entities.js';
import * as evidencePage from './evidence.js';
import * as methodologyPage from './methodology.js';
import * as promptsPage from './prompts.js';
import * as settingsPage from './settings.js';
import * as setupPage from './setup.js';
import { listEntities, openAlertCount, latestRun } from '../queries.js';

/**
 * @typedef {Object} PageDeps
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {import('../../core/config.js').Config} config
 * @property {string} version
 */

/**
 * The shell context every page shares: demo banner, alert badge, last-run line (§11.2).
 *
 * @param {PageDeps} deps
 * @returns {import('../layout.js').ShellCtx}
 */
export function shellCtx({ db, config, version }) {
  const run = latestRun(db);
  /** @type {string|null} */
  let lastRunLine = null;
  if (run !== null) {
    const stamp = run.finished_at ?? run.started_at;
    const when = new Date(stamp).toLocaleString();
    lastRunLine = `Last run ${when} · ${run.status} · ${run.done_calls}/${run.total_calls} calls`;
  }
  return {
    demo: config.demo,
    openAlerts: openAlertCount(db),
    lastRunLine,
    version,
  };
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {PageDeps} deps
 * @returns {void}
 */
export function registerPageRoutes(router, deps) {
  const { db, config } = deps;

  router.add('GET', '/', (ctx) => {
    // First-run redirect (§11.8): no entities and demo mode off → the wizard.
    if (!config.demo && listEntities(db).length === 0) {
      ctx.res.writeHead(302, { Location: '/setup' });
      ctx.res.end();
      return;
    }
    const days = Number(ctx.url.searchParams.get('days'));
    const seriesId = ctx.url.searchParams.get('series_id') ?? undefined;
    sendHtml(ctx.res, 200, dashboardPage.render(shellCtx(deps), dashboardPage.buildView(deps, {
      days: Number.isInteger(days) && days >= 1 && days <= 3650 ? days : undefined,
      seriesId,
    })));
  });

  router.add('GET', '/answers', (ctx) => {
    sendHtml(ctx.res, 200, answersPage.render(shellCtx(deps), answersPage.buildView(deps, ctx.url.searchParams)));
  });

  router.add('GET', '/evidence', (ctx) => {
    sendHtml(ctx.res, 200, evidencePage.render(shellCtx(deps), evidencePage.buildView(deps, ctx.url.searchParams)));
  });

  router.add('GET', '/prompts', (ctx) => {
    const days = Number(ctx.url.searchParams.get('days'));
    sendHtml(ctx.res, 200, promptsPage.render(shellCtx(deps), promptsPage.buildView(deps, {
      days: Number.isInteger(days) && days >= 1 && days <= 3650 ? days : undefined,
      seriesId: ctx.url.searchParams.get('series_id') ?? undefined,
    })));
  });

  router.add('GET', '/entities', (ctx) => {
    sendHtml(ctx.res, 200, entitiesPage.render(shellCtx(deps), entitiesPage.buildView(deps)));
  });

  router.add('GET', '/alerts', (ctx) => {
    sendHtml(ctx.res, 200, alertsPage.render(shellCtx(deps), alertsPage.buildView(deps, ctx.url.searchParams)));
  });

  router.add('GET', '/settings', (ctx) => {
    sendHtml(ctx.res, 200, settingsPage.render(shellCtx(deps), settingsPage.buildView(deps)));
  });

  router.add('GET', '/setup', (ctx) => {
    sendHtml(ctx.res, 200, setupPage.render(shellCtx(deps), setupPage.buildView(deps, ctx.url.searchParams)));
  });

  router.add('GET', '/methodology', (ctx) => {
    sendHtml(ctx.res, 200, methodologyPage.render(shellCtx(deps), methodologyPage.buildView(deps)));
  });
}
