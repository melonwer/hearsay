import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const root = resolve(process.argv[2] || '.');
const pending = ['core', 'web', 'mcp', 'bin', 'public', 'server.js',
  'scripts/run-panel.js', 'scripts/seed.js', 'scripts/suggest-prompts.js', 'scripts/build-bundles.js'].map((path) => resolve(root, path));
const seen = new Set();
/** @type {string[]} */
const errors = [];
while (pending.length) {
  const file = /** @type {string} */ (pending.pop());
  if (seen.has(file)) continue;
  seen.add(file);
  if (statSync(file).isDirectory()) {
    pending.push(...readdirSync(file).map((name) => resolve(file, name)));
    continue;
  }
  if (!['.js', '.mjs', '.cjs'].includes(extname(file))) continue;
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @param {ts.Node} node */
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require'
      || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require')) {
      specifier = node.arguments[0] ?? node;
    }
    if (specifier) {
      const line = source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1;
      const location = `${relative(root, file)}:${line}`;
      if (!ts.isStringLiteralLike(specifier)) errors.push(`${location}: module specifier must be a literal`);
      else if (specifier.text.startsWith('node:') && isBuiltin(specifier.text)) return;
      else if (specifier.text.startsWith('./') || specifier.text.startsWith('../')) {
        const target = resolve(dirname(file), specifier.text);
        if (!target.startsWith(`${root}${sep}`)) errors.push(`${location}: import leaves the repository`);
        else pending.push(target);
      } else errors.push(`${location}: external runtime import ${JSON.stringify(specifier.text)}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else console.log('Runtime imports use only node: builtins and repository files.');
