# Dynamic Local Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a default Hearsay install bind an OS-selected free local port and let the stdio MCP proxy discover that port without falling back to an unrelated service on `:3000`.

**Architecture:** Add a small `core/port-discovery.js` module that owns the installation-relative port-file path, strict port parsing, atomic writes, conditional cleanup, and MCP URL resolution. `server.js` writes the selected bound port after `listen()` and removes only its own port record on shutdown. `mcp/server.mjs` resolves `HEARSAY_URL` first and otherwise reads the discovery file for every tool call, so a long-lived MCP process notices a later Hearsay startup.

**Tech Stack:** Node.js built-ins only, ESM, `node:test`, `node:sqlite`, newline-delimited JSON-RPC MCP, existing zero-dependency HTTP server.

## Global Constraints

- Keep the runtime dependency-free; use only Node built-ins already used by the repository.
- Keep the default host loopback-only: `127.0.0.1`.
- Preserve explicit positive `PORT` values and explicit `HEARSAY_URL` values for reverse proxies, VPS installs, and scripts.
- Treat `PORT=0` as automatic OS-selected ephemeral binding; reject or normalize invalid values to that automatic default.
- Never scan for or kill a process using an explicitly requested fixed port.
- Never silently fall back to `http://127.0.0.1:3000` when discovery is absent or malformed.
- Keep local port files under ignored runtime data and write them with restrictive permissions.
- Run focused tests after each behavior change, then the full suite, typecheck, and `git diff --check` before completion.

---

### Task 1: Port discovery utility

**Files:**
- Create: `core/port-discovery.js`
- Test: `test/port-discovery.test.js`

**Interfaces:**
- Produces `DEFAULT_PORT_FILE`, `resolvePortFilePath(env)`, `readPortFile(file)`, `writePortFile(file, port)`, `removePortFile(file, port)`, and `resolveHearsayUrl(env)` for the server and MCP layers.
- `resolvePortFilePath` uses `HEARSAY_PORT_FILE` when set, resolving a relative override from the current working directory; otherwise it uses the installation-relative `data/hearsay.port` path.
- `resolveHearsayUrl` returns an explicit normalized `HEARSAY_URL` when present, an installation-local `http://127.0.0.1:<discovered-port>` URL when the port file is valid, or a structured unreachable message when no valid discovery record exists.

- [ ] **Step 1: Write the failing tests**

Add tests that assert:

```js
test('automatic discovery uses a strict positive port and explicit URL wins', () => {
  assert.equal(resolveHearsayUrl({ HEARSAY_URL: 'http://example.test:9000/' }).url, 'http://example.test:9000');
  assert.equal(resolveHearsayUrl({ HEARSAY_PORT_FILE: tempFile }).url, `http://127.0.0.1:${readFileSync(tempFile, 'utf8').trim()}`);
});

test('missing or malformed discovery does not fall back to port 3000', () => {
  const result = resolveHearsayUrl({ HEARSAY_PORT_FILE: missingFile });
  assert.equal(result.url, null);
  assert.match(result.message, /start.*server/i);
  assert.doesNotMatch(result.message, /:3000/);
});

