# Development checks

The application and its unit tests run without installing packages:

```sh
node --test
```

Type checking and the runtime dependency checker use development tools. Install the same versions as CI without changing the package manifest:

```sh
npm install --no-save --package-lock=false typescript@5.9.3 @types/node@24.19.0 playwright@1.62.0
npm run typecheck
node --test scripts/check-runtime-deps.cases.mjs
npm run check:runtime-deps
```

Playwright supplies types for the optional browser verification scripts. To run those scripts, install its browser separately with `npx playwright install chromium`.

The dependency checker parses JavaScript imports in the server, core, web, MCP, command, public, and non-browser utility code. It follows relative imports into other files and rejects package imports or computed targets. Optional browser verification scripts may use Playwright; importing one from application code fails the check. Ordinary text such as `/api/research/import` is not a module import.
