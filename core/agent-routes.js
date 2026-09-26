export const AGENT_ROUTES = Object.freeze([
  { id: 'codex-agent', key: 'codex', provider: 'openai', label: 'Codex agent', executable: 'codex',
    enabledEnv: 'HEARSAY_CODEX_ENABLED', pathEnv: 'HEARSAY_CODEX_PATH', profile: 'codex-search-v1',
    authArgs: ['login', 'status'], helpArgs: [['--help'], ['exec', '--help']],
    requiredFlags: ['--search', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', '--skip-git-repo-check'] },
  { id: 'claude-code-agent', key: 'claudeCode', provider: 'anthropic', label: 'Claude Code agent', executable: 'claude',
    enabledEnv: 'HEARSAY_CLAUDE_CODE_ENABLED', pathEnv: 'HEARSAY_CLAUDE_CODE_PATH', profile: 'claude-code-search-v1',
    authArgs: ['auth', 'status'], helpArgs: [['--help']],
    requiredFlags: ['--safe-mode', '--no-session-persistence', '--no-chrome', '--output-format', '--permission-mode', '--tools', '--allowedTools', '--strict-mcp-config'] },
  { id: 'agy-cli', key: 'agy', provider: 'gemini', label: 'Antigravity CLI', executable: 'agy',
    enabledEnv: 'HEARSAY_AGY_ENABLED', pathEnv: 'HEARSAY_AGY_PATH', profile: 'agy-search-v2',
    authArgs: [], helpArgs: [['--help']], requiredFlags: ['--print', '--output-format', '--agent'] },
]);
export const AGENT_SURFACES = AGENT_ROUTES.map((route) => route.id);
export const AGENT_SURFACES_SQL = AGENT_SURFACES.map((id) => `'${id}'`).join(',');
/** @param {string} id */
export function agentRoute(id) {
  const route = AGENT_ROUTES.find((route) => route.id === id);
  if (!route) throw new TypeError(`Unsupported agent route: ${id}`);
  return route;
}
/** @param {unknown} id */
export function isAgentSurface(id) { return typeof id === 'string' && AGENT_SURFACES.includes(id); }
