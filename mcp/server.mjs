/**
 * Zero-dependency stdio MCP server (§13). Phase 3.
 *
 * Newline-delimited JSON-RPC 2.0 over stdin/stdout, hand-rolled — no SDK. Handles
 * initialize / notifications/initialized / ping / tools/list / tools/call, and -32601
 * for anything else. The protocol version string is [VERIFY-AT-BUILD]; echo the
 * client's requested version when it is one we know. stdout stays protocol-pure:
 * every log line goes to stderr.
 *
 * Tools read a running Hearsay over HTTP at HEARSAY_URL (default http://127.0.0.1:3000):
 * hearsay_summary, hearsay_alerts, hearsay_answers_search, hearsay_prompt_results,
 * hearsay_run_panel, hearsay_citation_gap, hearsay_intent_results.
 */
export {};
