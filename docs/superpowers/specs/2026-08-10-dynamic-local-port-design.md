# Hearsay dynamic local port design

**Date:** 2026-08-10  
**Status:** Approved for implementation

## Problem

Hearsay currently defaults to `127.0.0.1:3000`. That is a common local port and is
already occupied on the development machine by another service. A local-first
Hearsay install should start without asking the user to discover and edit a port,
while remote or scripted installs must retain an explicit fixed-port escape hatch.

The MCP stdio process is separate from the HTTP process, so it must be able to
discover the port selected by Hearsay. It must never silently send requests to an
unrelated service on a fallback port.

## Design

### Port selection

- The default `PORT` becomes `0`. Node passes this to the operating system, which
  selects an available ephemeral TCP port atomically.
- A positive `PORT` remains supported and binds that exact port. This preserves
  reverse-proxy, VPS, and scripted deployments.
- The configured host remains `127.0.0.1` by default.
- Startup logs print the actual bound URL, including the selected port.

### Port discovery

After the HTTP listener is bound, Hearsay writes the selected port as a single
newline-terminated integer to `data/hearsay.port` beside the repository's local
runtime data. The write is atomic and uses restrictive local-file permissions.
The file is removed during graceful shutdown. A stale file after a crash is safe:
the next startup replaces it, and MCP validates the live HTTP response rather than
treating the file as proof that Hearsay is running.

`HEARSAY_PORT_FILE` may override the discovery path for custom data directories or
service managers. The default remains derived from the Hearsay installation so the
absolute MCP command registered in a local profile can find it regardless of the
MCP process working directory.

### MCP resolution

For each tool call, the MCP server resolves its backend URL in this order:

1. `HEARSAY_URL`, when explicitly set, for fixed local, reverse-proxy, or remote
   deployments.
2. `HEARSAY_PORT_FILE`, or the installation-relative default discovery file, with
   host `127.0.0.1`.
3. A clear `unreachable` response explaining that Hearsay has not been started.

There is no implicit `:3000` fallback. This prevents MCP from accidentally talking
to Open WebUI or another unrelated process. The existing `HEARSAY_MCP_TIMEOUT_MS`
behavior is unchanged.

### Documentation and compatibility

The `.env.example`, README quickstart, troubleshooting text, and MCP setup notes
will describe automatic port selection and show how to read the actual port for
manual HTTP checks. Explicit `PORT=3000` examples remain valid where a fixed port
is required.

## Testing

- Configuration tests prove the default is `0`, positive explicit ports are
  preserved, and invalid values return to the automatic default.
- Server lifecycle tests prove an ephemeral listener gets a positive free port,
  writes the discovery file, and removes it on close.
- MCP tests prove `HEARSAY_URL` wins, discovery-file resolution works after the
  MCP process has started, malformed/missing files return a clear unreachable
  response, and no `:3000` fallback is attempted.
- Existing full-suite, typecheck, and whitespace checks remain required.

## Non-goals

- Do not scan or kill processes occupying a user-selected fixed port.
- Do not change host binding or expose Hearsay beyond loopback by default.
- Do not modify a user's global Codex/Claude profile from the repository.
- Do not add a dependency or a service manager.