test('port file writes atomically and conditional cleanup preserves another owner', () => {
  writePortFile(file, 43127);
  assert.equal(readPortFile(file), 43127);
  writePortFile(file, 43128);
  removePortFile(file, 43127);
  assert.equal(readPortFile(file), 43128);
  removePortFile(file, 43128);
  assert.equal(readPortFile(file), null);
});
```

Use a temporary directory and real filesystem operations; do not mock `fs`.

- [ ] **Step 2: Run the focused tests and verify the expected failure**

Run: `node --test test/port-discovery.test.js`

Expected: FAIL because `core/port-discovery.js` and its exported functions do not yet exist.

- [ ] **Step 3: Implement the minimal utility**

Use `mkdirSync`, `writeFileSync` to a sibling temporary file, `renameSync`, `readFileSync`, `existsSync`, and `unlinkSync` from `node:fs`. Parse only `/^[1-9][0-9]{0,4}$/` values in the inclusive range `1..65535`. Create the parent directory before writing, use mode `0o600`, and remove a file only when its current parsed port equals the caller’s port. Return `{url, file, message}` from `resolveHearsayUrl`; normalize trailing slashes only on explicit URLs.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `node --test test/port-discovery.test.js`

Expected: all port-discovery tests pass.

- [ ] **Step 5: Commit the utility**

```bash
git add core/port-discovery.js test/port-discovery.test.js
git commit -m "feat: add local port discovery utility"
```

### Task 2: Automatic server binding and lifecycle ownership

**Files:**
- Modify: `core/config.js: Config typedef and buildConfig port parsing`
- Modify: `server.js: startServer options, listener lifecycle, and cleanup`
- Modify: `test/port-discovery.test.js: configuration and server lifecycle tests`
- Modify: `test/api.test.js` or the existing config-focused test file only if an existing default-port assertion must be updated.

**Interfaces:**
- `Config.port` defaults to `0`; `Config.portFile` stores the resolved discovery path.
- `startServer({port: 0, portFile})` returns the positive bound `port` and removes only its own discovery record from `close()`.

- [ ] **Step 1: Write the failing tests**

Add real tests for:

```js
test('config defaults to automatic binding while explicit positive PORT remains fixed', () => {
  assert.equal(buildConfig({}).port, 0);
  assert.equal(buildConfig({ PORT: '3100' }).port, 3100);
  assert.equal(buildConfig({ PORT: '-1' }).port, 0);
  assert.equal(buildConfig({ PORT: 'not-a-port' }).port, 0);
});

test('server writes the actual ephemeral port and removes it on close', async () => {
  const running = await startServer({ config, dbPath, port: 0, portFile });
  assert.ok(running.port > 0);
  assert.equal(readPortFile(portFile), running.port);
  await running.close();
  assert.equal(readPortFile(portFile), null);
});
```

Use a temporary SQLite path and temporary port-file path; set demo mode in the test config so the test cannot make provider calls or schedule work.

- [ ] **Step 2: Run the focused tests and verify they fail for the missing behavior**

Run: `node --test test/port-discovery.test.js`

Expected: the config and lifecycle assertions fail because the default is still `3000` and `startServer` does not own a discovery file.

- [ ] **Step 3: Implement the minimal server/config changes**

Change the port parse lower bound to `0` and default to `0`. Add `portFile` to the config using `resolvePortFilePath`. Add an optional `portFile` start option, write the bound port immediately after `server.listen()` succeeds, and include cleanup in `close()`. If discovery-file writing fails, close the scheduler, HTTP server, and database before rethrowing so startup cannot leave an undiscoverable server running. Keep the existing startup URL log, which already receives the actual bound port.

- [ ] **Step 4: Run focused and existing API tests**

Run: `node --test test/port-discovery.test.js test/api.test.js`

Expected: all selected tests pass with no change to explicit fixed-port behavior.

- [ ] **Step 5: Commit the server behavior**

```bash
git add core/config.js server.js test/port-discovery.test.js test/api.test.js
git commit -m "feat: bind local Hearsay to an available port"
```

### Task 3: MCP discovery resolution

**Files:**
- Modify: `mcp/server.mjs: backend URL resolution before tools/call fetch`
- Modify: `test/mcp.test.js: URL override, discovery, and missing-file cases`

**Interfaces:**
- MCP keeps the existing JSON-RPC and tool table contracts.
- `tools/call` resolves the backend URL at call time. `HEARSAY_URL` takes precedence; otherwise the current discovery file is read. Missing/invalid discovery produces `isError: true` with the existing API-shaped unreachable response and never performs a request to port 3000.

- [ ] **Step 1: Write the failing MCP tests**

Extend the existing child-process MCP harness with a temporary `HEARSAY_PORT_FILE` and a stub HTTP server. Assert that:

```js
test('MCP follows a discovery file created after the process starts', async () => {
  const child = startMcp({ env: { HEARSAY_PORT_FILE: portFile } });
  writePortFile(portFile, stub.address().port);
  const reply = await callTool(child, 'hearsay_status');
  assert.equal(JSON.parse(reply.content[0].text).ok, true);
});

