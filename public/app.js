/**
 * The only client-side script: theme toggle now; chart tooltips and fetch-powered
 * actions (run panel, sortable leaderboard, CRUD forms) land with Phase 1 Lane C.
 *
 * Plain vanilla ES module. No framework, no build step, no dependencies.
 */

const THEME_KEY = 'hearsay:theme';
const MODES = ['auto', 'light', 'dark'];

/** @returns {string} */
function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value && MODES.includes(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/** @param {string} mode */
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);

  for (const button of document.querySelectorAll('[data-theme-set]')) {
    button.setAttribute('aria-pressed', String(button.getAttribute('data-theme-set') === mode));
  }
}

/** @param {string} mode */
function setTheme(mode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* private mode — the choice just will not persist */
  }
  applyTheme(mode);
}

function initTheme() {
  applyTheme(storedTheme());
  for (const button of document.querySelectorAll('[data-theme-set]')) {
    button.addEventListener('click', () => {
      setTheme(button.getAttribute('data-theme-set') ?? 'auto');
    });
  }
}

initTheme();

// Phase 1 Lane C:
//   - "Run panel now": POST /api/run, then poll GET /api/runs/latest and drive
//     #run-progress / #last-run from done_calls / total_calls.
//   - Shared crosshair tooltip driven by each chart's data-chart JSON attribute.
//   - Client-side sortable leaderboard, prompt/entity CRUD via fetch + reload.
