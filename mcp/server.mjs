#!/usr/bin/env node
/**
 * Zero-dependency stdio MCP server (§13, SPEC §2/§6). Newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; logs go to stderr. Data comes from a running
 * Hearsay over HTTP at HEARSAY_URL — this process holds no API keys and opens no DB.
 */
import { readFileSync } from 'node:fs';

const HEARSAY_URL = (process.env.HEARSAY_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
// [VERIFY-AT-BUILD]: verified 2026-07-26 against modelcontextprotocol.io/specification/versioning
// — current revision is 2025-11-25; earlier revisions remain valid to echo.
const KNOWN_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** @param {unknown} id @param {object} result */
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
/** @param {unknown} id @param {number} code @param {string} message */
function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

/** @param {{id?: unknown, method?: string, params?: any}} msg */
async function dispatch(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined;
  try {
    switch (method) {
      case 'initialize': {
        const asked = String(params?.protocolVersion ?? '');
        reply(id, {
          protocolVersion: KNOWN_PROTOCOL_VERSIONS.includes(asked) ? asked : KNOWN_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'hearsay', version: VERSION },
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'notifications/initialized':
        return; // acknowledged silently
      case 'tools/list':
      case 'tools/call':
        // Implemented in Tasks 5–6.
        replyError(id, -32601, `${method} not wired yet`);
        return;
      default:
        if (!isNotification) replyError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (err) {
    process.stderr.write(`[hearsay-mcp] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    if (!isNotification) replyError(id, -32603, 'Internal error');
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === '') continue;
    try {
      void dispatch(JSON.parse(line));
    } catch {
      replyError(null, -32700, 'Parse error');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