test('MCP reports missing discovery instead of contacting port 3000', async () => {
  const reply = await callTool(startMcp({ env: { HEARSAY_PORT_FILE: missingFile } }), 'hearsay_status');
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /not.*started|discovery/i);
  assert.doesNotMatch(reply.content[0].text, /127\\.0\\.0\\.1:3000/);
});

test('explicit HEARSAY_URL overrides the discovery file', async () => {
  const reply = await callTool(startMcp({ env: { HEARSAY_URL: stubUrl, HEARSAY_PORT_FILE: badFile } }), 'hearsay_status');
  assert.equal(JSON.parse(reply.content[0].text).ok, true);
});
```

- [ ] **Step 2: Run MCP tests and verify the new cases fail**

Run: `node --test test/mcp.test.js`

Expected: the existing MCP tests pass, while the new discovery cases fail because the server currently captures a `:3000` URL at module load.

- [ ] **Step 3: Implement per-call resolution**

Import `resolveHearsayUrl` from `core/port-discovery.js`, remove the module-level fixed URL, resolve immediately before each backend fetch, and return the structured unreachable content without calling `fetch` when resolution returns no URL. Preserve timeout handling and error envelope wording for explicit URLs.

- [ ] **Step 4: Run MCP tests and verify they pass**

Run: `node --test test/mcp.test.js`

Expected: all MCP framing, tool-list, HTTP mapping, explicit URL, discovery, and missing-file tests pass.

- [ ] **Step 5: Commit the MCP behavior**

```bash
git add mcp/server.mjs test/mcp.test.js
git commit -m "feat: let MCP discover Hearsay's local port"
```

### Task 4: Documentation and release verification

**Files:**
- Modify: `.env.example: PORT comment and optional HEARSAY_PORT_FILE documentation`
- Modify: `README.md: quickstart, manual status check, MCP setup, and port-conflict troubleshooting`
- Modify: `SECURITY.md` only if the port-file behavior needs a security clarification; otherwise leave it unchanged.

- [ ] **Step 1: Update the configuration example**

Set `PORT=0` with a comment explaining OS-selected local binding. Document `HEARSAY_PORT_FILE` only as an advanced override; do not place a machine-specific absolute path in the repository example.

- [ ] **Step 2: Update the README**

Replace hardcoded default-port assumptions with the startup log and `data/hearsay.port` discovery command. Keep the explicit fixed-port example (`PORT=3000`) in troubleshooting for reverse proxies or users who intentionally reserve that port. Explain that the MCP command needs no port argument when Hearsay uses the default discovery file, while `HEARSAY_URL` remains the override for remote/fixed deployments.

- [ ] **Step 3: Run documentation and static checks**

Run:

```bash
git diff --check
rg -n "127\\.0\\.0\\.1:3000|PORT=3000|HEARSAY_PORT_FILE|hearsay\\.port" README.md .env.example mcp/server.mjs core server.js
```

Expected: `:3000` appears only in the intentional explicit-port/troubleshooting text; automatic startup and MCP docs refer to the selected port/discovery file.

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Expected: 0 test failures, typecheck exit 0, and no whitespace errors.

- [ ] **Step 5: Review the final diff and commit documentation**

```bash
git status --short --branch
git diff --stat HEAD~3..HEAD
git add .env.example README.md SECURITY.md
git commit -m "docs: explain automatic local port discovery"
```

If `SECURITY.md` was unchanged, omit it from the add command. Confirm the final worktree is clean and record the final commit hashes.
