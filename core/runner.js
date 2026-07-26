/**
 * Panel execution engine (§8.1).
 *
 * Phase 1 Lane A implements runPanel({trigger}) → Promise<RunSummary>: in-process mutex
 * plus a DB check refusing a second concurrent run, task list of active prompts ×
 * enabled providers × config.samples, a concurrency pool, one transaction per response
 * (insert response, then analyzeResponse → mentions/citations), a per-provider circuit
 * breaker after 3 consecutive auth/quota errors, then alerts.evaluate(runId) and
 * finalisation. Refuses with DemoModeError when demo mode is on.
 */
export {};
