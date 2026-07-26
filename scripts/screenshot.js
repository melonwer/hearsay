/**
 * CLI: node scripts/screenshot.js — README screenshots (§18 step 4).
 *
 * Dev-only and deliberately not a dependency of the app: it drives Playwright from a
 * local --no-save/npx install over the seeded demo. Nothing in the shipped runtime
 * imports this file, and the Playwright import below is dynamic through a variable
 * specifier so neither `node --test` nor `tsc` ever needs the package present.
 *
 * Produces (1440×900 viewport unless noted):
 *   docs/screenshot-light.png    dashboard, light theme
 *   docs/screenshot-dark.png     dashboard, dark theme
 *   docs/screenshot-answers.png  answers explorer, light theme
 *   docs/screenshot-cost.png     settings page (cost calculator), light theme
 *   docs/social-preview.png      dashboard KPI row at 1280×640 (repo social preview)
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(REPO_DIR, 'docs');

// Demo mode + a throwaway DB must be decided before core/config.js is imported,
// which happens transitively the moment server.js loads — hence env first,
// dynamic import after.
const tempDir = mkdtempSync(join(tmpdir(), 'hearsay-shots-'));
process.env.HEARSAY_DEMO = '1';
process.env.HEARSAY_DB_PATH = join(tempDir, 'hearsay.db');

/**
 * Playwright ships no types here (it is never in package.json), so everything it
 * returns is typed as `any` on purpose.
 *
 * @returns {Promise<any>} the `chromium` browser type
 */
async function loadChromium() {
  const specifier = 'playwright'; // variable on purpose: keeps tsc from resolving it
  try {
    const playwright = await import(specifier);
    return playwright.chromium;
  } catch {
    process.stderr.write(
      'scripts/screenshot.js needs Playwright (dev tooling only, never a package.json dependency):\n' +
        '  npm i --no-save playwright && npx playwright install chromium\n',
    );
    process.exit(1);
  }
}

/**
 * @param {any} browser Playwright Browser
 * @param {string} origin
 * @param {{pagePath: string, path: string, theme: 'light'|'dark', width: number, height: number, clip?: {x:number,y:number,width:number,height:number}}} shot
 */
async function capture(browser, origin, shot) {
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    colorScheme: shot.theme,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  // public/app.js reads localStorage['hearsay:theme'] and stamps data-theme on <html>;
  // seed both the stored choice and the attribute so the first paint is already themed.
  await page.addInitScript(`
    try { localStorage.setItem('hearsay:theme', '${shot.theme}'); } catch {}
    document.documentElement.setAttribute('data-theme', '${shot.theme}');
  `);
  await page.goto(origin + shot.pagePath, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250); // let SVG charts and fonts settle
  await page.screenshot({ path: shot.path, clip: shot.clip });
  await context.close();
}

async function main() {
  const chromium = await loadChromium();
  const { startServer } = await import('../server.js');
  const { port, close } = await startServer({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${port}`;
  mkdirSync(DOCS_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    /** @type {Array<{pagePath: string, path: string, theme: 'light'|'dark', width: number, height: number, clip?: {x:number,y:number,width:number,height:number}}>} */
    const shots = [
      { pagePath: '/', path: join(DOCS_DIR, 'screenshot-light.png'), theme: 'light', width: 1440, height: 900 },
      { pagePath: '/', path: join(DOCS_DIR, 'screenshot-dark.png'), theme: 'dark', width: 1440, height: 900 },
      { pagePath: '/answers', path: join(DOCS_DIR, 'screenshot-answers.png'), theme: 'light', width: 1440, height: 900 },
      { pagePath: '/settings', path: join(DOCS_DIR, 'screenshot-cost.png'), theme: 'light', width: 1440, height: 900 },
      // Repo social preview: the dashboard KPI row at GitHub's 1280×640 card size.
      { pagePath: '/', path: join(DOCS_DIR, 'social-preview.png'), theme: 'light', width: 1280, height: 640 },
    ];
    for (const shot of shots) {
      await capture(browser, origin, shot);
      process.stderr.write(`wrote ${shot.path} (${shot.theme}, ${shot.width}×${shot.height})\n`);
    }
  } finally {
    await browser.close();
    await close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`screenshot run failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
